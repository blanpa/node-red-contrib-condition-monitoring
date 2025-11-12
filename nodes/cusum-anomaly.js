module.exports = function(RED) {
    "use strict";
    
    function CUSUMAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        this.target = config.target !== "" ? parseFloat(config.target) : null;
        this.threshold = parseFloat(config.threshold) || 5.0;
        this.drift = parseFloat(config.drift) || 0.5;
        this.windowSize = parseInt(config.windowSize) || 100;
        this.dataBuffer = [];
        this.cusumPos = 0; // Positive CUSUM
        this.cusumNeg = 0; // Negative CUSUM
        this.mean = null;
        this.initialized = false;
        
        node.on('input', function(msg) {
            try {
                // Wert aus der Nachricht extrahieren
                var value = parseFloat(msg.payload);
                
                if (isNaN(value)) {
                    node.error("Payload ist keine gültige Zahl", msg);
                    return;
                }
                
                // Wert zum Buffer hinzufügen
                node.dataBuffer.push({
                    timestamp: Date.now(),
                    value: value
                });
                
                // Buffer auf maximale Größe begrenzen
                if (node.dataBuffer.length > node.windowSize) {
                    node.dataBuffer.shift();
                }
                
                // Zielwert bestimmen (vom Benutzer oder Mittelwert)
                var target = node.target;
                if (target === null) {
                    // Mittelwert aus Buffer berechnen
                    if (node.dataBuffer.length < 2) {
                        node.send(msg);
                        return;
                    }
                    var values = node.dataBuffer.map(d => d.value);
                    target = values.reduce((a, b) => a + b, 0) / values.length;
                    node.mean = target;
                } else {
                    node.mean = target;
                }
                
                // CUSUM berechnen
                var deviation = value - target;
                node.cusumPos = Math.max(0, node.cusumPos + deviation - node.drift);
                node.cusumNeg = Math.max(0, node.cusumNeg - deviation - node.drift);
                
                // Anomalieerkennung
                var isAnomaly = node.cusumPos > node.threshold || node.cusumNeg > node.threshold;
                
                // Ausgabe-Nachricht erstellen
                var outputMsg = {
                    payload: value,
                    target: target,
                    cusumPos: node.cusumPos,
                    cusumNeg: node.cusumNeg,
                    deviation: deviation,
                    isAnomaly: isAnomaly,
                    threshold: node.threshold,
                    drift: node.drift,
                    method: "cusum",
                    timestamp: Date.now()
                };
                
                // Original-Nachrichteneigenschaften kopieren
                Object.keys(msg).forEach(function(key) {
                    if (key !== 'payload' && key !== 'target' && key !== 'cusumPos' && 
                        key !== 'cusumNeg' && key !== 'deviation' && key !== 'isAnomaly' && 
                        key !== 'threshold' && key !== 'drift' && key !== 'method' && key !== 'timestamp') {
                        outputMsg[key] = msg[key];
                    }
                });
                
                // Anomalien an Ausgang 1, normale Werte an Ausgang 0
                if (isAnomaly) {
                    node.send([null, outputMsg]);
                    // CUSUM zurücksetzen nach Erkennung
                    node.cusumPos = 0;
                    node.cusumNeg = 0;
                } else {
                    node.send([outputMsg, null]);
                }
                
            } catch (err) {
                node.error("Fehler bei CUSUM Berechnung: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.dataBuffer = [];
            node.cusumPos = 0;
            node.cusumNeg = 0;
            node.mean = null;
            node.initialized = false;
        });
    }
    
    RED.nodes.registerType("cusum-anomaly", CUSUMAnomalyNode);
};

