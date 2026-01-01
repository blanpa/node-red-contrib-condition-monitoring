module.exports = function(RED) {
    "use strict";
    
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
        
        // State
        this.dataBuffer = [];
        
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
        
        // Initial status
        node.status({fill: "blue", shape: "ring", text: node.method + " - waiting"});
        
        // Helper functions
        function calculateMean(values) {
            return values.reduce((a, b) => a + b, 0) / values.length;
        }
        
        function calculateStdDev(values, mean) {
            var variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
            return Math.sqrt(variance);
        }
        
        function calculateQuartiles(values) {
            var sorted = values.slice().sort((a, b) => a - b);
            var q1Index = Math.floor(sorted.length * 0.25);
            var q3Index = Math.floor(sorted.length * 0.75);
            return {
                q1: sorted[q1Index],
                q3: sorted[q3Index],
                iqr: sorted[q3Index] - sorted[q1Index],
                median: sorted[Math.floor(sorted.length * 0.5)]
            };
        }
        
        function calculatePercentile(sorted, percentile) {
            if (sorted.length === 0) return 0;
            var index = (percentile / 100) * (sorted.length - 1);
            var lower = Math.floor(index);
            var upper = Math.ceil(index);
            var weight = index - lower;
            if (lower === upper) return sorted[lower];
            return sorted[lower] * (1 - weight) + sorted[upper] * weight;
        }
        
        // Z-Score method
        function detectZScore(value, values) {
            var mean = calculateMean(values);
            var stdDev = calculateStdDev(values, mean);
            var zScore = stdDev === 0 ? 0 : (value - mean) / stdDev;
            var absZScore = Math.abs(zScore);
            
            var severity = "normal";
            var isAnomaly = false;
            
            if (absZScore > node.zscoreThreshold) {
                severity = "critical";
                isAnomaly = true;
            } else if (absZScore > node.zscoreWarning) {
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
                    threshold: node.zscoreThreshold,
                    warningThreshold: node.zscoreWarning
                },
                statusText: severity === "critical" ? "CRITICAL z=" + zScore.toFixed(2) :
                            severity === "warning" ? "warning z=" + zScore.toFixed(2) :
                            "μ=" + mean.toFixed(1) + " σ=" + stdDev.toFixed(2)
            };
        }
        
        // IQR method
        function detectIQR(value, values) {
            var quartiles = calculateQuartiles(values);
            var lowerBound = quartiles.q1 - (node.iqrMultiplier * quartiles.iqr);
            var upperBound = quartiles.q3 + (node.iqrMultiplier * quartiles.iqr);
            var lowerWarning = quartiles.q1 - (node.iqrWarningMultiplier * quartiles.iqr);
            var upperWarning = quartiles.q3 + (node.iqrWarningMultiplier * quartiles.iqr);
            
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
                    multiplier: node.iqrMultiplier
                },
                statusText: severity === "critical" ? "CRITICAL: " + value.toFixed(2) :
                            severity === "warning" ? "warning: " + value.toFixed(2) :
                            "Q1=" + quartiles.q1.toFixed(1) + " Q3=" + quartiles.q3.toFixed(1)
            };
        }
        
        // Threshold method
        function detectThreshold(value) {
            var severity = "normal";
            var isAnomaly = false;
            var reason = null;
            
            var minWarning = node.minThreshold !== null ? node.minThreshold * (1 + node.warningMargin / 100) : null;
            var maxWarning = node.maxThreshold !== null ? node.maxThreshold * (1 - node.warningMargin / 100) : null;
            
            if (node.minThreshold !== null && value < node.minThreshold) {
                severity = "critical";
                isAnomaly = true;
                reason = "Below minimum (" + node.minThreshold + ")";
            } else if (minWarning !== null && value < minWarning) {
                severity = "warning";
                isAnomaly = true;
                reason = "Approaching minimum";
            }
            
            if (node.maxThreshold !== null && value > node.maxThreshold) {
                severity = "critical";
                isAnomaly = true;
                reason = reason ? reason + " AND above maximum" : "Above maximum (" + node.maxThreshold + ")";
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
        
        node.on('input', function(msg) {
            try {
                // Reset function
                if (msg.reset === true) {
                    node.dataBuffer = [];
                    node.ema = null;
                    node.cusumPos = 0;
                    node.cusumNeg = 0;
                    node.initialized = false;
                    node.status({fill: "blue", shape: "ring", text: node.method + " - reset"});
                    return;
                }
                
                var value = parseFloat(msg.payload);
                
                if (isNaN(value)) {
                    node.status({fill: "red", shape: "ring", text: "invalid input"});
                    node.error("Payload is not a valid number", msg);
                    return;
                }
                
                // Add to buffer
                node.dataBuffer.push({ timestamp: Date.now(), value: value });
                if (node.dataBuffer.length > node.windowSize) {
                    node.dataBuffer.shift();
                }
                
                var values = node.dataBuffer.map(d => d.value);
                
                // Minimum data check
                var minRequired = node.method === "iqr" ? 4 : 2;
                if (node.dataBuffer.length < minRequired) {
                    node.status({fill: "yellow", shape: "ring", text: "warmup " + node.dataBuffer.length + "/" + minRequired});
                    node.send(msg);
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
                        result = detectEMA(value, values);
                        break;
                    case "cusum":
                        result = detectCUSUM(value, values);
                        break;
                    case "moving-average":
                        result = detectMovingAverage(value, values);
                        break;
                    default:
                        result = detectZScore(value, values);
                }
                
                // Update status
                var statusColor = result.severity === "critical" ? "red" :
                                  result.severity === "warning" ? "yellow" : "green";
                node.status({fill: statusColor, shape: "dot", text: result.statusText});
                
                debugLog(node.method + ": value=" + value + ", severity=" + result.severity);
                
                // Build output message
                var outputMsg = {
                    payload: value,
                    isAnomaly: result.isAnomaly,
                    severity: result.severity,
                    method: node.method,
                    bufferSize: node.dataBuffer.length,
                    windowSize: node.windowSize
                };
                
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
                if (result.isAnomaly) {
                    node.send([null, outputMsg]);
                } else {
                    node.send([outputMsg, null]);
                }
                
            } catch (err) {
                node.status({fill: "red", shape: "ring", text: "error"});
                node.error("Error in anomaly detection: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.dataBuffer = [];
            node.ema = null;
            node.cusumPos = 0;
            node.cusumNeg = 0;
            node.initialized = false;
            node.status({});
        });
    }
    
    RED.nodes.registerType("anomaly-detector", AnomalyDetectorNode);
};
