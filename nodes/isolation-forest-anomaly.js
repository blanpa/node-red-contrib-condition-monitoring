module.exports = function (RED) {
    "use strict";

    // Upper bound for the sliding window. Every sample touches the live window,
    // so the ceiling is a usability guard, not a formality — the old 1_000_000
    // let a single message cost a million-element pass.
    const MAX_WINDOW_SIZE = 100000;

    // Admin-route auth guard (Node-RED does not apply adminAuth to httpAdmin routes)
    const { needsPermission } = require("./utils/admin-auth");

    // Import shared statistics utilities
    const stats = require("./utils/statistics");

    // Import state persistence helper
    const persistenceHelper = require("./utils/persistence-helper");

    const { clampInt, clampFloat } = require("./utils/config-validator");
    const groupState = require("./utils/group-state");
    const { copyPassthrough } = require("./utils/message");

    // Samples needed before the first forest is built.
    const MIN_TRAIN_SAMPLES = 10;

    // The threshold is calibrated on at most this many (evenly spaced) training
    // points, so a refit on a very large window stays cheap.
    const MAX_CALIBRATION_POINTS = 2000;

    // Isolation-forest scores at or below 0.5 mean "no easier to isolate than
    // an average point" (Liu et al. 2008). Nothing below it is ever an anomaly,
    // whatever the contamination quantile says.
    const SCORE_FLOOR = 0.5;

    // c(n): average path length of an unsuccessful BST search over n points —
    // the normaliser of the isolation-forest score.
    function averagePathLength(n) {
        if (n <= 1) return 0;
        if (n === 2) return 1;
        return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n;
    }

    // Draw `count` rows without replacement.
    function subsample(rows, count) {
        const n = rows.length;
        if (count >= n) return rows;
        const picked = [];
        if (count * 2 < n) {
            const seen = new Set();
            while (picked.length < count) {
                const idx = Math.floor(Math.random() * n);
                if (!seen.has(idx)) {
                    seen.add(idx);
                    picked.push(rows[idx]);
                }
            }
            return picked;
        }
        const pool = rows.slice();
        for (let i = 0; i < count; i++) {
            const j = i + Math.floor(Math.random() * (n - i));
            const tmp = pool[i];
            pool[i] = pool[j];
            pool[j] = tmp;
            picked.push(pool[i]);
        }
        return picked;
    }

    function IsolationForestAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Load Isolation Forest only if available
        let IsolationForest = null;
        try {
            IsolationForest = require("ml-isolation-forest").IsolationForest;
        } catch (err) {
            node.warn("ml-isolation-forest not available. Please install: npm install ml-isolation-forest");
        }

        this.contamination = clampFloat(config.contamination, 0.001, 0.5, 0.1);
        this.windowSize = clampInt(config.windowSize, 2, MAX_WINDOW_SIZE, 100);
        this.numEstimators = clampInt(config.numEstimators, 1, 10000, 100);
        this.maxSamples = clampInt(config.maxSamples, 1, 1000000, 256);
        this.outputTopic = config.outputTopic || "";
        // Kept off `this.debug`: that name is Node-RED's own logger method, and
        // overwriting it with a boolean breaks every node.debug(...) call — state
        // persistence logs through it too.
        this.debugEnabled = config.debug === true;

        // Learning settings
        //   batch       – refit each time the window has turned over
        //   incremental – refit every retrainInterval samples
        //   adaptive    – as incremental, and the threshold additionally tracks
        //                 the recent score distribution at adaptRate
        // Any other non-empty value (the bundled example flow says "online")
        // has always behaved as incremental, so it still does.
        if (["batch", "incremental", "adaptive"].includes(config.learningMode)) {
            this.learningMode = config.learningMode;
        } else {
            this.learningMode = config.learningMode ? "incremental" : "batch";
        }
        this.retrainInterval = clampInt(config.retrainInterval, 1, 1000000, 50); // Retrain every N samples
        this.adaptRate = clampFloat(config.adaptRate, 0.001, 1, 0.1); // Adaptation rate for adaptive mode
        this.persistState = config.persistState === true;

        // Per-device grouping: one independent forest per value of a message
        // property (e.g. "topic"). Empty = one shared forest (default, legacy).
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
                dataBuffer: [],
                scoreBuffer: [], // recent scores, used by adaptive mode
                model: null, // { trees, subsampleSize }
                isTrained: false,
                anomalyThreshold: SCORE_FLOOR,
                sampleCount: 0, // Total samples processed
                lastRetrainCount: 0, // Samples at last retrain
                fullWindowFit: false
            };
        }

        // Fetch (or create) the state for a key. The map is kept in LRU order, so
        // an unbounded key space evicts the least recently used forest.
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
        const legacyDefaults = {
            dataBuffer: [],
            scoreBuffer: [],
            model: null,
            isTrained: false,
            anomalyThreshold: SCORE_FLOOR,
            sampleCount: 0,
            lastRetrainCount: 0
        };
        Object.keys(legacyDefaults).forEach(function (prop) {
            Object.defineProperty(node, prop, {
                configurable: true,
                get: function () {
                    const state = node.groups.get(DEFAULT_GROUP);
                    return state ? state[prop] : legacyDefaults[prop];
                }
            });
        });

        // Prefix status text with the group key so a shared node stays readable
        function groupText(state, text) {
            return node.groupBy && state.key !== DEFAULT_GROUP ? state.key + ": " + text : text;
        }

        // Initialize state persistence using helper
        // Note: the forest itself is not serialized; the buffer is, and the
        // forest is rebuilt from it on restore.
        let persistence = null;
        persistence = persistenceHelper.initializeStatePersistence(node, {
            stateKey: "isolationForestState",
            saveInterval: 60000,
            debug: node.debugEnabled,
            onStateLoaded: function (state) {
                // v2 stores one entry per group; v1 stored a single flat buffer,
                // which restores into the default (ungrouped) bucket.
                // Decided up front: `state` is the manager's live object, and the
                // retrain below saves the v2 layout into it.
                const isLegacy = !state.groups;
                const saved = state.groups || (Array.isArray(state.dataBuffer) ? { "": state } : null);
                if (!saved) {
                    return;
                }

                let restored = 0;
                Object.keys(saved).forEach(function (key) {
                    const entry = saved[key];
                    if (!entry || !Array.isArray(entry.dataBuffer) || entry.dataBuffer.length === 0) {
                        return;
                    }
                    const target = getGroupState(key);
                    target.dataBuffer = entry.dataBuffer.filter(function (d) {
                        return d && Number.isFinite(d.value);
                    });
                    target.scoreBuffer = Array.isArray(entry.scoreBuffer) ? entry.scoreBuffer : [];
                    target.sampleCount = entry.sampleCount || 0;
                    target.lastRetrainCount = entry.lastRetrainCount || 0;
                    restored += target.dataBuffer.length;

                    // Re-train model from restored buffer
                    if (target.dataBuffer.length >= MIN_TRAIN_SAMPLES && IsolationForest) {
                        trainModel(target, "restored");
                        // The adaptive threshold is learned state; a fresh
                        // calibration would throw it away.
                        if (node.learningMode === "adaptive" && Number.isFinite(entry.anomalyThreshold)) {
                            target.anomalyThreshold = Math.max(SCORE_FLOOR, entry.anomalyThreshold);
                        }
                    }
                });

                if (isLegacy && persistence) {
                    // Migrated a v1 payload: drop the flat keys so the stored blob
                    // does not carry a stale copy of the buffer forever.
                    [
                        "dataBuffer",
                        "scoreBuffer",
                        "anomalyThreshold",
                        "sampleCount",
                        "lastRetrainCount",
                        "isTrained"
                    ].forEach(function (key) {
                        persistence.manager.delete(key);
                    });
                }

                if (restored > 0) {
                    debugLog("Restored and retrained Isolation Forest from " + restored + " buffered samples");
                }
            },
            getStateToSave: function () {
                // Always the full group map — including an empty one — so a
                // reset is persisted instead of leaving the old buffer on disk.
                const groups = {};
                node.groups.forEach(function (state, key) {
                    if (state.dataBuffer.length === 0) {
                        return;
                    }
                    groups[key] = {
                        dataBuffer: state.dataBuffer,
                        scoreBuffer: state.scoreBuffer,
                        anomalyThreshold: state.anomalyThreshold,
                        sampleCount: state.sampleCount,
                        lastRetrainCount: state.lastRetrainCount,
                        isTrained: state.isTrained
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

        // Features of the sample at `index`: its value and the step from the
        // previous one. (No time index: the newest sample would always sit at
        // the edge of that feature and score as easier to isolate.)
        function featuresAt(buffer, index) {
            const value = buffer[index].value;
            return [value, index > 0 ? value - buffer[index - 1].value : 0];
        }

        // Anomaly score in (0, 1]; higher = easier to isolate = more anomalous.
        function scoreFeatures(model, features) {
            // The trees only partition the range they were trained on: a value
            // far outside it follows the same branches as the most extreme
            // training sample and gets that sample's score, however far out it
            // lies — so it merely ties with the calibrated threshold. A feature
            // more than one full training range beyond that range is therefore
            // novel by definition. The same rule covers a feature that never
            // varied in training (range 0), where the trees have nothing to
            // split on at all.
            for (let f = 0; f < features.length; f++) {
                const lo = model.featureMin[f];
                const hi = model.featureMax[f];
                const margin = hi > lo ? hi - lo : 1e-9 * Math.max(1, Math.abs(lo));
                if (features[f] < lo - margin || features[f] > hi + margin) return 1;
            }

            const normaliser = averagePathLength(model.subsampleSize);
            if (normaliser === 0) return SCORE_FLOOR;
            let total = 0;
            for (let i = 0; i < model.trees.length; i++) {
                total += model.trees[i].pathLengthFromRoot(features, 0);
            }
            return Math.pow(2, -(total / model.trees.length) / normaliser);
        }

        function trainModel(state, modeLabel) {
            if (!IsolationForest || state.dataBuffer.length < MIN_TRAIN_SAMPLES) {
                return;
            }

            try {
                const buffer = state.dataBuffer;
                const trainingData = buffer.map(function (d, index) {
                    return featuresAt(buffer, index);
                });

                // ml-isolation-forest grows every tree on the whole set it is
                // given and only knows `nEstimators`. Each tree is therefore
                // grown as its own one-tree forest on its own subsample, which is
                // what makes numEstimators and maxSamples take effect.
                const subsampleSize = Math.min(node.maxSamples, trainingData.length);
                debugLog(
                    "Training Isolation Forest (" +
                        modeLabel +
                        "): trees=" +
                        node.numEstimators +
                        ", samples=" +
                        subsampleSize
                );

                const trees = [];
                for (let t = 0; t < node.numEstimators; t++) {
                    const single = new IsolationForest({ nEstimators: 1 });
                    single.train(subsample(trainingData, subsampleSize));
                    trees.push(single.forest[0]);
                }
                const featureMin = trainingData[0].slice();
                const featureMax = trainingData[0].slice();
                trainingData.forEach(function (row) {
                    for (let f = 0; f < row.length; f++) {
                        if (row[f] < featureMin[f]) featureMin[f] = row[f];
                        if (row[f] > featureMax[f]) featureMax[f] = row[f];
                    }
                });
                const model = {
                    trees: trees,
                    subsampleSize: subsampleSize,
                    featureMin: featureMin,
                    featureMax: featureMax
                };

                // Calibrate the threshold on the training scores: the
                // contamination share with the highest scores counts as
                // anomalous, but never anything at or below SCORE_FLOOR. It then
                // stays fixed until the next fit.
                const step = Math.max(1, Math.ceil(trainingData.length / MAX_CALIBRATION_POINTS));
                const calibration = [];
                for (let i = 0; i < trainingData.length; i += step) {
                    calibration.push(scoreFeatures(model, trainingData[i]));
                }
                calibration.sort(function (a, b) {
                    return b - a;
                }); // Sort descending
                const thresholdIndex = Math.min(
                    calibration.length - 1,
                    Math.floor(calibration.length * node.contamination)
                );

                state.model = model;
                state.isTrained = true;
                state.lastRetrainCount = state.sampleCount;
                state.anomalyThreshold = Math.max(SCORE_FLOOR, calibration[thresholdIndex]);
                if (buffer.length >= node.windowSize) {
                    state.fullWindowFit = true;
                }

                // Update status
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: groupText(state, "Trained (" + modeLabel + ") | n=" + buffer.length)
                });

                // Persist after training
                persistCurrentState();
            } catch (err) {
                node.error("Error training Isolation Forest: " + err.message);
                state.isTrained = false;
                state.model = null;
            }
        }

        // Is a refit due?
        function shouldRetrain(state) {
            // The first forest is grown on very few samples to get going early;
            // replace it as soon as a full window is available.
            if (!state.fullWindowFit && state.dataBuffer.length >= node.windowSize) {
                return true;
            }
            const samplesSinceRetrain = state.sampleCount - state.lastRetrainCount;
            if (node.learningMode === "batch") {
                return samplesSinceRetrain >= node.windowSize;
            }
            return samplesSinceRetrain >= node.retrainInterval;
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
                    node.status({ fill: "blue", shape: "ring", text: "reset" });
                    done();
                    return;
                }

                // Extract value from message
                const value = parseFloat(msg.payload);

                // Validate value is a finite number (catches NaN, Infinity, -Infinity)
                if (!Number.isFinite(value)) {
                    done("Payload is not a valid finite number");
                    return;
                }

                const state = getGroupState(resolveGroupKey(msg));

                // Add value to buffer
                state.dataBuffer.push({
                    timestamp: Date.now(),
                    value: value
                });

                // Increment sample count
                state.sampleCount++;

                // Limit buffer to maximum size
                if (state.dataBuffer.length > node.windowSize) {
                    state.dataBuffer.shift();
                }

                // Train model when enough data is available, refit when due
                if (!state.isTrained) {
                    if (state.dataBuffer.length >= MIN_TRAIN_SAMPLES) {
                        trainModel(state, "full");
                    }
                } else if (shouldRetrain(state)) {
                    trainModel(state, node.learningMode === "batch" ? "full" : "incremental");
                }

                // If Isolation Forest is not available or not trained, use simple fallback method
                if (!IsolationForest || !state.isTrained) {
                    // Fallback: Z-Score based detection using shared utilities
                    if (state.dataBuffer.length < 2) {
                        send([msg, null]);
                        done();
                        return;
                    }

                    const values = state.dataBuffer.map((d) => d.value);
                    const zScoreResult = stats.calculateZScore(value, values);
                    const zScore = zScoreResult.zScore;
                    const isFallbackAnomaly = Math.abs(zScore) > 3.0;

                    const fallbackMsg = {
                        payload: value,
                        isAnomaly: isFallbackAnomaly,
                        method: "fallback-zscore",
                        zScore: zScore,
                        timestamp: Date.now()
                    };
                    if (node.outputTopic) {
                        fallbackMsg.topic = node.outputTopic;
                    }
                    if (node.groupBy) {
                        fallbackMsg.group = state.key;
                    }
                    copyPassthrough(fallbackMsg, msg, { preserveTopic: !node.outputTopic });

                    if (isFallbackAnomaly) {
                        send([null, fallbackMsg]);
                    } else {
                        send([fallbackMsg, null]);
                    }
                    done();
                    return;
                }

                // Isolation Forest prediction
                const features = featuresAt(state.dataBuffer, state.dataBuffer.length - 1);
                const score = scoreFeatures(state.model, features); // higher = more anomalous

                // Strictly above the calibrated threshold: a tie with it (e.g. a
                // flat signal, where every score is identical) is not an anomaly.
                const isAnomaly = score > state.anomalyThreshold;
                const usedThreshold = state.anomalyThreshold;

                // Adaptive mode: let the threshold follow the contamination
                // quantile of the recent scores, smoothed by adaptRate. The other
                // modes keep the threshold calibrated at training time — a
                // quantile recomputed on every sample flags a fixed share of the
                // stream no matter what the data looks like.
                if (node.learningMode === "adaptive") {
                    state.scoreBuffer.push(score);
                    if (state.scoreBuffer.length > node.windowSize) {
                        state.scoreBuffer.shift();
                    }
                    if (state.scoreBuffer.length >= MIN_TRAIN_SAMPLES) {
                        const sortedScores = state.scoreBuffer.slice().sort(function (a, b) {
                            return b - a;
                        });
                        const recent =
                            sortedScores[
                                Math.min(sortedScores.length - 1, Math.floor(sortedScores.length * node.contamination))
                            ];
                        state.anomalyThreshold = Math.max(
                            SCORE_FLOOR,
                            (1 - node.adaptRate) * state.anomalyThreshold + node.adaptRate * recent
                        );
                    }
                }

                debugLog(
                    "Score: " +
                        score.toFixed(4) +
                        ", Threshold: " +
                        usedThreshold.toFixed(4) +
                        ", Anomaly: " +
                        isAnomaly
                );

                // Create output message
                const outputMsg = {
                    payload: value,
                    isAnomaly: isAnomaly,
                    anomalyScore: score,
                    threshold: usedThreshold,
                    method: "isolation-forest",
                    learningMode: node.learningMode,
                    contamination: node.contamination,
                    numEstimators: node.numEstimators,
                    sampleCount: state.sampleCount,
                    bufferSize: state.dataBuffer.length,
                    lastRetrain: state.lastRetrainCount,
                    timestamp: Date.now()
                };

                // Set topic if configured
                if (node.outputTopic) {
                    outputMsg.topic = node.outputTopic;
                }
                if (node.groupBy) {
                    outputMsg.group = state.key;
                }

                // Copy original message properties; keep the inbound topic when
                // no output topic is configured.
                copyPassthrough(outputMsg, msg, { preserveTopic: !node.outputTopic });

                // Anomalies to output 1, normal values to output 0
                if (isAnomaly) {
                    send([null, outputMsg]);
                } else {
                    send([outputMsg, null]);
                }
                done();
            } catch (err) {
                done("Error in Isolation Forest calculation: " + err.message);
            }
        });

        node.on("close", async function (done) {
            // Save state before closing if persistence enabled
            if (persistence) {
                await persistence.close();
            }

            node.groups.clear();

            if (done) done();
        });
    }

    RED.nodes.registerType("isolation-forest-anomaly", IsolationForestAnomalyNode);

    // API endpoint to check ml-isolation-forest availability
    RED.httpAdmin.get(
        "/isolation-forest-anomaly/status",
        needsPermission(RED, "isolation-forest-anomaly.read"),
        function (req, res) {
            let available = false;
            try {
                require("ml-isolation-forest");
                available = true;
            } catch (err) {
                available = false;
            }
            res.json({ available: available });
        }
    );
};
