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
        const outputTopic = config.outputTopic || "";
        const debug = config.debug === true;
        
        // Scale conversion helper
        const scaleOutput = function(value) {
            if (outputScale === "0-1") {
                return value / 100;
            }
            return value; // Default 0-100
        };
        
        const scaleThreshold = function(value) {
            if (outputScale === "0-1") {
                return value / 100;
            }
            return value;
        };
        
        // Threshold configuration
        const healthyThreshold = parseFloat(config.healthyThreshold) || 80;
        const warningThreshold = parseFloat(config.warningThreshold) || 60;
        const degradedThreshold = parseFloat(config.degradedThreshold) || 40;
        const criticalThreshold = parseFloat(config.criticalThreshold) || 20;
        
        // Debug logging helper
        const debugLog = function(message) {
            if (debug) {
                node.warn("[DEBUG] " + message);
            }
        };
        
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
            
            debugLog("Health Index: " + healthResult.index.toFixed(1) + "%, Worst: " + (healthResult.worstSensor ? healthResult.worstSensor.name : "N/A"));
            
            // Determine health status using configurable thresholds
            let status = "healthy";
            let statusColor = "green";
            
            if (healthResult.index < criticalThreshold) {
                status = "critical";
                statusColor = "red";
            } else if (healthResult.index < degradedThreshold) {
                status = "degraded";
                statusColor = "red";
            } else if (healthResult.index < warningThreshold) {
                status = "warning";
                statusColor = "yellow";
            } else if (healthResult.index < healthyThreshold) {
                status = "attention";
                statusColor = "yellow";
            }
            
            // Scale the output values
            const scaledIndex = scaleOutput(healthResult.index);
            const scaledSensorScores = {};
            for (const [name, score] of Object.entries(healthResult.sensorScores)) {
                scaledSensorScores[name] = scaleOutput(score);
            }
            
            // Prepare output
            const outputMsg = {
                payload: scaledIndex,
                healthIndex: scaledIndex,
                status: status,
                scale: outputScale,
                sensorScores: scaledSensorScores,
                worstSensor: healthResult.worstSensor ? {
                    name: healthResult.worstSensor.name,
                    score: scaleOutput(healthResult.worstSensor.score)
                } : null,
                contributingFactors: healthResult.contributingFactors,
                method: aggregationMethod,
                thresholds: {
                    healthy: scaleThreshold(healthyThreshold),
                    warning: scaleThreshold(warningThreshold),
                    degraded: scaleThreshold(degradedThreshold),
                    critical: scaleThreshold(criticalThreshold)
                }
            };
            
            // Set topic if configured
            if (outputTopic) {
                outputMsg.topic = outputTopic;
            }
            
            // Copy original message properties
            Object.keys(msg).forEach(key => {
                if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                    outputMsg[key] = msg[key];
                }
                // Preserve original topic if no output topic configured
                if (key === 'topic' && !outputTopic) {
                    outputMsg.topic = msg.topic;
                }
            });
            
            // Set status
            const statusText = outputScale === "0-1" 
                ? `Health: ${scaledIndex.toFixed(2)} (${status})`
                : `Health: ${scaledIndex.toFixed(1)}% (${status})`;
            node.status({
                fill: statusColor, 
                shape: "dot", 
                text: statusText
            });
            
            // Send to different outputs based on status
            if (status === "critical" || status === "degraded" || status === "warning") {
                node.send([null, outputMsg]); // Output 2: Degraded/Warning/Critical health
            } else {
                node.send([outputMsg, null]); // Output 1: Healthy/Attention
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

