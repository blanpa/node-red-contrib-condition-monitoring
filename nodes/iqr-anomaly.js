module.exports = function(RED) {
    "use strict";
    
    function IQRAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        this.multiplier = parseFloat(config.multiplier) || 1.5;
        this.warningMultiplier = parseFloat(config.warningMultiplier) || (this.multiplier * 0.8);
        this.windowSize = parseInt(config.windowSize) || 100;
        this.dataBuffer = [];
        
        // Initial status
        node.status({fill: "blue", shape: "ring", text: "waiting for data"});
        
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
            return { q1: q1, q3: q3, iqr: iqr, median: sorted[Math.floor(sorted.length * 0.5)] };
        }
        
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
                    node.status({fill: "yellow", shape: "ring", text: "warmup " + node.dataBuffer.length + "/4"});
                    node.send(msg);
                    return;
                }
                
                // Warmup-Status anzeigen
                if (node.dataBuffer.length < node.windowSize) {
                    node.status({fill: "yellow", shape: "dot", text: "warmup " + node.dataBuffer.length + "/" + node.windowSize});
                }
                
                // Werte extrahieren
                var values = node.dataBuffer.map(d => d.value);
                
                // Quartile berechnen
                var quartiles = calculateQuartiles(values);
                
                // Grenzen für Anomalien berechnen
                var lowerBound = quartiles.q1 - (node.multiplier * quartiles.iqr);
                var upperBound = quartiles.q3 + (node.multiplier * quartiles.iqr);
                
                // Warning-Grenzen
                var lowerWarning = quartiles.q1 - (node.warningMultiplier * quartiles.iqr);
                var upperWarning = quartiles.q3 + (node.warningMultiplier * quartiles.iqr);
                
                // Severity bestimmen
                var severity = "normal";
                var isAnomaly = false;
                
                if (value < lowerBound || value > upperBound) {
                    severity = "critical";
                    isAnomaly = true;
                } else if (value < lowerWarning || value > upperWarning) {
                    severity = "warning";
                    isAnomaly = true;
                }
                
                // Status aktualisieren
                if (node.dataBuffer.length >= 4) {
                    if (severity === "critical") {
                        node.status({fill: "red", shape: "dot", text: "CRITICAL: " + value.toFixed(2)});
                    } else if (severity === "warning") {
                        node.status({fill: "yellow", shape: "dot", text: "warning: " + value.toFixed(2)});
                    } else {
                        node.status({fill: "green", shape: "dot", text: "Q1=" + quartiles.q1.toFixed(1) + " Q3=" + quartiles.q3.toFixed(1)});
                    }
                }
                
                // Ausgabe-Nachricht erstellen
                var outputMsg = {
                    payload: value,
                    q1: quartiles.q1,
                    q3: quartiles.q3,
                    iqr: quartiles.iqr,
                    median: quartiles.median,
                    lowerBound: lowerBound,
                    upperBound: upperBound,
                    isAnomaly: isAnomaly,
                    severity: severity,
                    multiplier: node.multiplier,
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
                node.error("Fehler bei IQR Berechnung: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.dataBuffer = [];
            node.status({});
        });
    }
    
    RED.nodes.registerType("iqr-anomaly", IQRAnomalyNode);
};
