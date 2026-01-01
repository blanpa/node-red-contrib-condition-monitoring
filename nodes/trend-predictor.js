module.exports = function(RED) {
    "use strict";
    
    function TrendPredictorNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        // Configuration
        this.mode = config.mode || "prediction"; // prediction, rate-of-change, rul
        this.method = config.method || "linear"; // linear, exponential
        this.predictionSteps = parseInt(config.predictionSteps) || 10;
        this.windowSize = parseInt(config.windowSize) || 50;
        this.threshold = config.threshold !== "" && config.threshold !== undefined ? parseFloat(config.threshold) : null;
        
        // Rate of change settings
        this.rocMethod = config.rocMethod || "absolute"; // absolute, percentage
        this.timeWindow = parseInt(config.timeWindow) || 1;
        this.rocThreshold = config.rocThreshold !== "" && config.rocThreshold !== undefined ? parseFloat(config.rocThreshold) : null;
        
        // RUL settings
        this.failureThreshold = config.failureThreshold !== "" && config.failureThreshold !== undefined ? parseFloat(config.failureThreshold) : null;
        this.warningThreshold = config.warningThreshold !== "" && config.warningThreshold !== undefined ? parseFloat(config.warningThreshold) : null;
        this.rulUnit = config.rulUnit || "hours"; // hours, minutes, days, cycles
        this.degradationModel = config.degradationModel || "linear"; // linear, exponential, weibull
        this.confidenceLevel = parseFloat(config.confidenceLevel) || 0.95;
        
        // Weibull settings
        this.weibullBeta = parseFloat(config.weibullBeta) || 2.0; // Shape parameter (β)
        this.weibullEta = parseFloat(config.weibullEta) || 1000; // Scale parameter (η) in hours
        
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
            var x = 1 + 1 / beta;
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
                return { phase: "infant_mortality", trend: "decreasing failure rate", recommendation: "Check manufacturing/installation quality" };
            } else if (beta === 1) {
                return { phase: "useful_life", trend: "constant failure rate", recommendation: "Normal maintenance schedule" };
            } else if (beta < 4) {
                return { phase: "wear_out", trend: "increasing failure rate", recommendation: "Preventive replacement recommended" };
            } else {
                return { phase: "rapid_wear_out", trend: "strongly increasing failure rate", recommendation: "Time-based replacement critical" };
            }
        }
        
        function gammaApprox(z) {
            // Stirling approximation for Gamma function
            if (z < 0.5) {
                return Math.PI / (Math.sin(Math.PI * z) * gammaApprox(1 - z));
            }
            z -= 1;
            var g = 7;
            var c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
                     771.32342877765313, -176.61502916214059, 12.507343278686905,
                     -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
            var x = c[0];
            for (var i = 1; i < g + 2; i++) {
                x += c[i] / (z + i);
            }
            var t = z + g + 0.5;
            return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
        }
        
        // Estimate Weibull parameters from failure data using MLE
        function estimateWeibullParams(data, timestamps) {
            if (data.length < 3) return null;
            
            // Normalize data to represent degradation fraction (0 to 1)
            var maxVal = Math.max.apply(null, data);
            var minVal = Math.min.apply(null, data);
            var range = maxVal - minVal;
            
            if (range === 0) return null;
            
            // Use simple estimation based on degradation trend
            var n = data.length;
            var avgInterval = (timestamps[n-1] - timestamps[0]) / (n - 1);
            
            // Calculate degradation rate
            var result = linearRegression(data, 1);
            var slope = result.slope;
            
            if (slope <= 0) return null;
            
            // Estimate eta (characteristic life) from degradation rate
            var currentDegradation = (data[n-1] - minVal) / range;
            var timeElapsed = (n - 1) * avgInterval;
            
            // Estimate beta from variance of degradation
            var mean = data.reduce((a, b) => a + b, 0) / n;
            var variance = data.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
            var cv = Math.sqrt(variance) / mean; // Coefficient of variation
            
            // Beta estimation: higher CV suggests lower beta (more variable)
            var beta = cv > 0 ? Math.max(0.5, Math.min(5, 1 / cv)) : 2.0;
            
            // Eta estimation from current reliability
            var reliability = 1 - currentDegradation;
            if (reliability > 0 && reliability < 1) {
                var eta = timeElapsed / Math.pow(-Math.log(reliability), 1/beta);
                return { beta: beta, eta: eta };
            }
            
            return null;
        }
        
        // Calculate RUL with confidence intervals
        function calculateRUL(data, timestamps, failureThreshold, method, confidenceLevel) {
            if (data.length < 5) return null;
            
            var n = data.length;
            var currentValue = data[n - 1];
            
            // Already failed?
            if (currentValue >= failureThreshold) {
                return {
                    rul: 0,
                    confidence: 1.0,
                    status: 'failed',
                    percentDegraded: 100,
                    model: method
                };
            }
            
            // Calculate degradation rate using linear regression
            var result = linearRegression(data, 1000);
            var slope = result.slope;
            
            // No degradation or improving
            if (slope <= 0) {
                return {
                    rul: Infinity,
                    confidence: 0.5,
                    status: 'stable',
                    percentDegraded: (currentValue / failureThreshold) * 100,
                    trend: 'stable',
                    model: method
                };
            }
            
            // Calculate average time between samples
            var avgInterval = 0;
            if (timestamps.length >= 2) {
                var totalTime = timestamps[n - 1] - timestamps[0];
                avgInterval = totalTime / (n - 1);
            } else {
                avgInterval = 1000; // Default 1 second
            }
            
            var timeToFailure, rulLower, rulUpper, confidence, weibullInfo;
            
            if (method === 'weibull') {
                // Weibull-based RUL estimation
                var weibullParams = estimateWeibullParams(data, timestamps);
                
                if (weibullParams) {
                    var beta = weibullParams.beta;
                    var eta = weibullParams.eta;
                    var timeElapsed = (n - 1) * avgInterval;
                    
                    // Current reliability
                    var currentReliability = weibullReliability(timeElapsed, beta, eta);
                    
                    // Target reliability at failure (e.g., 10%)
                    var targetReliability = 0.1;
                    
                    // Time to target reliability
                    var timeAtTarget = eta * Math.pow(-Math.log(targetReliability), 1/beta);
                    timeToFailure = Math.max(0, timeAtTarget - timeElapsed);
                    
                    // Confidence bounds (rough approximation)
                    var hazardRate = weibullHazard(timeElapsed, beta, eta);
                    var stdTime = 1 / (hazardRate * Math.sqrt(n));
                    rulLower = Math.max(0, timeToFailure - 1.96 * stdTime);
                    rulUpper = timeToFailure + 1.96 * stdTime;
                    
                    // Confidence from R-squared of fit
                    confidence = Math.max(0.3, 1 - Math.abs(currentReliability - (1 - currentValue/failureThreshold)));
                    
                    var betaInterpretation = interpretBeta(beta);
                    weibullInfo = {
                        beta: beta,
                        eta: eta,
                        currentReliability: currentReliability,
                        hazardRate: hazardRate,
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
                    // Fall back to linear if Weibull estimation fails
                    method = 'linear';
                }
            }
            
            if (method !== 'weibull') {
                // Linear or exponential method
                var stepsToFailure = (failureThreshold - currentValue) / slope;
                timeToFailure = stepsToFailure * avgInterval;
                
                // Calculate R-squared for confidence
                var yMean = data.reduce((a, b) => a + b, 0) / n;
                var ssTot = data.reduce((sum, y) => sum + Math.pow(y - yMean, 2), 0);
                var ssRes = 0;
                for (var i = 0; i < n; i++) {
                    var predicted = result.intercept + result.slope * i;
                    ssRes += Math.pow(data[i] - predicted, 2);
                }
                confidence = ssTot > 0 ? 1 - (ssRes / ssTot) : 0;
                
                // Calculate prediction interval
                var stdError = Math.sqrt(ssRes / Math.max(1, n - 2));
                var zScore = 1.96;
                var margin = zScore * stdError * Math.sqrt(1 + 1/n);
                
                rulLower = ((failureThreshold - margin) - currentValue) / slope * avgInterval;
                rulUpper = ((failureThreshold + margin) - currentValue) / slope * avgInterval;
            }
            
            var status = 'healthy';
            if (timeToFailure < avgInterval * 10) status = 'critical';
            else if (timeToFailure < avgInterval * 50) status = 'warning';
            
            return {
                rul: timeToFailure,
                rulLower: Math.max(0, rulLower),
                rulUpper: rulUpper,
                confidence: Math.max(0, Math.min(1, confidence)),
                status: status,
                percentDegraded: Math.min(100, (currentValue / failureThreshold) * 100),
                degradationRate: slope,
                trend: result.trend,
                model: method,
                weibull: weibullInfo
            };
        }
        
        // Process RUL mode
        function processRUL(msg, value, timestamp) {
            node.buffer.push(value);
            node.timestamps.push(timestamp);
            
            if (node.buffer.length > node.windowSize) {
                node.buffer.shift();
                node.timestamps.shift();
            }
            
            if (node.buffer.length < 5) {
                node.status({fill: "yellow", shape: "ring", text: "RUL: collecting " + node.buffer.length + "/5"});
                return null;
            }
            
            if (node.failureThreshold === null) {
                node.status({fill: "red", shape: "ring", text: "RUL: no threshold set"});
                return null;
            }
            
            var rulResult = calculateRUL(
                node.buffer, 
                node.timestamps, 
                node.failureThreshold, 
                node.degradationModel,
                node.confidenceLevel
            );
            
            if (!rulResult) return null;
            
            // Convert RUL to specified unit
            var rulValue = rulResult.rul;
            var unitLabel = '';
            if (rulResult.rul !== Infinity) {
                switch (node.rulUnit) {
                    case 'minutes':
                        rulValue = rulResult.rul / 60000;
                        unitLabel = 'min';
                        break;
                    case 'hours':
                        rulValue = rulResult.rul / 3600000;
                        unitLabel = 'h';
                        break;
                    case 'days':
                        rulValue = rulResult.rul / 86400000;
                        unitLabel = 'd';
                        break;
                    case 'cycles':
                        rulValue = rulResult.rul; // Already in steps
                        unitLabel = 'cycles';
                        break;
                }
            }
            
            var outputMsg = {
                payload: value,
                rul: {
                    value: rulValue,
                    unit: node.rulUnit,
                    lower: rulResult.rulLower ? rulResult.rulLower / (node.rulUnit === 'hours' ? 3600000 : node.rulUnit === 'minutes' ? 60000 : node.rulUnit === 'days' ? 86400000 : 1) : null,
                    upper: rulResult.rulUpper ? rulResult.rulUpper / (node.rulUnit === 'hours' ? 3600000 : node.rulUnit === 'minutes' ? 60000 : node.rulUnit === 'days' ? 86400000 : 1) : null,
                    confidence: rulResult.confidence,
                    status: rulResult.status
                },
                degradation: {
                    percent: rulResult.percentDegraded,
                    rate: rulResult.degradationRate,
                    trend: rulResult.trend
                },
                thresholds: {
                    failure: node.failureThreshold,
                    warning: node.warningThreshold
                },
                currentValue: value,
                timestamp: timestamp
            };
            
            Object.keys(msg).forEach(function(key) {
                if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                    outputMsg[key] = msg[key];
                }
            });
            
            // Status display
            var statusColor = rulResult.status === 'critical' ? 'red' : 
                             rulResult.status === 'warning' ? 'yellow' : 
                             rulResult.status === 'failed' ? 'red' : 'green';
            var statusText = rulResult.rul === Infinity ? 'RUL: ∞ (stable)' : 
                            rulResult.rul === 0 ? 'FAILED' :
                            'RUL: ' + rulValue.toFixed(1) + unitLabel + ' (' + (rulResult.confidence * 100).toFixed(0) + '%)';
            
            node.status({fill: statusColor, shape: rulResult.status === 'healthy' ? 'dot' : 'ring', text: statusText});
            
            var isAnomaly = rulResult.status === 'critical' || rulResult.status === 'failed' ||
                           (node.warningThreshold !== null && value >= node.warningThreshold);
            
            return { normal: isAnomaly ? null : outputMsg, anomaly: isAnomaly ? outputMsg : null };
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
                } else if (node.mode === "rul") {
                    result = processRUL(msg, value, timestamp);
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
