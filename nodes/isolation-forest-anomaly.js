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
        this.numEstimators = parseInt(config.numEstimators) || 100;
        this.maxSamples = parseInt(config.maxSamples) || 256;
        this.outputTopic = config.outputTopic || "";
        this.debug = config.debug === true;
        
        // Online/Incremental Learning settings
        this.learningMode = config.learningMode || "batch"; // batch, incremental, adaptive
        this.retrainInterval = parseInt(config.retrainInterval) || 50; // Retrain every N samples
        this.adaptRate = parseFloat(config.adaptRate) || 0.1; // Adaptation rate for adaptive mode
        this.persistModel = config.persistModel === true;
        
        this.dataBuffer = [];
        this.scoreBuffer = []; // Store prediction scores for threshold calculation
        this.model = null;
        this.isTrained = false;
        this.anomalyThreshold = 0.5; // Default threshold, will be updated dynamically
        this.sampleCount = 0; // Total samples processed
        this.lastRetrainCount = 0; // Samples at last retrain
        
        // Debug logging helper
        var debugLog = function(message) {
            if (node.debug) {
                node.warn("[DEBUG] " + message);
            }
        };
        
        function trainModel(isIncremental) {
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
                var actualMaxSamples = Math.min(node.maxSamples, node.dataBuffer.length);
                var modeLabel = isIncremental ? "incremental" : "full";
                debugLog("Training Isolation Forest (" + modeLabel + "): trees=" + node.numEstimators + ", samples=" + actualMaxSamples);
                
                node.model = new IsolationForest({
                    contamination: node.contamination,
                    numEstimators: node.numEstimators,
                    maxSamples: actualMaxSamples
                });
                
                node.model.train(trainingData);
                node.isTrained = true;
                node.lastRetrainCount = node.sampleCount;
                
                // Calculate threshold based on training data scores
                var trainingScores = trainingData.map(function(features) {
                    return node.model.predict([features])[0];
                });
                trainingScores.sort(function(a, b) { return b - a; }); // Sort descending
                var thresholdIndex = Math.floor(trainingScores.length * node.contamination);
                node.anomalyThreshold = thresholdIndex > 0 ? trainingScores[thresholdIndex] : trainingScores[0] || 0.5;
                
                // Update status
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: "Trained (" + modeLabel + ") | n=" + node.dataBuffer.length
                });
                
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
            
            var samplesSinceRetrain = node.sampleCount - node.lastRetrainCount;
            return samplesSinceRetrain >= node.retrainInterval;
        }
        
        // Adaptive threshold update
        function updateAdaptiveThreshold(newScore, wasAnomaly) {
            if (node.learningMode !== "adaptive") return;
            
            // If detected as normal but marked anomaly, increase threshold slightly
            // If detected as anomaly but was normal, decrease threshold
            if (wasAnomaly && newScore < node.anomalyThreshold) {
                // False negative - decrease threshold
                node.anomalyThreshold = node.anomalyThreshold * (1 - node.adaptRate * 0.5);
            }
            // Can add feedback mechanism here for user corrections
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
                var score = prediction[0]; // Score: higher values indicate anomalies
                
                // Add score to buffer for dynamic threshold updates
                node.scoreBuffer.push(score);
                if (node.scoreBuffer.length > node.windowSize) {
                    node.scoreBuffer.shift();
                }
                
                // Update threshold dynamically based on recent scores
                if (node.scoreBuffer.length >= 10) {
                    var sortedScores = node.scoreBuffer.slice().sort(function(a, b) { return b - a; });
                    var thresholdIndex = Math.floor(sortedScores.length * node.contamination);
                    node.anomalyThreshold = thresholdIndex > 0 ? sortedScores[thresholdIndex] : sortedScores[0] || 0.5;
                }
                
                // Higher scores indicate anomalies (points that are easier to isolate)
                var isAnomaly = score >= node.anomalyThreshold;
                
                debugLog("Score: " + score.toFixed(4) + ", Threshold: " + node.anomalyThreshold.toFixed(4) + ", Anomaly: " + isAnomaly);
                
                // Create output message
                var outputMsg = {
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
                Object.keys(msg).forEach(function(key) {
                    if (key !== 'payload' && key !== 'isAnomaly' && key !== 'anomalyScore' && 
                        key !== 'method' && key !== 'contamination' && key !== 'timestamp' && key !== 'topic') {
                        outputMsg[key] = msg[key];
                    }
                    // Preserve original topic if no output topic configured
                    if (key === 'topic' && !node.outputTopic) {
                        outputMsg.topic = msg.topic;
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
            node.scoreBuffer = [];
            node.model = null;
            node.isTrained = false;
        });
    }
    
    RED.nodes.registerType("isolation-forest-anomaly", IsolationForestAnomalyNode);
    
    // API endpoint to check ml-isolation-forest availability
    RED.httpAdmin.get('/isolation-forest-anomaly/status', function(req, res) {
        var available = false;
        try {
            require('ml-isolation-forest');
            available = true;
        } catch (err) {
            available = false;
        }
        res.json({ available: available });
    });
};

