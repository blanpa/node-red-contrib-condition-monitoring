module.exports = function(RED) {
    "use strict";
    
    function ZScoreAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        this.threshold = parseFloat(config.threshold) || 3.0;
        this.warningThreshold = parseFloat(config.warningThreshold) || (this.threshold * 0.7);
        this.windowSize = parseInt(config.windowSize) || 100;
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
                    node.status({fill: "yellow", shape: "ring", text: "warmup " + node.dataBuffer.length + "/" + node.windowSize});
                    node.send(msg);
                    return;
                }
                
                // Warmup-Status anzeigen
                if (node.dataBuffer.length < node.windowSize) {
                    node.status({fill: "yellow", shape: "dot", text: "warmup " + node.dataBuffer.length + "/" + node.windowSize});
                }
                
                // Mittelwert und Standardabweichung berechnen
                var values = node.dataBuffer.map(d => d.value);
                var mean = values.reduce((a, b) => a + b, 0) / values.length;
                var variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
                var stdDev = Math.sqrt(variance);
                
                // Z-Score berechnen
                var zScore = stdDev === 0 ? 0 : (value - mean) / stdDev;
                var absZScore = Math.abs(zScore);
                
                // Severity bestimmen
                var severity = "normal";
                var isAnomaly = false;
                
                if (absZScore > node.threshold) {
                    severity = "critical";
                    isAnomaly = true;
                } else if (absZScore > node.warningThreshold) {
                    severity = "warning";
                    isAnomaly = true;
                }
                
                // Status aktualisieren
                if (node.dataBuffer.length >= node.windowSize) {
                    if (severity === "critical") {
                        node.status({fill: "red", shape: "dot", text: "CRITICAL z=" + zScore.toFixed(2)});
                    } else if (severity === "warning") {
                        node.status({fill: "yellow", shape: "dot", text: "warning z=" + zScore.toFixed(2)});
                    } else {
                        node.status({fill: "green", shape: "dot", text: "μ=" + mean.toFixed(1) + " σ=" + stdDev.toFixed(2)});
                    }
                }
                
                // Ausgabe-Nachricht erstellen
                var outputMsg = {
                    payload: value,
                    zScore: zScore,
                    mean: mean,
                    stdDev: stdDev,
                    isAnomaly: isAnomaly,
                    severity: severity,
                    threshold: node.threshold,
                    warningThreshold: node.warningThreshold,
                    bufferSize: node.dataBuffer.length,
                    windowSize: node.windowSize
                };
                
                // Original-Nachrichteneigenschaften kopieren (außer unsere Felder)
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
                node.error("Fehler bei Z-Score Berechnung: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.dataBuffer = [];
            node.status({});
        });
    }
    
    RED.nodes.registerType("zscore-anomaly", ZScoreAnomalyNode);
};
