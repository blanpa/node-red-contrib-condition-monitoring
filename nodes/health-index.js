module.exports = function(RED) {
    function HealthIndexNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        // Configuration - parse sensor weights
        const sensorWeights = {};
        try {
            const weightsConfig = config.sensorWeights || "{}";
            Object.assign(sensorWeights, JSON.parse(weightsConfig));
        } catch(e) {
            node.warn("Invalid sensor weights configuration");
        }
        
        const aggregationMethod = config.aggregationMethod || "weighted";
        const outputScale = config.outputScale || "0-100";
        
        node.on('input', function(msg) {
            const payload = msg.payload;
            
            // Accept array or object of sensor values
            let sensorData = {};
            
            if (Array.isArray(payload)) {
                // Array format: convert to object with indices as keys
                payload.forEach((value, index) => {
                    if (typeof value === 'object' && value !== null) {
                        // Array of objects with sensor info
                        const name = value.valueName || value.name || `sensor${index}`;
                        sensorData[name] = value;
                    } else {
                        sensorData[`sensor${index}`] = { value: value };
                    }
                });
            } else if (typeof payload === 'object' && payload !== null) {
                sensorData = payload;
            } else {
                node.warn("Payload must be an array or object");
                return;
            }
            
            // Calculate health index
            const healthResult = calculateHealthIndex(sensorData, sensorWeights, aggregationMethod);
            
            // Determine health status
            let status = "healthy";
            let statusColor = "green";
            
            if (healthResult.index < 40) {
                status = "critical";
                statusColor = "red";
            } else if (healthResult.index < 60) {
                status = "warning";
                statusColor = "yellow";
            } else if (healthResult.index < 80) {
                status = "degraded";
                statusColor = "yellow";
            }
            
            // Prepare output
            const outputMsg = {
                payload: healthResult.index,
                healthIndex: healthResult.index,
                status: status,
                sensorScores: healthResult.sensorScores,
                worstSensor: healthResult.worstSensor,
                contributingFactors: healthResult.contributingFactors,
                method: aggregationMethod
            };
            
            // Copy original message properties
            Object.keys(msg).forEach(key => {
                if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                    outputMsg[key] = msg[key];
                }
            });
            
            // Set status
            node.status({
                fill: statusColor, 
                shape: "dot", 
                text: `Health: ${healthResult.index.toFixed(1)}% (${status})`
            });
            
            // Send to different outputs based on status
            if (status === "critical" || status === "warning") {
                node.send([null, outputMsg]); // Output 2: Degraded health
            } else {
                node.send([outputMsg, null]); // Output 1: Healthy
            }
        });
        
        function calculateHealthIndex(sensorData, weights, method) {
            const sensorScores = {};
            const contributingFactors = [];
            
            // Calculate individual sensor health scores
            for (const [sensorName, sensorInfo] of Object.entries(sensorData)) {
                let score = 100; // Start with perfect health
                
                // Check for anomaly flag
                if (sensorInfo.isAnomaly === true) {
                    score -= 30;
                    contributingFactors.push({
                        sensor: sensorName,
                        reason: "anomaly detected",
                        impact: -30
                    });
                }
                
                // Check Z-score or similar normalized metric
                if (sensorInfo.zScore !== undefined) {
                    const zScore = Math.abs(sensorInfo.zScore);
                    if (zScore > 3) {
                        score -= 40;
                        contributingFactors.push({
                            sensor: sensorName,
                            reason: `high z-score: ${zScore.toFixed(2)}`,
                            impact: -40
                        });
                    } else if (zScore > 2) {
                        score -= 20;
                        contributingFactors.push({
                            sensor: sensorName,
                            reason: `elevated z-score: ${zScore.toFixed(2)}`,
                            impact: -20
                        });
                    }
                }
                
                // Check deviation percentage
                if (sensorInfo.deviationPercent !== undefined) {
                    const devPercent = Math.abs(sensorInfo.deviationPercent);
                    if (devPercent > 30) {
                        score -= 30;
                        contributingFactors.push({
                            sensor: sensorName,
                            reason: `high deviation: ${devPercent.toFixed(1)}%`,
                            impact: -30
                        });
                    } else if (devPercent > 15) {
                        score -= 15;
                        contributingFactors.push({
                            sensor: sensorName,
                            reason: `moderate deviation: ${devPercent.toFixed(1)}%`,
                            impact: -15
                        });
                    }
                }
                
                // Check trend (if available)
                if (sensorInfo.trend === "increasing" && sensorInfo.slope > 0) {
                    score -= 10;
                    contributingFactors.push({
                        sensor: sensorName,
                        reason: "increasing trend",
                        impact: -10
                    });
                }
                
                // Ensure score stays within 0-100
                score = Math.max(0, Math.min(100, score));
                sensorScores[sensorName] = score;
            }
            
            // Aggregate scores
            let healthIndex = 0;
            
            if (method === "weighted") {
                // Weighted average
                let totalWeight = 0;
                let weightedSum = 0;
                
                for (const [sensorName, score] of Object.entries(sensorScores)) {
                    const weight = weights[sensorName] || 1.0;
                    weightedSum += score * weight;
                    totalWeight += weight;
                }
                
                healthIndex = totalWeight > 0 ? weightedSum / totalWeight : 100;
                
            } else if (method === "minimum") {
                // Worst-case (minimum score)
                healthIndex = Math.min(...Object.values(sensorScores));
                
            } else if (method === "average") {
                // Simple average
                const scores = Object.values(sensorScores);
                healthIndex = scores.reduce((a, b) => a + b, 0) / scores.length;
                
            } else if (method === "geometric") {
                // Geometric mean (emphasizes low scores)
                const scores = Object.values(sensorScores);
                const product = scores.reduce((a, b) => a * b, 1);
                healthIndex = Math.pow(product, 1 / scores.length);
            }
            
            // Find worst sensor
            let worstSensor = null;
            let worstScore = 100;
            
            for (const [sensorName, score] of Object.entries(sensorScores)) {
                if (score < worstScore) {
                    worstScore = score;
                    worstSensor = {
                        name: sensorName,
                        score: score
                    };
                }
            }
            
            return {
                index: healthIndex,
                sensorScores: sensorScores,
                worstSensor: worstSensor,
                contributingFactors: contributingFactors
            };
        }
    }
    
    RED.nodes.registerType("health-index", HealthIndexNode);
};

