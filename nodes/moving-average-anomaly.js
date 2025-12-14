module.exports = function(RED) {
    "use strict";
    
    function MovingAverageAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        this.windowSize = parseInt(config.windowSize) || 10;
        this.threshold = parseFloat(config.threshold) || 2.0;
        this.method = config.method || "stddev"; // "stddev" oder "percentage"
        this.dataBuffer = [];
        
        node.on('input', function(msg) {
            try {
                // Wert aus der Nachricht extrahieren
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
                }
                
                // At least windowSize values required
                if (node.dataBuffer.length < node.windowSize) {
                    node.send(msg);
                    return;
                }
                
                // Gleitender Durchschnitt berechnen
                var values = node.dataBuffer.map(d => d.value);
                var movingAverage = values.reduce((a, b) => a + b, 0) / values.length;
                
                var isAnomaly = false;
                var deviation = 0;
                var deviationPercent = 0;
                
                if (node.method === "stddev") {
                    // Standardabweichung berechnen
                    var variance = values.reduce((sum, val) => sum + Math.pow(val - movingAverage, 2), 0) / values.length;
                    var stdDev = Math.sqrt(variance);
                    
                    // Abweichung vom Mittelwert
                    deviation = Math.abs(value - movingAverage);
                    deviationPercent = stdDev === 0 ? 0 : (deviation / stdDev) * 100;
                    
                    // Anomaly if deviation is greater than threshold * standard deviation
                    isAnomaly = deviation > (node.threshold * stdDev);
                    
                } else if (node.method === "percentage") {
                    // Prozentuale Abweichung
                    deviation = Math.abs(value - movingAverage);
                    deviationPercent = movingAverage === 0 ? 0 : (deviation / Math.abs(movingAverage)) * 100;
                    
                    // Anomaly if percentage deviation is greater than threshold
                    isAnomaly = deviationPercent > node.threshold;
                }
                
                // Ausgabe-Nachricht erstellen
                var outputMsg = {
                    payload: value,
                    movingAverage: movingAverage,
                    deviation: deviation,
                    deviationPercent: deviationPercent,
                    isAnomaly: isAnomaly,
                    method: node.method,
                    threshold: node.threshold,
                    timestamp: Date.now()
                };
                
                // Original-Nachrichteneigenschaften kopieren
                Object.keys(msg).forEach(function(key) {
                    if (key !== 'payload' && key !== 'movingAverage' && key !== 'deviation' && 
                        key !== 'deviationPercent' && key !== 'isAnomaly' && key !== 'method' && 
                        key !== 'threshold' && key !== 'timestamp') {
                        outputMsg[key] = msg[key];
                    }
                });
                
                // Anomalien an Ausgang 1, normale Werte an Ausgang 0
                if (isAnomaly) {
                    node.send([null, outputMsg]);
                } else {
                    node.send([outputMsg, null]);
                }
                
            } catch (err) {
                node.error("Fehler bei Moving Average Berechnung: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.dataBuffer = [];
        });
    }
    
    RED.nodes.registerType("moving-average-anomaly", MovingAverageAnomalyNode);
};

