module.exports = function (RED) {
    "use strict";

    // Import shared statistics utilities
    const stats = require("./utils/statistics");

    // Import state persistence helper
    const persistenceHelper = require("./utils/persistence-helper");

    // Import error handling utilities
    const errorHandler = require("./utils/error-handler");

    // Config validation: parse + range-clamp (0 stays 0 where it is valid)
    const { clampInt, clampFloat } = require("./utils/config-validator");

    // Import WebSocket manager for real-time dashboards
    let WebSocketManager = null;
    try {
        WebSocketManager = require("./websocket-manager");
    } catch (err) {
        // WebSocket support not available
    }

    function AnomalyDetectorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Common Configuration
        this.method = config.method || "zscore"; // zscore, iqr, threshold, percentile, ema, cusum, moving-average
        this.windowSize = clampInt(config.windowSize, 2, 1000000, 100);

        // Z-Score specific
        this.zscoreThreshold = clampFloat(config.zscoreThreshold, 0.1, 1000, 3.0);
        this.zscoreWarning = clampFloat(config.zscoreWarning, 0.1, 1000, 2.0);

        // IQR specific
        this.iqrMultiplier = clampFloat(config.iqrMultiplier, 0.1, 100, 1.5);
        this.iqrWarningMultiplier = clampFloat(config.iqrWarningMultiplier, 0.1, 100, 1.2);

        // Threshold specific
        this.minThreshold =
            config.minThreshold !== "" && config.minThreshold !== undefined ? parseFloat(config.minThreshold) : null;
        this.maxThreshold =
            config.maxThreshold !== "" && config.maxThreshold !== undefined ? parseFloat(config.maxThreshold) : null;
        this.warningMargin = clampFloat(config.warningMargin, 0, 100, 10);

        // Percentile specific (0 is a valid percentile)
        this.lowerPercentile = clampFloat(config.lowerPercentile, 0, 100, 5.0);
        this.upperPercentile = clampFloat(config.upperPercentile, 0, 100, 95.0);

        // EMA specific
        this.emaAlpha = clampFloat(config.emaAlpha, 0.001, 1, 0.3);
        this.emaThreshold = clampFloat(config.emaThreshold, 0.1, 1000, 2.0);
        this.emaWarning = clampFloat(config.emaWarning, 0.1, 1000, 1.5);
        this.emaMethod = config.emaMethod || "stddev";

        // CUSUM specific
        this.cusumTarget =
            config.cusumTarget !== "" && config.cusumTarget !== undefined ? parseFloat(config.cusumTarget) : null;
        this.cusumThreshold = clampFloat(config.cusumThreshold, 0.1, 10000, 5.0);
        this.cusumWarning = clampFloat(config.cusumWarning, 0.1, 10000, 3.5);
        this.cusumDrift = clampFloat(config.cusumDrift, 0, 1000, 0.5);

        // Moving Average specific
        this.maThreshold = clampFloat(config.maThreshold, 0.1, 1000, 2.0);
        this.maWarning = clampFloat(config.maWarning, 0.1, 1000, 1.5);
        this.maMethod = config.maMethod || "stddev";

        // Advanced settings
        this.outputTopic = config.outputTopic || "";
        this.debug = config.debug === true;
        this.persistState = config.persistState === true;

        // Hysteresis settings - prevents alarm flickering
        this.hysteresisEnabled = config.hysteresisEnabled !== false; // Default: enabled
        this.hysteresisPercent = clampFloat(config.hysteresisPercent, 0, 100, 10); // deadband; 0 = none
        this.consecutiveCount = clampInt(config.consecutiveCount, 1, 1000, 1); // Consecutive samples to confirm

        // Adaptive Thresholds - learns from operator feedback
        this.adaptiveEnabled = config.adaptiveEnabled === true;
        this.adaptiveLearningRate = clampFloat(config.adaptiveLearningRate, 0.001, 1, 0.1); // How fast to adjust
        this.adaptiveMinSamples = clampInt(config.adaptiveMinSamples, 1, 100000, 10); // Min feedback before adjusting
        this.targetFalsePositiveRate = clampFloat(config.targetFalsePositiveRate, 0, 1, 0.05); // 5% target

        // Batch Processing Mode - for historical data analysis
        this.batchMode = config.batchMode === true;

        // WebSocket for real-time dashboards
        this.websocketEnabled = config.websocketEnabled === true;
        this.websocketPort = clampInt(config.websocketPort, 1, 65535, 1881);
        this.websocketTopic = config.websocketTopic || "anomaly-detector";
        // Optional auth: shared token + allowed origins. Recommended for any
        // deployment where the WS port is reachable from outside `localhost`.
        this.websocketAuthToken =
            typeof config.websocketAuthToken === "string" && config.websocketAuthToken.length > 0
                ? config.websocketAuthToken
                : null;
        this.websocketAllowedOrigins = (function parseOrigins(raw) {
            if (!raw) return null;
            if (Array.isArray(raw)) return raw.filter((s) => typeof s === "string" && s.length > 0);
            if (typeof raw === "string") {
                const list = raw
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                return list.length > 0 ? list : null;
            }
            return null;
        })(config.websocketAllowedOrigins);

        // State
        this.dataBuffer = [];
        this.lastAnomalyState = false; // Track previous anomaly state for hysteresis
        this.consecutiveAnomalies = 0; // Counter for consecutive anomalies
        this.consecutiveNormals = 0; // Counter for consecutive normal values

        // Adaptive Thresholds State
        this.adaptiveState = {
            feedbackHistory: [], // { timestamp, predicted, actual, value }
            truePositives: 0,
            falsePositives: 0,
            trueNegatives: 0,
            falseNegatives: 0,
            currentThresholdAdjustment: 0, // Cumulative adjustment to threshold
            lastAdjustmentTime: null
        };

        // WebSocket manager reference
        this.wsManager = null;

        // Debug logging helper
        const debugLog = function (message) {
            if (node.debug) {
                node.debug(message);
            }
        };
        this.ema = null;
        this.cusumPos = 0;
        this.cusumNeg = 0;
        this.initialized = false;

        // Initialize state persistence using helper
        const persistence = persistenceHelper.initializeStatePersistence(node, {
            stateKey: "anomalyDetectorState",
            saveInterval: 30000,
            debug: node.debug,
            onStateLoaded: function (state) {
                if (state.dataBuffer && Array.isArray(state.dataBuffer)) {
                    node.dataBuffer = state.dataBuffer;
                }
                if (state.ema !== undefined) {
                    node.ema = state.ema;
                }
                if (state.cusumPos !== undefined) {
                    node.cusumPos = state.cusumPos;
                }
                if (state.cusumNeg !== undefined) {
                    node.cusumNeg = state.cusumNeg;
                }
                if (state.initialized !== undefined) {
                    node.initialized = state.initialized;
                }

                // Restore adaptive state
                if (state.adaptiveState && node.adaptiveEnabled) {
                    node.adaptiveState = state.adaptiveState;
                    debugLog(
                        "Restored adaptive state with " +
                            (state.adaptiveState.truePositives +
                                state.adaptiveState.falsePositives +
                                state.adaptiveState.trueNegatives +
                                state.adaptiveState.falseNegatives) +
                            " feedback samples"
                    );
                }

                if (node.dataBuffer.length > 0) {
                    debugLog("Restored " + node.dataBuffer.length + " buffered values from persistence");
                    node.status({
                        fill: "green",
                        shape: "dot",
                        text: node.method + " - restored (" + node.dataBuffer.length + ")"
                    });
                }
            },
            getStateToSave: function () {
                const state = {
                    dataBuffer: node.dataBuffer,
                    ema: node.ema,
                    cusumPos: node.cusumPos,
                    cusumNeg: node.cusumNeg,
                    initialized: node.initialized
                };
                if (node.adaptiveEnabled) {
                    state.adaptiveState = node.adaptiveState;
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

        // Initialize WebSocket if enabled
        if (node.websocketEnabled && WebSocketManager && WebSocketManager.isWebSocketAvailable()) {
            node.wsManager = WebSocketManager.getWebSocketManager({
                port: node.websocketPort,
                authToken: node.websocketAuthToken,
                allowedOrigins: node.websocketAllowedOrigins
            });
            // Surface mismatched WS configs at runtime — multiple nodes that disagree
            // about authToken/origins indicate an operator error worth flagging.
            node.wsManager.on("optionMismatch", function (info) {
                node.warn(
                    "WebSocket option mismatch (" +
                        info.key +
                        "): another node already configured this manager differently — first writer wins"
                );
            });
            node.wsManager.on("authFailed", function (info) {
                node.warn("WebSocket auth failed from " + (info.ip || "unknown"));
            });
            if (!node.wsManager.isRunning) {
                node.wsManager
                    .start()
                    .then(function () {
                        debugLog("WebSocket server started on port " + node.websocketPort);
                    })
                    .catch(function (err) {
                        node.warn("Failed to start WebSocket server: " + err.message);
                    });
            }
        }

        // Initial status
        node.status({ fill: "blue", shape: "ring", text: node.method + " - waiting" });

        // Use shared statistics utilities (calculateZScore / calculateIQRBounds called via stats.* directly)
        const calculateMean = stats.calculateMean;
        const calculateStdDev = stats.calculateStdDev;
        const calculatePercentile = stats.calculatePercentileSorted;

        // Z-Score method (uses node defaults)
        function detectZScore(value, values) {
            return detectZScoreWithConfig(value, values, node.zscoreThreshold, node.zscoreWarning);
        }

        // Z-Score method with configurable thresholds (for msg.config override)
        function detectZScoreWithConfig(value, values, threshold, warning) {
            // Single source of truth for mean/stdDev — utils/statistics is the canonical implementation.
            const z = stats.calculateZScore(value, values);
            const mean = z.mean;
            const stdDev = z.stdDev;
            const zScore = z.zScore;
            const absZScore = Math.abs(zScore);

            let severity = "normal";
            let isAnomaly = false;

            if (absZScore > threshold) {
                severity = "critical";
                isAnomaly = true;
            } else if (absZScore > warning) {
                severity = "warning";
                isAnomaly = true;
            }

            return {
                isAnomaly: isAnomaly,
                severity: severity,
                details: {
                    zScore: zScore,
                    mean: mean,
                    stdDev: stdDev,
                    threshold: threshold,
                    warningThreshold: warning
                },
                statusText:
                    severity === "critical"
                        ? "CRITICAL z=" + zScore.toFixed(2)
                        : severity === "warning"
                          ? "warning z=" + zScore.toFixed(2)
                          : "μ=" + mean.toFixed(1) + " σ=" + stdDev.toFixed(2)
            };
        }

        // IQR method (uses node defaults)
        function detectIQR(value, values) {
            return detectIQRWithConfig(value, values, node.iqrMultiplier);
        }

        // IQR method with configurable multiplier (for msg.config override)
        function detectIQRWithConfig(value, values, multiplier) {
            // Bounds and quartiles come from the shared util (no duplicated quantile logic).
            const bounds = stats.calculateIQRBounds(values, multiplier);
            const quartiles = { q1: bounds.q1, q3: bounds.q3, iqr: bounds.iqr, median: bounds.median };
            const warningMultiplier = multiplier * 0.8; // Warning at 80% of critical
            const lowerBound = bounds.lowerBound;
            const upperBound = bounds.upperBound;
            const lowerWarning = quartiles.q1 - warningMultiplier * quartiles.iqr;
            const upperWarning = quartiles.q3 + warningMultiplier * quartiles.iqr;

            let severity = "normal";
            let isAnomaly = false;

            if (value < lowerBound || value > upperBound) {
                severity = "critical";
                isAnomaly = true;
            } else if (value < lowerWarning || value > upperWarning) {
                severity = "warning";
                isAnomaly = true;
            }

            return {
                isAnomaly: isAnomaly,
                severity: severity,
                details: {
                    q1: quartiles.q1,
                    q3: quartiles.q3,
                    iqr: quartiles.iqr,
                    median: quartiles.median,
                    lowerBound: lowerBound,
                    upperBound: upperBound,
                    multiplier: multiplier
                },
                statusText:
                    severity === "critical"
                        ? "CRITICAL: " + value.toFixed(2)
                        : severity === "warning"
                          ? "warning: " + value.toFixed(2)
                          : "Q1=" + quartiles.q1.toFixed(1) + " Q3=" + quartiles.q3.toFixed(1)
            };
        }

        // Threshold method (uses node defaults)
        function detectThreshold(value) {
            return detectThresholdWithConfig(value, node.minThreshold, node.maxThreshold);
        }

        // Threshold method with configurable thresholds (for msg.config override)
        function detectThresholdWithConfig(value, minThreshold, maxThreshold) {
            let severity = "normal";
            let isAnomaly = false;
            let reason = null;

            const minWarning = minThreshold !== null ? minThreshold * (1 + node.warningMargin / 100) : null;
            const maxWarning = maxThreshold !== null ? maxThreshold * (1 - node.warningMargin / 100) : null;

            if (minThreshold !== null && value < minThreshold) {
                severity = "critical";
                isAnomaly = true;
                reason = "Below minimum (" + minThreshold + ")";
            } else if (minWarning !== null && value < minWarning) {
                severity = "warning";
                isAnomaly = true;
                reason = "Approaching minimum";
            }

            if (maxThreshold !== null && value > maxThreshold) {
                severity = "critical";
                isAnomaly = true;
                reason = reason ? reason + " AND above maximum" : "Above maximum (" + maxThreshold + ")";
            } else if (maxWarning !== null && value > maxWarning && severity !== "critical") {
                severity = severity === "warning" ? "warning" : "warning";
                isAnomaly = true;
                reason = reason ? reason + " AND approaching maximum" : "Approaching maximum";
            }

            return {
                isAnomaly: isAnomaly,
                severity: severity,
                details: {
                    minThreshold: node.minThreshold,
                    maxThreshold: node.maxThreshold,
                    reason: reason
                },
                statusText:
                    severity === "critical"
                        ? "CRITICAL: " + value
                        : severity === "warning"
                          ? "warning: " + value
                          : "OK: " + value
            };
        }

        // Percentile method
        function detectPercentile(value, values) {
            const sorted = values.slice().sort((a, b) => a - b);
            const lowerBound = calculatePercentile(sorted, node.lowerPercentile);
            const upperBound = calculatePercentile(sorted, node.upperPercentile);

            const isAnomaly = value < lowerBound || value > upperBound;

            return {
                isAnomaly: isAnomaly,
                severity: isAnomaly ? "critical" : "normal",
                details: {
                    lowerPercentile: node.lowerPercentile,
                    upperPercentile: node.upperPercentile,
                    lowerBound: lowerBound,
                    upperBound: upperBound
                },
                statusText: isAnomaly
                    ? "ANOMALY: " + value.toFixed(2)
                    : "P" + node.lowerPercentile + "-P" + node.upperPercentile
            };
        }

        // EMA method
        function detectEMA(value, values) {
            if (!node.initialized) {
                node.ema = value;
                node.initialized = true;
                return { isAnomaly: false, severity: "normal", details: { ema: value }, statusText: "initializing" };
            }

            node.ema = node.emaAlpha * value + (1 - node.emaAlpha) * node.ema;

            const mean = calculateMean(values);
            const stdDev = calculateStdDev(values, mean);
            const deviation = Math.abs(value - node.ema);
            const deviationFactor = stdDev === 0 ? 0 : deviation / stdDev;

            let severity = "normal";
            let isAnomaly = false;

            if (node.emaMethod === "stddev") {
                if (deviationFactor > node.emaThreshold) {
                    severity = "critical";
                    isAnomaly = true;
                } else if (deviationFactor > node.emaWarning) {
                    severity = "warning";
                    isAnomaly = true;
                }
            } else {
                const deviationPercent = node.ema === 0 ? 0 : (deviation / Math.abs(node.ema)) * 100;
                if (deviationPercent > node.emaThreshold) {
                    severity = "critical";
                    isAnomaly = true;
                } else if (deviationPercent > node.emaWarning) {
                    severity = "warning";
                    isAnomaly = true;
                }
            }

            return {
                isAnomaly: isAnomaly,
                severity: severity,
                details: {
                    ema: node.ema,
                    deviation: deviation,
                    deviationFactor: deviationFactor,
                    alpha: node.emaAlpha
                },
                statusText:
                    severity === "critical"
                        ? "CRITICAL EMA=" + node.ema.toFixed(2)
                        : severity === "warning"
                          ? "warning EMA=" + node.ema.toFixed(2)
                          : "EMA=" + node.ema.toFixed(2)
            };
        }

        // CUSUM method
        function detectCUSUM(value, values) {
            const target = node.cusumTarget !== null ? node.cusumTarget : calculateMean(values);

            const deviation = value - target;
            node.cusumPos = Math.max(0, node.cusumPos + deviation - node.cusumDrift);
            node.cusumNeg = Math.max(0, node.cusumNeg - deviation - node.cusumDrift);

            const maxCusum = Math.max(node.cusumPos, node.cusumNeg);

            let severity = "normal";
            let isAnomaly = false;

            if (maxCusum > node.cusumThreshold) {
                severity = "critical";
                isAnomaly = true;
                // Reset after detection
                node.cusumPos = 0;
                node.cusumNeg = 0;
            } else if (maxCusum > node.cusumWarning) {
                severity = "warning";
                isAnomaly = true;
            }

            return {
                isAnomaly: isAnomaly,
                severity: severity,
                details: {
                    target: target,
                    cusumPos: node.cusumPos,
                    cusumNeg: node.cusumNeg,
                    cusumMax: maxCusum,
                    drift: node.cusumDrift
                },
                statusText:
                    severity === "critical"
                        ? "CRITICAL CUSUM=" + maxCusum.toFixed(2)
                        : severity === "warning"
                          ? "warning CUSUM=" + maxCusum.toFixed(2)
                          : "CUSUM=" + maxCusum.toFixed(2)
            };
        }

        // Moving Average method
        function detectMovingAverage(value, values) {
            const movingAverage = calculateMean(values);
            const stdDev = calculateStdDev(values, movingAverage);
            const deviation = Math.abs(value - movingAverage);
            const deviationFactor = stdDev === 0 ? 0 : deviation / stdDev;

            let severity = "normal";
            let isAnomaly = false;

            if (node.maMethod === "stddev") {
                if (deviationFactor > node.maThreshold) {
                    severity = "critical";
                    isAnomaly = true;
                } else if (deviationFactor > node.maWarning) {
                    severity = "warning";
                    isAnomaly = true;
                }
            } else {
                const deviationPercent = movingAverage === 0 ? 0 : (deviation / Math.abs(movingAverage)) * 100;
                if (deviationPercent > node.maThreshold) {
                    severity = "critical";
                    isAnomaly = true;
                } else if (deviationPercent > node.maWarning) {
                    severity = "warning";
                    isAnomaly = true;
                }
            }

            return {
                isAnomaly: isAnomaly,
                severity: severity,
                details: {
                    movingAverage: movingAverage,
                    stdDev: stdDev,
                    deviation: deviation,
                    deviationFactor: deviationFactor
                },
                statusText:
                    severity === "critical"
                        ? "CRITICAL MA=" + movingAverage.toFixed(2)
                        : severity === "warning"
                          ? "warning MA=" + movingAverage.toFixed(2)
                          : "MA=" + movingAverage.toFixed(2)
            };
        }

        // Initialize multi-sensor buffers
        node.sensorBuffers = {};
        node.sensorStates = {};
        node.sensorEma = {};
        node.sensorCusum = {};

        /**
         * Process multi-sensor JSON input for anomaly detection
         * @param {Object} msg - The incoming message
         * @param {Object} sensorData - Object with sensor names as keys and values
         */
        function processMultiSensorInput(msg, sensorData) {
            const results = {};
            let anyAnomaly = false;
            let worstSeverity = "normal";
            const anomalySensors = [];
            const skippedSensors = [];

            const sensorNames = Object.keys(sensorData);

            sensorNames.forEach(function (sensorName) {
                const rawValue = sensorData[sensorName];
                const value = parseFloat(rawValue);

                // Validate value is a finite number (catches NaN, Infinity, -Infinity)
                if (!Number.isFinite(value)) {
                    skippedSensors.push({ name: sensorName, reason: "not a finite number", value: rawValue });
                    debugLog("Skipping sensor " + sensorName + ": value is not a finite number (" + rawValue + ")");
                    return;
                }

                // Initialize per-sensor buffers if needed
                if (!node.sensorBuffers[sensorName]) {
                    node.sensorBuffers[sensorName] = [];
                    node.sensorStates[sensorName] = {
                        lastAnomalyState: false,
                        consecutiveAnomalies: 0,
                        consecutiveNormals: 0
                    };
                    node.sensorEma[sensorName] = null;
                    node.sensorCusum[sensorName] = { pos: 0, neg: 0 };
                }

                // Add to sensor buffer
                node.sensorBuffers[sensorName].push({ timestamp: Date.now(), value: value });
                if (node.sensorBuffers[sensorName].length > node.windowSize) {
                    node.sensorBuffers[sensorName].shift();
                }

                const values = node.sensorBuffers[sensorName].map(function (d) {
                    return d.value;
                });

                // Minimum data check
                const minRequired = node.method === "iqr" ? 4 : 2;
                if (node.sensorBuffers[sensorName].length < minRequired) {
                    results[sensorName] = {
                        value: value,
                        isAnomaly: false,
                        severity: "warmup",
                        bufferSize: node.sensorBuffers[sensorName].length,
                        minRequired: minRequired
                    };
                    return;
                }

                // Detect anomaly based on method
                let result;
                switch (node.method) {
                    case "zscore":
                        result = detectZScore(value, values);
                        break;
                    case "iqr":
                        result = detectIQR(value, values);
                        break;
                    case "threshold":
                        result = detectThreshold(value);
                        break;
                    case "percentile":
                        result = detectPercentile(value, values);
                        break;
                    case "ema":
                        // Use per-sensor EMA
                        result = detectEMASensor(value, values, sensorName);
                        break;
                    case "cusum":
                        result = detectCUSUMSensor(value, values, sensorName);
                        break;
                    case "moving-average":
                        result = detectMovingAverage(value, values);
                        break;
                    default:
                        result = detectZScore(value, values);
                }

                // Apply per-sensor hysteresis
                let finalIsAnomaly = result.isAnomaly;
                const state = node.sensorStates[sensorName];

                if (node.hysteresisEnabled) {
                    if (result.isAnomaly) {
                        state.consecutiveAnomalies++;
                        state.consecutiveNormals = 0;

                        if (state.consecutiveAnomalies < node.consecutiveCount) {
                            finalIsAnomaly = false;
                        }
                    } else {
                        state.consecutiveNormals++;

                        if (state.lastAnomalyState) {
                            const requiredNormals = Math.ceil(
                                node.consecutiveCount * (1 + node.hysteresisPercent / 100)
                            );
                            if (state.consecutiveNormals < requiredNormals) {
                                finalIsAnomaly = true;
                                result.severity = "warning";
                            } else {
                                state.consecutiveAnomalies = 0;
                            }
                        }
                    }
                    state.lastAnomalyState = finalIsAnomaly;
                }

                results[sensorName] = {
                    value: value,
                    isAnomaly: finalIsAnomaly,
                    rawAnomaly: result.isAnomaly,
                    severity: finalIsAnomaly ? result.severity : "normal",
                    method: node.method,
                    bufferSize: node.sensorBuffers[sensorName].length,
                    details: result.details || {}
                };

                if (finalIsAnomaly) {
                    anyAnomaly = true;
                    anomalySensors.push(sensorName);
                    if (
                        result.severity === "critical" ||
                        (worstSeverity !== "critical" && result.severity === "warning")
                    ) {
                        worstSeverity = result.severity;
                    }
                }
            });

            // Check if any valid sensors were processed
            const validSensorCount = Object.keys(results).length;
            if (validSensorCount === 0) {
                errorHandler.handleNodeError(node, "No valid sensor readings in input", msg, "warn", {
                    statusText: "no valid sensors"
                });
                return;
            }

            // Build output message
            const outMsg = {
                payload: results,
                isAnomaly: anyAnomaly,
                severity: anyAnomaly ? worstSeverity : "normal",
                anomalySensors: anomalySensors,
                sensorCount: validSensorCount,
                totalSensors: sensorNames.length,
                skippedSensors: skippedSensors.length > 0 ? skippedSensors : undefined,
                method: node.method,
                windowSize: node.windowSize,
                inputFormat: "multi-sensor",
                _msgid: msg._msgid
            };

            // Copy original message properties
            if (msg.topic) outMsg.topic = node.outputTopic || msg.topic;

            // Update status
            if (anyAnomaly) {
                node.status({
                    fill: worstSeverity === "critical" ? "red" : "yellow",
                    shape: "dot",
                    text: worstSeverity.toUpperCase() + ": " + anomalySensors.join(", ")
                });
                node.send([null, outMsg]);
            } else {
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: sensorNames.length + " sensors OK"
                });
                node.send([outMsg, null]);
            }
        }

        // EMA detection for specific sensor (isolated per-sensor state)
        function detectEMASensor(value, values, sensorName) {
            // Swap in per-sensor state before detection
            const savedEma = node.ema;
            const savedInitialized = node.initialized;
            if (node.sensorEma[sensorName] !== null && node.sensorEma[sensorName] !== undefined) {
                node.ema = node.sensorEma[sensorName];
                node.initialized = true;
            } else {
                node.ema = null;
                node.initialized = false;
            }

            const result = detectEMA(value, values);

            // Save per-sensor state and restore global
            node.sensorEma[sensorName] = node.ema;
            node.ema = savedEma;
            node.initialized = savedInitialized;
            return result;
        }

        // CUSUM detection for specific sensor (isolated per-sensor state)
        function detectCUSUMSensor(value, values, sensorName) {
            // Swap in per-sensor state before detection
            const savedPos = node.cusumPos;
            const savedNeg = node.cusumNeg;
            if (node.sensorCusum[sensorName]) {
                node.cusumPos = node.sensorCusum[sensorName].pos;
                node.cusumNeg = node.sensorCusum[sensorName].neg;
            } else {
                node.cusumPos = 0;
                node.cusumNeg = 0;
            }

            const result = detectCUSUM(value, values);

            // Save per-sensor state and restore global
            node.sensorCusum[sensorName] = { pos: node.cusumPos, neg: node.cusumNeg };
            node.cusumPos = savedPos;
            node.cusumNeg = savedNeg;
            return result;
        }

        // ==========================================
        // ADAPTIVE THRESHOLDS - Learn from Feedback
        // ==========================================

        /**
         * Process operator feedback to adjust anomaly detection thresholds.
         * Uses confusion matrix tracking to calculate false positive/negative rates
         * and adjusts thresholds toward target error rate.
         *
         * @param {Object} feedback - Feedback object from operator
         * @param {boolean} feedback.predictedAnomaly - What the detector predicted
         * @param {boolean} feedback.wasAnomaly - What the operator confirms (ground truth)
         * @param {number} [feedback.value] - The sensor value for this detection
         * @returns {void}
         *
         * @example
         * // Send feedback that a detection was a false positive
         * msg.feedback = {
         *     predictedAnomaly: true,
         *     wasAnomaly: false,
         *     value: 42.5
         * };
         */
        function processAdaptiveFeedback(feedback) {
            if (!node.adaptiveEnabled) return;

            const state = node.adaptiveState;
            const entry = {
                timestamp: Date.now(),
                predicted: feedback.predictedAnomaly,
                actual: feedback.wasAnomaly,
                value: feedback.value
            };

            state.feedbackHistory.push(entry);

            // Keep only last 1000 feedback entries
            if (state.feedbackHistory.length > 1000) {
                state.feedbackHistory.shift();
            }

            // Update confusion matrix
            if (feedback.predictedAnomaly && feedback.wasAnomaly) {
                state.truePositives++;
            } else if (feedback.predictedAnomaly && !feedback.wasAnomaly) {
                state.falsePositives++;
            } else if (!feedback.predictedAnomaly && feedback.wasAnomaly) {
                state.falseNegatives++;
            } else {
                state.trueNegatives++;
            }

            // Calculate current false positive rate
            const totalPositives = state.truePositives + state.falsePositives;
            const totalNegatives = state.trueNegatives + state.falseNegatives;
            const totalSamples = totalPositives + totalNegatives;

            debugLog(
                "Adaptive feedback: TP=" +
                    state.truePositives +
                    " FP=" +
                    state.falsePositives +
                    " TN=" +
                    state.trueNegatives +
                    " FN=" +
                    state.falseNegatives
            );

            // Only adjust after minimum samples
            if (totalSamples < node.adaptiveMinSamples) {
                debugLog("Adaptive: waiting for more samples (" + totalSamples + "/" + node.adaptiveMinSamples + ")");
                return;
            }

            // Calculate false positive rate
            const falsePositiveRate = totalPositives > 0 ? state.falsePositives / totalPositives : 0;
            const falseNegativeRate =
                totalNegatives > 0 ? state.falseNegatives / (state.falseNegatives + state.trueNegatives) : 0;

            // Adjust threshold based on error rates
            let adjustment = 0;

            if (falsePositiveRate > node.targetFalsePositiveRate) {
                // Too many false positives - make threshold less sensitive (increase)
                adjustment = node.adaptiveLearningRate * (falsePositiveRate - node.targetFalsePositiveRate);
                debugLog(
                    "Adaptive: FP rate " +
                        (falsePositiveRate * 100).toFixed(1) +
                        "% > target, loosening threshold by " +
                        adjustment.toFixed(3)
                );
            } else if (falseNegativeRate > node.targetFalsePositiveRate * 2) {
                // Too many false negatives - make threshold more sensitive (decrease)
                adjustment = -node.adaptiveLearningRate * (falseNegativeRate - node.targetFalsePositiveRate);
                debugLog(
                    "Adaptive: FN rate " +
                        (falseNegativeRate * 100).toFixed(1) +
                        "% high, tightening threshold by " +
                        (-adjustment).toFixed(3)
                );
            }

            if (adjustment !== 0) {
                state.currentThresholdAdjustment += adjustment;
                // Limit adjustment range to ±50% of original threshold
                state.currentThresholdAdjustment = Math.max(-0.5, Math.min(0.5, state.currentThresholdAdjustment));
                state.lastAdjustmentTime = Date.now();

                debugLog(
                    "Adaptive: total threshold adjustment = " +
                        (state.currentThresholdAdjustment * 100).toFixed(1) +
                        "%"
                );
            }
        }

        /**
         * Get adaptive-adjusted threshold
         */
        function getAdaptiveThreshold(baseThreshold) {
            if (!node.adaptiveEnabled) return baseThreshold;
            const adjustment = node.adaptiveState.currentThresholdAdjustment;
            return baseThreshold * (1 + adjustment);
        }

        /**
         * Get adaptive statistics for output
         */
        function getAdaptiveStats() {
            const state = node.adaptiveState;
            const total = state.truePositives + state.falsePositives + state.trueNegatives + state.falseNegatives;

            return {
                enabled: node.adaptiveEnabled,
                feedbackCount: total,
                truePositives: state.truePositives,
                falsePositives: state.falsePositives,
                trueNegatives: state.trueNegatives,
                falseNegatives: state.falseNegatives,
                falsePositiveRate:
                    total > 0 ? state.falsePositives / Math.max(1, state.truePositives + state.falsePositives) : 0,
                precision:
                    state.truePositives + state.falsePositives > 0
                        ? state.truePositives / (state.truePositives + state.falsePositives)
                        : 1,
                recall:
                    state.truePositives + state.falseNegatives > 0
                        ? state.truePositives / (state.truePositives + state.falseNegatives)
                        : 1,
                thresholdAdjustment: state.currentThresholdAdjustment,
                lastAdjustmentTime: state.lastAdjustmentTime
            };
        }

        // ==========================================
        // BATCH PROCESSING - Historical Data Analysis
        // ==========================================

        /**
         * Process a batch of historical values
         * @param {Array} values - Array of values or {timestamp, value} objects
         * @returns {Object} Batch analysis results
         */
        function processBatch(values, method, threshold) {
            const results = [];
            let anomalyCount = 0;
            let warningCount = 0;
            let normalCount = 0;
            const anomalyIndices = [];

            // Build temporary buffer for analysis
            const tempBuffer = [];
            const minRequired = method === "iqr" ? 4 : 2;

            for (let i = 0; i < values.length; i++) {
                const item = values[i];
                let value = typeof item === "object" ? item.value : item;
                const timestamp = typeof item === "object" ? item.timestamp : Date.now();

                value = parseFloat(value);
                if (isNaN(value)) continue;

                tempBuffer.push({ timestamp: timestamp, value: value });

                // Keep buffer size limited
                if (tempBuffer.length > node.windowSize) {
                    tempBuffer.shift();
                }

                // Skip if not enough data
                if (tempBuffer.length < minRequired) {
                    results.push({
                        index: i,
                        value: value,
                        timestamp: timestamp,
                        isAnomaly: false,
                        severity: "warmup"
                    });
                    continue;
                }

                const bufferValues = tempBuffer.map(function (d) {
                    return d.value;
                });
                let result;

                // Use adaptive threshold if enabled
                const activeThreshold = getAdaptiveThreshold(threshold || node.zscoreThreshold);

                switch (method || node.method) {
                    case "zscore":
                        result = detectZScoreWithConfig(value, bufferValues, activeThreshold, activeThreshold * 0.67);
                        break;
                    case "iqr":
                        result = detectIQRWithConfig(value, bufferValues, node.iqrMultiplier);
                        break;
                    case "threshold":
                        result = detectThresholdWithConfig(value, node.minThreshold, node.maxThreshold);
                        break;
                    case "percentile":
                        result = detectPercentile(value, bufferValues);
                        break;
                    default:
                        result = detectZScoreWithConfig(value, bufferValues, activeThreshold, activeThreshold * 0.67);
                }

                const batchResult = {
                    index: i,
                    value: value,
                    timestamp: timestamp,
                    isAnomaly: result.isAnomaly,
                    severity: result.severity,
                    details: result.details
                };

                results.push(batchResult);

                if (result.isAnomaly) {
                    anomalyIndices.push(i);
                    if (result.severity === "critical") {
                        anomalyCount++;
                    } else {
                        warningCount++;
                    }
                } else {
                    normalCount++;
                }
            }

            // Calculate statistics
            const allValues = values
                .map(function (v) {
                    return typeof v === "object" ? parseFloat(v.value) : parseFloat(v);
                })
                .filter(function (v) {
                    return !isNaN(v);
                });

            const stats = {
                count: allValues.length,
                mean: allValues.length > 0 ? calculateMean(allValues) : 0,
                stdDev: allValues.length > 1 ? calculateStdDev(allValues, calculateMean(allValues)) : 0,
                min: allValues.length > 0 ? Math.min.apply(null, allValues) : 0,
                max: allValues.length > 0 ? Math.max.apply(null, allValues) : 0
            };

            return {
                results: results,
                summary: {
                    totalSamples: values.length,
                    anomalies: anomalyCount,
                    warnings: warningCount,
                    normal: normalCount,
                    anomalyRate: values.length > 0 ? (anomalyCount + warningCount) / values.length : 0,
                    anomalyIndices: anomalyIndices
                },
                statistics: stats,
                method: method || node.method,
                windowSize: node.windowSize,
                batchMode: true
            };
        }

        // ==========================================
        // WEBSOCKET BROADCAST
        // ==========================================

        /**
         * Broadcast result via WebSocket
         */
        function broadcastResult(result) {
            if (!node.wsManager || !node.wsManager.isRunning) return;

            try {
                node.wsManager.broadcast(node.websocketTopic, {
                    nodeId: node.id,
                    nodeName: node.name || "Anomaly Detector",
                    ...result
                });
            } catch (err) {
                debugLog("WebSocket broadcast error: " + err.message);
            }
        }

        node.on("input", function (msg, send, done) {
            // Node-RED >=1.0 passes send/done; shim for older runtimes.
            done =
                done ||
                function (err) {
                    if (err) node.error(err, msg);
                };
            try {
                // ==========================================
                // FEEDBACK PROCESSING (Adaptive Thresholds)
                // ==========================================
                if (msg.feedback) {
                    processAdaptiveFeedback(msg.feedback);
                    const adaptiveStats = getAdaptiveStats();
                    node.status({
                        fill: "blue",
                        shape: "dot",
                        text:
                            "Feedback: " +
                            adaptiveStats.feedbackCount +
                            " samples, adj=" +
                            (adaptiveStats.thresholdAdjustment * 100).toFixed(1) +
                            "%"
                    });

                    // Send feedback confirmation
                    const feedbackMsg = {
                        payload: adaptiveStats,
                        topic: "adaptive-feedback",
                        _msgid: msg._msgid
                    };
                    node.send([feedbackMsg, null]);
                    done();
                    return;
                }

                // ==========================================
                // BATCH PROCESSING MODE
                // ==========================================
                if (
                    msg.batch === true ||
                    (node.batchMode &&
                        Array.isArray(msg.payload) &&
                        msg.payload.length > 1 &&
                        typeof msg.payload[0] !== "object")
                ) {
                    // Array of raw numbers for batch processing
                    const batchResult = processBatch(msg.payload, msg.method || node.method, msg.threshold);

                    const batchMsg = {
                        payload: batchResult,
                        topic: msg.topic || "batch-analysis",
                        _msgid: msg._msgid
                    };

                    // Broadcast via WebSocket
                    if (node.websocketEnabled) {
                        broadcastResult({
                            type: "batch",
                            ...batchResult.summary,
                            statistics: batchResult.statistics
                        });
                    }

                    node.status({
                        fill: batchResult.summary.anomalies > 0 ? "red" : "green",
                        shape: "dot",
                        text:
                            "Batch: " +
                            batchResult.summary.anomalies +
                            "/" +
                            batchResult.summary.totalSamples +
                            " anomalies"
                    });

                    // Output batch results (anomalies found = output 2, no anomalies = output 1)
                    if (batchResult.summary.anomalies > 0 || batchResult.summary.warnings > 0) {
                        node.send([null, batchMsg]);
                    } else {
                        node.send([batchMsg, null]);
                    }
                    done();
                    return;
                }

                // Dynamic configuration via msg.config
                // Allows runtime override of node settings
                const cfg = msg.config || {};
                const activeMethod = cfg.method || node.method;
                let activeZscoreThreshold =
                    cfg.zscoreThreshold !== undefined ? parseFloat(cfg.zscoreThreshold) : node.zscoreThreshold;
                let activeZscoreWarning =
                    cfg.zscoreWarning !== undefined ? parseFloat(cfg.zscoreWarning) : node.zscoreWarning;
                const activeIqrMultiplier =
                    cfg.iqrMultiplier !== undefined ? parseFloat(cfg.iqrMultiplier) : node.iqrMultiplier;
                const activeMinThreshold =
                    cfg.minThreshold !== undefined ? parseFloat(cfg.minThreshold) : node.minThreshold;
                const activeMaxThreshold =
                    cfg.maxThreshold !== undefined ? parseFloat(cfg.maxThreshold) : node.maxThreshold;
                const activeHysteresisEnabled =
                    cfg.hysteresisEnabled !== undefined ? cfg.hysteresisEnabled : node.hysteresisEnabled;
                const activeConsecutiveCount =
                    cfg.consecutiveCount !== undefined ? parseInt(cfg.consecutiveCount) : node.consecutiveCount;

                // Apply adaptive threshold adjustment
                activeZscoreThreshold = getAdaptiveThreshold(activeZscoreThreshold);
                activeZscoreWarning = getAdaptiveThreshold(activeZscoreWarning);

                // Reset function
                if (msg.reset === true) {
                    node.dataBuffer = [];
                    node.sensorBuffers = {}; // For multi-sensor mode
                    node.sensorStates = {}; // Hysteresis states per sensor
                    node.ema = null;
                    node.cusumPos = 0;
                    node.cusumNeg = 0;
                    node.initialized = false;
                    node.lastAnomalyState = false;
                    node.consecutiveAnomalies = 0;
                    node.consecutiveNormals = 0;

                    // Reset adaptive state if requested
                    if (msg.resetAdaptive === true) {
                        node.adaptiveState = {
                            feedbackHistory: [],
                            truePositives: 0,
                            falsePositives: 0,
                            trueNegatives: 0,
                            falseNegatives: 0,
                            currentThresholdAdjustment: 0,
                            lastAdjustmentTime: null
                        };
                    }

                    node.status({ fill: "blue", shape: "ring", text: activeMethod + " - reset" });
                    done();
                    return;
                }

                // Check if payload is JSON object or array (multi-sensor mode)
                if (typeof msg.payload === "object" && msg.payload !== null && !Array.isArray(msg.payload)) {
                    // JSON object input: { "sensor1": 25.5, "sensor2": 30.2, ... }
                    processMultiSensorInput(msg, msg.payload);
                    done();
                    return;
                } else if (Array.isArray(msg.payload) && msg.payload.length > 0 && typeof msg.payload[0] === "object") {
                    // Array of sensor objects: [{ name: "temp", value: 25.5 }, ...]
                    const sensorData = {};
                    msg.payload.forEach(function (item) {
                        if (item.name && item.value !== undefined) {
                            sensorData[item.name] = item.value;
                        }
                    });
                    processMultiSensorInput(msg, sensorData);
                    done();
                    return;
                }

                // SECURITY: Strict number validation
                // parseFloat("123abc") returns 123 which can be misleading
                let value;
                if (typeof msg.payload === "number") {
                    value = msg.payload;
                } else if (typeof msg.payload === "string") {
                    // Only accept strings that are purely numeric
                    const trimmed = msg.payload.trim();
                    if (trimmed === "" || !/^-?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(trimmed)) {
                        node.status({ fill: "red", shape: "ring", text: "invalid input" });
                        done("Payload is not a valid number: " + msg.payload);
                        return;
                    }
                    value = parseFloat(trimmed);
                } else {
                    node.status({ fill: "red", shape: "ring", text: "invalid input" });
                    done("Payload must be a number or numeric string, got: " + typeof msg.payload);
                    return;
                }

                if (!Number.isFinite(value)) {
                    node.status({ fill: "red", shape: "ring", text: "invalid input" });
                    done("Payload is not a finite number (NaN or Infinity)");
                    return;
                }

                // Add to buffer
                node.dataBuffer.push({ timestamp: Date.now(), value: value });
                if (node.dataBuffer.length > node.windowSize) {
                    node.dataBuffer.shift();
                }

                // Persist state periodically (every 10th sample to reduce overhead)
                if (node.stateManager && node.dataBuffer.length % 10 === 0) {
                    persistCurrentState();
                }

                const values = node.dataBuffer.map((d) => d.value);

                // Minimum data check
                const minRequired = node.method === "iqr" ? 4 : 2;
                if (node.dataBuffer.length < minRequired) {
                    node.status({
                        fill: "yellow",
                        shape: "ring",
                        text: "warmup " + node.dataBuffer.length + "/" + minRequired
                    });
                    node.send(msg);
                    done();
                    return;
                }

                // Detect anomaly based on method (use active config from msg.config or node defaults)
                let result;
                switch (activeMethod) {
                    case "zscore":
                        result = detectZScoreWithConfig(value, values, activeZscoreThreshold, activeZscoreWarning);
                        break;
                    case "iqr":
                        result = detectIQRWithConfig(value, values, activeIqrMultiplier);
                        break;
                    case "threshold":
                        result = detectThresholdWithConfig(value, activeMinThreshold, activeMaxThreshold);
                        break;
                    case "percentile":
                        result = detectPercentile(value, values);
                        break;
                    case "ema":
                        result = detectEMA(value, values);
                        break;
                    case "cusum":
                        result = detectCUSUM(value, values);
                        break;
                    case "moving-average":
                        result = detectMovingAverage(value, values);
                        break;
                    default:
                        result = detectZScoreWithConfig(value, values, activeZscoreThreshold, activeZscoreWarning);
                }

                // Apply hysteresis to prevent alarm flickering
                let finalIsAnomaly = result.isAnomaly;
                let hysteresisApplied = false;

                if (activeHysteresisEnabled) {
                    if (result.isAnomaly) {
                        node.consecutiveAnomalies++;
                        node.consecutiveNormals = 0;

                        // Only trigger anomaly if consecutive count reached
                        // OR if already in anomaly state (maintain state)
                        if (node.consecutiveAnomalies >= activeConsecutiveCount || node.lastAnomalyState) {
                            finalIsAnomaly = true;
                        } else {
                            finalIsAnomaly = false;
                            hysteresisApplied = true;
                        }
                    } else {
                        node.consecutiveNormals++;
                        node.consecutiveAnomalies = 0;

                        // Only return to normal if consecutive normal count reached
                        // This creates hysteresis (deadband)
                        if (node.lastAnomalyState) {
                            // Apply hysteresis: need more consecutive normals to exit anomaly state
                            const exitCount = Math.max(
                                activeConsecutiveCount,
                                Math.ceil(activeConsecutiveCount * (1 + node.hysteresisPercent / 100))
                            );

                            if (node.consecutiveNormals >= exitCount) {
                                finalIsAnomaly = false;
                            } else {
                                finalIsAnomaly = true; // Stay in anomaly state
                                hysteresisApplied = true;
                            }
                        } else {
                            finalIsAnomaly = false;
                        }
                    }

                    node.lastAnomalyState = finalIsAnomaly;
                }

                debugLog(
                    node.method +
                        ": value=" +
                        value +
                        ", rawAnomaly=" +
                        result.isAnomaly +
                        ", finalAnomaly=" +
                        finalIsAnomaly +
                        ", hysteresis=" +
                        hysteresisApplied +
                        ", consec_anom=" +
                        node.consecutiveAnomalies +
                        ", consec_norm=" +
                        node.consecutiveNormals
                );

                // Update status
                const statusColor =
                    result.severity === "critical" ? "red" : result.severity === "warning" ? "yellow" : "green";
                const statusShape = hysteresisApplied ? "ring" : "dot";
                node.status({ fill: statusColor, shape: statusShape, text: result.statusText });

                // Build output message
                const outputMsg = {
                    payload: value,
                    isAnomaly: finalIsAnomaly,
                    rawAnomaly: result.isAnomaly,
                    severity: result.severity,
                    method: node.method,
                    bufferSize: node.dataBuffer.length,
                    windowSize: node.windowSize,
                    hysteresis: {
                        enabled: node.hysteresisEnabled,
                        applied: hysteresisApplied,
                        consecutiveAnomalies: node.consecutiveAnomalies,
                        consecutiveNormals: node.consecutiveNormals
                    },
                    timestamp: Date.now()
                };

                // Add adaptive threshold info
                if (node.adaptiveEnabled) {
                    outputMsg.adaptive = getAdaptiveStats();
                    outputMsg.adaptive.adjustedThreshold = activeZscoreThreshold;
                }

                // Broadcast via WebSocket for real-time dashboards
                if (node.websocketEnabled && node.wsManager) {
                    broadcastResult({
                        type: "single",
                        value: value,
                        isAnomaly: finalIsAnomaly,
                        severity: result.severity,
                        method: node.method,
                        details: result.details,
                        timestamp: outputMsg.timestamp
                    });
                }

                // Set topic if configured
                if (node.outputTopic) {
                    outputMsg.topic = node.outputTopic;
                }

                // Add method-specific details
                Object.assign(outputMsg, result.details);

                // Copy original message properties
                Object.keys(msg).forEach(function (key) {
                    if (!Object.prototype.hasOwnProperty.call(outputMsg, key)) {
                        outputMsg[key] = msg[key];
                    }
                    // Preserve original topic if no output topic configured
                    if (key === "topic" && !node.outputTopic) {
                        outputMsg.topic = msg.topic;
                    }
                });

                // Output: normal to output 1, anomaly to output 2
                if (finalIsAnomaly) {
                    node.send([null, outputMsg]);
                } else {
                    node.send([outputMsg, null]);
                }
                done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "error" });
                done("Error in anomaly detection: " + err.message);
            }
        });

        node.on("close", async function (done) {
            // Save state before closing if persistence enabled
            if (persistence) {
                await persistence.close();
            }

            // Note: Don't shutdown global WebSocket manager here as other nodes may use it
            // The manager has its own cleanup via Node-RED lifecycle

            node.dataBuffer = [];
            node.ema = null;
            node.cusumPos = 0;
            node.cusumNeg = 0;
            node.initialized = false;
            node.lastAnomalyState = false;
            node.consecutiveAnomalies = 0;
            node.consecutiveNormals = 0;
            node.status({});

            if (done) done();
        });
    }

    RED.nodes.registerType("anomaly-detector", AnomalyDetectorNode);
};
