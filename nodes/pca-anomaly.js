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
    const groupState = require("./utils/group-state");

    const { chiSquaredQuantileFromZ, hotellingLimitFromZ } = require("./utils/statistics");

    // Import ml-pca for the decomposition itself (SVD-based, numerically stable)
    let PCA = null;
    try {
        PCA = require("ml-pca").PCA;
    } catch (err) {
        // Library not available - will show error on node creation
    }

    // SPE of a sample the model reproduces exactly is zero up to rounding
    // (~1e-30). A limit of exactly zero would turn that rounding noise into
    // alarms, so the limit never drops below this (standardised units squared).
    const SPE_LIMIT_FLOOR = 1e-8;

    function PcaAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Check if required libraries are available
        if (!PCA) {
            node.error("Required libraries not found. Please install: npm install ml-pca ml-matrix");
            node.status({ fill: "red", shape: "ring", text: "Missing ml-pca/ml-matrix" });
            return;
        }

        // Configuration
        this.nComponents = clampInt(config.nComponents, 1, 1000, 2);
        this.windowSize = clampInt(config.windowSize, 2, MAX_WINDOW_SIZE, 100);
        this.threshold = clampFloat(config.threshold, 0.1, 1000, 3.0);
        this.method = config.method || "t2"; // t2 (Hotelling's T²), spe (Squared Prediction Error), combined
        this.autoComponents = config.autoComponents !== false; // Auto-select components by explained variance
        this.varianceThreshold = clampFloat(config.varianceThreshold, 0.01, 1, 0.95); // 95% variance explained
        this.contributionThreshold = clampFloat(config.contributionThreshold, 0, 1, 0.1); // Min contribution to show
        this.showTopContributors = clampInt(config.showTopContributors, 1, 100, 3); // Max contributors to show
        // "window": refit on the anomaly-free window every windowSize normal
        // samples, so slow, legitimate drift is followed. "off": the model is
        // frozen once it has been fitted on a full window.
        this.retrainMode = config.retrainMode === "off" ? "off" : "window";
        this.outputTopic = config.outputTopic || "";
        // Kept off `this.debug`: that name is Node-RED's own logger method, and
        // overwriting it with a boolean breaks every node.debug(...) call — state
        // persistence logs through it too.
        this.debugEnabled = config.debug === true;
        this.persistState = config.persistState === true;

        // Per-device grouping: one independent model per value of a message
        // property (e.g. "topic"). Empty = one shared model (default, legacy).
        this.groupBy = typeof config.groupBy === "string" ? config.groupBy.trim() : "";
        this.maxGroups = clampInt(config.maxGroups, 1, 10000, 50);

        // Samples needed before the first fit. Never more than the window can hold.
        const minTrainSamples = Math.min(node.windowSize, Math.max(10, Math.ceil(node.windowSize * 0.5)));

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
                dataBuffer: [],
                featureNames: null, // frozen on the first accepted sample
                pcaModel: null, // ml-pca model instance
                mean: null, // For standardization
                stdDev: null, // For standardization
                isTrained: false,
                nComponents: node.nComponents,
                eigenvalues: null,
                eigenvectors: null, // [feature][component]
                cumulativeVariance: null,
                t2Threshold: null,
                speThreshold: null,
                trainedOn: 0, // samples the current model was fitted on
                sinceTrain: 0, // normal samples accepted since that fit
                fullWindowFit: false
            };
        }

        // Fetch (or create) the state for a key. The map is kept in LRU order, so
        // an unbounded key space evicts the least recently used model.
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

        // Backwards-compatible read-only view of the default (ungrouped) model.
        // With grouping enabled it only describes traffic without a group value.
        ["dataBuffer", "pcaModel", "mean", "stdDev", "isTrained", "t2Threshold", "speThreshold"].forEach(
            function (prop) {
                Object.defineProperty(node, prop, {
                    configurable: true,
                    get: function () {
                        const state = node.groups.get(DEFAULT_GROUP);
                        if (state) return state[prop];
                        return prop === "dataBuffer" ? [] : prop === "isTrained" ? false : null;
                    }
                });
            }
        );

        // Prefix status text with the group key so a shared node stays readable
        function groupText(state, text) {
            return node.groupBy && state.key !== DEFAULT_GROUP ? state.key + ": " + text : text;
        }

        // Derive everything scoring needs from a fitted (or restored) model:
        // cached eigen-decomposition, component count and control limits. The
        // limits are a pure function of the model and the configured threshold,
        // so they are recomputed on restore instead of being trusted from disk.
        function finalizeModel(state, trainedOn) {
            const model = state.pcaModel;
            state.eigenvalues = model.getEigenvalues();
            // U has one row per feature and one column per component. (ml-pca's
            // getLoadings() returns the transpose — rows are components.)
            state.eigenvectors = model.getEigenvectors().to2DArray();
            state.cumulativeVariance = model.getCumulativeVariance();

            const nFeatures = state.eigenvectors.length;
            let k = node.nComponents;
            if (node.autoComponents) {
                k = state.cumulativeVariance.length;
                for (let i = 0; i < state.cumulativeVariance.length; i++) {
                    if (state.cumulativeVariance[i] >= node.varianceThreshold) {
                        k = i + 1;
                        break;
                    }
                }
            }
            k = Math.max(1, Math.min(k, nFeatures, state.eigenvalues.length));
            state.nComponents = k;
            state.trainedOn = trainedOn;

            // `threshold` is sigma-like: it is the one-sided normal quantile of
            // the confidence level (3 ≈ 99.87%).
            //
            // T² of a new sample against a model estimated from n samples
            // follows a scaled F distribution; it only approaches chi-squared
            // with k degrees of freedom for large n. The chi-squared limit is
            // the fallback when n is too small for the F limit to exist.
            state.t2Threshold = hotellingLimitFromZ(k, trainedOn, node.threshold);
            if (!Number.isFinite(state.t2Threshold)) {
                state.t2Threshold = chiSquaredQuantileFromZ(k, node.threshold);
                debugLog("Only " + trainedOn + " samples for " + k + " components: T² limit falls back to chi-squared");
            }

            // SPE: weighted chi-squared approximation (Box) from the discarded
            // eigenvalues, SPE ~ g·χ²(h) with g = θ2/θ1 and h = θ1²/θ2.
            let theta1 = 0;
            let theta2 = 0;
            for (let i = k; i < state.eigenvalues.length; i++) {
                const ev = state.eigenvalues[i];
                if (ev > 0) {
                    theta1 += ev;
                    theta2 += ev * ev;
                }
            }
            let speLimit = 0;
            if (theta2 > 0) {
                speLimit = (theta2 / theta1) * chiSquaredQuantileFromZ((theta1 * theta1) / theta2, node.threshold);
            }
            state.speThreshold = Math.max(speLimit, SPE_LIMIT_FLOOR);
        }

        // Initialize state persistence using helper.
        // Declared with `let` so onStateLoaded — which only runs once the async
        // load resolves — can reach the manager.
        let persistence = null;
        persistence = persistenceHelper.initializeStatePersistence(node, {
            stateKey: "pcaAnomalyState",
            saveInterval: 60000,
            debug: node.debugEnabled,
            onStateLoaded: function (state) {
                // v2 stores one entry per group; v1 stored a single flat model,
                // which restores into the default (ungrouped) bucket.
                const saved = state.groups || (state.pcaModelJSON || state.dataBuffer ? { "": state } : null);
                if (!saved) {
                    return;
                }

                let restoredModels = 0;
                Object.keys(saved).forEach(function (key) {
                    const entry = saved[key];
                    if (!entry || typeof entry !== "object") {
                        return;
                    }
                    const rawBuffer = Array.isArray(entry.dataBuffer) ? entry.dataBuffer : [];
                    const target = getGroupState(key);
                    target.dataBuffer = rawBuffer
                        .filter(function (d) {
                            return d && Array.isArray(d.values);
                        })
                        .map(function (d) {
                            return { timestamp: d.timestamp, values: d.values };
                        });

                    if (Array.isArray(entry.featureNames)) {
                        target.featureNames = entry.featureNames;
                    } else if (rawBuffer.length > 0 && Array.isArray(rawBuffer[0].names)) {
                        target.featureNames = rawBuffer[0].names; // v1 kept names per sample
                    } else if (Array.isArray(entry.mean)) {
                        target.featureNames = entry.mean.map(function (m, i) {
                            return "sensor" + i;
                        });
                    }

                    target.sinceTrain = entry.sinceTrain || 0;
                    target.fullWindowFit = entry.fullWindowFit === true;

                    if (entry.pcaModelJSON && Array.isArray(entry.mean) && Array.isArray(entry.stdDev)) {
                        try {
                            target.pcaModel = PCA.load(entry.pcaModelJSON);
                            target.mean = entry.mean;
                            target.stdDev = entry.stdDev;
                            finalizeModel(target, entry.trainedOn || target.dataBuffer.length || node.windowSize);
                            target.isTrained = true;
                            restoredModels++;
                        } catch (err) {
                            // Leave the group untrained: it refits from the
                            // restored buffer on the next sample.
                            target.pcaModel = null;
                            target.isTrained = false;
                            debugLog("Failed to restore PCA model for group '" + key + "': " + err.message);
                        }
                    }
                });

                if (!state.groups && persistence) {
                    // Migrated a v1 payload: drop the flat keys so the stored blob
                    // does not carry a stale copy of the model forever.
                    [
                        "dataBuffer",
                        "mean",
                        "stdDev",
                        "pcaModelJSON",
                        "isTrained",
                        "t2Threshold",
                        "speThreshold",
                        "nComponents"
                    ].forEach(function (key) {
                        persistence.manager.delete(key);
                    });
                }

                if (restoredModels > 0) {
                    const scope = node.groupBy ? " (" + restoredModels + " groups)" : "";
                    node.status({ fill: "green", shape: "dot", text: "PCA - restored (trained)" + scope });
                    debugLog("Restored trained PCA model from persistence" + scope);
                }
            },
            getStateToSave: function () {
                // Always returns the full group map — including an empty one —
                // so a reset is persisted instead of leaving the old model on disk.
                const groups = {};
                node.groups.forEach(function (state, key) {
                    if (!state.featureNames) {
                        return;
                    }
                    groups[key] = {
                        dataBuffer: state.dataBuffer,
                        featureNames: state.featureNames,
                        mean: state.mean,
                        stdDev: state.stdDev,
                        pcaModelJSON: state.isTrained && state.pcaModel ? state.pcaModel.toJSON() : null,
                        isTrained: state.isTrained,
                        trainedOn: state.trainedOn,
                        sinceTrain: state.sinceTrain,
                        fullWindowFit: state.fullWindowFit
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

        node.status({ fill: "blue", shape: "ring", text: "PCA - waiting for data" });

        // Helper: Calculate mean of each column
        function calculateColumnMeans(data) {
            const nCols = data[0].length;
            const means = new Array(nCols).fill(0);

            for (let i = 0; i < data.length; i++) {
                for (let j = 0; j < nCols; j++) {
                    means[j] += data[i][j];
                }
            }

            for (let j = 0; j < nCols; j++) {
                means[j] /= data.length;
            }

            return means;
        }

        // Helper: Calculate standard deviation of each column
        function calculateColumnStdDevs(data, means) {
            const nCols = data[0].length;
            const stdDevs = new Array(nCols).fill(0);

            for (let i = 0; i < data.length; i++) {
                for (let j = 0; j < nCols; j++) {
                    stdDevs[j] += Math.pow(data[i][j] - means[j], 2);
                }
            }

            for (let j = 0; j < nCols; j++) {
                stdDevs[j] = Math.sqrt(stdDevs[j] / data.length);
                if (stdDevs[j] === 0) stdDevs[j] = 1; // Avoid division by zero
            }

            return stdDevs;
        }

        // Helper: Standardize single sample
        function standardizeSample(sample, means, stdDevs) {
            return sample.map(function (val, j) {
                return (val - means[j]) / stdDevs[j];
            });
        }

        // Fit the PCA model of a group on its buffer (ml-pca, SVD-based).
        // On failure the previous model, if any, stays in place.
        function trainPCA(state) {
            if (state.dataBuffer.length < minTrainSamples) {
                return false;
            }

            const data = state.dataBuffer.map(function (d) {
                return d.values;
            });

            const mean = calculateColumnMeans(data);
            const stdDev = calculateColumnStdDevs(data, mean);
            const standardizedData = data.map(function (row) {
                return standardizeSample(row, mean, stdDev);
            });

            let model;
            try {
                model = new PCA(standardizedData, {
                    center: false, // Already centered via standardization
                    scale: false // Already scaled via standardization
                });
            } catch (err) {
                node.error("PCA training failed: " + err.message);
                return false;
            }

            state.pcaModel = model;
            state.mean = mean;
            state.stdDev = stdDev;
            finalizeModel(state, data.length);
            state.isTrained = true;
            state.sinceTrain = 0;
            if (data.length >= node.windowSize) {
                state.fullWindowFit = true;
            }

            debugLog(
                "PCA trained on " +
                    data.length +
                    " samples: " +
                    state.nComponents +
                    " components (" +
                    (state.cumulativeVariance[state.nComponents - 1] * 100).toFixed(1) +
                    "% variance), T² limit: " +
                    state.t2Threshold.toFixed(4) +
                    ", SPE limit: " +
                    state.speThreshold.toFixed(4)
            );

            // Persist trained model
            persistCurrentState();

            return true;
        }

        // Calculate T² and SPE statistics for a standardized sample
        function calculateStatistics(state, standardizedSample) {
            if (!state.isTrained || !state.eigenvectors) return null;

            const U = state.eigenvectors;
            const k = state.nComponents;
            const p = standardizedSample.length;

            // Project onto the retained principal components
            const scores = new Array(k);
            let t2 = 0;
            for (let i = 0; i < k; i++) {
                let s = 0;
                for (let j = 0; j < p; j++) {
                    s += standardizedSample[j] * U[j][i];
                }
                scores[i] = s;
                if (state.eigenvalues[i] > 1e-10) {
                    t2 += (s * s) / state.eigenvalues[i];
                }
            }

            // Reconstruct from the retained components; SPE is what is left over
            const reconstructed = new Array(p);
            let spe = 0;
            for (let j = 0; j < p; j++) {
                let r = 0;
                for (let i = 0; i < k; i++) {
                    r += scores[i] * U[j][i];
                }
                reconstructed[j] = r;
                const residual = standardizedSample[j] - r;
                spe += residual * residual;
            }

            return { scores: scores, t2: t2, spe: spe, reconstructed: reconstructed };
        }

        // Pull named, finite numeric features out of a payload. Array entries
        // keep the name of their ORIGINAL position, so a dropped (non-finite)
        // entry cannot shift its neighbours onto the wrong sensor.
        function extractFeatures(payload) {
            const names = [];
            const values = [];

            if (Array.isArray(payload)) {
                payload.forEach(function (v, i) {
                    if (typeof v === "number" && Number.isFinite(v)) {
                        names.push("sensor" + i);
                        values.push(v);
                    }
                });
            } else if (typeof payload === "object" && payload !== null) {
                Object.keys(payload).forEach(function (key) {
                    const val = payload[key];
                    if (typeof val === "number" && Number.isFinite(val)) {
                        names.push(key);
                        values.push(val);
                    } else if (typeof val === "string") {
                        const parsed = parseFloat(val);
                        if (Number.isFinite(parsed)) {
                            names.push(key);
                            values.push(parsed);
                        }
                    }
                });
            } else {
                return null;
            }

            return { names: names, values: values };
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
                    node.status({ fill: "blue", shape: "ring", text: "PCA - reset" });
                    done();
                    return;
                }

                // Extract multi-dimensional input
                const features = extractFeatures(msg.payload);
                if (!features) {
                    done("Payload must be an array or object with multiple sensor values");
                    return;
                }

                const state = getGroupState(resolveGroupKey(msg));

                // The feature set is frozen on the first accepted sample. From
                // then on values are matched BY NAME, so key order, extra keys
                // and dropped entries cannot land a value in the wrong column.
                let values;
                if (!state.featureNames) {
                    if (features.values.length < 2) {
                        done("At least 2 sensor values are required for PCA");
                        return;
                    }
                    state.featureNames = features.names.slice();
                    values = features.values;
                } else {
                    const lookup = new Map();
                    features.names.forEach(function (name, i) {
                        lookup.set(name, features.values[i]);
                    });
                    const missing = state.featureNames.filter(function (name) {
                        return !lookup.has(name);
                    });
                    if (missing.length > 0) {
                        node.status({
                            fill: "yellow",
                            shape: "ring",
                            text: groupText(state, "skipped: no value for " + missing[0])
                        });
                        done(
                            "Sample skipped: no finite value for feature(s) " +
                                missing.join(", ") +
                                " (send msg.reset to relearn the feature set)"
                        );
                        return;
                    }
                    values = state.featureNames.map(function (name) {
                        return lookup.get(name);
                    });
                }
                const valueNames = state.featureNames;
                const sample = { timestamp: Date.now(), values: values };
                let alreadyBuffered = false;

                // Warm-up: collect, then fit once enough samples are in
                if (!state.isTrained) {
                    state.dataBuffer.push(sample);
                    if (state.dataBuffer.length > node.windowSize) {
                        state.dataBuffer.shift();
                    }

                    if (state.dataBuffer.length < minTrainSamples || !trainPCA(state)) {
                        if (state.dataBuffer.length < minTrainSamples) {
                            node.status({
                                fill: "yellow",
                                shape: "ring",
                                text: groupText(state, "Training: " + state.dataBuffer.length + "/" + minTrainSamples)
                            });
                        }
                        send([msg, null]);
                        done();
                        return;
                    }
                    alreadyBuffered = true;
                }

                // Standardize current sample
                const standardizedSample = standardizeSample(values, state.mean, state.stdDev);

                // Calculate statistics
                const stats = calculateStatistics(state, standardizedSample);

                if (!stats) {
                    send([msg, null]);
                    done();
                    return;
                }

                // Determine anomaly
                const isT2Anomaly = stats.t2 > state.t2Threshold;
                const isSPEAnomaly = stats.spe > state.speThreshold;
                let isAnomaly = false;

                switch (node.method) {
                    case "t2":
                        isAnomaly = isT2Anomaly;
                        break;
                    case "spe":
                        isAnomaly = isSPEAnomaly;
                        break;
                    case "combined":
                    default:
                        isAnomaly = isT2Anomaly || isSPEAnomaly;
                }

                // Calculate contribution to anomaly for each sensor
                let contributions = [];
                let totalContribution = 0;

                for (let i = 0; i < values.length; i++) {
                    const contrib = Math.abs(standardizedSample[i] - stats.reconstructed[i]);
                    totalContribution += contrib;
                    contributions.push({
                        sensor: valueNames[i],
                        contribution: contrib,
                        originalValue: values[i],
                        reconstructedValue: stats.reconstructed[i] * state.stdDev[i] + state.mean[i]
                    });
                }

                // Normalize and sort contributions
                contributions = contributions.map(function (c) {
                    c.normalizedContribution = totalContribution > 0 ? c.contribution / totalContribution : 0;
                    c.percentContribution = (c.normalizedContribution * 100).toFixed(1) + "%";
                    return c;
                });
                contributions.sort(function (a, b) {
                    return b.contribution - a.contribution;
                });

                // Filter by threshold and limit to top N
                const filteredContributions = contributions
                    .filter(function (c) {
                        return c.normalizedContribution >= node.contributionThreshold;
                    })
                    .slice(0, node.showTopContributors);

                // Explained variance of the retained components
                const explainedVarianceRatio = state.cumulativeVariance[state.nComponents - 1];

                // Build output message
                const outputMsg = {
                    payload: msg.payload,
                    isAnomaly: isAnomaly,
                    method: "pca-" + node.method,
                    pca: {
                        scores: stats.scores,
                        t2: stats.t2,
                        t2Threshold: state.t2Threshold,
                        t2Anomaly: isT2Anomaly,
                        spe: stats.spe,
                        speThreshold: state.speThreshold,
                        speAnomaly: isSPEAnomaly,
                        nComponents: state.nComponents,
                        explainedVariance: explainedVarianceRatio,
                        eigenvalues: state.eigenvalues.slice(0, state.nComponents)
                    },
                    contributions: filteredContributions.length > 0 ? filteredContributions : undefined,
                    allContributions: isAnomaly ? contributions : undefined,
                    topContributor: contributions.length > 0 ? contributions[0].sensor : null,
                    sensorNames: valueNames,
                    bufferSize: state.dataBuffer.length,
                    timestamp: Date.now()
                };

                if (node.outputTopic) {
                    outputMsg.topic = node.outputTopic;
                }
                if (node.groupBy) {
                    outputMsg.group = state.key;
                }

                // Preserve original message properties
                copyPassthrough(outputMsg, msg);

                // Update status
                const statusColor = isAnomaly ? "red" : "green";
                let statusText = "T²=" + stats.t2.toFixed(2) + " SPE=" + stats.spe.toFixed(2);
                if (isAnomaly && contributions.length > 0) {
                    statusText = "ANOMALY: " + contributions[0].sensor;
                }
                node.status({
                    fill: statusColor,
                    shape: isAnomaly ? "ring" : "dot",
                    text: groupText(state, statusText)
                });

                // Send to appropriate output
                if (isAnomaly) {
                    send([null, outputMsg]);
                } else {
                    send([outputMsg, null]);
                }

                // Only samples judged normal join the reference window, so a
                // fault cannot teach the model that faulty is the new normal.
                if (!isAnomaly && !alreadyBuffered) {
                    state.dataBuffer.push(sample);
                    if (state.dataBuffer.length > node.windowSize) {
                        state.dataBuffer.shift();
                    }
                    state.sinceTrain++;
                }

                // The first fit runs on half a window to get going early; refit
                // once the window is full, then (retrainMode "window") every time
                // it has turned over with normal samples.
                const windowFull = state.dataBuffer.length >= node.windowSize;
                if (
                    windowFull &&
                    (!state.fullWindowFit || (node.retrainMode === "window" && state.sinceTrain >= node.windowSize))
                ) {
                    if (!trainPCA(state)) {
                        // Do not retry a failing fit on every message
                        state.fullWindowFit = true;
                        state.sinceTrain = 0;
                    }
                }
                done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "error" });
                done("Error in PCA analysis: " + err.message);
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

    RED.nodes.registerType("pca-anomaly", PcaAnomalyNode);
};
