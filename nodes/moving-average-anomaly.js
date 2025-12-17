module.exports = function(RED) {
    "use strict";
    
    function MovingAverageAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        this.windowSize = parseInt(config.windowSize) || 10;
        this.threshold = parseFloat(config.threshold) || 2.0;
        this.warningThreshold = parseFloat(config.warningThreshold) || (this.threshold * 0.7);
        this.method = config.method || "stddev"; // "stddev" oder "percentage"
        this.dataBuffer = [];
        
        // Initial status
        node.status({fill: "blue", shape: "ring", text: "waiting for data"});
        
        node.on('input', function(msg) {
            try {
                // Reset-Funktion
                if (msg.reset === true) {
                    node.dataBuffer = [];
                    node.status({fill: "blue", shape: "ring", text: "reset - waiting for data"});
                    return;
                }
                
                // Wert aus der Nachricht extrahieren
                var value = parseFloat(msg.payload);
                
                if (isNaN(value)) {
                    node.status({fill: "red", shape: "ring", text: "invalid input"});
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
                    node.status({fill: "yellow", shape: "ring", text: "warmup " + node.dataBuffer.length + "/" + node.windowSize});
                    node.send(msg);
                    return;
                }
                
                // Gleitender Durchschnitt berechnen
                var values = node.dataBuffer.map(d => d.value);
                var movingAverage = values.reduce((a, b) => a + b, 0) / values.length;
                
                var isAnomaly = false;
                var severity = "normal";
                var deviation = 0;
                var deviationPercent = 0;
                var stdDev = 0;
                
                if (node.method === "stddev") {
                    // Standardabweichung berechnen
                    var variance = values.reduce((sum, val) => sum + Math.pow(val - movingAverage, 2), 0) / values.length;
                    stdDev = Math.sqrt(variance);
                    
                    // Abweichung vom Mittelwert
                    deviation = Math.abs(value - movingAverage);
                    deviationPercent = stdDev === 0 ? 0 : (deviation / stdDev) * 100;
                    
                    // Severity bestimmen
                    if (stdDev > 0) {
                        var deviationFactor = deviation / stdDev;
                        if (deviationFactor > node.threshold) {
                            severity = "critical";
                            isAnomaly = true;
                        } else if (deviationFactor > node.warningThreshold) {
                            severity = "warning";
                            isAnomaly = true;
                        }
                    }
                    
                } else if (node.method === "percentage") {
                    // Prozentuale Abweichung
                    deviation = Math.abs(value - movingAverage);
                    deviationPercent = movingAverage === 0 ? 0 : (deviation / Math.abs(movingAverage)) * 100;
                    
                    // Severity bestimmen
                    if (deviationPercent > node.threshold) {
                        severity = "critical";
                        isAnomaly = true;
                    } else if (deviationPercent > node.warningThreshold) {
                        severity = "warning";
                        isAnomaly = true;
                    }
                }
                
                // Status aktualisieren
                if (severity === "critical") {
                    node.status({fill: "red", shape: "dot", text: "CRITICAL dev=" + deviationPercent.toFixed(1) + "%"});
                } else if (severity === "warning") {
                    node.status({fill: "yellow", shape: "dot", text: "warning dev=" + deviationPercent.toFixed(1) + "%"});
                } else {
                    node.status({fill: "green", shape: "dot", text: "MA=" + movingAverage.toFixed(2)});
                }
                
                // Ausgabe-Nachricht erstellen
                var outputMsg = {
                    payload: value,
                    movingAverage: movingAverage,
                    deviation: deviation,
                    deviationPercent: deviationPercent,
                    stdDev: stdDev,
                    isAnomaly: isAnomaly,
                    severity: severity,
                    method: node.method,
                    threshold: node.threshold,
                    warningThreshold: node.warningThreshold,
                    bufferSize: node.dataBuffer.length,
                    windowSize: node.windowSize
                };
                
                // Original-Nachrichteneigenschaften kopieren
                Object.keys(msg).forEach(function(key) {
                    if (!outputMsg.hasOwnProperty(key)) {
                        outputMsg[key] = msg[key];
                    }
                });
                
                // Anomalien an Ausgang 2, normale Werte an Ausgang 1
                if (isAnomaly) {
                    node.send([null, outputMsg]);
                } else {
                    node.send([outputMsg, null]);
                }
                
            } catch (err) {
                node.status({fill: "red", shape: "ring", text: "error"});
                node.error("Fehler bei Moving Average Berechnung: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.dataBuffer = [];
            node.status({});
        });
    }
    
    RED.nodes.registerType("moving-average-anomaly", MovingAverageAnomalyNode);
};
