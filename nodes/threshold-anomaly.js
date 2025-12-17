module.exports = function(RED) {
    "use strict";
    
    function ThresholdAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        this.minThreshold = config.minThreshold !== "" ? parseFloat(config.minThreshold) : null;
        this.maxThreshold = config.maxThreshold !== "" ? parseFloat(config.maxThreshold) : null;
        this.warningMargin = parseFloat(config.warningMargin) || 10; // Prozent für Warning-Zone
        this.inclusive = config.inclusive !== undefined ? config.inclusive : false;
        
        // Warning-Grenzen berechnen
        this.minWarning = null;
        this.maxWarning = null;
        if (this.minThreshold !== null) {
            this.minWarning = this.minThreshold * (1 + this.warningMargin / 100);
        }
        if (this.maxThreshold !== null) {
            this.maxWarning = this.maxThreshold * (1 - this.warningMargin / 100);
        }
        
        // Initial status
        var rangeText = "";
        if (this.minThreshold !== null && this.maxThreshold !== null) {
            rangeText = this.minThreshold + " - " + this.maxThreshold;
        } else if (this.minThreshold !== null) {
            rangeText = "min: " + this.minThreshold;
        } else if (this.maxThreshold !== null) {
            rangeText = "max: " + this.maxThreshold;
        }
        node.status({fill: "blue", shape: "ring", text: "range: " + rangeText});
        
        node.on('input', function(msg) {
            try {
                // Reset-Funktion (für Konsistenz mit anderen Nodes)
                if (msg.reset === true) {
                    node.status({fill: "blue", shape: "ring", text: "range: " + rangeText});
                    return;
                }
                
                // Wert aus der Nachricht extrahieren
                var value = parseFloat(msg.payload);
                
                if (isNaN(value)) {
                    node.status({fill: "red", shape: "ring", text: "invalid input"});
                    node.error("Payload is not a valid number", msg);
                    return;
                }
                
                var isAnomaly = false;
                var severity = "normal";
                var reason = null;
                
                // Check minimum threshold
                if (node.minThreshold !== null) {
                    var belowMin = node.inclusive ? (value <= node.minThreshold) : (value < node.minThreshold);
                    var nearMin = node.minWarning !== null && value < node.minWarning && !belowMin;
                    
                    if (belowMin) {
                        isAnomaly = true;
                        severity = "critical";
                        reason = "Below minimum threshold (" + node.minThreshold + ")";
                    } else if (nearMin) {
                        isAnomaly = true;
                        severity = "warning";
                        reason = "Approaching minimum threshold";
                    }
                }
                
                // Check maximum threshold
                if (node.maxThreshold !== null) {
                    var aboveMax = node.inclusive ? (value >= node.maxThreshold) : (value > node.maxThreshold);
                    var nearMax = node.maxWarning !== null && value > node.maxWarning && !aboveMax;
                    
                    if (aboveMax) {
                        isAnomaly = true;
                        severity = "critical";
                        reason = reason ? reason + " AND above maximum threshold (" + node.maxThreshold + ")" : "Above maximum threshold (" + node.maxThreshold + ")";
                    } else if (nearMax && severity !== "critical") {
                        isAnomaly = true;
                        severity = severity === "warning" ? "warning" : "warning";
                        reason = reason ? reason + " AND approaching maximum threshold" : "Approaching maximum threshold";
                    }
                }
                
                // Status aktualisieren
                if (severity === "critical") {
                    node.status({fill: "red", shape: "dot", text: "CRITICAL: " + value});
                } else if (severity === "warning") {
                    node.status({fill: "yellow", shape: "dot", text: "warning: " + value});
                } else {
                    node.status({fill: "green", shape: "dot", text: "OK: " + value});
                }
                
                // Ausgabe-Nachricht erstellen
                var outputMsg = {
                    payload: value,
                    isAnomaly: isAnomaly,
                    severity: severity,
                    minThreshold: node.minThreshold,
                    maxThreshold: node.maxThreshold,
                    reason: reason,
                    method: "threshold"
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
                node.error("Error in threshold check: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.status({});
        });
    }
    
    RED.nodes.registerType("threshold-anomaly", ThresholdAnomalyNode);
};
