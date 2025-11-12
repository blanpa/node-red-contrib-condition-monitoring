module.exports = function(RED) {
    "use strict";
    
    function ThresholdAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        this.minThreshold = config.minThreshold !== "" ? parseFloat(config.minThreshold) : null;
        this.maxThreshold = config.maxThreshold !== "" ? parseFloat(config.maxThreshold) : null;
        this.inclusive = config.inclusive !== undefined ? config.inclusive : false;
        
        node.on('input', function(msg) {
            try {
                // Wert aus der Nachricht extrahieren
                var value = parseFloat(msg.payload);
                
                if (isNaN(value)) {
                    node.error("Payload ist keine gültige Zahl", msg);
                    return;
                }
                
                var isAnomaly = false;
                var reason = null;
                
                // Prüfung auf Minimum-Schwellenwert
                if (node.minThreshold !== null) {
                    if (node.inclusive) {
                        if (value <= node.minThreshold) {
                            isAnomaly = true;
                            reason = "Unter Minimum-Schwellenwert";
                        }
                    } else {
                        if (value < node.minThreshold) {
                            isAnomaly = true;
                            reason = "Unter Minimum-Schwellenwert";
                        }
                    }
                }
                
                // Prüfung auf Maximum-Schwellenwert
                if (node.maxThreshold !== null) {
                    if (node.inclusive) {
                        if (value >= node.maxThreshold) {
                            isAnomaly = true;
                            reason = reason ? reason + " oder über Maximum-Schwellenwert" : "Über Maximum-Schwellenwert";
                        }
                    } else {
                        if (value > node.maxThreshold) {
                            isAnomaly = true;
                            reason = reason ? reason + " oder über Maximum-Schwellenwert" : "Über Maximum-Schwellenwert";
                        }
                    }
                }
                
                // Ausgabe-Nachricht erstellen
                var outputMsg = {
                    payload: value,
                    isAnomaly: isAnomaly,
                    minThreshold: node.minThreshold,
                    maxThreshold: node.maxThreshold,
                    reason: reason,
                    method: "threshold",
                    timestamp: Date.now()
                };
                
                // Original-Nachrichteneigenschaften kopieren
                Object.keys(msg).forEach(function(key) {
                    if (key !== 'payload' && key !== 'isAnomaly' && key !== 'minThreshold' && 
                        key !== 'maxThreshold' && key !== 'reason' && key !== 'method' && key !== 'timestamp') {
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
                node.error("Fehler bei Threshold-Prüfung: " + err.message, msg);
            }
        });
    }
    
    RED.nodes.registerType("threshold-anomaly", ThresholdAnomalyNode);
};

