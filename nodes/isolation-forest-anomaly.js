module.exports = function(RED) {
    "use strict";
    
    function IsolationForestAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        // Load Isolation Forest only if available
        var IsolationForest = null;
        try {
            IsolationForest = require('ml-isolation-forest').IsolationForest;
        } catch (err) {
            node.warn("ml-isolation-forest not available. Please install: npm install ml-isolation-forest");
        }
        
        this.contamination = parseFloat(config.contamination) || 0.1;
        this.windowSize = parseInt(config.windowSize) || 100;
        this.dataBuffer = [];
        this.model = null;
        this.isTrained = false;
        
        function trainModel() {
            if (!IsolationForest || node.dataBuffer.length < 10) {
                return;
            }
            
            try {
                // Prepare data for training
                var trainingData = node.dataBuffer.map(function(d, index) {
                    // Features: value, time index, and optional difference to previous value
                    var features = [d.value];
                    if (index > 0) {
                        features.push(d.value - node.dataBuffer[index - 1].value);
                    } else {
                        features.push(0);
                    }
                    features.push(index); // Time index
                    return features;
                });
                
                // Train Isolation Forest
                node.model = new IsolationForest({
                    contamination: node.contamination,
                    numEstimators: 100,
                    maxSamples: Math.min(256, node.dataBuffer.length)
                });
                
                node.model.train(trainingData);
                node.isTrained = true;
                
            } catch (err) {
                node.error("Error training Isolation Forest: " + err.message);
                node.isTrained = false;
            }
        }
        
        node.on('input', function(msg) {
            try {
                // Extract value from message
                var value = parseFloat(msg.payload);
                
                if (isNaN(value)) {
                    node.error("Payload is not a valid number", msg);
                    return;
                }
                
                // Add value to buffer
                node.dataBuffer.push({
                    timestamp: Date.now(),
                    value: value
                });
                
                // Limit buffer to maximum size
                if (node.dataBuffer.length > node.windowSize) {
                    node.dataBuffer.shift();
                    // Retrain model when buffer is full
                    trainModel();
                }
                
                // Train model when enough data is available
                if (!node.isTrained && node.dataBuffer.length >= 10) {
                    trainModel();
                }
                
                // If Isolation Forest is not available or not trained, use simple fallback method
                if (!IsolationForest || !node.isTrained) {
                    // Fallback: Z-Score based detection
                    if (node.dataBuffer.length < 2) {
                        node.send(msg);
                        return;
                    }
                    
                    var values = node.dataBuffer.map(d => d.value);
                    var mean = values.reduce((a, b) => a + b, 0) / values.length;
                    var variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
                    var stdDev = Math.sqrt(variance);
                    var zScore = stdDev === 0 ? 0 : (value - mean) / stdDev;
                    var isAnomaly = Math.abs(zScore) > 3.0;
                    
                    var outputMsg = {
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
                    return;
                }
                
                // Isolation Forest prediction
                var currentIndex = node.dataBuffer.length - 1;
                var prevValue = currentIndex > 0 ? node.dataBuffer[currentIndex - 1].value : value;
                var features = [value, value - prevValue, currentIndex];
                
                var prediction = node.model.predict([features]);
                var isAnomaly = prediction[0] === -1; // -1 = anomaly, 1 = normal
                
                // Calculate score (approximation, as decisionFunction is not available)
                var score = isAnomaly ? -0.5 : 0.5;
                
                // Create output message
                var outputMsg = {
                    payload: value,
                    isAnomaly: isAnomaly,
                    anomalyScore: score,
                    method: "isolation-forest",
                    contamination: node.contamination,
                    timestamp: Date.now()
                };
                
                // Copy original message properties
                Object.keys(msg).forEach(function(key) {
                    if (key !== 'payload' && key !== 'isAnomaly' && key !== 'anomalyScore' && 
                        key !== 'method' && key !== 'contamination' && key !== 'timestamp') {
                        outputMsg[key] = msg[key];
                    }
                });
                
                // Anomalies to output 1, normal values to output 0
                if (isAnomaly) {
                    node.send([null, outputMsg]);
                } else {
                    node.send([outputMsg, null]);
                }
                
            } catch (err) {
                node.error("Error in Isolation Forest calculation: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.dataBuffer = [];
            node.model = null;
            node.isTrained = false;
        });
    }
    
    RED.nodes.registerType("isolation-forest-anomaly", IsolationForestAnomalyNode);
};

