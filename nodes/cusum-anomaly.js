module.exports = function(RED) {
    "use strict";
    
    function CUSUMAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        this.target = config.target !== "" ? parseFloat(config.target) : null;
        this.threshold = parseFloat(config.threshold) || 5.0;
        this.warningThreshold = parseFloat(config.warningThreshold) || (this.threshold * 0.7);
        this.drift = parseFloat(config.drift) || 0.5;
        this.windowSize = parseInt(config.windowSize) || 100;
        this.dataBuffer = [];
        this.cusumPos = 0; // Positive CUSUM
        this.cusumNeg = 0; // Negative CUSUM
        this.mean = null;
        this.initialized = false;
        
        // Initial status
        node.status({fill: "blue", shape: "ring", text: "waiting for data"});
        
        node.on('input', function(msg) {
            try {
                // Reset-Funktion
                if (msg.reset === true) {
                    node.dataBuffer = [];
                    node.cusumPos = 0;
                    node.cusumNeg = 0;
                    node.mean = null;
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
                
                // Add value to buffer
                node.dataBuffer.push({
                    timestamp: Date.now(),
                    value: value
                });
                
                // Limit buffer to maximum size
                if (node.dataBuffer.length > node.windowSize) {
                    node.dataBuffer.shift();
                }
                
                // Zielwert bestimmen (vom Benutzer oder Mittelwert)
                var target = node.target;
                if (target === null) {
                    // Mittelwert aus Buffer berechnen
                    if (node.dataBuffer.length < 2) {
                        node.status({fill: "yellow", shape: "ring", text: "warmup " + node.dataBuffer.length + "/" + node.windowSize});
                        node.send(msg);
                        return;
                    }
                    var values = node.dataBuffer.map(d => d.value);
                    target = values.reduce((a, b) => a + b, 0) / values.length;
                    node.mean = target;
                } else {
                    node.mean = target;
                }
                
                // Warmup-Status anzeigen
                if (node.dataBuffer.length < node.windowSize) {
                    node.status({fill: "yellow", shape: "dot", text: "warmup " + node.dataBuffer.length + "/" + node.windowSize});
                }
                
                // CUSUM berechnen
                var deviation = value - target;
                node.cusumPos = Math.max(0, node.cusumPos + deviation - node.drift);
                node.cusumNeg = Math.max(0, node.cusumNeg - deviation - node.drift);
                
                // Maximaler CUSUM-Wert
                var maxCusum = Math.max(node.cusumPos, node.cusumNeg);
                
                // Severity bestimmen
                var severity = "normal";
                var isAnomaly = false;
                
                if (maxCusum > node.threshold) {
                    severity = "critical";
                    isAnomaly = true;
                } else if (maxCusum > node.warningThreshold) {
                    severity = "warning";
                    isAnomaly = true;
                }
                
                // Status aktualisieren
                if (node.dataBuffer.length >= 2) {
                    if (severity === "critical") {
                        var direction = node.cusumPos > node.cusumNeg ? "↑" : "↓";
                        node.status({fill: "red", shape: "dot", text: "CRITICAL " + direction + " CUSUM=" + maxCusum.toFixed(2)});
                    } else if (severity === "warning") {
                        node.status({fill: "yellow", shape: "dot", text: "warning CUSUM=" + maxCusum.toFixed(2)});
                    } else {
                        node.status({fill: "green", shape: "dot", text: "target=" + target.toFixed(2) + " CUSUM=" + maxCusum.toFixed(2)});
                    }
                }
                
                // Ausgabe-Nachricht erstellen
                var outputMsg = {
                    payload: value,
                    target: target,
                    cusumPos: node.cusumPos,
                    cusumNeg: node.cusumNeg,
                    cusumMax: maxCusum,
                    deviation: deviation,
                    isAnomaly: isAnomaly,
                    severity: severity,
                    threshold: node.threshold,
                    warningThreshold: node.warningThreshold,
                    drift: node.drift,
                    method: "cusum",
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
                    // Reset CUSUM after critical detection (optional)
                    if (severity === "critical") {
                        node.cusumPos = 0;
                        node.cusumNeg = 0;
                    }
                } else {
                    node.send([outputMsg, null]);
                }
                
            } catch (err) {
                node.status({fill: "red", shape: "ring", text: "error"});
                node.error("Fehler bei CUSUM Berechnung: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.dataBuffer = [];
            node.cusumPos = 0;
            node.cusumNeg = 0;
            node.mean = null;
            node.initialized = false;
            node.status({});
        });
    }
    
    RED.nodes.registerType("cusum-anomaly", CUSUMAnomalyNode);
};
