module.exports = function(RED) {
    "use strict";
    
    function EMAAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        this.alpha = parseFloat(config.alpha) || 0.3;
        this.threshold = parseFloat(config.threshold) || 2.0;
        this.warningThreshold = parseFloat(config.warningThreshold) || (this.threshold * 0.7);
        this.method = config.method || "stddev"; // "stddev" oder "percentage"
        this.windowSize = parseInt(config.windowSize) || 100;
        this.dataBuffer = [];
        this.ema = null;
        this.initialized = false;
        
        // Initial status
        node.status({fill: "blue", shape: "ring", text: "waiting for data"});
        
        node.on('input', function(msg) {
            try {
                // Reset-Funktion
                if (msg.reset === true) {
                    node.dataBuffer = [];
                    node.ema = null;
                    node.initialized = false;
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
                
                // EMA initialisieren mit erstem Wert
                if (!node.initialized) {
                    node.ema = value;
                    node.initialized = true;
                    node.dataBuffer.push({
                        timestamp: Date.now(),
                        value: value
                    });
                    node.status({fill: "yellow", shape: "ring", text: "warmup 1/" + node.windowSize});
                    node.send(msg);
                    return;
                }
                
                // EMA berechnen: EMA = alpha * value + (1 - alpha) * previous_EMA
                node.ema = node.alpha * value + (1 - node.alpha) * node.ema;
                
                // Add value to buffer
                node.dataBuffer.push({
                    timestamp: Date.now(),
                    value: value
                });
                
                // Limit buffer to maximum size (for standard deviation)
                if (node.dataBuffer.length > node.windowSize) {
                    node.dataBuffer.shift();
                }
                
                // Warmup-Status anzeigen
                if (node.dataBuffer.length < node.windowSize) {
                    node.status({fill: "yellow", shape: "dot", text: "warmup " + node.dataBuffer.length + "/" + node.windowSize});
                }
                
                var isAnomaly = false;
                var severity = "normal";
                var deviation = 0;
                var deviationPercent = 0;
                var stdDev = 0;
                
                if (node.method === "stddev") {
                    // Standardabweichung der letzten Werte berechnen
                    if (node.dataBuffer.length < 2) {
                        node.send(msg);
                        return;
                    }
                    
                    var values = node.dataBuffer.map(d => d.value);
                    var mean = values.reduce((a, b) => a + b, 0) / values.length;
                    var variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
                    stdDev = Math.sqrt(variance);
                    
                    // Abweichung vom EMA
                    deviation = Math.abs(value - node.ema);
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
                    // Prozentuale Abweichung vom EMA
                    deviation = Math.abs(value - node.ema);
                    deviationPercent = node.ema === 0 ? 0 : (deviation / Math.abs(node.ema)) * 100;
                    
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
                if (node.dataBuffer.length >= node.windowSize) {
                    if (severity === "critical") {
                        node.status({fill: "red", shape: "dot", text: "CRITICAL dev=" + deviationPercent.toFixed(1) + "%"});
                    } else if (severity === "warning") {
                        node.status({fill: "yellow", shape: "dot", text: "warning dev=" + deviationPercent.toFixed(1) + "%"});
                    } else {
                        node.status({fill: "green", shape: "dot", text: "EMA=" + node.ema.toFixed(2)});
                    }
                }
                
                // Ausgabe-Nachricht erstellen
                var outputMsg = {
                    payload: value,
                    ema: node.ema,
                    deviation: deviation,
                    deviationPercent: deviationPercent,
                    isAnomaly: isAnomaly,
                    severity: severity,
                    method: "ema-" + node.method,
                    alpha: node.alpha,
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
                node.error("Fehler bei EMA Berechnung: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.dataBuffer = [];
            node.ema = null;
            node.initialized = false;
            node.status({});
        });
    }
    
    RED.nodes.registerType("ema-anomaly", EMAAnomalyNode);
};
