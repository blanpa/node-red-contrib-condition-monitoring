module.exports = function(RED) {
    function CorrelationAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        // Configuration
        const sensor1 = config.sensor1 || "sensor1";
        const sensor2 = config.sensor2 || "sensor2";
        const threshold = parseFloat(config.threshold) || 0.7;
        const windowSize = parseInt(config.windowSize) || 30;
        const method = config.method || "pearson";
        
        // Buffers for each sensor
        let buffer1 = [];
        let buffer2 = [];
        
        node.on('input', function(msg) {
            const payload = msg.payload;
            
            // Accept object with sensor values
            if (typeof payload !== 'object' || payload === null) {
                node.warn("Payload must be an object with sensor values");
                return;
            }
            
            // Extract sensor values
            const value1 = parseFloat(payload[sensor1]);
            const value2 = parseFloat(payload[sensor2]);
            
            if (isNaN(value1) || isNaN(value2)) {
                node.warn(`Missing or invalid sensor values: ${sensor1}, ${sensor2}`);
                return;
            }
            
            // Add to buffers
            buffer1.push(value1);
            buffer2.push(value2);
            
            // Maintain window size
            if (buffer1.length > windowSize) {
                buffer1.shift();
                buffer2.shift();
            }
            
            // Need minimum samples for meaningful correlation
            if (buffer1.length < 3) {
                node.status({fill: "yellow", shape: "ring", text: `Buffering: ${buffer1.length}/${windowSize}`});
                return;
            }
            
            // Calculate correlation
            let correlation = null;
            let isAnomalous = false;
            
            if (method === "pearson") {
                correlation = calculatePearsonCorrelation(buffer1, buffer2);
            } else if (method === "spearman") {
                correlation = calculateSpearmanCorrelation(buffer1, buffer2);
            }
            
            // Check if correlation is anomalous
            if (correlation !== null) {
                // Normal = high correlation, Anomalous = low or negative correlation
                isAnomalous = Math.abs(correlation) < threshold;
            }
            
            // Calculate additional statistics
            const stats = {
                correlation: correlation,
                sensor1Mean: buffer1.reduce((a, b) => a + b, 0) / buffer1.length,
                sensor2Mean: buffer2.reduce((a, b) => a + b, 0) / buffer2.length,
                bufferSize: buffer1.length
            };
            
            // Prepare output
            const outputMsg = {
                payload: payload,
                correlation: correlation,
                isAnomalous: isAnomalous,
                sensor1: sensor1,
                sensor2: sensor2,
                stats: stats,
                method: method
            };
            
            // Copy original message properties
            Object.keys(msg).forEach(key => {
                if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                    outputMsg[key] = msg[key];
                }
            });
            
            // Set status
            if (correlation !== null) {
                const color = isAnomalous ? "red" : "green";
                const shape = isAnomalous ? "ring" : "dot";
                node.status({
                    fill: color, 
                    shape: shape, 
                    text: `ρ=${correlation.toFixed(3)} ${isAnomalous ? '!' : ''}`
                });
            }
            
            // Send to appropriate output
            if (isAnomalous) {
                node.send([null, outputMsg]); // Output 2: Anomalous correlation
            } else {
                node.send([outputMsg, null]); // Output 1: Normal correlation
            }
        });
        
        // Pearson Correlation Coefficient
        function calculatePearsonCorrelation(x, y) {
            const n = x.length;
            if (n !== y.length || n === 0) return null;
            
            // Calculate means
            const meanX = x.reduce((a, b) => a + b, 0) / n;
            const meanY = y.reduce((a, b) => a + b, 0) / n;
            
            // Calculate covariance and standard deviations
            let covariance = 0;
            let stdX = 0;
            let stdY = 0;
            
            for (let i = 0; i < n; i++) {
                const dx = x[i] - meanX;
                const dy = y[i] - meanY;
                covariance += dx * dy;
                stdX += dx * dx;
                stdY += dy * dy;
            }
            
            stdX = Math.sqrt(stdX);
            stdY = Math.sqrt(stdY);
            
            // Calculate correlation
            if (stdX === 0 || stdY === 0) return 0;
            return covariance / (stdX * stdY);
        }
        
        // Spearman Rank Correlation Coefficient
        function calculateSpearmanCorrelation(x, y) {
            const n = x.length;
            if (n !== y.length || n === 0) return null;
            
            // Convert to ranks
            const ranksX = getRanks(x);
            const ranksY = getRanks(y);
            
            // Use Pearson correlation on ranks
            return calculatePearsonCorrelation(ranksX, ranksY);
        }
        
        // Convert values to ranks
        function getRanks(values) {
            // Create array of {value, index} pairs
            const indexed = values.map((value, index) => ({value, index}));
            
            // Sort by value
            indexed.sort((a, b) => a.value - b.value);
            
            // Assign ranks (handling ties with average rank)
            const ranks = new Array(values.length);
            let i = 0;
            
            while (i < indexed.length) {
                let j = i;
                // Find ties
                while (j < indexed.length && indexed[j].value === indexed[i].value) {
                    j++;
                }
                
                // Average rank for ties
                const avgRank = (i + j + 1) / 2;
                
                // Assign ranks
                for (let k = i; k < j; k++) {
                    ranks[indexed[k].index] = avgRank;
                }
                
                i = j;
            }
            
            return ranks;
        }
    }
    
    RED.nodes.registerType("correlation-anomaly", CorrelationAnomalyNode);
};

