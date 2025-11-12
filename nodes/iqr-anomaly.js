module.exports = function(RED) {
    "use strict";
    
    function IQRAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        this.multiplier = parseFloat(config.multiplier) || 1.5;
        this.windowSize = parseInt(config.windowSize) || 100;
        this.dataBuffer = [];
        
        // Hilfsfunktion zum Sortieren
        function sortNumbers(a, b) {
            return a - b;
        }
        
        // Quartile berechnen
        function calculateQuartiles(values) {
            var sorted = values.slice().sort(sortNumbers);
            var q1Index = Math.floor(sorted.length * 0.25);
            var q3Index = Math.floor(sorted.length * 0.75);
            var q1 = sorted[q1Index];
            var q3 = sorted[q3Index];
            var iqr = q3 - q1;
            return { q1: q1, q3: q3, iqr: iqr };
        }
        
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
                
                // Mindestens 4 Werte für Quartile benötigt
                if (node.dataBuffer.length < 4) {
                    node.send(msg);
                    return;
                }
                
                // Werte extrahieren
                var values = node.dataBuffer.map(d => d.value);
                
                // Quartile berechnen
                var quartiles = calculateQuartiles(values);
                
                // Grenzen für Anomalien berechnen
                var lowerBound = quartiles.q1 - (node.multiplier * quartiles.iqr);
                var upperBound = quartiles.q3 + (node.multiplier * quartiles.iqr);
                
                // Anomalieerkennung
                var isAnomaly = value < lowerBound || value > upperBound;
                
                // Ausgabe-Nachricht erstellen
                var outputMsg = {
                    payload: value,
                    q1: quartiles.q1,
                    q3: quartiles.q3,
                    iqr: quartiles.iqr,
                    lowerBound: lowerBound,
                    upperBound: upperBound,
                    isAnomaly: isAnomaly,
                    multiplier: node.multiplier,
                    timestamp: Date.now()
                };
                
                // Original-Nachrichteneigenschaften kopieren
                Object.keys(msg).forEach(function(key) {
                    if (key !== 'payload' && key !== 'q1' && key !== 'q3' && 
                        key !== 'iqr' && key !== 'lowerBound' && key !== 'upperBound' && 
                        key !== 'isAnomaly' && key !== 'multiplier' && key !== 'timestamp') {
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
                node.error("Fehler bei IQR Berechnung: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.dataBuffer = [];
        });
    }
    
    RED.nodes.registerType("iqr-anomaly", IQRAnomalyNode);
};

