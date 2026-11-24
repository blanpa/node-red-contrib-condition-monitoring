module.exports = function (RED) {
    "use strict";
    const { copyPassthrough } = require("./utils/message");

    // Upper bound for the sliding window. Every sample touches the live window,
    // so the ceiling is a usability guard, not a formality — the old 1_000_000
    // let a single message cost a million-element pass.
    const MAX_WINDOW_SIZE = 100000;

    // Import state persistence helper
    const persistenceHelper = require("./utils/persistence-helper");
    const { clampInt, clampFloat } = require("./utils/config-validator");
    // zScoreForConfidence: confidence level -> two-sided z
    const vibration = require("./utils/vibration");
    // Per-group state: key resolution and the field swapper
    const groupState = require("./utils/group-state");

    function TrendPredictorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Configuration
        this.mode = config.mode || "prediction"; // prediction, rate-of-change, rul
        this.method = config.method || "linear"; // linear, exponential
        this.predictionSteps = clampInt(config.predictionSteps, 1, 100000, 10);
        this.windowSize = clampInt(config.windowSize, 2, MAX_WINDOW_SIZE, 50);
        this.threshold =
            config.threshold !== "" && config.threshold !== undefined ? parseFloat(config.threshold) : null;

        // Rate of change settings
        this.rocMethod = config.rocMethod || "absolute"; // absolute, percentage
        this.timeWindow = clampInt(config.timeWindow, 1, 1000000, 1);
        this.rocThreshold =
            config.rocThreshold !== "" && config.rocThreshold !== undefined ? parseFloat(config.rocThreshold) : null;

        // RUL settings
        this.failureThreshold =
            config.failureThreshold !== "" && config.failureThreshold !== undefined
                ? parseFloat(config.failureThreshold)
                : null;
        this.warningThreshold =
            config.warningThreshold !== "" && config.warningThreshold !== undefined
                ? parseFloat(config.warningThreshold)
                : null;
        // Which way the indicator moves towards failure: "rising" (vibration,
        // temperature — the default and the historical behaviour) or "falling"
        // (pressure, efficiency, a 100 → 0 health index).
        this.failureDirection = config.failureDirection === "falling" ? "falling" : "rising";
        this.rulUnit = config.rulUnit || "hours"; // hours, minutes, days, cycles
        this.degradationModel = config.degradationModel || "linear"; // linear, exponential, weibull
        this.confidenceLevel = clampFloat(config.confidenceLevel, 0.5, 0.9999, 0.95);

        // Weibull settings
        this.weibullBeta = clampFloat(config.weibullBeta, 0.01, 100, 2.0); // Shape parameter (β)
        this.weibullEta = clampFloat(config.weibullEta, 0.001, 1e9, 1000); // Scale parameter (η) in hours

        // Upper bound for distinct sensor names in multi-sensor (object payload) mode.
        const MAX_SENSORS = 1000;

        // Advanced settings
        this.outputTopic = config.outputTopic || "";
        // Kept off `this.debug`: that name is Node-RED's own logger method, and
        // overwriting it with a boolean breaks every node.debug(...) call —
        // including the one state persistence makes while restoring.
        this.debugEnabled = config.debug === true;
        this.persistState = config.persistState === true;

        // Per-device grouping: one independent state (buffers, rate-of-change
        // history, per-sensor buffers) per value of a message property such as
        // "topic". Empty = one shared state (default, legacy).
        this.groupBy = typeof config.groupBy === "string" ? config.groupBy.trim() : "";
        this.maxGroups = clampInt(config.maxGroups, 1, 10000, 50);

        // State
        this.buffer = [];
        // Monotonic sample counter driving the persistence throttle. It must NOT
        // be derived from the buffer length: the buffer is capped, so once it
        // saturates `length % N` is a constant — the throttle then fires on
        // every sample or on none, depending on the configured window size.
        this.sampleCount = 0;

        // Debug logging helper
        const debugLog = function (message) {
            if (node.debugEnabled && typeof node.debug === "function") {
                node.debug(message);
            }
        };

        // Warn once per kind of problem (clock step, seconds timestamps), not
        // once per message — the stream keeps flowing while the user reads it.
        const warnedKeys = new Set();
        function warnOnce(key, text) {
            if (!warnedKeys.has(key) && warnedKeys.size < 50) {
                warnedKeys.add(key);
                node.warn(text);
            }
        }
        this.timestamps = [];
        this.previousValue = null;
        this.previousTimestamp = null;
        this.rocHistory = [];

        // ---- Groups ----
        // The state lives as plain fields on the node (every mode reads them
        // directly); a message for another group swaps those fields wholesale.
        // Parked groups sit in `node.groups`, least recently used first.
        const GROUP_FIELDS = [
            "buffer",
            "timestamps",
            "previousValue",
            "previousTimestamp",
            "rocHistory",
            "sensorBuffers",
            "sensorTimestamps",
            "sensorPrevious"
        ];
        function freshGroupState() {
            return {
                buffer: [],
                timestamps: [],
                previousValue: null,
                previousTimestamp: null,
                rocHistory: [],
                // (prototype-less: sensor names come straight from the payload,
                // and a sensor called "constructor" must not resolve to an
                // inherited member)
                sensorBuffers: Object.create(null),
                sensorTimestamps: Object.create(null),
                sensorPrevious: Object.create(null)
            };
        }
        this.groups = new Map();
        this.activeGroup = groupState.DEFAULT_GROUP;
        const swapper = groupState.createStateSwapper(node, {
            fields: GROUP_FIELDS,
            fresh: freshGroupState,
            parked: node.groups,
            isEmpty: function () {
                return (
                    node.buffer.length === 0 &&
                    node.previousValue === null &&
                    Object.keys(node.sensorBuffers).length === 0
                );
            },
            max: function () {
                return node.maxGroups;
            }
        });
        function switchGroup(msg) {
            const key = groupState.resolveGroupKey(RED, msg, node.groupBy);
            swapper.switchTo(key);
            node.activeGroup = key;
        }

        // What of one group survives a restart
        const PERSISTED_FIELDS = ["buffer", "timestamps", "previousValue", "previousTimestamp", "rocHistory"];
        function restoreInto(target, saved) {
            target.buffer = saved.buffer;
            target.timestamps = Array.isArray(saved.timestamps) ? saved.timestamps : [];
            target.previousValue = saved.previousValue !== undefined ? saved.previousValue : null;
            target.previousTimestamp = saved.previousTimestamp !== undefined ? saved.previousTimestamp : null;
            target.rocHistory = Array.isArray(saved.rocHistory) ? saved.rocHistory : [];
        }

        // Initialize state persistence using helper
        const persistence = persistenceHelper.initializeStatePersistence(node, {
            stateKey: "trendPredictorState",
            saveInterval: 30000,
            debug: node.debugEnabled,
            // The blob shape has not changed since the unversioned (pre-0.4.1)
            // writes, so those are adopted as they are.
            migrate: function (state, fromVersion) {
                return fromVersion === 0 ? state : null;
            },
            onStateLoaded: function (state) {
                // The flat keys describe the group that was active when the
                // state was saved (the only one, without Group By).
                if (Array.isArray(state.buffer) && state.buffer.length > 0) {
                    restoreInto(node, state);

                    debugLog("Restored " + node.buffer.length + " buffered values from persistence");
                    node.status({
                        fill: "green",
                        shape: "dot",
                        text: node.mode + " - restored (" + node.buffer.length + ")"
                    });
                }
                if (node.groupBy) {
                    if (typeof state.activeGroup === "string") {
                        swapper.setActiveKey(state.activeGroup);
                        node.activeGroup = state.activeGroup;
                    }
                    if (state.groups && typeof state.groups === "object") {
                        Object.keys(state.groups)
                            .slice(0, Math.max(0, node.maxGroups - 1))
                            .forEach(function (key) {
                                const saved = state.groups[key];
                                if (!saved || !Array.isArray(saved.buffer) || key === node.activeGroup) return;
                                const bundle = freshGroupState();
                                restoreInto(bundle, saved);
                                node.groups.set(key, bundle);
                            });
                    }
                }
            },
            getStateToSave: function () {
                const state = {};
                PERSISTED_FIELDS.forEach(function (f) {
                    state[f] = node[f];
                });
                if (node.groupBy) {
                    state.activeGroup = node.activeGroup;
                    state.groups = {};
                    node.groups.forEach(function (bundle, key) {
                        const entry = {};
                        PERSISTED_FIELDS.forEach(function (f) {
                            entry[f] = bundle[f];
                        });
                        state.groups[key] = entry;
                    });
                }
                return state;
            }
        });

        // Helper to persist current state
        function persistCurrentState() {
            if (persistence) {
                persistence.saveNow();
            }
        }

        node.status({ fill: "blue", shape: "ring", text: node.mode + " mode" });

        /**
         * Whether the window shows a trend at all, and which way. The least-
         * squares slope over the sample index is compared with its standard
         * error: a trend counts when |slope| > 2 SE, i.e. it is distinguishable
         * from the noise around the line. The test is scale-free — the old
         * absolute cut-off (|slope| > 0.01 per sample) called a 0-1 health index
         * falling 0.005 per sample "stable" and a noisy flat signal in large
         * units "increasing" — and it is the same test RUL mode applies.
         *
         * `reported` is the slope the caller publishes (the Holt trend for
         * exponential smoothing); the label follows its sign, and only when the
         * regression agrees on that sign.
         */
        function trendLabel(data, reported) {
            const n = data.length;
            if (n < 3) return "stable";
            const meanX = (n - 1) / 2;
            let meanY = 0;
            for (let i = 0; i < n; i++) meanY += data[i];
            meanY /= n;
            let sxy = 0;
            let sxx = 0;
            for (let i = 0; i < n; i++) {
                sxy += (i - meanX) * (data[i] - meanY);
                sxx += (i - meanX) * (i - meanX);
            }
            const slope = sxx !== 0 ? sxy / sxx : 0;
            const intercept = meanY - slope * meanX;
            let ssRes = 0;
            for (let i = 0; i < n; i++) {
                const r = data[i] - (slope * i + intercept);
                ssRes += r * r;
            }
            const varSlope = ssRes / Math.max(1, n - 2) / sxx;
            // A change over the window below floating-point resolution of the
            // level is no trend either (a constant series has σ = 0)
            const scale = Math.max(Math.abs(meanY), Number.MIN_VALUE);
            const negligible = Math.abs(slope) * (n - 1) <= 1e-12 * scale;
            const significant = !negligible && Math.abs(slope) > 2 * Math.sqrt(varSlope);
            const ref = reported === undefined ? slope : reported;
            if (!significant || !(ref * slope > 0)) return "stable";
            return ref > 0 ? "increasing" : "decreasing";
        }

        // Linear Regression
        function linearRegression(data, steps) {
            const n = data.length;
            const x = [];
            for (let i = 0; i < n; i++) x.push(i);

            const meanX =
                x.reduce(function (a, b) {
                    return a + b;
                }, 0) / n;
            const meanY =
                data.reduce(function (a, b) {
                    return a + b;
                }, 0) / n;

            let numerator = 0;
            let denominator = 0;

            for (let i = 0; i < n; i++) {
                numerator += (x[i] - meanX) * (data[i] - meanY);
                denominator += Math.pow(x[i] - meanX, 2);
            }

            const slope = denominator !== 0 ? numerator / denominator : 0;
            const intercept = meanY - slope * meanX;

            const predictedValues = [];
            for (let i = 1; i <= steps; i++) {
                const futureX = n + i - 1;
                predictedValues.push(slope * futureX + intercept);
            }

            return {
                slope: slope,
                intercept: intercept,
                predictedValues: predictedValues,
                trend: trendLabel(data, slope)
            };
        }

        // Exponential Smoothing
        function exponentialSmoothing(data, steps) {
            const alpha = 0.3;
            const beta = 0.1;

            let level = data[0];
            let trend = data.length > 1 ? data[1] - data[0] : 0;

            for (let i = 1; i < data.length; i++) {
                const prevLevel = level;
                level = alpha * data[i] + (1 - alpha) * (level + trend);
                trend = beta * (level - prevLevel) + (1 - beta) * trend;
            }

            const predictedValues = [];
            for (let i = 1; i <= steps; i++) {
                predictedValues.push(level + i * trend);
            }

            return {
                slope: trend,
                intercept: level,
                predictedValues: predictedValues,
                trend: trendLabel(data, trend)
            };
        }

        // First predicted step at which the threshold is crossed. The crossing
        // direction follows from where the series currently sits: below the
        // threshold it has to rise to it, above it has to fall to it.
        function calculateStepsToThreshold(predictedValues, threshold, currentValue) {
            const fromAbove = currentValue > threshold;
            for (let i = 0; i < predictedValues.length; i++) {
                if (fromAbove ? predictedValues[i] <= threshold : predictedValues[i] >= threshold) {
                    return i + 1;
                }
            }
            return null;
        }

        // Moving Average Smoothing - reduces noise before RUL calculation
        function smoothData(data, windowSize) {
            if (data.length < windowSize) {
                windowSize = data.length;
            }
            if (windowSize < 2) return data.slice();

            const smoothed = [];
            const halfWindow = Math.floor(windowSize / 2);

            for (let i = 0; i < data.length; i++) {
                const start = Math.max(0, i - halfWindow);
                const end = Math.min(data.length, i + halfWindow + 1);
                let sum = 0;
                for (let j = start; j < end; j++) {
                    sum += data[j];
                }
                smoothed.push(sum / (end - start));
            }
            return smoothed;
        }

        // Median filter - removes outliers before trend calculation
        function medianFilter(data, windowSize) {
            if (data.length < windowSize) return data.slice();
            if (windowSize < 3) windowSize = 3;
            if (windowSize % 2 === 0) windowSize++; // Ensure odd window size

            const filtered = [];
            const halfWindow = Math.floor(windowSize / 2);

            for (let i = 0; i < data.length; i++) {
                // Near the ends the window shrinks *symmetrically*. A one-sided
                // window there takes the median of the inner neighbours, which
                // pulls both end points of a trend towards the middle — the
                // slope then reads low and the RUL late.
                const half = Math.min(halfWindow, i, data.length - 1 - i);
                const start = i - half;
                const end = i + half + 1;
                const window = data.slice(start, end).sort(function (a, b) {
                    return a - b;
                });
                filtered.push(window[Math.floor(window.length / 2)]);
            }
            return filtered;
        }

        // Robust slope calculation using Theil-Sen estimator (median of the
        // pairwise slopes). `x` are the sample positions; omitted = unit spacing.
        function robustSlope(data, x) {
            if (data.length < 2) return 0;

            const slopes = [];
            // For efficiency, sample pairs if data is large
            const step = data.length > 50 ? Math.floor(data.length / 25) : 1;

            for (let i = 0; i < data.length; i += step) {
                for (let j = i + 1; j < data.length; j += step) {
                    const dx = x ? x[j] - x[i] : j - i;
                    if (dx > 0) {
                        slopes.push((data[j] - data[i]) / dx);
                    }
                }
            }

            if (slopes.length === 0) return 0;

            // Return median slope
            slopes.sort(function (a, b) {
                return a - b;
            });
            return slopes[Math.floor(slopes.length / 2)];
        }

        // Least-squares slope of data over positions x
        function leastSquaresSlope(data, x) {
            const n = data.length;
            let meanX = 0;
            let meanY = 0;
            for (let i = 0; i < n; i++) {
                meanX += x[i];
                meanY += data[i];
            }
            meanX /= n;
            meanY /= n;
            let num = 0;
            let den = 0;
            for (let i = 0; i < n; i++) {
                num += (x[i] - meanX) * (data[i] - meanY);
                den += (x[i] - meanX) * (x[i] - meanX);
            }
            return den !== 0 ? num / den : 0;
        }

        // An interval this many times the median interval is not a sampling
        // interval: either the data stopped (gap) or the clock moved (step).
        const INTERVAL_OUTLIER_FACTOR = 10;

        /**
         * Positions of the samples on a "steps" axis: elapsed time divided by
         * the mean sampling interval, so evenly spaced samples sit at 0, 1, 2, …
         * and a gap in the data counts for as many steps as it lasted. Fitting
         * against the sample index instead treats a ten-minute gap like a
         * one-second one and bends the trend accordingly.
         *
         * An interval more than INTERVAL_OUTLIER_FACTOR times the median one is
         * either a data gap (the device was offline, the process kept running)
         * or a clock step (an NTP correction: the process did not notice). The
         * two look the same on the time axis and opposite on the value axis, so
         * the jump in value across the interval decides: close to what the
         * trend would have produced over that much time it is a gap and counts
         * in full; otherwise it is a step and counts as one ordinary interval
         * (a reset of the time base). Extrapolating the pre-step line over an
         * hour that never happened put the crossing in the past and the RUL
         * negative.
         *
         * Falls back to the plain index when the timestamps do not increase
         * strictly (duplicates, a clock step backwards).
         *
         * @param {number[]} timestamps - ms
         * @param {number[]} [values] - the series, for the gap/step decision
         * @returns {{x:number[], avgInterval:number, timeBased:boolean, intervalOutliers:number, timeBaseResets:number}}
         */
        function samplePositions(timestamps, values) {
            const n = timestamps.length;
            const index = function (avgInterval) {
                return indexPositions(n, avgInterval);
            };
            const span = timestamps[n - 1] - timestamps[0];
            if (!(span > 0)) return index(1000); // Default 1 second
            const intervals = new Array(n - 1);
            for (let i = 1; i < n; i++) {
                const d = timestamps[i] - timestamps[i - 1];
                if (!(d > 0)) return index(span / (n - 1));
                intervals[i - 1] = d;
            }

            const sorted = intervals.slice().sort(function (a, b) {
                return a - b;
            });
            const median = sorted[Math.floor(sorted.length / 2)];
            const limit = INTERVAL_OUTLIER_FACTOR * median;
            let outliers = 0;
            let resets = 0;
            // Three intervals are the least a median can be trusted on
            if (intervals.length >= 3 && Array.isArray(values) && values.length === n) {
                // Rate of change per ms over the ordinary intervals
                const rates = [];
                for (let i = 0; i < intervals.length; i++) {
                    if (intervals[i] <= limit) rates.push((values[i + 1] - values[i]) / intervals[i]);
                }
                rates.sort(function (a, b) {
                    return a - b;
                });
                const rate = rates.length ? rates[Math.floor(rates.length / 2)] : 0;
                for (let i = 0; i < intervals.length; i++) {
                    if (!(intervals[i] > limit)) continue;
                    outliers++;
                    const jump = values[i + 1] - values[i];
                    const asGap = Math.abs(jump - rate * intervals[i]);
                    const asStep = Math.abs(jump - rate * median);
                    if (asStep <= asGap) {
                        intervals[i] = median;
                        resets++;
                    }
                }
            }

            let total = 0;
            for (let i = 0; i < intervals.length; i++) total += intervals[i];
            const avgInterval = total / (n - 1);
            const x = new Array(n);
            x[0] = 0;
            for (let i = 1; i < n; i++) x[i] = x[i - 1] + intervals[i - 1] / avgInterval;
            return {
                x: x,
                avgInterval: avgInterval,
                timeBased: true,
                intervalOutliers: outliers,
                timeBaseResets: resets
            };
        }

        // Plain sample index as positions (unit spacing), `avgInterval` ms a step
        function indexPositions(n, avgInterval) {
            const x = new Array(n);
            for (let i = 0; i < n; i++) x[i] = i;
            return { x: x, avgInterval: avgInterval, timeBased: false, intervalOutliers: 0, timeBaseResets: 0 };
        }

        // Report what samplePositions found about the time base, once
        function reportTimeBase(positions) {
            if (positions.timeBaseResets > 0) {
                warnOnce(
                    "clock-step",
                    "Timestamps: an interval more than " +
                        INTERVAL_OUTLIER_FACTOR +
                        "× the usual sampling interval, with the value continuing where it left off - " +
                        "treated as a clock step (time base reset), not as elapsed time. Check the device clock / NTP."
                );
            } else if (positions.intervalOutliers > 0) {
                warnOnce(
                    "data-gap",
                    "Timestamps: an interval more than " +
                        INTERVAL_OUTLIER_FACTOR +
                        "× the usual sampling interval - fitted as a data gap (the value moved on meanwhile)."
                );
            }
        }

        /**
         * Trend line through the window over positions `x`: a Theil-Sen /
         * least-squares blend for the slope, the lag-free Theil-Sen level at the
         * last sample, and the residual statistics the confidence band needs.
         *
         * The slope runs on the median-filtered (not the moving-average-smoothed)
         * series: the centred moving average is truncated at both ends of the
         * buffer, which pulls the end points inward and biases the slope low —
         * and a low slope means an optimistic RUL. Theil-Sen is robust on its own.
         * The level is the Theil-Sen intercept at the last position (median of
         * data[i] + slope·(xLast − x[i])): the smoothed series lags the trend by
         * roughly half a window there, which would bias the RUL late.
         *
         * @param {number[]} filtered - median-filtered series (fit input)
         * @param {number[]} raw - the series the residuals are measured on
         * @param {number[]} x - sample positions
         */
        function fitTrend(filtered, raw, x) {
            const n = filtered.length;
            const xLast = x[n - 1];
            const robustSlopeValue = robustSlope(filtered, x);
            const linearSlopeValue = leastSquaresSlope(filtered, x);
            // Robust slope is more reliable but linear gives better R-squared
            const slope = 0.7 * robustSlopeValue + 0.3 * linearSlopeValue;

            const levelOffsets = [];
            for (let i = 0; i < n; i++) levelOffsets.push(filtered[i] + slope * (xLast - x[i]));
            levelOffsets.sort(function (a, b) {
                return a - b;
            });
            const currentLevel =
                n % 2 === 1 ? levelOffsets[(n - 1) / 2] : (levelOffsets[n / 2 - 1] + levelOffsets[n / 2]) / 2;

            // Residuals of the data around the robust line -> noise σ and R²
            const yMean = raw.reduce((a, b) => a + b, 0) / n;
            const ssTot = raw.reduce((sum, y) => sum + Math.pow(y - yMean, 2), 0);
            let ssRes = 0;
            for (let i = 0; i < n; i++) {
                const predicted = currentLevel - slope * (xLast - x[i]);
                ssRes += Math.pow(raw[i] - predicted, 2);
            }
            const rSquared = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

            //   var(level) = σ² (1/n + x̄²/Sxx)   (level is the fit at the last index)
            //   var(slope) = σ² / Sxx,  Sxx = Σ(x − x̄)²  (n(n²-1)/12 for unit spacing)
            const sigma2 = ssRes / Math.max(1, n - 2);
            let xMean = 0;
            for (let i = 0; i < n; i++) xMean += x[i];
            xMean /= n;
            let sxx = 0;
            for (let i = 0; i < n; i++) sxx += (x[i] - xMean) * (x[i] - xMean);
            const xBarDist = xLast - xMean;

            return {
                slope: slope,
                currentLevel: currentLevel,
                xLast: xLast,
                rSquared: rSquared,
                varLevel: sigma2 * (1 / n + (xBarDist * xBarDist) / sxx),
                varSlope: sigma2 / sxx,
                linearSlopeValue: linearSlopeValue,
                robustSlopeValue: robustSlopeValue
            };
        }

        // Weibull distribution functions
        function weibullReliability(t, beta, eta) {
            // R(t) = exp(-(t/eta)^beta)
            return Math.exp(-Math.pow(t / eta, beta));
        }

        function weibullHazard(t, beta, eta) {
            // h(t) = (beta/eta) * (t/eta)^(beta-1)
            return (beta / eta) * Math.pow(t / eta, beta - 1);
        }

        function weibullMTTF(beta, eta) {
            // MTTF = eta * Gamma(1 + 1/beta)
            // Approximation of Gamma function for 1 + 1/beta
            const x = 1 + 1 / beta;
            return eta * gammaApprox(x);
        }

        // Calculate B-Life (time at which X% of population has failed)
        function weibullBLife(beta, eta, percentFailed) {
            // B_x = eta * (-ln(1 - x/100))^(1/beta)
            return eta * Math.pow(-Math.log(1 - percentFailed / 100), 1 / beta);
        }

        // Interpret Weibull beta parameter
        function interpretBeta(beta) {
            if (beta < 1) {
                return {
                    phase: "infant_mortality",
                    trend: "decreasing failure rate",
                    recommendation: "Check manufacturing/installation quality"
                };
            } else if (beta === 1) {
                return {
                    phase: "useful_life",
                    trend: "constant failure rate",
                    recommendation: "Normal maintenance schedule"
                };
            } else if (beta < 4) {
                return {
                    phase: "wear_out",
                    trend: "increasing failure rate",
                    recommendation: "Preventive replacement recommended"
                };
            } else {
                return {
                    phase: "rapid_wear_out",
                    trend: "strongly increasing failure rate",
                    recommendation: "Time-based replacement critical"
                };
            }
        }

        function gammaApprox(z) {
            // Lanczos approximation for Gamma function
            if (!Number.isFinite(z) || z <= 0) return 1; // Safe fallback for invalid inputs
            if (z < 0.5) {
                const sinPiZ = Math.sin(Math.PI * z);
                if (sinPiZ === 0) return 1; // Avoid division by zero at integer values
                return Math.PI / (sinPiZ * gammaApprox(1 - z));
            }
            z -= 1;
            const g = 7;
            const c = [
                0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
                12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
            ];
            let x = c[0];
            for (let i = 1; i < g + 2; i++) {
                x += c[i] / (z + i);
            }
            const t = z + g + 0.5;
            const result = Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
            return Number.isFinite(result) ? result : 1;
        }

        /**
         * Calculate Remaining Useful Life (RUL) with confidence intervals.
         *
         * Estimates the time until a monitored value reaches a failure threshold.
         *
         * 1. Input validation (non-finite samples are dropped)
         * 2. Direction: a "falling" indicator is mirrored so the rest of the
         *    function only ever deals with a value rising towards a threshold
         * 3. Model: "exponential" fits a straight line to ln(y) (y = a·e^(bt));
         *    it needs positive values and falls back to "linear" otherwise
         * 4. Median filter, then a Theil-Sen/least-squares slope and a lag-free
         *    Theil-Sen level at the last sample
         * 5. A trend only counts when the slope is statistically distinguishable
         *    from zero (|slope| > 2 standard errors) — the test is scale-free, so
         *    a slow drift on a fast-sampled signal is not mistaken for "stable"
         * 6. Crossing time with a delta-method confidence interval, or for
         *    "weibull" the remaining life at the equivalent age (see below)
         *
         * @param {number[]} data - sensor readings (degradation indicator)
         * @param {number[]} timestamps - ms since epoch (or any monotonic counter)
         * @param {number} failureThreshold - value at which failure is defined
         * @param {string} method - 'linear', 'exponential' or 'weibull'
         * @param {number} confidenceLevel - e.g. 0.95
         * @param {string} [direction='rising'] - 'rising' or 'falling'
         * @returns {Object|null} rul / rulLower / rulUpper (timestamp units),
         *   rulSteps / rulLowerSteps / rulUpperSteps (samples), confidence (R²),
         *   status, percentDegraded, degradationRate (per sample), trend, model …
         */
        function calculateRUL(data, timestamps, failureThreshold, method, confidenceLevel, direction) {
            if (data.length < 5) return null;

            // Two-sided z for the configured confidence level (0.95 → 1.96,
            // 0.99 → 2.576). Out-of-range values fall back to 95 %.
            const zScore = vibration.zScoreForConfidence(confidenceLevel);
            const effectiveConfidenceLevel = confidenceLevel > 0 && confidenceLevel < 1 ? confidenceLevel : 0.95;

            if (!Number.isFinite(failureThreshold)) {
                debugLog("RUL: Failure threshold is not finite: " + failureThreshold);
                return null;
            }

            // STABILITY: Filter out any NaN/Infinity values from data
            const validData = [];
            const validTimestamps = [];
            for (let i = 0; i < data.length; i++) {
                if (Number.isFinite(data[i]) && Number.isFinite(timestamps[i])) {
                    validData.push(data[i]);
                    validTimestamps.push(timestamps[i]);
                }
            }

            if (validData.length < 5) {
                debugLog("RUL: Not enough valid data points after filtering: " + validData.length);
                return null;
            }

            timestamps = validTimestamps;
            const n = validData.length;
            const falling = direction === "falling";
            const sign = falling ? -1 : 1;

            // Mirror a falling indicator: from here on the value rises to the threshold
            data = falling
                ? validData.map(function (v) {
                      return -v;
                  })
                : validData;
            let threshold = sign * failureThreshold;

            // Share of the way to the threshold, in original units
            const percentOf = function (level) {
                const ratio = falling ? failureThreshold / level : level / failureThreshold;
                return Number.isFinite(ratio) ? Math.max(0, Math.min(100, ratio * 100)) : null;
            };

            // Already failed? Decided on the median of the last three samples:
            // the raw last sample alone turned a single spike at the threshold
            // (a sensor glitch) into "failed, confidence 1.0" and "stable" one
            // sample later. The price is one sample of latency on a genuine
            // crossing, during which the RUL reads ~0 and "critical" anyway.
            const recent = data.slice(-3).sort(function (a, b) {
                return a - b;
            });
            const recentLevel = recent[Math.floor(recent.length / 2)];
            if (recentLevel >= threshold) {
                return {
                    rul: 0,
                    rulSteps: 0,
                    confidence: 1.0,
                    status: "failed",
                    percentDegraded: 100,
                    model: method,
                    direction: falling ? "falling" : "rising"
                };
            }

            // Exponential growth is a straight line in ln(y)
            let logDomain = false;
            if (method === "exponential") {
                const positive =
                    threshold > 0 &&
                    data.every(function (v) {
                        return v > 0;
                    });
                if (positive) {
                    data = data.map(Math.log);
                    threshold = Math.log(threshold);
                    logDomain = true;
                } else {
                    debugLog(
                        "RUL: exponential model needs positive values rising to a positive threshold - using linear"
                    );
                    method = "linear";
                }
            }
            const toOriginal = function (v) {
                return sign * (logDomain ? Math.exp(v) : v);
            };

            // Step 1: Apply median filter to remove outliers
            const filteredData = medianFilter(data, 5);

            // Step 2: Apply moving average smoothing to reduce noise
            const smoothingWindow = Math.max(3, Math.floor(n / 10));
            const smoothedData = smoothData(filteredData, smoothingWindow);

            // Step 3: Fit the trend over the sample *positions in time* (see
            // samplePositions), which equal the indices for even sampling.
            let positions = samplePositions(timestamps, filteredData);
            reportTimeBase(positions);
            let fit = fitTrend(filteredData, data, positions.x);

            // The fitted level sits at or above the threshold although the recent
            // samples do not: the time axis is lying (a clock step the interval
            // test let through, a device clock set forward). Refit over the sample
            // index rather than place the crossing in the past.
            let timeBaseFallback = false;
            if (positions.timeBased && fit.slope > 0 && threshold - fit.currentLevel <= 0) {
                positions = indexPositions(n, positions.avgInterval);
                fit = fitTrend(filteredData, data, positions.x);
                timeBaseFallback = true;
                debugLog("RUL: time-based fit put the crossing in the past - refitted over the sample index");
            }
            const xLast = fit.xLast;
            const slope = fit.slope;
            const currentLevel = fit.currentLevel;
            const rSquared = fit.rSquared;
            const varLevel = fit.varLevel;
            const varSlope = fit.varSlope;
            const linearSlopeValue = fit.linearSlopeValue;
            const robustSlopeValue = fit.robustSlopeValue;

            // Step 4: index-based regression, for the trend label
            const result = linearRegression(filteredData, 1);

            const smoothedCurrentValue = toOriginal(smoothedData[n - 1]);
            const currentLevelOriginal = toOriginal(currentLevel);

            debugLog(
                "RUL: raw_slope=" +
                    linearSlopeValue.toFixed(4) +
                    ", robust_slope=" +
                    robustSlopeValue.toFixed(4) +
                    ", combined=" +
                    slope.toFixed(4)
            );

            // Slope in original units per sample (instantaneous for the exponential model)
            const slopeOriginal = sign * (logDomain ? slope * Math.exp(currentLevel) : slope);
            // Direction of the raw signal, as reported before
            const signalTrend =
                !falling || result.trend === "stable"
                    ? result.trend
                    : result.trend === "increasing"
                      ? "decreasing"
                      : "increasing";

            // No degradation or improving. "No trend" is a statistical statement:
            // the slope is within two standard errors of zero, or the change over
            // the whole window is below floating-point resolution of the level.
            const scale = Math.max(Math.abs(currentLevel), Math.abs(threshold), Number.MIN_VALUE);
            const negligible = Math.abs(slope) * xLast <= 1e-12 * scale;
            const significant = !negligible && Math.abs(slope) > 2 * Math.sqrt(varSlope);
            if (!(slope > 0) || !significant) {
                return {
                    rul: Infinity,
                    rulSteps: Infinity,
                    confidence: 0.5,
                    status: "stable",
                    percentDegraded: percentOf(smoothedCurrentValue),
                    trend: significant && slope < 0 ? "improving" : "stable",
                    model: method,
                    direction: falling ? "falling" : "rising",
                    smoothedValue: smoothedCurrentValue,
                    rawSlope: sign * linearSlopeValue,
                    robustSlope: sign * robustSlopeValue
                };
            }

            // Mean time between samples: one step on the position axis
            const avgInterval = positions.avgInterval;

            let timeToFailure, rulLower, rulUpper, weibullInfo;
            const confidence = rSquared;

            if (method === "weibull") {
                // Weibull lifetime model with the configured shape β and
                // characteristic life η. The node does not know the asset's age,
                // so the observed degradation fraction D (level / threshold) is
                // read as the failed fraction F(t) = D, which gives an
                // *equivalent age* t_eq = η·(−ln(1−D))^(1/β). The RUL is the time
                // from there to the age at which reliability drops to 10 %.
                const fraction = threshold > 0 ? currentLevel / threshold : NaN;
                if (fraction > 0 && fraction < 1) {
                    const beta = node.weibullBeta;
                    const eta = node.weibullEta * 3600000; // hours -> ms
                    const ageOf = function (d) {
                        return eta * Math.pow(-Math.log(1 - d), 1 / beta);
                    };
                    const equivalentAge = ageOf(fraction);
                    const targetReliability = 0.1;
                    const timeAtTarget = eta * Math.pow(-Math.log(targetReliability), 1 / beta);
                    timeToFailure = Math.max(0, timeAtTarget - equivalentAge);

                    // Bounds from the uncertainty of the current level
                    const dFraction = (zScore * Math.sqrt(varLevel)) / threshold;
                    rulLower = Math.max(0, timeAtTarget - ageOf(Math.min(1 - 1e-12, fraction + dFraction)));
                    rulUpper = Math.max(0, timeAtTarget - ageOf(Math.max(1e-12, fraction - dFraction)));

                    const betaInterpretation = interpretBeta(beta);
                    weibullInfo = {
                        beta: beta,
                        eta: eta,
                        etaHours: node.weibullEta,
                        equivalentAge: equivalentAge,
                        currentReliability: weibullReliability(equivalentAge, beta, eta),
                        hazardRate: weibullHazard(equivalentAge, beta, eta),
                        mttf: weibullMTTF(beta, eta),
                        failureMode: betaInterpretation.phase,
                        interpretation: betaInterpretation,
                        bLife: {
                            B1: weibullBLife(beta, eta, 1),
                            B5: weibullBLife(beta, eta, 5),
                            B10: weibullBLife(beta, eta, 10),
                            B50: weibullBLife(beta, eta, 50)
                        }
                    };
                } else {
                    // Needs a positive level below a positive threshold
                    method = "linear";
                }
            }

            const finiteOrNull = function (v) {
                return Number.isFinite(v) ? v : null;
            };
            const stepsOrNull = function (ms) {
                return Number.isFinite(ms) ? ms / avgInterval : null;
            };

            if (method !== "weibull") {
                // Linear or exponential method: extrapolate the trend line from
                // its lag-free current level.
                const gap = threshold - currentLevel;
                if (gap <= 0) {
                    // Even over the sample index the fitted level is at or past
                    // the threshold while the recent samples are not. A negative
                    // RUL is not an estimate — say the model and the data disagree
                    // instead of routing a crossing "in the past" to the critical
                    // output.
                    return {
                        rul: null,
                        rulLower: null,
                        rulUpper: null,
                        rulSteps: null,
                        rulLowerSteps: null,
                        rulUpperSteps: null,
                        confidence: 0,
                        confidenceLevel: effectiveConfidenceLevel,
                        status: "inconsistent",
                        percentDegraded: percentOf(currentLevelOriginal),
                        degradationRate: finiteOrNull(slopeOriginal),
                        trend: signalTrend,
                        model: method,
                        direction: falling ? "falling" : "rising",
                        timeBased: positions.timeBased,
                        timeBaseFallback: timeBaseFallback,
                        intervalOutliers: positions.intervalOutliers,
                        smoothedValue: finiteOrNull(smoothedCurrentValue),
                        currentLevel: finiteOrNull(currentLevelOriginal),
                        rawSlope: finiteOrNull(sign * linearSlopeValue),
                        robustSlope: finiteOrNull(sign * robustSlopeValue)
                    };
                }
                const stepsToFailure = gap / slope;
                timeToFailure = stepsToFailure * avgInterval;

                // Interval for the *crossing time*, not for the next observation:
                // delta method on t = (T - level) / slope. The slope term grows
                // with the distance to the threshold, which is what makes a
                // far-off failure genuinely more uncertain.
                const varSteps = varLevel / (slope * slope) + (gap * gap * varSlope) / Math.pow(slope, 4);
                const marginSteps = zScore * Math.sqrt(Math.max(0, varSteps));

                rulLower = (stepsToFailure - marginSteps) * avgInterval;
                rulUpper = (stepsToFailure + marginSteps) * avgInterval;
            }

            let status = "healthy";
            if (timeToFailure < avgInterval * 10) status = "critical";
            else if (timeToFailure < avgInterval * 50) status = "warning";

            // STABILITY: Ensure all returned values are valid numbers
            const rulResult = {
                rul: finiteOrNull(timeToFailure),
                rulLower: Number.isFinite(rulLower) ? Math.max(0, rulLower) : null,
                rulUpper: finiteOrNull(rulUpper),
                rulSteps: stepsOrNull(timeToFailure),
                rulLowerSteps: Number.isFinite(rulLower) ? Math.max(0, rulLower) / avgInterval : null,
                rulUpperSteps: stepsOrNull(rulUpper),
                confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
                confidenceLevel: effectiveConfidenceLevel,
                status: status,
                percentDegraded: percentOf(currentLevelOriginal),
                degradationRate: finiteOrNull(slopeOriginal),
                growthRate: logDomain ? finiteOrNull(slope) : undefined,
                trend: signalTrend,
                model: method,
                direction: falling ? "falling" : "rising",
                timeBased: positions.timeBased,
                timeBaseFallback: timeBaseFallback,
                intervalOutliers: positions.intervalOutliers,
                weibull: weibullInfo,
                smoothedValue: finiteOrNull(smoothedCurrentValue),
                currentLevel: finiteOrNull(currentLevelOriginal),
                rawSlope: finiteOrNull(sign * linearSlopeValue),
                robustSlope: finiteOrNull(sign * robustSlopeValue)
            };

            // STABILITY: If RUL is null/invalid, treat as stable
            if (rulResult.rul === null) {
                rulResult.rul = Infinity;
                rulResult.rulSteps = Infinity;
                rulResult.status = "stable";
                rulResult.confidence = 0.3; // Low confidence for fallback
                debugLog("RUL: timeToFailure was invalid, treating as stable");
            }

            return rulResult;
        }

        // Process RUL mode with configurable thresholds (for msg.config override)
        function processRULWithConfig(msg, value, timestamp, failureThreshold, warningThreshold, direction) {
            node.buffer.push(value);
            node.timestamps.push(timestamp);

            if (node.buffer.length > node.windowSize) {
                node.buffer.shift();
                node.timestamps.shift();
            }

            // Persist state periodically (every 10th sample to reduce overhead)
            node.sampleCount++;
            if (node.stateManager && node.sampleCount % 10 === 0) {
                persistCurrentState();
            }

            if (node.buffer.length < 5) {
                node.status({ fill: "yellow", shape: "ring", text: "RUL: collecting " + node.buffer.length + "/5" });
                return null;
            }

            if (failureThreshold === null) {
                node.status({ fill: "red", shape: "ring", text: "RUL: no threshold set" });
                return null;
            }

            const rulResult = calculateRUL(
                node.buffer,
                node.timestamps,
                failureThreshold,
                node.degradationModel,
                node.confidenceLevel,
                direction
            );

            if (!rulResult) return null;

            // ms (timestamp units) -> configured unit; "cycles" counts samples
            const unitDivisor = { minutes: 60000, hours: 3600000, days: 86400000 }[node.rulUnit] || 1;
            const inUnit = function (ms, steps) {
                if (ms === null || ms === undefined) return null;
                if (node.rulUnit === "cycles") return steps === undefined ? null : steps;
                return ms / unitDivisor;
            };

            // Convert RUL to specified unit
            let rulValue = rulResult.rul;
            const unitLabel = { minutes: "min", hours: "h", days: "d", cycles: " cycles" }[node.rulUnit] || "";
            if (rulResult.rul !== Infinity) {
                rulValue = inUnit(rulResult.rul, rulResult.rulSteps);
            }

            const outputMsg = {
                payload: value,
                rul: {
                    value: rulValue,
                    unit: node.rulUnit,
                    // (a lower bound of 0 is a result - "could fail now" - not a missing value)
                    lower: inUnit(rulResult.rulLower, rulResult.rulLowerSteps),
                    upper: inUnit(rulResult.rulUpper, rulResult.rulUpperSteps),
                    confidence: rulResult.confidence,
                    confidenceLevel: rulResult.confidenceLevel,
                    status: rulResult.status,
                    model: rulResult.model,
                    direction: rulResult.direction,
                    // How the time axis was built: over the timestamps, or over the
                    // sample index (no usable timestamps, or a fallback after the
                    // time-based fit placed the crossing in the past)
                    timeBased: rulResult.timeBased === true,
                    timeBaseFallback: rulResult.timeBaseFallback === true,
                    intervalOutliers: rulResult.intervalOutliers || 0
                },
                degradation: {
                    percent: rulResult.percentDegraded,
                    rate: rulResult.degradationRate,
                    trend: rulResult.trend
                },
                thresholds: {
                    failure: failureThreshold,
                    warning: warningThreshold
                },
                currentValue: value,
                timestamp: timestamp
            };
            if (rulResult.weibull) {
                outputMsg.weibull = rulResult.weibull;
            }

            if (node.outputTopic) {
                outputMsg.topic = node.outputTopic;
            }

            copyPassthrough(outputMsg, msg);

            // Status display
            const statusColor =
                rulResult.status === "critical"
                    ? "red"
                    : rulResult.status === "warning" || rulResult.status === "inconsistent"
                      ? "yellow"
                      : rulResult.status === "failed"
                        ? "red"
                        : "green";
            const statusText =
                rulResult.status === "inconsistent"
                    ? "RUL: inconsistent (fit past threshold)"
                    : rulResult.rul === Infinity
                      ? "RUL: ∞ (stable)"
                      : rulResult.rul === 0
                        ? "FAILED"
                        : "RUL: " +
                          rulValue.toFixed(1) +
                          unitLabel +
                          " (" +
                          (rulResult.confidence * 100).toFixed(0) +
                          "%)";

            node.status({
                fill: statusColor,
                shape: rulResult.status === "healthy" ? "dot" : "ring",
                text: statusText
            });

            // The warning threshold is tested on the median of the last three
            // samples, like the failure threshold: one spike is not a warning.
            const recent = node.buffer.slice(-3).sort(function (a, b) {
                return a - b;
            });
            const recentLevel = recent[Math.floor(recent.length / 2)];
            const isAnomaly =
                rulResult.status === "critical" ||
                rulResult.status === "failed" ||
                (warningThreshold !== null &&
                    (direction === "falling" ? recentLevel <= warningThreshold : recentLevel >= warningThreshold));

            return { normal: isAnomaly ? null : outputMsg, anomaly: isAnomaly ? outputMsg : null };
        }

        // Process Trend Prediction with configurable parameters (for msg.config override)
        function processPredictionWithConfig(msg, value, timestamp, threshold, predictionSteps) {
            node.buffer.push(value);
            node.timestamps.push(timestamp);

            if (node.buffer.length > node.windowSize) {
                node.buffer.shift();
                node.timestamps.shift();
            }

            // Persist state periodically (every 10th sample to reduce overhead)
            node.sampleCount++;
            if (node.stateManager && node.sampleCount % 10 === 0) {
                persistCurrentState();
            }

            if (node.buffer.length < 3) {
                node.status({ fill: "yellow", shape: "ring", text: "Buffering: " + node.buffer.length + "/3" });
                return null;
            }

            let prediction = null;
            if (node.method === "linear") {
                prediction = linearRegression(node.buffer, predictionSteps);
            } else {
                prediction = exponentialSmoothing(node.buffer, predictionSteps);
            }

            let timeToThreshold = null;
            let stepsToThreshold = null;

            if (threshold !== null && prediction) {
                stepsToThreshold = calculateStepsToThreshold(prediction.predictedValues, threshold, value);
                if (stepsToThreshold !== null && node.timestamps.length >= 2) {
                    // Mean sampling interval with clock steps taken out (a one-hour
                    // NTP correction is not an hour between two samples)
                    const positions = samplePositions(node.timestamps, node.buffer);
                    reportTimeBase(positions);
                    timeToThreshold = stepsToThreshold * positions.avgInterval;
                }
            }

            const outputMsg = {
                payload: value,
                trend: prediction ? prediction.trend : null,
                slope: prediction ? prediction.slope : null,
                predictedValues: prediction ? prediction.predictedValues : [],
                timeToThreshold: timeToThreshold,
                stepsToThreshold: stepsToThreshold,
                bufferSize: node.buffer.length,
                method: node.method,
                timestamp: timestamp
            };

            if (node.outputTopic) {
                outputMsg.topic = node.outputTopic;
            }

            copyPassthrough(outputMsg, msg);

            if (prediction) {
                const trendIcon = prediction.slope > 0 ? "↗" : prediction.slope < 0 ? "↘" : "→";
                let statusText = trendIcon + " " + prediction.slope.toFixed(3);
                if (timeToThreshold !== null) {
                    const hours = Math.floor(timeToThreshold / 3600000);
                    statusText += " | RUL: " + hours + "h";
                }
                node.status({ fill: "green", shape: "dot", text: statusText });
            }

            return { normal: outputMsg, anomaly: null };
        }

        // Process Rate of Change with configurable threshold (for msg.config override)
        function processRateOfChangeWithConfig(msg, value, timestamp, rocThreshold) {
            node.rocHistory.push({ value: value, timestamp: timestamp });

            const windowMs = node.timeWindow * 1000;
            node.rocHistory = node.rocHistory.filter(function (h) {
                return timestamp - h.timestamp <= windowMs;
            });

            let rateOfChange = null;
            let isAnomalous = false;
            let acceleration = null;

            if (node.previousValue !== null && node.previousTimestamp !== null) {
                const timeDiff = (timestamp - node.previousTimestamp) / 1000;
                const valueDiff = value - node.previousValue;

                if (timeDiff > 0) {
                    if (node.rocMethod === "absolute") {
                        rateOfChange = valueDiff / timeDiff;
                    } else if (node.rocMethod === "percentage") {
                        if (node.previousValue !== 0) {
                            rateOfChange = ((valueDiff / Math.abs(node.previousValue)) * 100) / timeDiff;
                        }
                    }
                }

                if (node.rocHistory.length >= 3) {
                    const rates = [];
                    for (let i = 1; i < node.rocHistory.length; i++) {
                        const dt = (node.rocHistory[i].timestamp - node.rocHistory[i - 1].timestamp) / 1000;
                        const dv = node.rocHistory[i].value - node.rocHistory[i - 1].value;
                        if (dt > 0) {
                            rates.push(dv / dt);
                        }
                    }
                    // (a zero-length interval drops a rate; then the last three
                    // samples no longer line up with the last two rates)
                    if (rates.length !== node.rocHistory.length - 1) {
                        rates.length = 0;
                    }

                    if (rates.length >= 2) {
                        // Each rate belongs to the midpoint of its interval; the
                        // two midpoints are half the span of the last three
                        // samples apart.
                        const h = node.rocHistory;
                        const span = (h[h.length - 1].timestamp - h[h.length - 3].timestamp) / 1000;
                        if (span > 0) {
                            acceleration = (rates[rates.length - 1] - rates[rates.length - 2]) / (span / 2);
                        }
                    }
                }

                if (rocThreshold !== null && rateOfChange !== null) {
                    isAnomalous = Math.abs(rateOfChange) > rocThreshold;
                }
            }

            node.previousValue = value;
            node.previousTimestamp = timestamp;

            const outputMsg = {
                payload: value,
                rateOfChange: rateOfChange,
                acceleration: acceleration,
                isAnomalous: isAnomalous,
                method: node.rocMethod,
                timeWindow: node.timeWindow,
                timestamp: timestamp
            };

            if (node.outputTopic) {
                outputMsg.topic = node.outputTopic;
            }

            copyPassthrough(outputMsg, msg);

            if (rateOfChange !== null) {
                const sign = rateOfChange >= 0 ? "+" : "";
                const color = isAnomalous ? "red" : "green";
                const unit = node.rocMethod === "percentage" ? "%/s" : "/s";
                node.status({ fill: color, shape: "dot", text: sign + rateOfChange.toFixed(3) + unit });
            }

            return { normal: isAnomalous ? null : outputMsg, anomaly: isAnomalous ? outputMsg : null };
        }

        // Strict numeric input: a finite number, or a string that is one
        // (parseFloat alone turns "12abc" into 12 and lets "Infinity" through,
        // which then poisons every regression over the window).
        function toFiniteNumber(raw) {
            const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
            return typeof n === "number" && Number.isFinite(n) ? n : null;
        }

        // A numeric timestamp in this range is an epoch in *seconds* (1e9 s =
        // 2001, 1e11 s = year 5138; in ms the same numbers are 1970-1973).
        // Smaller numbers are left alone: a cycle counter or a relative clock
        // is a legitimate monotonic time base.
        const EPOCH_SECONDS_MIN = 1e9;
        const EPOCH_SECONDS_MAX = 1e11;

        // msg.timestamp as ms: a number, a Date, or a parseable date string;
        // anything else falls back to the arrival time. Epoch seconds are
        // converted (with a warning): taken as ms they put every interval a
        // thousand times too short, and the RUL in hours a thousand times too.
        function resolveTimestamp(raw) {
            let ms = null;
            if (typeof raw === "number" && Number.isFinite(raw)) ms = raw;
            else if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw.getTime();
            else if (typeof raw === "string" && raw.trim() !== "") {
                const n = Number(raw);
                if (Number.isFinite(n)) ms = n;
                else {
                    const parsed = Date.parse(raw);
                    if (Number.isFinite(parsed)) return parsed;
                }
            }
            if (ms === null) return Date.now();
            if (ms >= EPOCH_SECONDS_MIN && ms < EPOCH_SECONDS_MAX) {
                warnOnce(
                    "epoch-seconds",
                    "msg.timestamp looks like epoch seconds (" +
                        ms +
                        "); converted to milliseconds. Send ms to silence this."
                );
                return ms * 1000;
            }
            return ms;
        }

        // Per-message override that must be a finite number; a malformed one
        // (NaN from a typo) keeps the configured value.
        function finiteOr(raw, fallback) {
            if (raw === undefined || raw === null || raw === "") return fallback;
            const n = typeof raw === "number" ? raw : parseFloat(raw);
            return Number.isFinite(n) ? n : fallback;
        }

        // Multi-sensor state buffers
        Object.assign(node, {
            sensorBuffers: Object.create(null),
            sensorTimestamps: Object.create(null),
            sensorPrevious: Object.create(null)
        });

        // Process multi-sensor JSON input
        function processMultiSensorInput(msg, sensorData, send, timestamp, active) {
            const results = {};
            let anyThresholdExceeded = false;
            const exceededSensors = [];

            const sensorNames = Object.keys(sensorData);

            sensorNames.forEach(function (sensorName) {
                const value = toFiniteNumber(sensorData[sensorName]);
                if (value === null) return;

                // Initialize per-sensor buffers if needed
                if (!node.sensorBuffers[sensorName]) {
                    // Cap the number of sensors so a stream of ever-new keys
                    // cannot grow the state without bound.
                    if (Object.keys(node.sensorBuffers).length >= MAX_SENSORS) return;
                    node.sensorBuffers[sensorName] = [];
                    node.sensorTimestamps[sensorName] = [];
                    node.sensorPrevious[sensorName] = { value: null, timestamp: null };
                }

                // Add to sensor buffer
                node.sensorBuffers[sensorName].push(value);
                node.sensorTimestamps[sensorName].push(timestamp);
                if (node.sensorBuffers[sensorName].length > node.windowSize) {
                    node.sensorBuffers[sensorName].shift();
                    node.sensorTimestamps[sensorName].shift();
                }

                let sensorResult = {};

                if (active.mode === "prediction") {
                    if (node.sensorBuffers[sensorName].length >= 3) {
                        const regression = linearRegression(node.sensorBuffers[sensorName], active.predictionSteps);
                        sensorResult = {
                            value: value,
                            trend: regression.trend,
                            slope: regression.slope,
                            predictedValues: regression.predictedValues,
                            bufferSize: node.sensorBuffers[sensorName].length
                        };

                        if (active.threshold !== null) {
                            // A slope leading away from the threshold never reaches it
                            const rawSteps =
                                regression.slope !== 0 ? (active.threshold - value) / regression.slope : Infinity;
                            const stepsToThreshold = rawSteps < 0 ? Infinity : Math.ceil(rawSteps);
                            sensorResult.stepsToThreshold = stepsToThreshold;
                            if (
                                value >= active.threshold ||
                                (stepsToThreshold > 0 && stepsToThreshold <= active.predictionSteps)
                            ) {
                                anyThresholdExceeded = true;
                                exceededSensors.push(sensorName);
                            }
                        }
                    } else {
                        sensorResult = {
                            value: value,
                            trend: "warmup",
                            bufferSize: node.sensorBuffers[sensorName].length,
                            minRequired: 3
                        };
                    }
                } else if (active.mode === "rate-of-change") {
                    const prev = node.sensorPrevious[sensorName];
                    if (prev.value !== null) {
                        const deltaTime = (timestamp - prev.timestamp) / 1000;
                        const deltaValue = value - prev.value;
                        let roc = deltaTime > 0 ? deltaValue / deltaTime : 0;

                        if (node.rocMethod === "percentage" && prev.value !== 0) {
                            roc = (roc / Math.abs(prev.value)) * 100;
                        }

                        sensorResult = {
                            value: value,
                            rateOfChange: roc,
                            deltaValue: deltaValue,
                            deltaTime: deltaTime,
                            unit: node.rocMethod === "percentage" ? "%/s" : "/s"
                        };

                        if (active.rocThreshold !== null && Math.abs(roc) > active.rocThreshold) {
                            anyThresholdExceeded = true;
                            exceededSensors.push(sensorName);
                            sensorResult.thresholdExceeded = true;
                        }
                    } else {
                        sensorResult = { value: value, rateOfChange: null, warmup: true };
                    }
                    node.sensorPrevious[sensorName] = { value: value, timestamp: timestamp };
                } else if (active.mode === "rul") {
                    if (node.sensorBuffers[sensorName].length >= 5 && active.failureThreshold !== null) {
                        const rul = calculateRUL(
                            node.sensorBuffers[sensorName],
                            node.sensorTimestamps[sensorName],
                            active.failureThreshold,
                            node.degradationModel,
                            node.confidenceLevel,
                            active.direction
                        );
                        sensorResult = {
                            value: value,
                            rul: rul,
                            bufferSize: node.sensorBuffers[sensorName].length
                        };

                        if (rul && (rul.status === "critical" || rul.status === "failed")) {
                            anyThresholdExceeded = true;
                            exceededSensors.push(sensorName);
                        }
                    } else {
                        sensorResult = {
                            value: value,
                            rul: null,
                            warmup: true,
                            bufferSize: node.sensorBuffers[sensorName].length,
                            minRequired: 5
                        };
                    }
                }

                results[sensorName] = sensorResult;
            });

            // Build output message
            const outMsg = {
                payload: results,
                mode: active.mode,
                sensorCount: sensorNames.length,
                inputFormat: "multi-sensor",
                _msgid: msg._msgid
            };

            if (node.groupBy) outMsg.group = node.activeGroup;

            if (anyThresholdExceeded) {
                outMsg.thresholdExceeded = true;
                outMsg.exceededSensors = exceededSensors;
            }

            if (node.outputTopic) outMsg.topic = node.outputTopic;
            else if (msg.topic !== undefined) outMsg.topic = msg.topic;

            // Update status
            let statusText = sensorNames.length + " sensors";
            if (active.mode === "prediction") {
                statusText += " (trend)";
            } else if (active.mode === "rul") {
                statusText += " (RUL)";
            }

            if (anyThresholdExceeded) {
                node.status({
                    fill: "red",
                    shape: "dot",
                    text: "threshold: " + exceededSensors.join(", ")
                });
                send([null, outMsg]);
            } else {
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: statusText
                });
                send([outMsg, null]);
            }
        }

        node.on("input", function (msg, send, done) {
            // Node-RED >=1.0 passes send/done; shim for older runtimes.
            done =
                done ||
                function (err) {
                    if (err) node.error(err, msg);
                };
            send =
                send ||
                function () {
                    node.send.apply(node, arguments);
                };
            try {
                // Dynamic configuration via msg.config
                // Allows runtime override of node settings
                const cfg = msg.config && typeof msg.config === "object" ? msg.config : {};
                const activeMode = cfg.mode || node.mode;
                const activeThreshold = finiteOr(cfg.threshold, node.threshold);
                const activeFailureThreshold = finiteOr(cfg.failureThreshold, node.failureThreshold);
                const activeWarningThreshold = finiteOr(cfg.warningThreshold, node.warningThreshold);
                const activeRocThreshold = finiteOr(cfg.rocThreshold, node.rocThreshold);
                const activePredictionSteps = Math.min(
                    100000,
                    Math.max(1, Math.floor(finiteOr(cfg.predictionSteps, node.predictionSteps)))
                );
                const activeDirection =
                    cfg.failureDirection === "falling" || cfg.failureDirection === "rising"
                        ? cfg.failureDirection
                        : node.failureDirection;

                // msg.reset === "all" clears every group; msg.reset === true
                // clears the group this message belongs to (the only one when
                // Group By is not configured).
                if (msg.reset === "all") {
                    swapper.resetAll();
                    node.activeGroup = groupState.DEFAULT_GROUP;
                    node.status({ fill: "blue", shape: "ring", text: activeMode + " - reset (all groups)" });
                    done();
                    return;
                }

                // Select the state of the device this message belongs to
                switchGroup(msg);

                if (msg.reset === true) {
                    Object.assign(node, freshGroupState());
                    node.status({ fill: "blue", shape: "ring", text: activeMode + " - reset" });
                    done();
                    return;
                }

                const timestamp = resolveTimestamp(msg.timestamp);

                // Check if payload is JSON object (multi-sensor mode)
                if (typeof msg.payload === "object" && msg.payload !== null && !Array.isArray(msg.payload)) {
                    processMultiSensorInput(msg, msg.payload, send, timestamp, {
                        mode: activeMode,
                        threshold: activeThreshold,
                        predictionSteps: activePredictionSteps,
                        rocThreshold: activeRocThreshold,
                        failureThreshold: activeFailureThreshold,
                        direction: activeDirection
                    });
                    done();
                    return;
                }

                const value = toFiniteNumber(msg.payload);

                if (value === null) {
                    node.warn("Invalid payload: not a finite number");
                    done();
                    return;
                }

                let result = null;

                if (activeMode === "prediction") {
                    result = processPredictionWithConfig(msg, value, timestamp, activeThreshold, activePredictionSteps);
                } else if (activeMode === "rate-of-change") {
                    result = processRateOfChangeWithConfig(msg, value, timestamp, activeRocThreshold);
                } else if (activeMode === "rul") {
                    result = processRULWithConfig(
                        msg,
                        value,
                        timestamp,
                        activeFailureThreshold,
                        activeWarningThreshold,
                        activeDirection
                    );
                }

                if (result) {
                    if (node.groupBy) {
                        if (result.normal) result.normal.group = node.activeGroup;
                        if (result.anomaly) result.anomaly.group = node.activeGroup;
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
                done("Error in trend prediction: " + err.message);
            }
        });

        node.on("close", async function (done) {
            try {
                // Save state before closing if persistence enabled
                if (persistence) {
                    await persistence.close();
                }

                swapper.resetAll();
                node.status({});
            } finally {
                // Always release the runtime: a close handler that never calls
                // done() stalls every deploy until Node-RED's close timeout.
                if (done) done();
            }
        });
    }

    RED.nodes.registerType("trend-predictor", TrendPredictorNode);
};
