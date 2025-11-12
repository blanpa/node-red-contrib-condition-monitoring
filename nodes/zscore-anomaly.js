module.exports = function(RED) {
    "use strict";
    
    function ZScoreAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        this.threshold = parseFloat(config.threshold) || 3.0;
        this.windowSize = parseInt(config.windowSize) || 100;
        this.dataBuffer = [];
        
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
                
                // Mindestens 2 Werte für Berechnung benötigt
                if (node.dataBuffer.length < 2) {
                    node.send(msg);
                    return;
                }
                
                // Mittelwert und Standardabweichung berechnen
                var values = node.dataBuffer.map(d => d.value);
                var mean = values.reduce((a, b) => a + b, 0) / values.length;
                var variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
                var stdDev = Math.sqrt(variance);
                
                // Z-Score berechnen
                var zScore = stdDev === 0 ? 0 : (value - mean) / stdDev;
                
                // Anomalieerkennung
                var isAnomaly = Math.abs(zScore) > node.threshold;
                
                // Ausgabe-Nachricht erstellen
                var outputMsg = {
                    payload: value,
                    zScore: zScore,
                    mean: mean,
                    stdDev: stdDev,
                    isAnomaly: isAnomaly,
                    threshold: node.threshold,
                    timestamp: Date.now()
                };
                
                // Original-Nachrichteneigenschaften kopieren
                Object.keys(msg).forEach(function(key) {
                    if (key !== 'payload' && key !== 'zScore' && key !== 'mean' && 
                        key !== 'stdDev' && key !== 'isAnomaly' && key !== 'threshold' && key !== 'timestamp') {
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
                node.error("Fehler bei Z-Score Berechnung: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.dataBuffer = [];
        });
    }
    
    RED.nodes.registerType("zscore-anomaly", ZScoreAnomalyNode);
};

