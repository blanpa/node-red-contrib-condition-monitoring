module.exports = function (RED) {
    "use strict";

    // Import shared statistics utilities
    const stats = require("./utils/statistics");

    // Import state persistence helper
    const persistenceHelper = require("./utils/persistence-helper");

    const { clampInt, clampFloat } = require("./utils/config-validator");

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
        this.windowSize = clampInt(config.windowSize, 2, 1000000, 100);
        this.numEstimators = clampInt(config.numEstimators, 1, 10000, 100);
        this.maxSamples = clampInt(config.maxSamples, 1, 1000000, 256);
        this.outputTopic = config.outputTopic || "";
        this.debug = config.debug === true;

        // Online/Incremental Learning settings
        this.learningMode = config.learningMode || "batch"; // batch, incremental, adaptive
        this.retrainInterval = clampInt(config.retrainInterval, 1, 1000000, 50); // Retrain every N samples
        this.adaptRate = clampFloat(config.adaptRate, 0.001, 1, 0.1); // Adaptation rate for adaptive mode
        this.persistState = config.persistState === true;

        this.dataBuffer = [];
        this.scoreBuffer = []; // Store prediction scores for threshold calculation
        this.model = null;
        this.isTrained = false;
        this.anomalyThreshold = 0.5; // Default threshold, will be updated dynamically
        this.sampleCount = 0; // Total samples processed
        this.lastRetrainCount = 0; // Samples at last retrain

        // Debug logging helper
        const debugLog = function (message) {
            if (node.debug) {
                node.debug(message);
            }
        };

        // Initialize state persistence using helper
        // Note: model itself can't be serialized, but buffer can be and model will be retrained
        const persistence = persistenceHelper.initializeStatePersistence(node, {
            stateKey: "isolationForestState",
            saveInterval: 60000,
            debug: node.debug,
            onStateLoaded: function (state) {
                if (state.dataBuffer && state.dataBuffer.length > 0) {
                    node.dataBuffer = state.dataBuffer;
                    node.scoreBuffer = state.scoreBuffer || [];
                    node.anomalyThreshold = state.anomalyThreshold || 0.5;
                    node.sampleCount = state.sampleCount || 0;
                    node.lastRetrainCount = state.lastRetrainCount || 0;

                    // Re-train model from restored buffer
                    if (node.dataBuffer.length >= 10 && IsolationForest) {
                        trainModel(false);
                        debugLog(
                            "Restored and retrained Isolation Forest from " +
                                node.dataBuffer.length +
                                " buffered samples"
                        );
                    }
                }
            },
            getStateToSave: function () {
                return {
                    dataBuffer: node.dataBuffer,
                    scoreBuffer: node.scoreBuffer,
                    anomalyThreshold: node.anomalyThreshold,
                    sampleCount: node.sampleCount,
                    lastRetrainCount: node.lastRetrainCount,
                    isTrained: node.isTrained
                };
            }
        });

        // Helper to persist current state
        function persistCurrentState() {
            if (persistence) {
                persistence.saveNow();
            }
        }

        function trainModel(isIncremental) {
            if (!IsolationForest || node.dataBuffer.length < 10) {
                return;
            }

            try {
                // Prepare data for training
                const trainingData = node.dataBuffer.map(function (d, index) {
                    // Features: value, time index, and optional difference to previous value
                    const features = [d.value];
                    if (index > 0) {
                        features.push(d.value - node.dataBuffer[index - 1].value);
                    } else {
                        features.push(0);
                    }
                    features.push(index); // Time index
                    return features;
                });

                // Train Isolation Forest
                const actualMaxSamples = Math.min(node.maxSamples, node.dataBuffer.length);
                const modeLabel = isIncremental ? "incremental" : "full";
                debugLog(
                    "Training Isolation Forest (" +
                        modeLabel +
                        "): trees=" +
                        node.numEstimators +
                        ", samples=" +
                        actualMaxSamples
                );

                node.model = new IsolationForest({
                    contamination: node.contamination,
                    numEstimators: node.numEstimators,
                    maxSamples: actualMaxSamples
                });

                node.model.train(trainingData);
                node.isTrained = true;
                node.lastRetrainCount = node.sampleCount;

                // Calculate threshold based on training data scores
                const trainingScores = trainingData.map(function (features) {
                    return node.model.predict([features])[0];
                });
                trainingScores.sort(function (a, b) {
                    return b - a;
                }); // Sort descending
                const thresholdIndex = Math.floor(trainingScores.length * node.contamination);
                node.anomalyThreshold = thresholdIndex > 0 ? trainingScores[thresholdIndex] : trainingScores[0] || 0.5;

                // Update status
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: "Trained (" + modeLabel + ") | n=" + node.dataBuffer.length
                });

                // Persist after training
                persistCurrentState();
            } catch (err) {
                node.error("Error training Isolation Forest: " + err.message);
                node.isTrained = false;
            }
        }

        // Check if incremental retrain is needed
        function shouldRetrain() {
            if (node.learningMode === "batch") {
                return false; // Only retrain when buffer wraps
            }

            const samplesSinceRetrain = node.sampleCount - node.lastRetrainCount;
            return samplesSinceRetrain >= node.retrainInterval;
        }

        node.on("input", function (msg, send, done) {
            // Node-RED >=1.0 passes send/done; shim for older runtimes.
            done =
                done ||
                function (err) {
                    if (err) node.error(err, msg);
                };
            try {
                // Extract value from message
                const value = parseFloat(msg.payload);

                // Validate value is a finite number (catches NaN, Infinity, -Infinity)
                if (!Number.isFinite(value)) {
                    done("Payload is not a valid finite number");
                    return;
                }

                // Add value to buffer
                node.dataBuffer.push({
                    timestamp: Date.now(),
                    value: value
                });

                // Increment sample count
                node.sampleCount++;

                // Limit buffer to maximum size
                if (node.dataBuffer.length > node.windowSize) {
                    node.dataBuffer.shift();
                }

                // Train model when enough data is available
                if (!node.isTrained && node.dataBuffer.length >= 10) {
                    trainModel(false);
                }

                // Incremental/Adaptive retraining
                if (node.isTrained && shouldRetrain()) {
                    trainModel(true);
                }

                // If Isolation Forest is not available or not trained, use simple fallback method
                if (!IsolationForest || !node.isTrained) {
                    // Fallback: Z-Score based detection using shared utilities
                    if (node.dataBuffer.length < 2) {
                        node.send(msg);
                        done();
                        return;
                    }

                    const values = node.dataBuffer.map((d) => d.value);
                    const zScoreResult = stats.calculateZScore(value, values);
                    const zScore = zScoreResult.zScore;
                    const isAnomaly = Math.abs(zScore) > 3.0;

                    const outputMsg = {
                        payload: value,
                        isAnomaly: isAnomaly,
                        method: "fallback-zscore",
                        zScore: zScore,
                        timestamp: Date.now()
                    };

                    if (isAnomaly) {
                        node.send([null, outputMsg]);
                    } else {
                        node.send([outputMsg, null]);
                    }
                    done();
                    return;
                }

                // Isolation Forest prediction
                const currentIndex = node.dataBuffer.length - 1;
                const prevValue = currentIndex > 0 ? node.dataBuffer[currentIndex - 1].value : value;
                const features = [value, value - prevValue, currentIndex];

                const prediction = node.model.predict([features]);
                const score = prediction[0]; // Score: higher values indicate anomalies

                // Add score to buffer for dynamic threshold updates
                node.scoreBuffer.push(score);
                if (node.scoreBuffer.length > node.windowSize) {
                    node.scoreBuffer.shift();
                }

                // Update threshold dynamically based on recent scores
                if (node.scoreBuffer.length >= 10) {
                    const sortedScores = node.scoreBuffer.slice().sort(function (a, b) {
                        return b - a;
                    });
                    const thresholdIndex = Math.floor(sortedScores.length * node.contamination);
                    node.anomalyThreshold = thresholdIndex > 0 ? sortedScores[thresholdIndex] : sortedScores[0] || 0.5;
                }

                // Higher scores indicate anomalies (points that are easier to isolate)
                const isAnomaly = score >= node.anomalyThreshold;

                debugLog(
                    "Score: " +
                        score.toFixed(4) +
                        ", Threshold: " +
                        node.anomalyThreshold.toFixed(4) +
                        ", Anomaly: " +
                        isAnomaly
                );

                // Create output message
                const outputMsg = {
                    payload: value,
                    isAnomaly: isAnomaly,
                    anomalyScore: score,
                    threshold: node.anomalyThreshold,
                    method: "isolation-forest",
                    learningMode: node.learningMode,
                    contamination: node.contamination,
                    numEstimators: node.numEstimators,
                    sampleCount: node.sampleCount,
                    bufferSize: node.dataBuffer.length,
                    lastRetrain: node.lastRetrainCount,
                    timestamp: Date.now()
                };

                // Set topic if configured
                if (node.outputTopic) {
                    outputMsg.topic = node.outputTopic;
                }

                // Copy original message properties
                Object.keys(msg).forEach(function (key) {
                    if (
                        key !== "payload" &&
                        key !== "isAnomaly" &&
                        key !== "anomalyScore" &&
                        key !== "method" &&
                        key !== "contamination" &&
                        key !== "timestamp" &&
                        key !== "topic"
                    ) {
                        outputMsg[key] = msg[key];
                    }
                    // Preserve original topic if no output topic configured
                    if (key === "topic" && !node.outputTopic) {
                        outputMsg.topic = msg.topic;
                    }
                });

                // Anomalies to output 1, normal values to output 0
                if (isAnomaly) {
                    node.send([null, outputMsg]);
                } else {
                    node.send([outputMsg, null]);
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

            node.dataBuffer = [];
            node.scoreBuffer = [];
            node.model = null;
            node.isTrained = false;

            if (done) done();
        });
    }

    RED.nodes.registerType("isolation-forest-anomaly", IsolationForestAnomalyNode);

    // API endpoint to check ml-isolation-forest availability
    RED.httpAdmin.get("/isolation-forest-anomaly/status", function (req, res) {
        let available = false;
        try {
            require("ml-isolation-forest");
            available = true;
        } catch (err) {
            available = false;
        }
        res.json({ available: available });
    });
};
