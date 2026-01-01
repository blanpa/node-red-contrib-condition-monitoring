module.exports = function(RED) {
    "use strict";
    
    function MultiValueProcessorNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        // Configuration
        this.mode = config.mode || "split"; // split, analyze, correlate
        this.field = config.field || "payload";
        this.outputMode = config.outputMode || "sequential"; // sequential, parallel
        this.preserveOriginal = config.preserveOriginal !== false;
        
        // Anomaly detection settings
        this.anomalyMethod = config.anomalyMethod || "zscore";
        this.threshold = parseFloat(config.threshold) || 3.0;
        this.windowSize = parseInt(config.windowSize) || 100;
        this.minThreshold = config.minThreshold !== "" && config.minThreshold !== undefined ? parseFloat(config.minThreshold) : null;
        this.maxThreshold = config.maxThreshold !== "" && config.maxThreshold !== undefined ? parseFloat(config.maxThreshold) : null;
        
        // Correlation settings
        this.sensor1 = config.sensor1 || "sensor1";
        this.sensor2 = config.sensor2 || "sensor2";
        this.correlationThreshold = parseFloat(config.correlationThreshold) || 0.7;
        this.correlationMethod = config.correlationMethod || "pearson";
        
        // Advanced settings
        this.outputTopic = config.outputTopic || "";
        this.debug = config.debug === true;
        
        // State
        this.dataBuffers = {};
        
        // Debug logging helper
        var debugLog = function(message) {
            if (node.debug) {
                node.warn("[DEBUG] " + message);
            }
        };
        this.correlationBuffer1 = [];
        this.correlationBuffer2 = [];
        
        // Initial status
        node.status({fill: "blue", shape: "ring", text: node.mode + " mode"});
        
        // Helper functions
        function calculateMean(values) {
            return values.reduce((a, b) => a + b, 0) / values.length;
        }
        
        function calculateStdDev(values, mean) {
            var variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
            return Math.sqrt(variance);
        }
        
        function calculateZScore(value, values) {
            if (values.length < 2) return { zScore: 0, mean: value, stdDev: 0 };
            var mean = calculateMean(values);
            var stdDev = calculateStdDev(values, mean);
            var zScore = stdDev === 0 ? 0 : (value - mean) / stdDev;
            return { zScore: zScore, mean: mean, stdDev: stdDev };
        }
        
        function calculateIQR(values) {
            var sorted = values.slice().sort((a, b) => a - b);
            var q1Index = Math.floor(sorted.length * 0.25);
            var q3Index = Math.floor(sorted.length * 0.75);
            return {
                q1: sorted[q1Index],
                q3: sorted[q3Index],
                iqr: sorted[q3Index] - sorted[q1Index]
            };
        }
        
        function calculatePearsonCorrelation(x, y) {
            var n = x.length;
            if (n !== y.length || n === 0) return null;
            
            var meanX = calculateMean(x);
            var meanY = calculateMean(y);
            
            var covariance = 0;
            var stdX = 0;
            var stdY = 0;
            
            for (var i = 0; i < n; i++) {
                var dx = x[i] - meanX;
                var dy = y[i] - meanY;
                covariance += dx * dy;
                stdX += dx * dx;
                stdY += dy * dy;
            }
            
            stdX = Math.sqrt(stdX);
            stdY = Math.sqrt(stdY);
            
            if (stdX === 0 || stdY === 0) return 0;
            return covariance / (stdX * stdY);
        }
        
        function getRanks(values) {
            var indexed = values.map((value, index) => ({value, index}));
            indexed.sort((a, b) => a.value - b.value);
            
            var ranks = new Array(values.length);
            var i = 0;
            
            while (i < indexed.length) {
                var j = i;
                while (j < indexed.length && indexed[j].value === indexed[i].value) {
                    j++;
                }
                var avgRank = (i + j + 1) / 2;
                for (var k = i; k < j; k++) {
                    ranks[indexed[k].index] = avgRank;
                }
                i = j;
            }
            
            return ranks;
        }
        
        function calculateSpearmanCorrelation(x, y) {
            var ranksX = getRanks(x);
            var ranksY = getRanks(y);
            return calculatePearsonCorrelation(ranksX, ranksY);
        }
        
        // Split mode
        function processSplit(msg) {
            var sourceField = node.field === "payload" ? msg.payload : RED.util.getMessageProperty(msg, node.field);
            
            if (sourceField === undefined || sourceField === null) {
                node.error("Field '" + node.field + "' not found", msg);
                return null;
            }
            
            var values = [];
            var valueNames = [];
            
            if (Array.isArray(sourceField)) {
                values = sourceField;
                valueNames = values.map((v, i) => "value" + i);
            } else if (typeof sourceField === 'object' && sourceField !== null) {
                Object.keys(sourceField).forEach(key => {
                    var val = sourceField[key];
                    if (typeof val === 'number' || (typeof val === 'string' && !isNaN(parseFloat(val)))) {
                        valueNames.push(key);
                        values.push(parseFloat(val));
                    }
                });
            } else {
                var val = parseFloat(sourceField);
                if (!isNaN(val)) {
                    values = [val];
                    valueNames = ["value"];
                }
            }
            
            if (values.length === 0) {
                node.error("No valid numeric values found", msg);
                return null;
            }
            
            if (node.outputMode === "sequential") {
                values.forEach((value, index) => {
                    var newMsg = node.preserveOriginal ? RED.util.cloneMessage(msg) : {};
                    newMsg.payload = value;
                    newMsg.valueIndex = index;
                    newMsg.valueName = valueNames[index];
                    newMsg.totalValues = values.length;
                    node.send([newMsg, null]);
                });
                return null;
            } else {
                var outputMsg = node.preserveOriginal ? RED.util.cloneMessage(msg) : {};
                outputMsg.payload = values;
                outputMsg.valueNames = valueNames;
                outputMsg.valueCount = values.length;
                return { normal: outputMsg, anomaly: null };
            }
        }
        
        // Analyze mode
        function processAnalyze(msg) {
            var values = [];
            var valueNames = [];
            
            if (Array.isArray(msg.payload)) {
                values = msg.payload;
                valueNames = msg.valueNames || values.map((v, i) => "value" + i);
            } else if (typeof msg.payload === 'object' && msg.payload !== null) {
                Object.keys(msg.payload).forEach(key => {
                    var val = msg.payload[key];
                    if (typeof val === 'number' || (typeof val === 'string' && !isNaN(parseFloat(val)))) {
                        valueNames.push(key);
                        values.push(parseFloat(val));
                    }
                });
            } else {
                node.error("Payload must be an array or object", msg);
                return null;
            }
            
            if (values.length === 0) {
                node.error("No valid values found", msg);
                return null;
            }
            
            var results = [];
            var hasAnomaly = false;
            
            values.forEach((value, index) => {
                var valueName = valueNames[index] || ("value" + index);
                
                if (!node.dataBuffers[valueName]) {
                    node.dataBuffers[valueName] = [];
                }
                
                var buffer = node.dataBuffers[valueName];
                buffer.push({ timestamp: Date.now(), value: value });
                
                if (buffer.length > node.windowSize) {
                    buffer.shift();
                }
                
                var isAnomaly = false;
                var analysis = {
                    valueName: valueName,
                    value: value,
                    isAnomaly: false
                };
                
                if (buffer.length >= 2) {
                    var bufferValues = buffer.map(d => d.value);
                    
                    if (node.anomalyMethod === "zscore") {
                        var stats = calculateZScore(value, bufferValues);
                        analysis.zScore = stats.zScore;
                        analysis.mean = stats.mean;
                        analysis.stdDev = stats.stdDev;
                        isAnomaly = Math.abs(stats.zScore) > node.threshold;
                    } else if (node.anomalyMethod === "iqr") {
                        if (buffer.length >= 4) {
                            var iqr = calculateIQR(bufferValues);
                            var lowerBound = iqr.q1 - (1.5 * iqr.iqr);
                            var upperBound = iqr.q3 + (1.5 * iqr.iqr);
                            analysis.q1 = iqr.q1;
                            analysis.q3 = iqr.q3;
                            analysis.iqr = iqr.iqr;
                            isAnomaly = value < lowerBound || value > upperBound;
                        }
                    } else if (node.anomalyMethod === "threshold") {
                        if (node.minThreshold !== null && value < node.minThreshold) {
                            isAnomaly = true;
                            analysis.reason = "Below minimum";
                        }
                        if (node.maxThreshold !== null && value > node.maxThreshold) {
                            isAnomaly = true;
                            analysis.reason = analysis.reason ? analysis.reason + " and above maximum" : "Above maximum";
                        }
                    }
                }
                
                analysis.isAnomaly = isAnomaly;
                if (isAnomaly) hasAnomaly = true;
                results.push(analysis);
            });
            
            var outputMsg = RED.util.cloneMessage(msg);
            outputMsg.payload = results;
            outputMsg.hasAnomaly = hasAnomaly;
            outputMsg.anomalyCount = results.filter(r => r.isAnomaly).length;
            outputMsg.method = "multi-" + node.anomalyMethod;
            
            return { normal: hasAnomaly ? null : outputMsg, anomaly: hasAnomaly ? outputMsg : null };
        }
        
        // Correlate mode
        function processCorrelate(msg) {
            if (typeof msg.payload !== 'object' || msg.payload === null) {
                node.warn("Payload must be an object with sensor values");
                return null;
            }
            
            var value1 = parseFloat(msg.payload[node.sensor1]);
            var value2 = parseFloat(msg.payload[node.sensor2]);
            
            if (isNaN(value1) || isNaN(value2)) {
                node.warn("Missing or invalid sensor values: " + node.sensor1 + ", " + node.sensor2);
                return null;
            }
            
            node.correlationBuffer1.push(value1);
            node.correlationBuffer2.push(value2);
            
            if (node.correlationBuffer1.length > node.windowSize) {
                node.correlationBuffer1.shift();
                node.correlationBuffer2.shift();
            }
            
            if (node.correlationBuffer1.length < 3) {
                node.status({fill: "yellow", shape: "ring", text: "Buffering: " + node.correlationBuffer1.length + "/" + node.windowSize});
                return null;
            }
            
            var correlation = null;
            if (node.correlationMethod === "pearson") {
                correlation = calculatePearsonCorrelation(node.correlationBuffer1, node.correlationBuffer2);
            } else {
                correlation = calculateSpearmanCorrelation(node.correlationBuffer1, node.correlationBuffer2);
            }
            
            var isAnomalous = Math.abs(correlation) < node.correlationThreshold;
            
            var outputMsg = {
                payload: msg.payload,
                correlation: correlation,
                isAnomalous: isAnomalous,
                sensor1: node.sensor1,
                sensor2: node.sensor2,
                method: node.correlationMethod,
                stats: {
                    sensor1Mean: calculateMean(node.correlationBuffer1),
                    sensor2Mean: calculateMean(node.correlationBuffer2),
                    bufferSize: node.correlationBuffer1.length
                }
            };
            
            Object.keys(msg).forEach(key => {
                if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                    outputMsg[key] = msg[key];
                }
            });
            
            var statusColor = isAnomalous ? "red" : "green";
            node.status({fill: statusColor, shape: "dot", text: "ρ=" + correlation.toFixed(3)});
            
            return { normal: isAnomalous ? null : outputMsg, anomaly: isAnomalous ? outputMsg : null };
        }
        
        node.on('input', function(msg) {
            try {
                if (msg.reset === true) {
                    node.dataBuffers = {};
                    node.correlationBuffer1 = [];
                    node.correlationBuffer2 = [];
                    node.status({fill: "blue", shape: "ring", text: node.mode + " - reset"});
                    return;
                }
                
                var result = null;
                
                switch (node.mode) {
                    case "split":
                        result = processSplit(msg);
                        break;
                    case "analyze":
                        result = processAnalyze(msg);
                        break;
                    case "correlate":
                        result = processCorrelate(msg);
                        break;
                    default:
                        result = processSplit(msg);
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
                node.error("Error in multi-value processing: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.dataBuffers = {};
            node.correlationBuffer1 = [];
            node.correlationBuffer2 = [];
            node.status({});
        });
    }
    
    RED.nodes.registerType("multi-value-processor", MultiValueProcessorNode);
};
