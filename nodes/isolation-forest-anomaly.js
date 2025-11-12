module.exports = function(RED) {
    "use strict";
    
    function IsolationForestAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        // Isolation Forest wird nur geladen wenn verfügbar
        var IsolationForest = null;
        try {
            IsolationForest = require('ml-isolation-forest').IsolationForest;
        } catch (err) {
            node.warn("ml-isolation-forest nicht verfügbar. Bitte installieren: npm install ml-isolation-forest");
        }
        
        this.contamination = parseFloat(config.contamination) || 0.1;
        this.windowSize = parseInt(config.windowSize) || 100;
        this.dataBuffer = [];
        this.model = null;
        this.isTrained = false;
        
        function trainModel() {
            if (!IsolationForest || node.dataBuffer.length < 10) {
                return;
            }
            
            try {
                // Daten für Training vorbereiten
                var trainingData = node.dataBuffer.map(function(d, index) {
                    // Features: Wert, Index (Zeit), und optional Differenz zum vorherigen Wert
                    var features = [d.value];
                    if (index > 0) {
                        features.push(d.value - node.dataBuffer[index - 1].value);
                    } else {
                        features.push(0);
                    }
                    features.push(index); // Zeitindex
                    return features;
                });
                
                // Isolation Forest trainieren
                node.model = new IsolationForest({
                    contamination: node.contamination,
                    numEstimators: 100,
                    maxSamples: Math.min(256, node.dataBuffer.length)
                });
                
                node.model.train(trainingData);
                node.isTrained = true;
                
            } catch (err) {
                node.error("Fehler beim Training des Isolation Forest: " + err.message);
                node.isTrained = false;
            }
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
                    // Model neu trainieren wenn Buffer voll ist
                    trainModel();
                }
                
                // Model trainieren wenn genug Daten vorhanden
                if (!node.isTrained && node.dataBuffer.length >= 10) {
                    trainModel();
                }
                
                // Wenn Isolation Forest nicht verfügbar oder nicht trainiert, einfache Fallback-Methode
                if (!IsolationForest || !node.isTrained) {
                    // Fallback: Z-Score basierte Erkennung
                    if (node.dataBuffer.length < 2) {
                        node.send(msg);
                        return;
                    }
                    
                    var values = node.dataBuffer.map(d => d.value);
                    var mean = values.reduce((a, b) => a + b, 0) / values.length;
                    var variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
                    var stdDev = Math.sqrt(variance);
                    var zScore = stdDev === 0 ? 0 : (value - mean) / stdDev;
                    var isAnomaly = Math.abs(zScore) > 3.0;
                    
                    var outputMsg = {
                        payload: value,
                        isAnomaly: isAnomaly,
                        method: "fallback-zscore",
                        zScore: zScore,
                        timestamp: Date.now()
                    };
                    
                    if (isAnomaly) {
                        node.send([null, outputMsg]);
                    } else {
                        node.send([outputMsg, null]);
                    }
                    return;
                }
                
                // Isolation Forest Vorhersage
                var currentIndex = node.dataBuffer.length - 1;
                var prevValue = currentIndex > 0 ? node.dataBuffer[currentIndex - 1].value : value;
                var features = [value, value - prevValue, currentIndex];
                
                var prediction = node.model.predict([features]);
                var isAnomaly = prediction[0] === -1; // -1 = Anomalie, 1 = Normal
                var score = node.model.decisionFunction([features])[0];
                
                // Ausgabe-Nachricht erstellen
                var outputMsg = {
                    payload: value,
                    isAnomaly: isAnomaly,
                    anomalyScore: score,
                    method: "isolation-forest",
                    contamination: node.contamination,
                    timestamp: Date.now()
                };
                
                // Original-Nachrichteneigenschaften kopieren
                Object.keys(msg).forEach(function(key) {
                    if (key !== 'payload' && key !== 'isAnomaly' && key !== 'anomalyScore' && 
                        key !== 'method' && key !== 'contamination' && key !== 'timestamp') {
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
                node.error("Fehler bei Isolation Forest Berechnung: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.dataBuffer = [];
            node.model = null;
            node.isTrained = false;
        });
    }
    
    RED.nodes.registerType("isolation-forest-anomaly", IsolationForestAnomalyNode);
};

