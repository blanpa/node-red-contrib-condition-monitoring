module.exports = function(RED) {
    "use strict";

    // Import shared statistics utilities
    var stats = require('./utils/statistics');

    // Import state persistence helper
    var persistenceHelper = require('./utils/persistence-helper');

    // Import error handling utilities
    var errorHandler = require('./utils/error-handler');

    // Import WebSocket manager for real-time dashboards
    var WebSocketManager = null;
    try {
        WebSocketManager = require('./websocket-manager');
    } catch (err) {
        // WebSocket support not available
    }

    function AnomalyDetectorNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        // Common Configuration
        this.method = config.method || "zscore"; // zscore, iqr, threshold, percentile, ema, cusum, moving-average
        this.windowSize = parseInt(config.windowSize) || 100;
        
        // Z-Score specific
        this.zscoreThreshold = parseFloat(config.zscoreThreshold) || 3.0;
        this.zscoreWarning = parseFloat(config.zscoreWarning) || 2.0;
        
        // IQR specific
        this.iqrMultiplier = parseFloat(config.iqrMultiplier) || 1.5;
        this.iqrWarningMultiplier = parseFloat(config.iqrWarningMultiplier) || 1.2;
        
        // Threshold specific
        this.minThreshold = config.minThreshold !== "" && config.minThreshold !== undefined ? parseFloat(config.minThreshold) : null;
        this.maxThreshold = config.maxThreshold !== "" && config.maxThreshold !== undefined ? parseFloat(config.maxThreshold) : null;
        this.warningMargin = parseFloat(config.warningMargin) || 10;
        
        // Percentile specific
        this.lowerPercentile = parseFloat(config.lowerPercentile) || 5.0;
        this.upperPercentile = parseFloat(config.upperPercentile) || 95.0;
        
        // EMA specific
        this.emaAlpha = parseFloat(config.emaAlpha) || 0.3;
        this.emaThreshold = parseFloat(config.emaThreshold) || 2.0;
        this.emaWarning = parseFloat(config.emaWarning) || 1.5;
        this.emaMethod = config.emaMethod || "stddev";
        
        // CUSUM specific
        this.cusumTarget = config.cusumTarget !== "" && config.cusumTarget !== undefined ? parseFloat(config.cusumTarget) : null;
        this.cusumThreshold = parseFloat(config.cusumThreshold) || 5.0;
        this.cusumWarning = parseFloat(config.cusumWarning) || 3.5;
        this.cusumDrift = parseFloat(config.cusumDrift) || 0.5;
        
        // Moving Average specific
        this.maThreshold = parseFloat(config.maThreshold) || 2.0;
        this.maWarning = parseFloat(config.maWarning) || 1.5;
        this.maMethod = config.maMethod || "stddev";
        
        // Advanced settings
        this.outputTopic = config.outputTopic || "";
        this.debug = config.debug === true;
        this.persistState = config.persistState === true;
        
        // Hysteresis settings - prevents alarm flickering
        this.hysteresisEnabled = config.hysteresisEnabled !== false; // Default: enabled
        this.hysteresisPercent = parseFloat(config.hysteresisPercent) || 10; // 10% deadband
        this.consecutiveCount = parseInt(config.consecutiveCount) || 1; // Consecutive samples to confirm

        // Adaptive Thresholds - learns from operator feedback
        this.adaptiveEnabled = config.adaptiveEnabled === true;
        this.adaptiveLearningRate = parseFloat(config.adaptiveLearningRate) || 0.1; // How fast to adjust
        this.adaptiveMinSamples = parseInt(config.adaptiveMinSamples) || 10; // Min feedback before adjusting
        this.targetFalsePositiveRate = parseFloat(config.targetFalsePositiveRate) || 0.05; // 5% target

        // Batch Processing Mode - for historical data analysis
        this.batchMode = config.batchMode === true;

        // WebSocket for real-time dashboards
        this.websocketEnabled = config.websocketEnabled === true;
        this.websocketPort = parseInt(config.websocketPort) || 1881;
        this.websocketTopic = config.websocketTopic || "anomaly-detector";

        // State
        this.dataBuffer = [];
        this.lastAnomalyState = false; // Track previous anomaly state for hysteresis
        this.consecutiveAnomalies = 0; // Counter for consecutive anomalies
        this.consecutiveNormals = 0; // Counter for consecutive normal values

        // Adaptive Thresholds State
        this.adaptiveState = {
            feedbackHistory: [],       // { timestamp, predicted, actual, value }
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
        var debugLog = function(message) {
            if (node.debug) {
                node.warn("[DEBUG] " + message);
            }
        };
        this.ema = null;
        this.cusumPos = 0;
        this.cusumNeg = 0;
        this.initialized = false;
        
        // Initialize state persistence using helper
        var persistence = persistenceHelper.initializeStatePersistence(node, {
            stateKey: 'anomalyDetectorState',
            saveInterval: 30000,
            debug: node.debug,
            onStateLoaded: function(state) {
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
                    debugLog("Restored adaptive state with " +
                             (state.adaptiveState.truePositives + state.adaptiveState.falsePositives +
                              state.adaptiveState.trueNegatives + state.adaptiveState.falseNegatives) +
                             " feedback samples");
                }

                if (node.dataBuffer.length > 0) {
                    debugLog("Restored " + node.dataBuffer.length + " buffered values from persistence");
                    node.status({fill: "green", shape: "dot", text: node.method + " - restored (" + node.dataBuffer.length + ")"});
                }
            },
            getStateToSave: function() {
                var state = {
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
            node.wsManager = WebSocketManager.getWebSocketManager({ port: node.websocketPort });
            if (!node.wsManager.isRunning) {
                node.wsManager.start().then(function() {
                    debugLog("WebSocket server started on port " + node.websocketPort);
                }).catch(function(err) {
                    node.warn("Failed to start WebSocket server: " + err.message);
                });
            }
        }

        // Initial status
        node.status({fill: "blue", shape: "ring", text: node.method + " - waiting"});
        
        // Use shared statistics utilities
        var calculateMean = stats.calculateMean;
        var calculateStdDev = stats.calculateStdDev;
        var calculateQuartiles = stats.calculateQuartiles;
        var calculatePercentile = stats.calculatePercentileSorted;
        
        // Z-Score method (uses node defaults)
        function detectZScore(value, values) {
            return detectZScoreWithConfig(value, values, node.zscoreThreshold, node.zscoreWarning);
        }
        
        // Z-Score method with configurable thresholds (for msg.config override)
        function detectZScoreWithConfig(value, values, threshold, warning) {
            var mean = calculateMean(values);
            var stdDev = calculateStdDev(values, mean);
            var zScore = stdDev === 0 ? 0 : (value - mean) / stdDev;
            var absZScore = Math.abs(zScore);
            
            var severity = "normal";
            var isAnomaly = false;
            
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
                statusText: severity === "critical" ? "CRITICAL z=" + zScore.toFixed(2) :
                            severity === "warning" ? "warning z=" + zScore.toFixed(2) :
                            "μ=" + mean.toFixed(1) + " σ=" + stdDev.toFixed(2)
            };
        }
        
        // IQR method (uses node defaults)
        function detectIQR(value, values) {
            return detectIQRWithConfig(value, values, node.iqrMultiplier);
        }
        
        // IQR method with configurable multiplier (for msg.config override)
        function detectIQRWithConfig(value, values, multiplier) {
            var quartiles = calculateQuartiles(values);
            var warningMultiplier = multiplier * 0.8; // Warning at 80% of critical
            var lowerBound = quartiles.q1 - (multiplier * quartiles.iqr);
            var upperBound = quartiles.q3 + (multiplier * quartiles.iqr);
            var lowerWarning = quartiles.q1 - (warningMultiplier * quartiles.iqr);
            var upperWarning = quartiles.q3 + (warningMultiplier * quartiles.iqr);
            
            var severity = "normal";
            var isAnomaly = false;
            
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
                statusText: severity === "critical" ? "CRITICAL: " + value.toFixed(2) :
                            severity === "warning" ? "warning: " + value.toFixed(2) :
                            "Q1=" + quartiles.q1.toFixed(1) + " Q3=" + quartiles.q3.toFixed(1)
            };
        }
        
        // Threshold method (uses node defaults)
        function detectThreshold(value) {
            return detectThresholdWithConfig(value, node.minThreshold, node.maxThreshold);
        }
        
        // Threshold method with configurable thresholds (for msg.config override)
        function detectThresholdWithConfig(value, minThreshold, maxThreshold) {
            var severity = "normal";
            var isAnomaly = false;
            var reason = null;
            
            var minWarning = minThreshold !== null ? minThreshold * (1 + node.warningMargin / 100) : null;
            var maxWarning = maxThreshold !== null ? maxThreshold * (1 - node.warningMargin / 100) : null;
            
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
                statusText: severity === "critical" ? "CRITICAL: " + value :
                            severity === "warning" ? "warning: " + value :
                            "OK: " + value
            };
        }
        
        // Percentile method
        function detectPercentile(value, values) {
            var sorted = values.slice().sort((a, b) => a - b);
            var lowerBound = calculatePercentile(sorted, node.lowerPercentile);
            var upperBound = calculatePercentile(sorted, node.upperPercentile);
            
            var isAnomaly = value < lowerBound || value > upperBound;
            
            return {
                isAnomaly: isAnomaly,
                severity: isAnomaly ? "critical" : "normal",
                details: {
                    lowerPercentile: node.lowerPercentile,
                    upperPercentile: node.upperPercentile,
                    lowerBound: lowerBound,
                    upperBound: upperBound
                },
                statusText: isAnomaly ? "ANOMALY: " + value.toFixed(2) :
                            "P" + node.lowerPercentile + "-P" + node.upperPercentile
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
            
            var mean = calculateMean(values);
            var stdDev = calculateStdDev(values, mean);
            var deviation = Math.abs(value - node.ema);
            var deviationFactor = stdDev === 0 ? 0 : deviation / stdDev;
            
            var severity = "normal";
            var isAnomaly = false;
            
            if (node.emaMethod === "stddev") {
                if (deviationFactor > node.emaThreshold) {
                    severity = "critical";
                    isAnomaly = true;
                } else if (deviationFactor > node.emaWarning) {
                    severity = "warning";
                    isAnomaly = true;
                }
            } else {
                var deviationPercent = node.ema === 0 ? 0 : (deviation / Math.abs(node.ema)) * 100;
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
                statusText: severity === "critical" ? "CRITICAL EMA=" + node.ema.toFixed(2) :
                            severity === "warning" ? "warning EMA=" + node.ema.toFixed(2) :
                            "EMA=" + node.ema.toFixed(2)
            };
        }
        
        // CUSUM method
        function detectCUSUM(value, values) {
            var target = node.cusumTarget !== null ? node.cusumTarget : calculateMean(values);
            
            var deviation = value - target;
            node.cusumPos = Math.max(0, node.cusumPos + deviation - node.cusumDrift);
            node.cusumNeg = Math.max(0, node.cusumNeg - deviation - node.cusumDrift);
            
            var maxCusum = Math.max(node.cusumPos, node.cusumNeg);
            
            var severity = "normal";
            var isAnomaly = false;
            
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
                statusText: severity === "critical" ? "CRITICAL CUSUM=" + maxCusum.toFixed(2) :
                            severity === "warning" ? "warning CUSUM=" + maxCusum.toFixed(2) :
                            "CUSUM=" + maxCusum.toFixed(2)
            };
        }
        
        // Moving Average method
        function detectMovingAverage(value, values) {
            var movingAverage = calculateMean(values);
            var stdDev = calculateStdDev(values, movingAverage);
            var deviation = Math.abs(value - movingAverage);
            var deviationFactor = stdDev === 0 ? 0 : deviation / stdDev;
            
            var severity = "normal";
            var isAnomaly = false;
            
            if (node.maMethod === "stddev") {
                if (deviationFactor > node.maThreshold) {
                    severity = "critical";
                    isAnomaly = true;
                } else if (deviationFactor > node.maWarning) {
                    severity = "warning";
                    isAnomaly = true;
                }
            } else {
                var deviationPercent = movingAverage === 0 ? 0 : (deviation / Math.abs(movingAverage)) * 100;
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
                statusText: severity === "critical" ? "CRITICAL MA=" + movingAverage.toFixed(2) :
                            severity === "warning" ? "warning MA=" + movingAverage.toFixed(2) :
                            "MA=" + movingAverage.toFixed(2)
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
            var results = {};
            var anyAnomaly = false;
            var worstSeverity = "normal";
            var anomalySensors = [];
            var skippedSensors = [];

            var sensorNames = Object.keys(sensorData);

            sensorNames.forEach(function(sensorName) {
                var rawValue = sensorData[sensorName];
                var value = parseFloat(rawValue);

                // Validate value is a finite number (catches NaN, Infinity, -Infinity)
                if (!Number.isFinite(value)) {
                    skippedSensors.push({ name: sensorName, reason: 'not a finite number', value: rawValue });
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
                
                var values = node.sensorBuffers[sensorName].map(function(d) { return d.value; });
                
                // Minimum data check
                var minRequired = node.method === "iqr" ? 4 : 2;
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
                var result;
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
                        var sensorEmaResult = detectEMASensor(value, values, sensorName);
                        result = sensorEmaResult;
                        break;
                    case "cusum":
                        var sensorCusumResult = detectCUSUMSensor(value, values, sensorName);
                        result = sensorCusumResult;
                        break;
                    case "moving-average":
                        result = detectMovingAverage(value, values);
                        break;
                    default:
                        result = detectZScore(value, values);
                }
                
                // Apply per-sensor hysteresis
                var finalIsAnomaly = result.isAnomaly;
                var state = node.sensorStates[sensorName];
                
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
                            var requiredNormals = Math.ceil(node.consecutiveCount * (1 + node.hysteresisPercent / 100));
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
                    if (result.severity === "critical" || (worstSeverity !== "critical" && result.severity === "warning")) {
                        worstSeverity = result.severity;
                    }
                }
            });

            // Check if any valid sensors were processed
            var validSensorCount = Object.keys(results).length;
            if (validSensorCount === 0) {
                errorHandler.handleNodeError(node, "No valid sensor readings in input", msg, 'warn', {
                    statusText: "no valid sensors"
                });
                return;
            }

            // Build output message
            var outMsg = {
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
        
        // EMA detection for specific sensor
        function detectEMASensor(value, values, sensorName) {
            var result = detectEMA(value, values);
            // Store per-sensor EMA state
            if (!node.sensorEma[sensorName]) {
                node.sensorEma[sensorName] = node.ema;
            }
            return result;
        }
        
        // CUSUM detection for specific sensor
        function detectCUSUMSensor(value, values, sensorName) {
            var result = detectCUSUM(value, values);
            // Store per-sensor CUSUM state
            if (!node.sensorCusum[sensorName]) {
                node.sensorCusum[sensorName] = { pos: node.cusumPos, neg: node.cusumNeg };
            }
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

            var state = node.adaptiveState;
            var entry = {
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
            var totalPositives = state.truePositives + state.falsePositives;
            var totalNegatives = state.trueNegatives + state.falseNegatives;
            var totalSamples = totalPositives + totalNegatives;

            debugLog("Adaptive feedback: TP=" + state.truePositives + " FP=" + state.falsePositives +
                     " TN=" + state.trueNegatives + " FN=" + state.falseNegatives);

            // Only adjust after minimum samples
            if (totalSamples < node.adaptiveMinSamples) {
                debugLog("Adaptive: waiting for more samples (" + totalSamples + "/" + node.adaptiveMinSamples + ")");
                return;
            }

            // Calculate false positive rate
            var falsePositiveRate = totalPositives > 0 ? state.falsePositives / totalPositives : 0;
            var falseNegativeRate = totalNegatives > 0 ? state.falseNegatives / (state.falseNegatives + state.trueNegatives) : 0;

            // Adjust threshold based on error rates
            var adjustment = 0;

            if (falsePositiveRate > node.targetFalsePositiveRate) {
                // Too many false positives - make threshold less sensitive (increase)
                adjustment = node.adaptiveLearningRate * (falsePositiveRate - node.targetFalsePositiveRate);
                debugLog("Adaptive: FP rate " + (falsePositiveRate * 100).toFixed(1) + "% > target, loosening threshold by " + adjustment.toFixed(3));
            } else if (falseNegativeRate > node.targetFalsePositiveRate * 2) {
                // Too many false negatives - make threshold more sensitive (decrease)
                adjustment = -node.adaptiveLearningRate * (falseNegativeRate - node.targetFalsePositiveRate);
                debugLog("Adaptive: FN rate " + (falseNegativeRate * 100).toFixed(1) + "% high, tightening threshold by " + (-adjustment).toFixed(3));
            }

            if (adjustment !== 0) {
                state.currentThresholdAdjustment += adjustment;
                // Limit adjustment range to ±50% of original threshold
                state.currentThresholdAdjustment = Math.max(-0.5, Math.min(0.5, state.currentThresholdAdjustment));
                state.lastAdjustmentTime = Date.now();

                debugLog("Adaptive: total threshold adjustment = " + (state.currentThresholdAdjustment * 100).toFixed(1) + "%");
            }
        }

        /**
         * Get adaptive-adjusted threshold
         */
        function getAdaptiveThreshold(baseThreshold) {
            if (!node.adaptiveEnabled) return baseThreshold;
            var adjustment = node.adaptiveState.currentThresholdAdjustment;
            return baseThreshold * (1 + adjustment);
        }

        /**
         * Get adaptive statistics for output
         */
        function getAdaptiveStats() {
            var state = node.adaptiveState;
            var total = state.truePositives + state.falsePositives + state.trueNegatives + state.falseNegatives;

            return {
                enabled: node.adaptiveEnabled,
                feedbackCount: total,
                truePositives: state.truePositives,
                falsePositives: state.falsePositives,
                trueNegatives: state.trueNegatives,
                falseNegatives: state.falseNegatives,
                falsePositiveRate: total > 0 ? state.falsePositives / Math.max(1, state.truePositives + state.falsePositives) : 0,
                precision: state.truePositives + state.falsePositives > 0
                    ? state.truePositives / (state.truePositives + state.falsePositives) : 1,
                recall: state.truePositives + state.falseNegatives > 0
                    ? state.truePositives / (state.truePositives + state.falseNegatives) : 1,
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
            var results = [];
            var anomalyCount = 0;
            var warningCount = 0;
            var normalCount = 0;
            var anomalyIndices = [];

            // Build temporary buffer for analysis
            var tempBuffer = [];
            var minRequired = method === "iqr" ? 4 : 2;

            for (var i = 0; i < values.length; i++) {
                var item = values[i];
                var value = typeof item === 'object' ? item.value : item;
                var timestamp = typeof item === 'object' ? item.timestamp : Date.now();

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

                var bufferValues = tempBuffer.map(function(d) { return d.value; });
                var result;

                // Use adaptive threshold if enabled
                var activeThreshold = getAdaptiveThreshold(threshold || node.zscoreThreshold);

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

                var batchResult = {
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
            var allValues = values.map(function(v) {
                return typeof v === 'object' ? parseFloat(v.value) : parseFloat(v);
            }).filter(function(v) { return !isNaN(v); });

            var stats = {
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

        node.on('input', function(msg) {
            try {
                // ==========================================
                // FEEDBACK PROCESSING (Adaptive Thresholds)
                // ==========================================
                if (msg.feedback) {
                    processAdaptiveFeedback(msg.feedback);
                    var adaptiveStats = getAdaptiveStats();
                    node.status({
                        fill: "blue",
                        shape: "dot",
                        text: "Feedback: " + adaptiveStats.feedbackCount + " samples, adj=" +
                              (adaptiveStats.thresholdAdjustment * 100).toFixed(1) + "%"
                    });

                    // Send feedback confirmation
                    var feedbackMsg = {
                        payload: adaptiveStats,
                        topic: "adaptive-feedback",
                        _msgid: msg._msgid
                    };
                    node.send([feedbackMsg, null]);
                    return;
                }

                // ==========================================
                // BATCH PROCESSING MODE
                // ==========================================
                if (msg.batch === true || (node.batchMode && Array.isArray(msg.payload) && msg.payload.length > 1 && typeof msg.payload[0] !== 'object')) {
                    // Array of raw numbers for batch processing
                    var batchResult = processBatch(msg.payload, msg.method || node.method, msg.threshold);

                    var batchMsg = {
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
                        text: "Batch: " + batchResult.summary.anomalies + "/" + batchResult.summary.totalSamples + " anomalies"
                    });

                    // Output batch results (anomalies found = output 2, no anomalies = output 1)
                    if (batchResult.summary.anomalies > 0 || batchResult.summary.warnings > 0) {
                        node.send([null, batchMsg]);
                    } else {
                        node.send([batchMsg, null]);
                    }
                    return;
                }

                // Dynamic configuration via msg.config
                // Allows runtime override of node settings
                var cfg = msg.config || {};
                var activeMethod = cfg.method || node.method;
                var activeWindowSize = (cfg.windowSize !== undefined) ? parseInt(cfg.windowSize) : node.windowSize;
                var activeZscoreThreshold = (cfg.zscoreThreshold !== undefined) ? parseFloat(cfg.zscoreThreshold) : node.zscoreThreshold;
                var activeZscoreWarning = (cfg.zscoreWarning !== undefined) ? parseFloat(cfg.zscoreWarning) : node.zscoreWarning;
                var activeIqrMultiplier = (cfg.iqrMultiplier !== undefined) ? parseFloat(cfg.iqrMultiplier) : node.iqrMultiplier;
                var activeMinThreshold = (cfg.minThreshold !== undefined) ? parseFloat(cfg.minThreshold) : node.minThreshold;
                var activeMaxThreshold = (cfg.maxThreshold !== undefined) ? parseFloat(cfg.maxThreshold) : node.maxThreshold;
                var activeHysteresisEnabled = (cfg.hysteresisEnabled !== undefined) ? cfg.hysteresisEnabled : node.hysteresisEnabled;
                var activeConsecutiveCount = (cfg.consecutiveCount !== undefined) ? parseInt(cfg.consecutiveCount) : node.consecutiveCount;

                // Apply adaptive threshold adjustment
                activeZscoreThreshold = getAdaptiveThreshold(activeZscoreThreshold);
                activeZscoreWarning = getAdaptiveThreshold(activeZscoreWarning);

                // Reset function
                if (msg.reset === true) {
                    node.dataBuffer = [];
                    node.sensorBuffers = {}; // For multi-sensor mode
                    node.sensorStates = {};  // Hysteresis states per sensor
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

                    node.status({fill: "blue", shape: "ring", text: activeMethod + " - reset"});
                    return;
                }
                
                // Check if payload is JSON object or array (multi-sensor mode)
                if (typeof msg.payload === 'object' && msg.payload !== null && !Array.isArray(msg.payload)) {
                    // JSON object input: { "sensor1": 25.5, "sensor2": 30.2, ... }
                    processMultiSensorInput(msg, msg.payload);
                    return;
                } else if (Array.isArray(msg.payload) && msg.payload.length > 0 && typeof msg.payload[0] === 'object') {
                    // Array of sensor objects: [{ name: "temp", value: 25.5 }, ...]
                    var sensorData = {};
                    msg.payload.forEach(function(item) {
                        if (item.name && item.value !== undefined) {
                            sensorData[item.name] = item.value;
                        }
                    });
                    processMultiSensorInput(msg, sensorData);
                    return;
                }
                
                // SECURITY: Strict number validation
                // parseFloat("123abc") returns 123 which can be misleading
                var value;
                if (typeof msg.payload === 'number') {
                    value = msg.payload;
                } else if (typeof msg.payload === 'string') {
                    // Only accept strings that are purely numeric
                    var trimmed = msg.payload.trim();
                    if (trimmed === '' || !/^-?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(trimmed)) {
                        node.status({fill: "red", shape: "ring", text: "invalid input"});
                        node.error("Payload is not a valid number: " + msg.payload, msg);
                        return;
                    }
                    value = parseFloat(trimmed);
                } else {
                    node.status({fill: "red", shape: "ring", text: "invalid input"});
                    node.error("Payload must be a number or numeric string, got: " + typeof msg.payload, msg);
                    return;
                }

                if (!Number.isFinite(value)) {
                    node.status({fill: "red", shape: "ring", text: "invalid input"});
                    node.error("Payload is not a finite number (NaN or Infinity)", msg);
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
                
                var values = node.dataBuffer.map(d => d.value);
                
                // Minimum data check
                var minRequired = node.method === "iqr" ? 4 : 2;
                if (node.dataBuffer.length < minRequired) {
                    node.status({fill: "yellow", shape: "ring", text: "warmup " + node.dataBuffer.length + "/" + minRequired});
                    node.send(msg);
                    return;
                }
                
                // Detect anomaly based on method (use active config from msg.config or node defaults)
                var result;
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
                var finalIsAnomaly = result.isAnomaly;
                var hysteresisApplied = false;
                
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
                            var exitCount = Math.max(activeConsecutiveCount, 
                                Math.ceil(activeConsecutiveCount * (1 + node.hysteresisPercent / 100)));
                            
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
                
                debugLog(node.method + ": value=" + value + ", rawAnomaly=" + result.isAnomaly + 
                        ", finalAnomaly=" + finalIsAnomaly + ", hysteresis=" + hysteresisApplied +
                        ", consec_anom=" + node.consecutiveAnomalies + ", consec_norm=" + node.consecutiveNormals);
                
                // Update status
                var statusColor = result.severity === "critical" ? "red" :
                                  result.severity === "warning" ? "yellow" : "green";
                var statusShape = hysteresisApplied ? "ring" : "dot";
                node.status({fill: statusColor, shape: statusShape, text: result.statusText});
                
                // Build output message
                var outputMsg = {
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
                Object.keys(msg).forEach(function(key) {
                    if (!outputMsg.hasOwnProperty(key)) {
                        outputMsg[key] = msg[key];
                    }
                    // Preserve original topic if no output topic configured
                    if (key === 'topic' && !node.outputTopic) {
                        outputMsg.topic = msg.topic;
                    }
                });
                
                // Output: normal to output 1, anomaly to output 2
                if (finalIsAnomaly) {
                    node.send([null, outputMsg]);
                } else {
                    node.send([outputMsg, null]);
                }
                
            } catch (err) {
                node.status({fill: "red", shape: "ring", text: "error"});
                node.error("Error in anomaly detection: " + err.message, msg);
            }
        });
        
        node.on('close', async function(done) {
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
