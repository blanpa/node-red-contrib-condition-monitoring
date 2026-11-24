module.exports = function (RED) {
    "use strict";
    const { copyPassthrough } = require("./utils/message");

    // Upper bound for the sliding window. Every sample touches the live window,
    // so the ceiling is a usability guard, not a formality — the old 1_000_000
    // let a single message cost a million-element pass.
    const MAX_WINDOW_SIZE = 100000;

    // Import shared statistics utilities
    const stats = require("./utils/statistics");
    const { clampInt, clampFloat } = require("./utils/config-validator");
    const { parseSensorValue, parseSensorObject, createSkippedFieldWarner } = require("./utils/sensor-value");
    const groupState = require("./utils/group-state");
    const persistenceHelper = require("./utils/persistence-helper");

    // A z-score / IQR sample is scored against the window as it stood BEFORE
    // the sample arrived, once that window holds this many values (or is
    // full, for smaller windows). Same rule as anomaly-detector.
    const MIN_BASELINE = 10;

    // The streaming accumulator loses precision when the spread of a window is
    // tiny next to its level (catastrophic cancellation). Below this ratio of
    // standard deviation to |mean| the z-score is computed exactly instead.
    const MIN_STREAMING_SPREAD_RATIO = 1e-4;

    // The same cancellation happens over time: after a level shift or a large
    // outlier has left the window, the accumulator still carries rounding error
    // on the scale of the variance it held then. Once the variance has fallen to
    // this fraction of its peak since the last rebuild, rebuild.
    const VARIANCE_COLLAPSE_RATIO = 1e-4;

    // Persist every this many state-changing messages (the manager batches the
    // actual writes on its own timer).
    const PERSIST_EVERY = 10;

    // Cross-correlation searches at most this many lags each way unless the
    // node sets its own maxLag.
    const DEFAULT_MAX_LAG = 256;

    // Complete historical samples needed before a Mahalanobis distance is scored.
    const MIN_MAHALANOBIS_SAMPLES = 10;

    // Paired samples needed before a correlation is reported.
    const MIN_CORRELATION_SAMPLES = 3;

    // Import ml-matrix for robust matrix operations (Mahalanobis distance)
    let Matrix = null;
    try {
        Matrix = require("ml-matrix").Matrix;
    } catch (err) {
        // ml-matrix not available - will use fallback implementation
    }

    function MultiValueProcessorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Configuration
        this.mode = config.mode || "split"; // split, analyze, correlate, aggregate
        this.field = config.field || "payload";

        // Aggregation settings
        this.aggregateMethod = config.aggregateMethod || "mean"; // mean, median, min, max, sum, range, stddev
        this.aggregateOutput = config.aggregateOutput || "single"; // single, all
        this.outputMode = config.outputMode || "sequential"; // sequential, parallel
        this.preserveOriginal = config.preserveOriginal !== false;

        // Anomaly detection settings
        this.anomalyMethod = config.anomalyMethod || "zscore"; // zscore, iqr, threshold, mahalanobis
        this.threshold = clampFloat(config.threshold, 0.1, 1000, 3.0);
        this.warningThreshold = clampFloat(config.warningThreshold, 0.1, 1000, 2.0); // For Mahalanobis warning level
        this.windowSize = clampInt(config.windowSize, 2, MAX_WINDOW_SIZE, 100);
        // Static limits: a blank or unparseable field means "no limit", never NaN
        // (every comparison against NaN is false, which silently disabled the check).
        const optionalLimit = function (raw) {
            if (raw === "" || raw === undefined || raw === null) return null;
            const parsed = parseFloat(raw);
            return Number.isFinite(parsed) ? parsed : null;
        };
        this.minThreshold = optionalLimit(config.minThreshold);
        this.maxThreshold = optionalLimit(config.maxThreshold);

        // Correlation settings
        this.sensor1 = config.sensor1 || "sensor1";
        this.sensor2 = config.sensor2 || "sensor2";
        this.correlationThreshold = clampFloat(config.correlationThreshold, 0, 1, 0.7);
        this.correlationMethod = config.correlationMethod || "pearson";
        // Largest lag (in samples) searched by cross-correlation; 0 = automatic
        // (a quarter of the buffer, at most DEFAULT_MAX_LAG). The search costs
        // O(buffer x lags) per message, so it has to be bounded.
        this.maxLag = clampInt(config.maxLag, 0, 10000, 0);

        // Advanced settings
        this.outputTopic = config.outputTopic || "";
        // Kept off `this.debug`: that name is Node-RED's own logger method, and
        // overwriting it with a boolean breaks every node.debug(...) call.
        this.debugEnabled = config.debug === true;
        this.persistState = config.persistState === true;

        // Per-device grouping: one independent set of buffers per value of a
        // message property (e.g. "topic"). Empty = one shared set (default, legacy).
        this.groupBy = typeof config.groupBy === "string" ? config.groupBy.trim() : "";
        this.maxGroups = clampInt(config.maxGroups, 1, 10000, 50);

        // State: one entry per group, in least-recently-used order.
        const DEFAULT_GROUP = groupState.DEFAULT_GROUP;
        this.groups = new Map();

        // Debug logging helper
        const debugLog = function (message) {
            if (node.debugEnabled && typeof node.debug === "function") {
                node.debug(message);
            }
        };

        // Group key of a message; DEFAULT_GROUP when grouping is off or the
        // message carries no usable value.
        function resolveGroupKey(msg) {
            return groupState.resolveGroupKey(RED, msg, node.groupBy);
        }

        function createGroupState(key) {
            return {
                key: key,
                // Keyed by value name. Prototype-less, so a value called
                // "constructor" or "toString" is just another key.
                dataBuffers: Object.create(null),
                // Streaming mean/variance of each of those buffers (z-score)
                moments: Object.create(null),
                correlationBuffer1: [],
                correlationBuffer2: [],
                mahalanobisBuffer: [],
                // Streaming mean / covariance of mahalanobisBuffer for one set
                // of value names (see covarianceFor); null until first used
                mahalanobisCov: null
            };
        }

        // Fetch (or create) the state for a key. The map is kept in LRU order, so
        // an unbounded key space evicts the least recently used group.
        function getGroupState(key) {
            return groupState.getOrCreateGroup(node.groups, key, {
                create: createGroupState,
                max: node.maxGroups,
                lru: Boolean(node.groupBy),
                onEvict: function (evictedKey) {
                    debugLog(
                        "Evicted least recently used group '" + evictedKey + "' (maxGroups=" + node.maxGroups + ")"
                    );
                }
            });
        }

        // Backwards-compatible read-only view of the default (ungrouped) state.
        ["dataBuffers", "correlationBuffer1", "correlationBuffer2", "mahalanobisBuffer"].forEach(function (prop) {
            Object.defineProperty(node, prop, {
                configurable: true,
                get: function () {
                    const state = node.groups.get(DEFAULT_GROUP);
                    if (state) return state[prop];
                    return prop === "dataBuffers" ? {} : [];
                }
            });
        });

        // --- Per-value sliding window -----------------------------------------
        // `dataBuffers[name]` is the authoritative window: a ring buffer of the
        // last windowSize values (stats.createRingBuffer). `moments[name]`
        // mirrors it in a RunningStats accumulator so the z-score costs O(1) per
        // sample instead of a pass over the whole window. Everything that
        // changes a window goes through pushValue() / resyncMoments() so the two
        // cannot drift apart.

        /** Rebuild the accumulator of one value from its buffer. */
        function resyncMoments(state, valueName) {
            const track = { running: new stats.RunningStats(), removals: 0, peakVariance: 0 };
            const buffer = state.dataBuffers[valueName];
            const n = buffer ? buffer.length : 0;
            for (let i = 0; i < n; i++) {
                track.running.push(buffer.get(i));
            }
            track.peakVariance = track.running.variance();
            state.moments[valueName] = track;
            return track;
        }

        /** The window of one value, created on first use. */
        function windowOf(state, valueName) {
            if (!state.dataBuffers[valueName]) {
                state.dataBuffers[valueName] = stats.createRingBuffer(node.windowSize);
            }
            return state.dataBuffers[valueName];
        }

        /** Append a sample to a value's window, evicting the oldest once full. */
        function pushValue(state, valueName, value) {
            const buffer = windowOf(state, valueName);
            const track = state.moments[valueName] || resyncMoments(state, valueName);

            const evicted = buffer.push(value);
            track.running.push(value);
            let variance = track.running.variance();
            if (variance > track.peakVariance) {
                track.peakVariance = variance;
            }

            if (evicted !== undefined) {
                track.running.remove(evicted);
                track.removals++;
                variance = track.running.variance();
                // The reverse update accumulates rounding error. Rebuilding once
                // per window turnover bounds it at amortised O(1); rebuilding
                // when the variance collapses keeps it small relative to the
                // variance that is left.
                if (track.removals >= node.windowSize || variance < track.peakVariance * VARIANCE_COLLAPSE_RATIO) {
                    resyncMoments(state, valueName);
                }
            }
            return buffer;
        }

        /**
         * Deviation of `value` from the window's mean in units of σ. The window
         * does not contain the sample, so a perfectly flat baseline has σ = 0
         * and any departure from it is an arbitrarily large deviation, not "no
         * deviation" (stats.calculateZScore's convention for a flat window the
         * sample is part of). The floor keeps the result finite; it sits at the
         * rounding resolution of the level, so a real but tiny spread (0.01 at
         * a level of 1e9) still yields the true z-score.
         */
        function sigmaDeviation(value, mean, stdDev) {
            const diff = value - mean;
            if (diff === 0) return 0;
            const floor = Math.max(Math.abs(mean) * 1e-12, 1e-12);
            return diff / Math.max(stdDev, floor);
        }

        /**
         * Z-score of `value` against its window BEFORE the value is pushed.
         * Population standard deviation, read from the accumulator when the
         * window is well conditioned and computed exactly otherwise.
         */
        function windowZScore(state, valueName, value) {
            const track = state.moments[valueName] || resyncMoments(state, valueName);
            let mean = track.running.mean();
            let stdDev = track.running.stdDev();
            if (stdDev <= MIN_STREAMING_SPREAD_RATIO * Math.abs(mean)) {
                const values = state.dataBuffers[valueName].toArray();
                mean = calculateMean(values);
                stdDev = calculateStdDev(values, mean);
            }
            return { zScore: sigmaDeviation(value, mean, stdDev), mean: mean, stdDev: stdDev };
        }

        // --- State persistence ---------------------------------------------------
        let persistence = null;
        let persistCounter = 0;

        // Values of a persisted window: plain numbers (current layout) or the
        // `{timestamp, value}` objects earlier releases stored.
        function finiteSamples(raw) {
            if (!Array.isArray(raw)) return [];
            const values = [];
            raw.forEach(function (d) {
                const v = d !== null && typeof d === "object" ? d.value : d;
                if (typeof v === "number" && Number.isFinite(v)) values.push(v);
            });
            return values;
        }

        function finiteNumbers(raw) {
            return Array.isArray(raw) ? raw.filter(Number.isFinite) : [];
        }

        persistence = persistenceHelper.initializeStatePersistence(node, {
            stateKey: "multiValueProcessorState",
            saveInterval: 30000,
            debug: node.debugEnabled,
            // Blobs written before the manager versioned them (pre-0.4.1) are
            // accepted as they are: onStateLoaded validates every field itself.
            migrate: function (state) {
                return state;
            },
            onStateLoaded: function (saved) {
                if (!saved.groups || typeof saved.groups !== "object") {
                    return;
                }

                let restored = 0;
                Object.keys(saved.groups).forEach(function (key) {
                    const entry = saved.groups[key];
                    if (!entry || typeof entry !== "object") {
                        return;
                    }
                    const target = getGroupState(key);

                    target.dataBuffers = Object.create(null);
                    target.moments = Object.create(null);
                    const buffers = entry.dataBuffers && typeof entry.dataBuffers === "object" ? entry.dataBuffers : {};
                    Object.keys(buffers).forEach(function (valueName) {
                        const samples = finiteSamples(buffers[valueName]).slice(-node.windowSize);
                        if (samples.length > 0) {
                            const buffer = windowOf(target, valueName);
                            samples.forEach(function (v) {
                                buffer.push(v);
                            });
                            resyncMoments(target, valueName);
                            restored += samples.length;
                        }
                    });

                    // The two correlation buffers are only meaningful as pairs
                    const c1 = finiteNumbers(entry.correlationBuffer1);
                    const c2 = finiteNumbers(entry.correlationBuffer2);
                    if (c1.length === c2.length) {
                        target.correlationBuffer1 = c1.slice(-node.windowSize);
                        target.correlationBuffer2 = c2.slice(-node.windowSize);
                        restored += target.correlationBuffer1.length;
                    }

                    const history = Array.isArray(entry.mahalanobisBuffer) ? entry.mahalanobisBuffer : [];
                    target.mahalanobisCov = null; // rebuilt from the buffer on first use
                    target.mahalanobisBuffer = history
                        .filter(function (sample) {
                            return sample && typeof sample === "object";
                        })
                        .slice(-node.windowSize)
                        .map(function (sample) {
                            const copy = Object.create(null);
                            Object.keys(sample).forEach(function (valueName) {
                                if (typeof sample[valueName] === "number" && Number.isFinite(sample[valueName])) {
                                    copy[valueName] = sample[valueName];
                                }
                            });
                            return copy;
                        });
                    restored += target.mahalanobisBuffer.length;
                });

                if (restored > 0) {
                    const scope = node.groupBy ? " in " + node.groups.size + " groups" : "";
                    node.status({
                        fill: "green",
                        shape: "dot",
                        text: node.mode + " - restored (" + restored + " samples" + scope + ")"
                    });
                    debugLog("Restored " + restored + " buffered samples from persistence" + scope);
                }
            },
            getStateToSave: function () {
                // Always the full group map — including an empty one — so a
                // reset is persisted instead of leaving the old buffers on disk.
                const groups = {};
                node.groups.forEach(function (state, key) {
                    const dataBuffers = {};
                    let hasData = state.correlationBuffer1.length > 0 || state.mahalanobisBuffer.length > 0;
                    Object.keys(state.dataBuffers).forEach(function (valueName) {
                        // "__proto__" cannot be a key of the plain object that is stored
                        if (valueName !== "__proto__" && state.dataBuffers[valueName].length > 0) {
                            dataBuffers[valueName] = state.dataBuffers[valueName].toArray();
                            hasData = true;
                        }
                    });
                    if (!hasData) {
                        return;
                    }
                    groups[key] = {
                        dataBuffers: dataBuffers,
                        correlationBuffer1: state.correlationBuffer1,
                        correlationBuffer2: state.correlationBuffer2,
                        mahalanobisBuffer: state.mahalanobisBuffer.map(function (sample) {
                            return Object.assign({}, sample);
                        })
                    };
                });
                return { version: 2, groups: groups };
            }
        });

        // Helper to persist current state
        function persistCurrentState() {
            if (persistence) {
                persistence.saveNow();
            }
        }

        // Prefix status text with the group key so a shared node stays readable
        function groupText(state, text) {
            return node.groupBy && state.key !== DEFAULT_GROUP ? state.key + ": " + text : text;
        }

        // Values are read with the shared strict parser (utils/sensor-value):
        // numbers and purely numeric strings count, everything else — text,
        // "123abc", ISO timestamps, NaN / Infinity, null — is skipped instead
        // of poisoning a window or being monitored as a sensor.
        //
        // A skipped field that earlier releases DID read as a number (a date
        // string became 2024, "123abc" became 123) is reported once per name,
        // so the change in what is monitored does not go unnoticed.
        const warnSkippedFields = createSkippedFieldWarner(node);

        // Initial status
        node.status({ fill: "blue", shape: "ring", text: node.mode + " mode" });

        // Use shared statistics utilities
        const calculateMean = stats.calculateMean;
        const calculateStdDev = stats.calculateStdDev;
        const calculatePearsonCorrelation = stats.calculatePearsonCorrelation;
        const calculateSpearmanCorrelation = stats.calculateSpearmanCorrelation;

        // IQR calculation (returns compatible format)
        function calculateIQR(values) {
            const quartiles = stats.calculateQuartiles(values);
            return {
                q1: quartiles.q1,
                q3: quartiles.q3,
                iqr: quartiles.iqr
            };
        }

        // Cross-Correlation - finds time lag between two signals.
        // Lag k pairs x[i] with y[i + k], so a positive best lag means the
        // pattern shows up in Y k samples AFTER it showed up in X: X leads.
        // The best lag is the one with the largest |r| — a strong negative
        // relationship is as much a relationship as a positive one.
        function calculateCrossCorrelation(x, y, maxLag) {
            const n = Math.min(x.length, y.length);
            maxLag = Math.max(0, Math.min(maxLag === undefined ? Math.floor(n / 4) : maxLag, n - 1));

            const meanX = calculateMean(x.slice(0, n));
            const meanY = calculateMean(y.slice(0, n));

            const stdX = calculateStdDev(x.slice(0, n), meanX);
            const stdY = calculateStdDev(y.slice(0, n), meanY);

            if (stdX === 0 || stdY === 0) {
                return { lag: 0, correlation: 0, correlations: [] };
            }

            const correlations = [];
            let bestCorr = 0;
            let bestLag = 0;
            let bestAbs = -1;

            // Calculate cross-correlation for each lag
            for (let lag = -maxLag; lag <= maxLag; lag++) {
                let sum = 0;
                const from = Math.max(0, -lag);
                const to = Math.min(n, n - lag);
                for (let i = from; i < to; i++) {
                    sum += (x[i] - meanX) * (y[i + lag] - meanY);
                }
                const count = to - from;

                // Each lag is normalised by its own overlap with the full-window
                // moments, which can land marginally outside [-1, 1]; clamp.
                let corr = count > 0 ? sum / (count * stdX * stdY) : 0;
                corr = Math.max(-1, Math.min(1, corr));
                correlations.push({ lag: lag, correlation: corr });

                const abs = Math.abs(corr);
                // On a tie prefer the smaller shift
                if (abs > bestAbs || (abs === bestAbs && Math.abs(lag) < Math.abs(bestLag))) {
                    bestAbs = abs;
                    bestCorr = corr;
                    bestLag = lag;
                }
            }

            return {
                lag: bestLag,
                correlation: bestCorr,
                correlations: correlations,
                interpretation:
                    bestLag === 0
                        ? "Signals are synchronized"
                        : bestLag > 0
                          ? "Signal X leads Signal Y by " + bestLag + " samples"
                          : "Signal Y leads Signal X by " + -bestLag + " samples"
            };
        }

        /**
         * Calculate Mahalanobis distance for multivariate anomaly detection.
         *
         * Mahalanobis distance measures how far a point is from the center
         * of a distribution, accounting for correlations between variables.
         * Uses ml-matrix for numerically stable matrix inversion when available.
         *
         * @param {number[]} sample - Current sample values (one per sensor)
         * @param {number[]} meanVector - Mean values for each dimension
         * @param {number[][]} covMatrix - Covariance matrix (numDimensions x numDimensions)
         * @returns {number|null} Mahalanobis distance, or null if calculation fails
         *
         * @example
         * var distance = calculateMahalanobisDistance(
         *     [25.5, 100.2, 45.0],  // Current sensor readings
         *     [25.0, 100.0, 45.5],  // Historical means
         *     [[1, 0.5, 0], [0.5, 2, 0.3], [0, 0.3, 1]]  // Covariance matrix
         * );
         */
        function calculateMahalanobisDistance(sample, meanVector, covMatrix) {
            const numDimensions = sample.length;

            // STABILITY: Validate inputs
            if (!sample || !meanVector || !covMatrix || numDimensions === 0) {
                debugLog("Mahalanobis: Invalid inputs");
                return null;
            }

            // Calculate difference from mean
            const diffFromMean = [];
            for (let dimIdx = 0; dimIdx < numDimensions; dimIdx++) {
                const diff = sample[dimIdx] - meanVector[dimIdx];
                // STABILITY: Check for NaN/Infinity in difference
                if (!Number.isFinite(diff)) {
                    debugLog("Mahalanobis: Non-finite difference at index " + dimIdx);
                    return null;
                }
                diffFromMean.push(diff);
            }

            // STABILITY: Check covariance matrix for NaN/Infinity
            for (let rowIdx = 0; rowIdx < numDimensions; rowIdx++) {
                for (let colIdx = 0; colIdx < numDimensions; colIdx++) {
                    if (!Number.isFinite(covMatrix[rowIdx][colIdx])) {
                        debugLog("Mahalanobis: Non-finite covariance at [" + rowIdx + "][" + colIdx + "]");
                        return null;
                    }
                }
            }

            // Use ml-matrix for robust matrix inversion if available
            if (Matrix) {
                try {
                    // Create Matrix objects
                    const covMat = new Matrix(covMatrix);
                    const diffVec = Matrix.columnVector(diffFromMean);

                    // STABILITY: Add regularization proportional to variance to avoid singular matrix
                    // Use adaptive regularization based on matrix condition
                    let maxDiagonalValue = 0;
                    for (let idx = 0; idx < numDimensions; idx++) {
                        maxDiagonalValue = Math.max(maxDiagonalValue, Math.abs(covMat.get(idx, idx)));
                    }
                    const regularization = Math.max(1e-6, maxDiagonalValue * 1e-6);
                    for (let idx = 0; idx < numDimensions; idx++) {
                        covMat.set(idx, idx, covMat.get(idx, idx) + regularization);
                    }

                    // STABILITY: Always use pseudoInverse for robustness
                    const inverseCov = covMat.pseudoInverse();

                    // Calculate (x-μ)' * Σ^-1 * (x-μ)
                    const tempResult = inverseCov.mmul(diffVec);
                    const squaredDistance = diffVec.transpose().mmul(tempResult).get(0, 0);

                    // STABILITY: Ensure non-negative result
                    if (!Number.isFinite(squaredDistance) || squaredDistance < 0) {
                        debugLog("Mahalanobis: Invalid squared distance: " + squaredDistance);
                        return null;
                    }

                    return Math.sqrt(squaredDistance);
                } catch (err) {
                    // Fall back to manual implementation
                    debugLog("ml-matrix failed, using fallback: " + err.message);
                }
            }

            // Fallback: Manual implementation with improved stability
            const inverseCov = invertMatrixFallback(covMatrix);
            if (!inverseCov) return null;

            // Calculate (x-μ)' * Σ^-1 * (x-μ)
            const tempVector = [];
            for (let rowIdx = 0; rowIdx < numDimensions; rowIdx++) {
                let rowSum = 0;
                for (let colIdx = 0; colIdx < numDimensions; colIdx++) {
                    rowSum += diffFromMean[colIdx] * inverseCov[colIdx][rowIdx];
                }
                tempVector.push(rowSum);
            }

            let squaredDistance = 0;
            for (let idx = 0; idx < numDimensions; idx++) {
                squaredDistance += tempVector[idx] * diffFromMean[idx];
            }

            // STABILITY: Ensure non-negative and finite result
            if (!Number.isFinite(squaredDistance) || squaredDistance < 0) {
                debugLog("Mahalanobis fallback: Invalid squared distance: " + squaredDistance);
                return null;
            }

            return Math.sqrt(squaredDistance);
        }

        // Fallback matrix inversion using Gauss-Jordan (for when ml-matrix is not available)
        function invertMatrixFallback(matrix) {
            const n = matrix.length;

            // Create augmented matrix [A|I]
            const aug = [];
            for (let i = 0; i < n; i++) {
                aug.push([]);
                for (let j = 0; j < n; j++) {
                    aug[i].push(matrix[i][j]);
                }
                for (let j = 0; j < n; j++) {
                    aug[i].push(i === j ? 1 : 0);
                }
            }

            // Gauss-Jordan elimination with partial pivoting
            for (let col = 0; col < n; col++) {
                // Find pivot
                let maxRow = col;
                for (let row = col + 1; row < n; row++) {
                    if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) {
                        maxRow = row;
                    }
                }

                // Swap rows
                const temp = aug[col];
                aug[col] = aug[maxRow];
                aug[maxRow] = temp;

                // Check for singular matrix
                if (Math.abs(aug[col][col]) < 1e-10) {
                    // Add regularization
                    aug[col][col] += 1e-6;
                }

                // Scale pivot row
                const scale = aug[col][col];
                for (let j = 0; j < 2 * n; j++) {
                    aug[col][j] /= scale;
                }

                // Eliminate column
                for (let row = 0; row < n; row++) {
                    if (row !== col) {
                        const factor = aug[row][col];
                        for (let j = 0; j < 2 * n; j++) {
                            aug[row][j] -= factor * aug[col][j];
                        }
                    }
                }
            }

            // Extract inverse matrix
            const inv = [];
            for (let i = 0; i < n; i++) {
                inv.push([]);
                for (let j = 0; j < n; j++) {
                    inv[i].push(aug[i][n + j]);
                }
            }

            return inv;
        }

        // Calculate mean vector and (sample) covariance matrix from buffered
        // samples. Only COMPLETE samples — a finite value for every requested
        // name — are used: filling per-sensor columns independently would pair
        // values from different time steps as soon as one sensor skips a beat.
        function calculateCovarianceMatrix(dataBuffer, valueNames) {
            const n = valueNames.length;

            const rows = [];
            dataBuffer.forEach(function (sample) {
                const row = new Array(n);
                for (let i = 0; i < n; i++) {
                    const v = sample[valueNames[i]];
                    if (typeof v !== "number" || !Number.isFinite(v)) {
                        return;
                    }
                    row[i] = v;
                }
                rows.push(row);
            });

            const m = rows.length;
            if (m < 2) return null;

            // Calculate means
            const means = new Array(n).fill(0);
            rows.forEach(function (row) {
                for (let i = 0; i < n; i++) {
                    means[i] += row[i];
                }
            });
            for (let i = 0; i < n; i++) {
                means[i] /= m;
            }

            // Calculate covariance matrix (symmetric: fill the upper triangle, mirror)
            const cov = [];
            for (let i = 0; i < n; i++) {
                cov.push(new Array(n).fill(0));
            }
            rows.forEach(function (row) {
                for (let i = 0; i < n; i++) {
                    const di = row[i] - means[i];
                    for (let j = i; j < n; j++) {
                        cov[i][j] += di * (row[j] - means[j]);
                    }
                }
            });
            for (let i = 0; i < n; i++) {
                for (let j = i; j < n; j++) {
                    cov[i][j] /= m - 1;
                    cov[j][i] = cov[i][j];
                }
            }

            return { means: means, covariance: cov, count: m };
        }

        // --- Streaming covariance for the Mahalanobis path ---------------------
        // The covariance used to be recomputed from the whole history on every
        // message (O(n·p²)). `state.mahalanobisCov` keeps a RunningCovariance of
        // the COMPLETE rows of mahalanobisBuffer for one tuple of value names:
        // rows join it as they are buffered and leave it as they are evicted,
        // O(p²) per message. It is rebuilt from the buffer when the names
        // change, once per window turnover, when a variance collapses, after a
        // restore (null) and after a reset (the state is gone).

        // The row of `sample` for `valueNames`, or null when a value is missing
        function rowFor(sample, valueNames) {
            const row = new Array(valueNames.length);
            for (let i = 0; i < valueNames.length; i++) {
                const v = sample[valueNames[i]];
                if (typeof v !== "number" || !Number.isFinite(v)) return null;
                row[i] = v;
            }
            return row;
        }

        function notePeakVariances(acc) {
            for (let i = 0; i < acc.names.length; i++) {
                const v = acc.running.variance(i);
                if (v > acc.peakVariances[i]) acc.peakVariances[i] = v;
            }
        }

        function varianceCollapsed(acc) {
            for (let i = 0; i < acc.names.length; i++) {
                if (acc.running.variance(i) < acc.peakVariances[i] * VARIANCE_COLLAPSE_RATIO) return true;
            }
            return false;
        }

        function rebuildCovariance(state, valueNames) {
            const acc = {
                key: valueNames.join("\u0001"),
                names: valueNames.slice(),
                running: new stats.RunningCovariance(valueNames.length),
                removals: 0,
                peakVariances: new Float64Array(valueNames.length)
            };
            state.mahalanobisBuffer.forEach(function (sample) {
                const row = rowFor(sample, valueNames);
                if (row) acc.running.push(row);
            });
            notePeakVariances(acc);
            state.mahalanobisCov = acc;
            return acc;
        }

        // Mean vector and sample covariance of the complete rows for valueNames;
        // exact to rounding against calculateCovarianceMatrix on the same buffer.
        function covarianceFor(state, valueNames) {
            let acc = state.mahalanobisCov;
            if (!acc || acc.key !== valueNames.join("\u0001")) {
                acc = rebuildCovariance(state, valueNames);
            }
            const m = acc.running.count();
            if (m < 2) return null;

            // A spread tiny next to the level cancels catastrophically in the
            // accumulator: compute exactly then, as the z-score path does.
            const means = acc.running.means();
            for (let i = 0; i < valueNames.length; i++) {
                if (Math.sqrt(acc.running.variance(i)) <= MIN_STREAMING_SPREAD_RATIO * Math.abs(means[i])) {
                    return calculateCovarianceMatrix(state.mahalanobisBuffer, valueNames);
                }
            }
            return { means: means, covariance: acc.running.covariance(), count: m };
        }

        /** Append a sample to the Mahalanobis history, evicting the oldest once full. */
        function pushMahalanobisSample(state, sampleObj) {
            state.mahalanobisBuffer.push(sampleObj);
            const acc = state.mahalanobisCov;
            if (acc) {
                const row = rowFor(sampleObj, acc.names);
                if (row) {
                    acc.running.push(row);
                    notePeakVariances(acc);
                }
            }

            if (state.mahalanobisBuffer.length > node.windowSize) {
                const evicted = state.mahalanobisBuffer.shift();
                const row = acc ? rowFor(evicted, acc.names) : null;
                if (row) {
                    acc.running.remove(row);
                    acc.removals++;
                    // Same bound on the reverse update's rounding error as the
                    // per-value moments (see pushValue)
                    if (acc.removals >= node.windowSize || varianceCollapsed(acc)) {
                        rebuildCovariance(state, acc.names);
                    }
                }
            }
        }

        // Use shared median calculation
        const calculateMedian = stats.calculateMedian;

        // Aggregate mode - reduces multiple values to a single value
        function processAggregate(msg) {
            let values = [];
            let valueNames = [];

            if (Array.isArray(msg.payload)) {
                values = msg.payload.filter((v) => typeof v === "number" && Number.isFinite(v));
                valueNames = msg.valueNames || values.map((v, i) => "value" + i);
            } else if (typeof msg.payload === "object" && msg.payload !== null) {
                const parsed = parseSensorObject(msg.payload);
                values = parsed.values;
                valueNames = parsed.names;
                warnSkippedFields(msg.payload, parsed.skipped);
            } else {
                node.error("Payload must be an array or object for aggregation", msg);
                return null;
            }

            if (values.length === 0) {
                node.error("No valid values found for aggregation", msg);
                return null;
            }

            let primaryValue;

            // Calculate aggregations
            // min/max in a loop: Math.min.apply() overflows the stack on large arrays
            let sum = 0;
            let min = values[0];
            let max = values[0];
            for (let i = 0; i < values.length; i++) {
                sum += values[i];
                if (values[i] < min) min = values[i];
                if (values[i] > max) max = values[i];
            }
            const mean = sum / values.length;
            const range = max - min;
            const median = calculateMedian(values);
            const stdDev = calculateStdDev(values, mean);

            // Select primary value based on method
            switch (node.aggregateMethod) {
                case "mean":
                    primaryValue = mean;
                    break;
                case "median":
                    primaryValue = median;
                    break;
                case "min":
                    primaryValue = min;
                    break;
                case "max":
                    primaryValue = max;
                    break;
                case "sum":
                    primaryValue = sum;
                    break;
                case "range":
                    primaryValue = range;
                    break;
                case "stddev":
                    primaryValue = stdDev;
                    break;
                default:
                    primaryValue = mean;
            }

            const outputMsg = node.preserveOriginal ? RED.util.cloneMessage(msg) : {};
            outputMsg.payload = primaryValue;
            outputMsg.aggregation = {
                method: node.aggregateMethod,
                value: primaryValue,
                count: values.length,
                all: {
                    mean: mean,
                    median: median,
                    min: min,
                    max: max,
                    sum: sum,
                    range: range,
                    stdDev: stdDev
                }
            };

            if (node.aggregateOutput === "all") {
                outputMsg.originalValues = values;
                outputMsg.valueNames = valueNames;
            }

            if (node.outputTopic) {
                outputMsg.topic = node.outputTopic;
            }

            debugLog(
                "Aggregation: " + node.aggregateMethod + " = " + primaryValue.toFixed(4) + " (n=" + values.length + ")"
            );

            node.status({
                fill: "green",
                shape: "dot",
                text: node.aggregateMethod + ": " + primaryValue.toFixed(2) + " (n=" + values.length + ")"
            });

            return { normal: outputMsg, anomaly: null };
        }

        // Split mode
        function processSplit(msg, send) {
            const sourceField = node.field === "payload" ? msg.payload : RED.util.getMessageProperty(msg, node.field);

            if (sourceField === undefined || sourceField === null) {
                node.error("Field '" + node.field + "' not found", msg);
                return null;
            }

            let values = [];
            let valueNames = [];

            if (Array.isArray(sourceField)) {
                // Array elements are split out as they are, whatever their type
                values = sourceField;
                valueNames = values.map((v, i) => "value" + i);
            } else if (typeof sourceField === "object" && sourceField !== null) {
                const parsed = parseSensorObject(sourceField);
                values = parsed.values;
                valueNames = parsed.names;
                warnSkippedFields(sourceField, parsed.skipped);
            } else {
                const val = parseSensorValue(sourceField);
                if (val !== null) {
                    values = [val];
                    valueNames = ["value"];
                }
            }

            if (values.length === 0) {
                node.error("No valid numeric values found", msg);
                return null;
            }

            if (node.outputMode === "sequential") {
                // Clone the inbound message ONCE, without the payload that is
                // replaced anyway, and give every element a shallow copy of that
                // base. Deep-cloning the whole message per element made a
                // 5000-element split cost 5000 copies of a 5000-element array.
                let base = {};
                if (node.preserveOriginal) {
                    const rest = Object.assign({}, msg);
                    delete rest.payload;
                    base = RED.util.cloneMessage(rest);
                }
                if (node.outputTopic) {
                    base.topic = node.outputTopic;
                }
                const total = values.length;
                values.forEach((value, index) => {
                    const newMsg = Object.assign({}, base, {
                        payload: value,
                        valueIndex: index,
                        valueName: valueNames[index],
                        totalValues: total
                    });
                    send([newMsg, null]);
                });
                return null;
            } else {
                const outputMsg = node.preserveOriginal ? RED.util.cloneMessage(msg) : {};
                outputMsg.payload = values;
                outputMsg.valueNames = valueNames;
                outputMsg.valueCount = values.length;
                if (node.outputTopic) {
                    outputMsg.topic = node.outputTopic;
                }
                return { normal: outputMsg, anomaly: null };
            }
        }

        // Analyze mode
        function processAnalyze(msg, state) {
            let values = [];
            let valueNames = [];
            let skippedValues = [];

            // Entries that are not sensor values (NaN, Infinity, null, text,
            // timestamps) are left out and reported in msg.skippedValues. One
            // NaN in a buffer would otherwise turn every statistic of that
            // buffer into NaN for a whole window.
            if (Array.isArray(msg.payload)) {
                const givenNames = Array.isArray(msg.valueNames) ? msg.valueNames : [];
                msg.payload.forEach((raw, i) => {
                    const name =
                        typeof givenNames[i] === "string" && givenNames[i] !== "" ? givenNames[i] : "value" + i;
                    const val = parseSensorValue(raw);
                    if (val === null) {
                        skippedValues.push(name);
                    } else {
                        valueNames.push(name);
                        values.push(val);
                    }
                });
            } else if (typeof msg.payload === "object" && msg.payload !== null) {
                const parsed = parseSensorObject(msg.payload);
                values = parsed.values;
                valueNames = parsed.names;
                skippedValues = parsed.skipped;
                warnSkippedFields(msg.payload, skippedValues);
            } else {
                node.error("Payload must be an array or object", msg);
                return null;
            }

            if (values.length === 0) {
                node.error("No valid values found", msg);
                return null;
            }

            const results = [];
            let hasAnomaly = false;

            // z-score / IQR score a sample against the window as it stood BEFORE
            // the sample joined it. A sample that is part of its own baseline
            // inflates the spread, which caps |z| at sqrt(n − 1): with a short
            // window an outlier could never reach the threshold. The first sample
            // scored is the one that completes a baseline of
            // min(windowSize, MIN_BASELINE) values; until then samples are
            // buffered unscored and reported as warm-up. IQR needs 4 values, the
            // z-score 2, in any case.
            const minRequired = Math.max(
                node.anomalyMethod === "iqr" ? 4 : 2,
                Math.min(node.windowSize, MIN_BASELINE) - 1
            );

            values.forEach((value, index) => {
                const valueName = valueNames[index];
                const buffer = state.dataBuffers[valueName];
                const history = buffer ? buffer.length : 0;

                let isAnomaly = false;
                const analysis = {
                    valueName: valueName,
                    value: value,
                    isAnomaly: false
                };

                if (node.anomalyMethod === "threshold") {
                    // Static limits need no history: checked from the first sample on
                    if (node.minThreshold !== null && value < node.minThreshold) {
                        isAnomaly = true;
                        analysis.reason = "Below minimum";
                    }
                    if (node.maxThreshold !== null && value > node.maxThreshold) {
                        isAnomaly = true;
                        analysis.reason = analysis.reason ? analysis.reason + " and above maximum" : "Above maximum";
                    }
                } else if (node.anomalyMethod === "zscore" || node.anomalyMethod === "iqr") {
                    if (history < minRequired) {
                        analysis.severity = "warmup";
                        analysis.bufferSize = history;
                        analysis.minRequired = minRequired;
                    } else if (node.anomalyMethod === "zscore") {
                        const zResult = windowZScore(state, valueName, value);
                        analysis.zScore = zResult.zScore;
                        analysis.mean = zResult.mean;
                        analysis.stdDev = zResult.stdDev;
                        isAnomaly = Math.abs(zResult.zScore) > node.threshold;
                    } else {
                        const iqr = calculateIQR(buffer.toArray());
                        const lowerBound = iqr.q1 - 1.5 * iqr.iqr;
                        const upperBound = iqr.q3 + 1.5 * iqr.iqr;
                        analysis.q1 = iqr.q1;
                        analysis.q3 = iqr.q3;
                        analysis.iqr = iqr.iqr;
                        isAnomaly = value < lowerBound || value > upperBound;
                    }
                }

                // Mahalanobis distance is calculated at the sample level (after loop)
                if (node.anomalyMethod === "mahalanobis") {
                    analysis.mahalanobisDeferred = true; // Will be calculated below
                }

                // Scored: now the sample joins the window
                pushValue(state, valueName, value);

                analysis.isAnomaly = isAnomaly;
                if (isAnomaly) hasAnomaly = true;
                results.push(analysis);
            });

            // Handle Mahalanobis distance (multivariate)
            if (node.anomalyMethod === "mahalanobis") {
                // Score against the history BEFORE this sample joins it. A sample
                // that is part of its own covariance estimate can never be further
                // than (n-1)/sqrt(n) from the mean, however extreme it is — with a
                // short window that bound sits below the alarm limit.
                const covResult =
                    state.mahalanobisBuffer.length >= MIN_MAHALANOBIS_SAMPLES ? covarianceFor(state, valueNames) : null;

                // Limits for the squared distance of a new sample against a mean
                // and covariance estimated from `count` samples (scaled F; tends
                // to chi-squared with one degree of freedom per sensor as the
                // window grows). `threshold` / `warningThreshold` are sigma-like
                // one-sided normal quantiles, so a given setting means the same
                // false-alarm rate for 2 sensors as for 20, and for a short
                // window as for a long one. No finite limit = too few samples
                // for this many sensors: nothing is scored yet.
                const limitSquared = covResult
                    ? stats.hotellingLimitFromZ(values.length, covResult.count, node.threshold)
                    : Infinity;

                if (!covResult || covResult.count < MIN_MAHALANOBIS_SAMPLES || !Number.isFinite(limitSquared)) {
                    // Too little complete history for this many sensors: warm-up
                    const minSamples = Math.max(MIN_MAHALANOBIS_SAMPLES, values.length + 1);
                    results.forEach(function (r) {
                        r.severity = "warmup";
                        r.bufferSize = covResult ? covResult.count : state.mahalanobisBuffer.length;
                        r.minRequired = minSamples;
                    });
                } else {
                    // Calculate Mahalanobis distance for current sample
                    const distance = calculateMahalanobisDistance(values, covResult.means, covResult.covariance);

                    if (distance !== null) {
                        const chiThreshold = Math.sqrt(limitSquared);
                        const chiWarningThreshold = Math.sqrt(
                            stats.hotellingLimitFromZ(values.length, covResult.count, node.warningThreshold)
                        );

                        let severity = "normal";
                        if (distance > chiThreshold) {
                            severity = "critical";
                            hasAnomaly = true;
                        } else if (distance > chiWarningThreshold) {
                            severity = "warning";
                            hasAnomaly = true;
                        }

                        // Add to all results
                        results.forEach(function (r) {
                            r.mahalanobisDistance = distance;
                            r.mahalanobisThreshold = chiThreshold;
                            r.mahalanobisWarningThreshold = chiWarningThreshold;
                            r.severity = severity;
                            r.isAnomaly = hasAnomaly;
                        });

                        debugLog(
                            "Mahalanobis: d=" +
                                distance.toFixed(4) +
                                ", severity=" +
                                severity +
                                ", threshold=" +
                                chiThreshold.toFixed(4) +
                                ", anomaly=" +
                                hasAnomaly
                        );
                    }
                }

                const sampleObj = Object.create(null);
                values.forEach(function (val, idx) {
                    sampleObj[valueNames[idx]] = val;
                });
                pushMahalanobisSample(state, sampleObj);
            }

            const outputMsg = RED.util.cloneMessage(msg);
            outputMsg.payload = results;
            outputMsg.hasAnomaly = hasAnomaly;
            outputMsg.anomalyCount = results.filter((r) => r.isAnomaly).length;
            outputMsg.method = "multi-" + node.anomalyMethod;
            if (skippedValues.length > 0) {
                outputMsg.skippedValues = skippedValues;
            }
            if (node.outputTopic) {
                outputMsg.topic = node.outputTopic;
            }

            const warming = results.filter((r) => r.severity === "warmup");
            if (warming.length === results.length) {
                node.status({
                    fill: "yellow",
                    shape: "ring",
                    text: groupText(state, "warm-up " + warming[0].bufferSize + "/" + warming[0].minRequired)
                });
            } else {
                node.status({
                    fill: hasAnomaly ? "red" : "green",
                    shape: "dot",
                    text: groupText(
                        state,
                        hasAnomaly
                            ? outputMsg.anomalyCount + "/" + results.length + " anomalous"
                            : results.length + " values ok"
                    )
                });
            }

            return { normal: hasAnomaly ? null : outputMsg, anomaly: hasAnomaly ? outputMsg : null };
        }

        // True when every value of a (non-empty) series is the same
        function isConstant(series) {
            for (let i = 1; i < series.length; i++) {
                if (series[i] !== series[0]) return false;
            }
            return true;
        }

        // Correlate mode
        function processCorrelate(msg, state) {
            if (typeof msg.payload !== "object" || msg.payload === null) {
                node.warn("Payload must be an object with sensor values");
                return null;
            }

            const value1 = parseSensorValue(msg.payload[node.sensor1]);
            const value2 = parseSensorValue(msg.payload[node.sensor2]);

            if (value1 === null || value2 === null) {
                node.warn("Missing or invalid sensor values: " + node.sensor1 + ", " + node.sensor2);
                return null;
            }

            state.correlationBuffer1.push(value1);
            state.correlationBuffer2.push(value2);

            if (state.correlationBuffer1.length > node.windowSize) {
                state.correlationBuffer1.shift();
                state.correlationBuffer2.shift();
            }

            const bufferSize = state.correlationBuffer1.length;
            if (bufferSize < MIN_CORRELATION_SAMPLES) {
                // Warm-up: a result object rather than silence, so a downstream
                // check of msg.isAnomalous sees every message.
                const warmupMsg = {
                    payload: msg.payload,
                    correlation: null,
                    isAnomalous: false,
                    severity: "warmup",
                    bufferSize: bufferSize,
                    minRequired: MIN_CORRELATION_SAMPLES,
                    sensor1: node.sensor1,
                    sensor2: node.sensor2,
                    method: node.correlationMethod,
                    stats: {
                        sensor1Mean: calculateMean(state.correlationBuffer1),
                        sensor2Mean: calculateMean(state.correlationBuffer2),
                        bufferSize: bufferSize
                    }
                };
                if (node.outputTopic) {
                    warmupMsg.topic = node.outputTopic;
                }
                copyPassthrough(warmupMsg, msg);
                node.status({
                    fill: "yellow",
                    shape: "ring",
                    text: groupText(state, "Buffering: " + bufferSize + "/" + node.windowSize)
                });
                return { normal: warmupMsg, anomaly: null };
            }

            // Correlation with a series that never moved is undefined (0/0), not
            // "no correlation": report it as such instead of raising an alarm
            // every time a machine is switched off or a sensor holds its value.
            const constantSensors = [];
            if (isConstant(state.correlationBuffer1)) constantSensors.push(node.sensor1);
            if (isConstant(state.correlationBuffer2)) constantSensors.push(node.sensor2);
            if (constantSensors.length > 0) {
                const undefinedMsg = {
                    payload: msg.payload,
                    correlation: null,
                    isAnomalous: false,
                    reason: "zero variance: " + constantSensors.join(" and ") + " constant over the window",
                    sensor1: node.sensor1,
                    sensor2: node.sensor2,
                    method: node.correlationMethod,
                    stats: {
                        sensor1Mean: calculateMean(state.correlationBuffer1),
                        sensor2Mean: calculateMean(state.correlationBuffer2),
                        bufferSize: state.correlationBuffer1.length
                    }
                };
                if (node.outputTopic) {
                    undefinedMsg.topic = node.outputTopic;
                }
                copyPassthrough(undefinedMsg, msg);
                node.status({ fill: "grey", shape: "ring", text: groupText(state, "ρ undefined (constant input)") });
                return { normal: undefinedMsg, anomaly: null };
            }

            let correlation = null;
            let crossCorr = null;

            if (node.correlationMethod === "pearson") {
                correlation = calculatePearsonCorrelation(state.correlationBuffer1, state.correlationBuffer2);
            } else if (node.correlationMethod === "spearman") {
                correlation = calculateSpearmanCorrelation(state.correlationBuffer1, state.correlationBuffer2);
            } else if (node.correlationMethod === "cross") {
                // Cross-correlation with time lag detection
                const autoLag = Math.min(Math.floor(state.correlationBuffer1.length / 4), DEFAULT_MAX_LAG);
                const maxLag = node.maxLag > 0 ? node.maxLag : autoLag;
                crossCorr = calculateCrossCorrelation(state.correlationBuffer1, state.correlationBuffer2, maxLag);
                correlation = crossCorr.correlation;
            }

            // Guard against an unknown/invalid correlationMethod (correlation stays
            // null) or a non-finite result, which would crash on .toFixed() below.
            if (correlation === null || !Number.isFinite(correlation)) {
                throw new Error("Correlation could not be computed (method: " + node.correlationMethod + ")");
            }

            const isAnomalous = Math.abs(correlation) < node.correlationThreshold;

            const outputMsg = {
                payload: msg.payload,
                correlation: correlation,
                isAnomalous: isAnomalous,
                sensor1: node.sensor1,
                sensor2: node.sensor2,
                method: node.correlationMethod,
                stats: {
                    sensor1Mean: calculateMean(state.correlationBuffer1),
                    sensor2Mean: calculateMean(state.correlationBuffer2),
                    bufferSize: state.correlationBuffer1.length
                }
            };

            // Add cross-correlation specific output
            if (crossCorr) {
                outputMsg.crossCorrelation = {
                    bestLag: crossCorr.lag,
                    maxCorrelation: crossCorr.correlation,
                    interpretation: crossCorr.interpretation,
                    allLags: crossCorr.correlations
                };
            }

            if (node.outputTopic) {
                outputMsg.topic = node.outputTopic;
            }
            copyPassthrough(outputMsg, msg);

            const statusColor = isAnomalous ? "red" : "green";
            node.status({ fill: statusColor, shape: "dot", text: groupText(state, "ρ=" + correlation.toFixed(3)) });

            return { normal: isAnomalous ? null : outputMsg, anomaly: isAnomalous ? outputMsg : null };
        }

        node.on("input", function (msg, send, done) {
            // Node-RED >=1.0 passes send/done; shim for older runtimes.
            send =
                send ||
                function () {
                    node.send.apply(node, arguments);
                };
            done =
                done ||
                function (err) {
                    if (err) node.error(err, msg);
                };
            try {
                // Reset command: the message's own group when grouping is on and
                // the message names one, everything otherwise.
                if (msg.reset === true) {
                    const resetKey = resolveGroupKey(msg);
                    if (node.groupBy && resetKey !== DEFAULT_GROUP) {
                        node.groups.delete(resetKey);
                    } else {
                        node.groups.clear();
                    }
                    persistCurrentState();
                    node.status({ fill: "blue", shape: "ring", text: node.mode + " - reset" });
                    done();
                    return;
                }

                let result = null;
                let state = null;

                switch (node.mode) {
                    case "analyze":
                        state = getGroupState(resolveGroupKey(msg));
                        result = processAnalyze(msg, state);
                        break;
                    case "correlate":
                        state = getGroupState(resolveGroupKey(msg));
                        result = processCorrelate(msg, state);
                        break;
                    case "aggregate":
                        result = processAggregate(msg);
                        break;
                    case "split":
                    default:
                        result = processSplit(msg, send);
                }

                // Only analyze / correlate keep state worth persisting
                if (persistence && state) {
                    persistCounter++;
                    if (persistCounter % PERSIST_EVERY === 0) {
                        persistCurrentState();
                    }
                }

                if (result) {
                    const outputMsg = result.anomaly || result.normal;
                    if (outputMsg && state && node.groupBy) {
                        outputMsg.group = state.key;
                    }
                    if (result.anomaly) {
                        send([null, result.anomaly]);
                    } else if (result.normal) {
                        send([result.normal, null]);
                    }
                }
                done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "error" });
                done("Error in multi-value processing: " + err.message);
            }
        });

        node.on("close", async function (done) {
            // Save state before closing if persistence enabled
            if (persistence) {
                await persistence.close();
            }

            node.groups.clear();
            node.status({});

            if (done) done();
        });
    }

    RED.nodes.registerType("multi-value-processor", MultiValueProcessorNode);
};
