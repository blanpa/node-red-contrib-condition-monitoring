module.exports = function(RED) {
    function RateOfChangeNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        // Configuration
        const threshold = parseFloat(config.threshold) || null;
        const timeWindow = parseInt(config.timeWindow) || 1;
        const method = config.method || "absolute";
        
        // State
        let previousValue = null;
        let previousTimestamp = null;
        let history = [];
        
        node.on('input', function(msg) {
            const value = parseFloat(msg.payload);
            const timestamp = msg.timestamp || Date.now();
            
            if (isNaN(value)) {
                node.warn("Invalid payload: not a number");
                return;
            }
            
            // Store in history
            history.push({ value, timestamp });
            
            // Maintain window
            const windowMs = timeWindow * 1000;
            history = history.filter(h => timestamp - h.timestamp <= windowMs);
            
            let rateOfChange = null;
            let isAnomalous = false;
            let acceleration = null;
            
            if (previousValue !== null && previousTimestamp !== null) {
                const timeDiff = (timestamp - previousTimestamp) / 1000; // Convert to seconds
                const valueDiff = value - previousValue;
                
                // Calculate rate of change (derivative)
                if (timeDiff > 0) {
                    if (method === "absolute") {
                        rateOfChange = valueDiff / timeDiff;
                    } else if (method === "percentage") {
                        if (previousValue !== 0) {
                            rateOfChange = (valueDiff / Math.abs(previousValue)) * 100 / timeDiff;
                        }
                    }
                }
                
                // Calculate acceleration (second derivative) if we have enough history
                if (history.length >= 3) {
                    const rates = [];
                    for (let i = 1; i < history.length; i++) {
                        const dt = (history[i].timestamp - history[i-1].timestamp) / 1000;
                        const dv = history[i].value - history[i-1].value;
                        if (dt > 0) {
                            rates.push(dv / dt);
                        }
                    }
                    
                    if (rates.length >= 2) {
                        const lastRate = rates[rates.length - 1];
                        const prevRate = rates[rates.length - 2];
                        const avgTimeDiff = windowMs / 1000 / history.length;
                        acceleration = (lastRate - prevRate) / avgTimeDiff;
                    }
                }
                
                // Check threshold
                if (threshold !== null && rateOfChange !== null) {
                    isAnomalous = Math.abs(rateOfChange) > threshold;
                }
            }
            
            // Prepare output
            const outputMsg = {
                payload: value,
                rateOfChange: rateOfChange,
                acceleration: acceleration,
                isAnomalous: isAnomalous,
                method: method,
                timeWindow: timeWindow,
                timestamp: timestamp
            };
            
            // Copy original message properties
            Object.keys(msg).forEach(key => {
                if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                    outputMsg[key] = msg[key];
                }
            });
            
            // Set status
            if (rateOfChange !== null) {
                const sign = rateOfChange >= 0 ? "+" : "";
                const color = isAnomalous ? "red" : "green";
                const unit = method === "percentage" ? "%/s" : "/s";
                node.status({
                    fill: color, 
                    shape: "dot", 
                    text: `${sign}${rateOfChange.toFixed(3)}${unit}`
                });
            }
            
            // Send to appropriate output
            if (isAnomalous) {
                node.send([null, outputMsg]); // Output 2: Anomalous rate
            } else {
                node.send([outputMsg, null]); // Output 1: Normal rate
            }
            
            // Update state
            previousValue = value;
            previousTimestamp = timestamp;
        });
    }
    
    RED.nodes.registerType("rate-of-change", RateOfChangeNode);
};

