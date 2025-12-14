module.exports = function(RED) {
    "use strict";
    
    function EMAAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        this.alpha = parseFloat(config.alpha) || 0.3;
        this.threshold = parseFloat(config.threshold) || 2.0;
        this.method = config.method || "stddev"; // "stddev" oder "percentage"
        this.dataBuffer = [];
        this.ema = null;
        this.initialized = false;
        
        node.on('input', function(msg) {
            try {
                // Wert aus der Nachricht extrahieren
                var value = parseFloat(msg.payload);
                
                if (isNaN(value)) {
                    node.error("Payload is not a valid number", msg);
                    return;
                }
                
                // EMA initialisieren mit erstem Wert
                if (!node.initialized) {
                    node.ema = value;
                    node.initialized = true;
                    node.dataBuffer.push({
                        timestamp: Date.now(),
                        value: value
                    });
                    node.send(msg);
                    return;
                }
                
                // EMA berechnen: EMA = alpha * value + (1 - alpha) * previous_EMA
                node.ema = node.alpha * value + (1 - node.alpha) * node.ema;
                
                // Add value to buffer
                node.dataBuffer.push({
                    timestamp: Date.now(),
                    value: value
                });
                
                // Limit buffer to maximum size (for standard deviation)
                if (node.dataBuffer.length > 100) {
                    node.dataBuffer.shift();
                }
                
                var isAnomaly = false;
                var deviation = 0;
                var deviationPercent = 0;
                
                if (node.method === "stddev") {
                    // Standardabweichung der letzten Werte berechnen
                    if (node.dataBuffer.length < 2) {
                        node.send(msg);
                        return;
                    }
                    
                    var values = node.dataBuffer.map(d => d.value);
                    var mean = values.reduce((a, b) => a + b, 0) / values.length;
                    var variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
                    var stdDev = Math.sqrt(variance);
                    
                    // Abweichung vom EMA
                    deviation = Math.abs(value - node.ema);
                    deviationPercent = stdDev === 0 ? 0 : (deviation / stdDev) * 100;
                    
                    // Anomaly if deviation is greater than threshold * standard deviation
                    isAnomaly = deviation > (node.threshold * stdDev);
                    
                } else if (node.method === "percentage") {
                    // Prozentuale Abweichung vom EMA
                    deviation = Math.abs(value - node.ema);
                    deviationPercent = node.ema === 0 ? 0 : (deviation / Math.abs(node.ema)) * 100;
                    
                    // Anomaly if percentage deviation is greater than threshold
                    isAnomaly = deviationPercent > node.threshold;
                }
                
                // Ausgabe-Nachricht erstellen
                var outputMsg = {
                    payload: value,
                    ema: node.ema,
                    deviation: deviation,
                    deviationPercent: deviationPercent,
                    isAnomaly: isAnomaly,
                    method: "ema-" + node.method,
                    alpha: node.alpha,
                    threshold: node.threshold,
                    timestamp: Date.now()
                };
                
                // Original-Nachrichteneigenschaften kopieren
                Object.keys(msg).forEach(function(key) {
                    if (key !== 'payload' && key !== 'ema' && key !== 'deviation' && 
                        key !== 'deviationPercent' && key !== 'isAnomaly' && key !== 'method' && 
                        key !== 'alpha' && key !== 'threshold' && key !== 'timestamp') {
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
                node.error("Fehler bei EMA Berechnung: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.dataBuffer = [];
            node.ema = null;
            node.initialized = false;
        });
    }
    
    RED.nodes.registerType("ema-anomaly", EMAAnomalyNode);
};

