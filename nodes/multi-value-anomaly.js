module.exports = function(RED) {
    "use strict";
    
    function MultiValueAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        this.method = config.method || "zscore"; // "zscore", "iqr", "threshold"
        this.threshold = parseFloat(config.threshold) || 3.0;
        this.windowSize = parseInt(config.windowSize) || 100;
        this.minThreshold = config.minThreshold !== "" ? parseFloat(config.minThreshold) : null;
        this.maxThreshold = config.maxThreshold !== "" ? parseFloat(config.maxThreshold) : null;
        this.dataBuffers = {}; // Ein Buffer pro Wert-Name
        
        // Z-Score Berechnung
        function calculateZScore(value, values) {
            if (values.length < 2) return { zScore: 0, mean: value, stdDev: 0 };
            var mean = values.reduce((a, b) => a + b, 0) / values.length;
            var variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
            var stdDev = Math.sqrt(variance);
            var zScore = stdDev === 0 ? 0 : (value - mean) / stdDev;
            return { zScore: zScore, mean: mean, stdDev: stdDev };
        }
        
        // IQR Berechnung
        function calculateIQR(values) {
            var sorted = values.slice().sort(function(a, b) { return a - b; });
            var q1Index = Math.floor(sorted.length * 0.25);
            var q3Index = Math.floor(sorted.length * 0.75);
            var q1 = sorted[q1Index];
            var q3 = sorted[q3Index];
            var iqr = q3 - q1;
            return { q1: q1, q3: q3, iqr: iqr };
        }
        
        node.on('input', function(msg) {
            try {
                var values = [];
                var valueNames = [];
                
                // Payload extrahieren
                if (Array.isArray(msg.payload)) {
                    values = msg.payload;
                    valueNames = msg.valueNames || values.map(function(v, i) { return "value" + i; });
                } else if (typeof msg.payload === 'object' && msg.payload !== null) {
                    var keys = Object.keys(msg.payload);
                    values = keys.map(function(key) {
                        var val = msg.payload[key];
                        if (typeof val === 'number' || (typeof val === 'string' && !isNaN(parseFloat(val)))) {
                            valueNames.push(key);
                            return parseFloat(val);
                        }
                        return null;
                    }).filter(function(v) { return v !== null; });
                } else {
                    node.error("Payload muss ein Array oder Objekt sein", msg);
                    return;
                }
                
                if (values.length === 0) {
                    node.error("No valid values found", msg);
                    return;
                }
                
                var results = [];
                var hasAnomaly = false;
                
                // Jeden Wert analysieren
                values.forEach(function(value, index) {
                    var valueName = valueNames[index] || ("value" + index);
                    
                    // Initialize buffer for this value
                    if (!node.dataBuffers[valueName]) {
                        node.dataBuffers[valueName] = [];
                    }
                    
                    var buffer = node.dataBuffers[valueName];
                    
                    // Add value to buffer
                    buffer.push({
                        timestamp: Date.now(),
                        value: value
                    });
                    
                    // Buffer begrenzen
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
                        
                        if (node.method === "zscore") {
                            var stats = calculateZScore(value, bufferValues);
                            analysis.zScore = stats.zScore;
                            analysis.mean = stats.mean;
                            analysis.stdDev = stats.stdDev;
                            isAnomaly = Math.abs(stats.zScore) > node.threshold;
                        } else if (node.method === "iqr") {
                            if (buffer.length >= 4) {
                                var iqr = calculateIQR(bufferValues);
                                var multiplier = 1.5;
                                var lowerBound = iqr.q1 - (multiplier * iqr.iqr);
                                var upperBound = iqr.q3 + (multiplier * iqr.iqr);
                                analysis.q1 = iqr.q1;
                                analysis.q3 = iqr.q3;
                                analysis.iqr = iqr.iqr;
                                analysis.lowerBound = lowerBound;
                                analysis.upperBound = upperBound;
                                isAnomaly = value < lowerBound || value > upperBound;
                            }
                        } else if (node.method === "threshold") {
                            var minThreshold = parseFloat(node.minThreshold);
                            var maxThreshold = parseFloat(node.maxThreshold);
                            if (!isNaN(minThreshold) && value < minThreshold) {
                                isAnomaly = true;
                                analysis.reason = "Unter Minimum";
                            }
                            if (!isNaN(maxThreshold) && value > maxThreshold) {
                                isAnomaly = true;
                                analysis.reason = analysis.reason ? analysis.reason + " or above maximum" : "Above maximum";
                            }
                        }
                    }
                    
                    analysis.isAnomaly = isAnomaly;
                    if (isAnomaly) hasAnomaly = true;
                    
                    results.push(analysis);
                });
                
                // Ausgabe-Nachricht erstellen
                var outputMsg = RED.util.cloneMessage(msg);
                outputMsg.payload = results;
                outputMsg.hasAnomaly = hasAnomaly;
                outputMsg.anomalyCount = results.filter(r => r.isAnomaly).length;
                outputMsg.method = "multi-" + node.method;
                
                // Anomalien an Ausgang 1, normale Werte an Ausgang 0
                if (hasAnomaly) {
                    node.send([null, outputMsg]);
                } else {
                    node.send([outputMsg, null]);
                }
                
            } catch (err) {
                node.error("Fehler bei Multi-Value Analyse: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.dataBuffers = {};
        });
    }
    
    RED.nodes.registerType("multi-value-anomaly", MultiValueAnomalyNode);
};

