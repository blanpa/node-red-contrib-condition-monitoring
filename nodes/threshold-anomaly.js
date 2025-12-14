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
                    node.error("Payload is not a valid number", msg);
                    return;
                }
                
                var isAnomaly = false;
                var reason = null;
                
                // Check minimum threshold
                if (node.minThreshold !== null) {
                    if (node.inclusive) {
                        if (value <= node.minThreshold) {
                            isAnomaly = true;
                            reason = "Below minimum threshold";
                        }
                    } else {
                        if (value < node.minThreshold) {
                            isAnomaly = true;
                            reason = "Below minimum threshold";
                        }
                    }
                }
                
                // Check maximum threshold
                if (node.maxThreshold !== null) {
                    if (node.inclusive) {
                        if (value >= node.maxThreshold) {
                            isAnomaly = true;
                            reason = reason ? reason + " or above maximum threshold" : "Above maximum threshold";
                        }
                    } else {
                        if (value > node.maxThreshold) {
                            isAnomaly = true;
                            reason = reason ? reason + " or above maximum threshold" : "Above maximum threshold";
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
                node.error("Error in threshold check: " + err.message, msg);
            }
        });
    }
    
    RED.nodes.registerType("threshold-anomaly", ThresholdAnomalyNode);
};

