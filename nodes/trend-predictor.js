module.exports = function(RED) {
    "use strict";
    
    function TrendPredictorNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        // Configuration
        this.mode = config.mode || "prediction"; // prediction, rate-of-change
        this.method = config.method || "linear"; // linear, exponential
        this.predictionSteps = parseInt(config.predictionSteps) || 10;
        this.windowSize = parseInt(config.windowSize) || 50;
        this.threshold = config.threshold !== "" && config.threshold !== undefined ? parseFloat(config.threshold) : null;
        
        // Rate of change settings
        this.rocMethod = config.rocMethod || "absolute"; // absolute, percentage
        this.timeWindow = parseInt(config.timeWindow) || 1;
        this.rocThreshold = config.rocThreshold !== "" && config.rocThreshold !== undefined ? parseFloat(config.rocThreshold) : null;
        
        // Advanced settings
        this.outputTopic = config.outputTopic || "";
        this.debug = config.debug === true;
        
        // State
        this.buffer = [];
        
        // Debug logging helper
        var debugLog = function(message) {
            if (node.debug) {
                node.warn("[DEBUG] " + message);
            }
        };
        this.timestamps = [];
        this.previousValue = null;
        this.previousTimestamp = null;
        this.rocHistory = [];
        
        node.status({fill: "blue", shape: "ring", text: node.mode + " mode"});
        
        // Linear Regression
        function linearRegression(data, steps) {
            var n = data.length;
            var x = [];
            for (var i = 0; i < n; i++) x.push(i);
            
            var meanX = x.reduce(function(a, b) { return a + b; }, 0) / n;
            var meanY = data.reduce(function(a, b) { return a + b; }, 0) / n;
            
            var numerator = 0;
            var denominator = 0;
            
            for (var i = 0; i < n; i++) {
                numerator += (x[i] - meanX) * (data[i] - meanY);
                denominator += Math.pow(x[i] - meanX, 2);
            }
            
            var slope = denominator !== 0 ? numerator / denominator : 0;
            var intercept = meanY - slope * meanX;
            
            var predictedValues = [];
            for (var i = 1; i <= steps; i++) {
                var futureX = n + i - 1;
                predictedValues.push(slope * futureX + intercept);
            }
            
            var trend = "stable";
            if (Math.abs(slope) > 0.01) {
                trend = slope > 0 ? "increasing" : "decreasing";
            }
            
            return {
                slope: slope,
                intercept: intercept,
                predictedValues: predictedValues,
                trend: trend
            };
        }
        
        // Exponential Smoothing
        function exponentialSmoothing(data, steps) {
            var alpha = 0.3;
            var beta = 0.1;
            
            var level = data[0];
            var trend = data.length > 1 ? data[1] - data[0] : 0;
            
            for (var i = 1; i < data.length; i++) {
                var prevLevel = level;
                level = alpha * data[i] + (1 - alpha) * (level + trend);
                trend = beta * (level - prevLevel) + (1 - beta) * trend;
            }
            
            var predictedValues = [];
            for (var i = 1; i <= steps; i++) {
                predictedValues.push(level + i * trend);
            }
            
            var trendDirection = "stable";
            if (Math.abs(trend) > 0.01) {
                trendDirection = trend > 0 ? "increasing" : "decreasing";
            }
            
            return {
                slope: trend,
                intercept: level,
                predictedValues: predictedValues,
                trend: trendDirection
            };
        }
        
        function calculateStepsToThreshold(predictedValues, threshold) {
            for (var i = 0; i < predictedValues.length; i++) {
                if (predictedValues[i] >= threshold) {
                    return i + 1;
                }
            }
            return null;
        }
        
        // Process Trend Prediction
        function processPrediction(msg, value, timestamp) {
            node.buffer.push(value);
            node.timestamps.push(timestamp);
            
            if (node.buffer.length > node.windowSize) {
                node.buffer.shift();
                node.timestamps.shift();
            }
            
            if (node.buffer.length < 3) {
                node.status({fill: "yellow", shape: "ring", text: "Buffering: " + node.buffer.length + "/3"});
                return null;
            }
            
            var prediction = null;
            if (node.method === "linear") {
                prediction = linearRegression(node.buffer, node.predictionSteps);
            } else {
                prediction = exponentialSmoothing(node.buffer, node.predictionSteps);
            }
            
            var timeToThreshold = null;
            var stepsToThreshold = null;
            
            if (node.threshold !== null && prediction) {
                stepsToThreshold = calculateStepsToThreshold(prediction.predictedValues, node.threshold);
                if (stepsToThreshold !== null && node.timestamps.length >= 2) {
                    var timeDiffs = [];
                    for (var i = 1; i < node.timestamps.length; i++) {
                        timeDiffs.push(node.timestamps[i] - node.timestamps[i-1]);
                    }
                    var avgTimeDiff = timeDiffs.reduce(function(a, b) { return a + b; }, 0) / timeDiffs.length;
                    timeToThreshold = stepsToThreshold * avgTimeDiff;
                }
            }
            
            var outputMsg = {
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
            
            Object.keys(msg).forEach(function(key) {
                if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                    outputMsg[key] = msg[key];
                }
            });
            
            if (prediction) {
                var trendIcon = prediction.slope > 0 ? "↗" : prediction.slope < 0 ? "↘" : "→";
                var statusText = trendIcon + " " + prediction.slope.toFixed(3);
                if (timeToThreshold !== null) {
                    var hours = Math.floor(timeToThreshold / 3600000);
                    statusText += " | RUL: " + hours + "h";
                }
                node.status({fill: "green", shape: "dot", text: statusText});
            }
            
            return { normal: outputMsg, anomaly: null };
        }
        
        // Process Rate of Change
        function processRateOfChange(msg, value, timestamp) {
            node.rocHistory.push({ value: value, timestamp: timestamp });
            
            var windowMs = node.timeWindow * 1000;
            node.rocHistory = node.rocHistory.filter(function(h) { 
                return timestamp - h.timestamp <= windowMs; 
            });
            
            var rateOfChange = null;
            var isAnomalous = false;
            var acceleration = null;
            
            if (node.previousValue !== null && node.previousTimestamp !== null) {
                var timeDiff = (timestamp - node.previousTimestamp) / 1000;
                var valueDiff = value - node.previousValue;
                
                if (timeDiff > 0) {
                    if (node.rocMethod === "absolute") {
                        rateOfChange = valueDiff / timeDiff;
                    } else if (node.rocMethod === "percentage") {
                        if (node.previousValue !== 0) {
                            rateOfChange = (valueDiff / Math.abs(node.previousValue)) * 100 / timeDiff;
                        }
                    }
                }
                
                if (node.rocHistory.length >= 3) {
                    var rates = [];
                    for (var i = 1; i < node.rocHistory.length; i++) {
                        var dt = (node.rocHistory[i].timestamp - node.rocHistory[i-1].timestamp) / 1000;
                        var dv = node.rocHistory[i].value - node.rocHistory[i-1].value;
                        if (dt > 0) {
                            rates.push(dv / dt);
                        }
                    }
                    
                    if (rates.length >= 2) {
                        var lastRate = rates[rates.length - 1];
                        var prevRate = rates[rates.length - 2];
                        var avgTimeDiff = windowMs / 1000 / node.rocHistory.length;
                        acceleration = (lastRate - prevRate) / avgTimeDiff;
                    }
                }
                
                if (node.rocThreshold !== null && rateOfChange !== null) {
                    isAnomalous = Math.abs(rateOfChange) > node.rocThreshold;
                }
            }
            
            node.previousValue = value;
            node.previousTimestamp = timestamp;
            
            var outputMsg = {
                payload: value,
                rateOfChange: rateOfChange,
                acceleration: acceleration,
                isAnomalous: isAnomalous,
                method: node.rocMethod,
                timeWindow: node.timeWindow,
                timestamp: timestamp
            };
            
            Object.keys(msg).forEach(function(key) {
                if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                    outputMsg[key] = msg[key];
                }
            });
            
            if (rateOfChange !== null) {
                var sign = rateOfChange >= 0 ? "+" : "";
                var color = isAnomalous ? "red" : "green";
                var unit = node.rocMethod === "percentage" ? "%/s" : "/s";
                node.status({fill: color, shape: "dot", text: sign + rateOfChange.toFixed(3) + unit});
            }
            
            return { normal: isAnomalous ? null : outputMsg, anomaly: isAnomalous ? outputMsg : null };
        }
        
        node.on('input', function(msg) {
            try {
                if (msg.reset === true) {
                    node.buffer = [];
                    node.timestamps = [];
                    node.previousValue = null;
                    node.previousTimestamp = null;
                    node.rocHistory = [];
                    node.status({fill: "blue", shape: "ring", text: node.mode + " - reset"});
                    return;
                }
                
                var value = parseFloat(msg.payload);
                var timestamp = msg.timestamp || Date.now();
                
                if (isNaN(value)) {
                    node.warn("Invalid payload: not a number");
                    return;
                }
                
                var result = null;
                
                if (node.mode === "prediction") {
                    result = processPrediction(msg, value, timestamp);
                } else if (node.mode === "rate-of-change") {
                    result = processRateOfChange(msg, value, timestamp);
                }
                
                if (result) {
                    if (result.anomaly) {
                        node.send([null, result.anomaly]);
                    } else if (result.normal) {
                        node.send([result.normal, null]);
                    }
                }
                
            } catch (err) {
                node.status({fill: "red", shape: "ring", text: "error"});
                node.error("Error in trend prediction: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.buffer = [];
            node.timestamps = [];
            node.previousValue = null;
            node.previousTimestamp = null;
            node.rocHistory = [];
            node.status({});
        });
    }
    
    RED.nodes.registerType("trend-predictor", TrendPredictorNode);
};
