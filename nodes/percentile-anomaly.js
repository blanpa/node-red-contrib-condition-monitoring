module.exports = function(RED) {
    "use strict";
    
    function PercentileAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        this.lowerPercentile = parseFloat(config.lowerPercentile) || 5.0;
        this.upperPercentile = parseFloat(config.upperPercentile) || 95.0;
        this.windowSize = parseInt(config.windowSize) || 100;
        this.dataBuffer = [];
        
        // Perzentil berechnen
        function calculatePercentile(sorted, percentile) {
            if (sorted.length === 0) return 0;
            var index = (percentile / 100) * (sorted.length - 1);
            var lower = Math.floor(index);
            var upper = Math.ceil(index);
            var weight = index - lower;
            
            if (lower === upper) {
                return sorted[lower];
            }
            return sorted[lower] * (1 - weight) + sorted[upper] * weight;
        }
        
        node.on('input', function(msg) {
            try {
                // Wert aus der Nachricht extrahieren
                var value = parseFloat(msg.payload);
                
                if (isNaN(value)) {
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
                
                // At least 2 values required
                if (node.dataBuffer.length < 2) {
                    node.send(msg);
                    return;
                }
                
                // Werte extrahieren und sortieren
                var values = node.dataBuffer.map(d => d.value);
                var sorted = values.slice().sort(function(a, b) { return a - b; });
                
                // Perzentile berechnen
                var lowerBound = calculatePercentile(sorted, node.lowerPercentile);
                var upperBound = calculatePercentile(sorted, node.upperPercentile);
                
                // Anomalieerkennung
                var isAnomaly = value < lowerBound || value > upperBound;
                
                // Ausgabe-Nachricht erstellen
                var outputMsg = {
                    payload: value,
                    lowerPercentile: node.lowerPercentile,
                    upperPercentile: node.upperPercentile,
                    lowerBound: lowerBound,
                    upperBound: upperBound,
                    isAnomaly: isAnomaly,
                    method: "percentile",
                    timestamp: Date.now()
                };
                
                // Original-Nachrichteneigenschaften kopieren
                Object.keys(msg).forEach(function(key) {
                    if (key !== 'payload' && key !== 'lowerPercentile' && key !== 'upperPercentile' && 
                        key !== 'lowerBound' && key !== 'upperBound' && key !== 'isAnomaly' && 
                        key !== 'method' && key !== 'timestamp') {
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
                node.error("Fehler bei Percentile Berechnung: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.dataBuffer = [];
        });
    }
    
    RED.nodes.registerType("percentile-anomaly", PercentileAnomalyNode);
};

