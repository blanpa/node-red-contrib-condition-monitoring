module.exports = function(RED) {
    "use strict";
    
    // Import state persistence
    var StatePersistence = null;
    try {
        StatePersistence = require('./state-persistence');
    } catch (err) {
        // State persistence not available
    }
    
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
        const persistState = config.persistState === true;
        
        // State for tracking health history
        node.healthHistory = [];
        node.lastHealthIndex = null;
        node.lastStatus = null;
        
        // State persistence manager
        node.stateManager = null;
        
        // Helper to persist current state
        function persistCurrentState() {
            if (node.stateManager) {
                node.stateManager.setMultiple({
                    healthHistory: node.healthHistory,
                    lastHealthIndex: node.lastHealthIndex,
                    lastStatus: node.lastStatus
                });
            }
        }
        
        // Initialize state persistence if enabled
        if (persistState && StatePersistence) {
            node.stateManager = new StatePersistence.NodeStateManager(node, {
                stateKey: 'healthIndexState',
                saveInterval: 30000 // Save every 30 seconds
            });
            
            // Load persisted state on startup
            node.stateManager.load().then(function(state) {
                if (state.healthHistory && state.healthHistory.length > 0) {
                    node.healthHistory = state.healthHistory;
                    node.lastHealthIndex = state.lastHealthIndex;
                    node.lastStatus = state.lastStatus;
                    
                    if (debug) {
                        node.warn("[DEBUG] Restored " + node.healthHistory.length + " health history entries from persistence");
                    }
                    node.status({fill: "green", shape: "dot", text: "Restored (" + node.healthHistory.length + " entries)"});
                }
            }).catch(function(err) {
                if (debug) {
                    node.warn("[DEBUG] Failed to load persisted state: " + err.message);
                }
            });
        }
        
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
            // Dynamic configuration via msg.config
            // Allows runtime override of node settings
            const cfg = msg.config || {};
            const activeHealthyThreshold = (cfg.healthyThreshold !== undefined) ? parseFloat(cfg.healthyThreshold) : healthyThreshold;
            const activeWarningThreshold = (cfg.warningThreshold !== undefined) ? parseFloat(cfg.warningThreshold) : warningThreshold;
            const activeDegradedThreshold = (cfg.degradedThreshold !== undefined) ? parseFloat(cfg.degradedThreshold) : degradedThreshold;
            const activeCriticalThreshold = (cfg.criticalThreshold !== undefined) ? parseFloat(cfg.criticalThreshold) : criticalThreshold;
            const activeAggregationMethod = cfg.aggregationMethod || aggregationMethod;
            const activeSensorWeights = cfg.sensorWeights || sensorWeights;
            
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
            
            // Calculate health index (using active config from msg.config or node defaults)
            const healthResult = calculateHealthIndex(sensorData, activeSensorWeights, activeAggregationMethod);
            
            debugLog("Health Index: " + healthResult.index.toFixed(1) + "%, Worst: " + (healthResult.worstSensor ? healthResult.worstSensor.name : "N/A"));
            
            // Determine health status using configurable thresholds (active config)
            let status = "healthy";
            let statusColor = "green";
            
            if (healthResult.index < activeCriticalThreshold) {
                status = "critical";
                statusColor = "red";
            } else if (healthResult.index < activeDegradedThreshold) {
                status = "degraded";
                statusColor = "red";
            } else if (healthResult.index < activeWarningThreshold) {
                status = "warning";
                statusColor = "yellow";
            } else if (healthResult.index < activeHealthyThreshold) {
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
                    score: scaleOutput(healthResult.worstSensor.score),
                    reliability: healthResult.worstSensor.reliability
                } : null,
                contributingFactors: healthResult.contributingFactors,
                method: aggregationMethod,
                thresholds: {
                    healthy: scaleThreshold(healthyThreshold),
                    warning: scaleThreshold(warningThreshold),
                    degraded: scaleThreshold(degradedThreshold),
                    critical: scaleThreshold(criticalThreshold)
                },
                dynamicWeights: healthResult.dynamicWeights
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
            
            // Track health history
            node.healthHistory.push({
                timestamp: Date.now(),
                index: scaledIndex,
                status: status
            });
            
            // Limit history to last 100 entries
            if (node.healthHistory.length > 100) {
                node.healthHistory.shift();
            }
            
            node.lastHealthIndex = scaledIndex;
            node.lastStatus = status;
            
            // Persist state periodically (every 10th sample)
            if (node.stateManager && node.healthHistory.length % 10 === 0) {
                persistCurrentState();
            }
            
            // Add health trend to output
            outputMsg.healthTrend = calculateHealthTrend();
            
            // Send to different outputs based on status
            if (status === "critical" || status === "degraded" || status === "warning") {
                node.send([null, outputMsg]); // Output 2: Degraded/Warning/Critical health
            } else {
                node.send([outputMsg, null]); // Output 1: Healthy/Attention
            }
        });
        
        // Calculate health trend from history
        function calculateHealthTrend() {
            if (node.healthHistory.length < 3) {
                return { trend: "unknown", samples: node.healthHistory.length };
            }
            
            const recentHistory = node.healthHistory.slice(-10);
            const firstHalf = recentHistory.slice(0, Math.floor(recentHistory.length / 2));
            const secondHalf = recentHistory.slice(Math.floor(recentHistory.length / 2));
            
            const firstAvg = firstHalf.reduce((sum, h) => sum + h.index, 0) / firstHalf.length;
            const secondAvg = secondHalf.reduce((sum, h) => sum + h.index, 0) / secondHalf.length;
            
            const diff = secondAvg - firstAvg;
            let trend = "stable";
            
            if (diff > 2) {
                trend = "improving";
            } else if (diff < -2) {
                trend = "degrading";
            }
            
            return {
                trend: trend,
                recentAverage: secondAvg,
                previousAverage: firstAvg,
                change: diff,
                samples: node.healthHistory.length
            };
        }
        
        // Handle node close
        node.on('close', async function(done) {
            // Save state before closing if persistence enabled
            if (node.stateManager) {
                try {
                    persistCurrentState();
                    await node.stateManager.close();
                } catch (err) {
                    // Ignore persistence errors during shutdown
                }
            }
            
            node.healthHistory = [];
            node.lastHealthIndex = null;
            node.lastStatus = null;
            node.status({});
            
            if (done) done();
        });
        
        // Track sensor reliability for dynamic weighting
        if (!node.sensorReliability) {
            node.sensorReliability = {};
        }
        
        // Calculate dynamic weight based on sensor reliability
        function calculateDynamicWeight(sensorName, sensorInfo, baseWeight) {
            let reliabilityFactor = 1.0;
            
            // Initialize sensor reliability tracking
            if (!node.sensorReliability[sensorName]) {
                node.sensorReliability[sensorName] = {
                    values: [],
                    anomalyCount: 0,
                    totalCount: 0,
                    lastUpdate: Date.now()
                };
            }
            
            const reliability = node.sensorReliability[sensorName];
            reliability.totalCount++;
            
            // Track anomalies
            if (sensorInfo.isAnomaly) {
                reliability.anomalyCount++;
            }
            
            // Track values for variance calculation
            const value = sensorInfo.value !== undefined ? sensorInfo.value : 
                         (typeof sensorInfo === 'number' ? sensorInfo : null);
            
            if (value !== null && !isNaN(value)) {
                reliability.values.push(value);
                // Keep last 50 values
                if (reliability.values.length > 50) {
                    reliability.values.shift();
                }
            }
            
            // Factor 1: Reduce weight for sensors with high anomaly rate
            if (reliability.totalCount >= 10) {
                const anomalyRate = reliability.anomalyCount / reliability.totalCount;
                // High anomaly rate (>30%) reduces reliability
                if (anomalyRate > 0.3) {
                    reliabilityFactor *= (1 - (anomalyRate - 0.3));
                }
            }
            
            // Factor 2: Reduce weight for sensors with very high variance (noisy)
            if (reliability.values.length >= 10) {
                const mean = reliability.values.reduce((a, b) => a + b, 0) / reliability.values.length;
                const variance = reliability.values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / reliability.values.length;
                const cv = mean !== 0 ? Math.sqrt(variance) / Math.abs(mean) : 0;
                
                // High coefficient of variation (>0.5) reduces reliability
                if (cv > 0.5) {
                    reliabilityFactor *= Math.max(0.5, 1 - (cv - 0.5));
                }
            }
            
            // Factor 3: Confidence from sensor data
            if (sensorInfo.confidence !== undefined) {
                reliabilityFactor *= sensorInfo.confidence;
            }
            
            // Clamp reliability factor
            reliabilityFactor = Math.max(0.1, Math.min(1.0, reliabilityFactor));
            
            return {
                effectiveWeight: baseWeight * reliabilityFactor,
                reliabilityFactor: reliabilityFactor,
                anomalyRate: reliability.totalCount > 0 ? reliability.anomalyCount / reliability.totalCount : 0
            };
        }
        
        function calculateHealthIndex(sensorData, weights, method) {
            const sensorScores = {};
            const contributingFactors = [];
            const dynamicWeights = {};
            
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
                
                // Check confidence (reduce impact if low confidence)
                if (sensorInfo.confidence !== undefined && sensorInfo.confidence < 0.5) {
                    // Low confidence sensor - reduce penalty impact
                    const confidenceFactor = sensorInfo.confidence / 0.5;
                    const adjustment = Math.round((100 - score) * (1 - confidenceFactor) * 0.5);
                    score = Math.min(100, score + adjustment);
                    contributingFactors.push({
                        sensor: sensorName,
                        reason: `low confidence (${(sensorInfo.confidence * 100).toFixed(0)}%)`,
                        impact: adjustment
                    });
                }
                
                // Ensure score stays within 0-100
                score = Math.max(0, Math.min(100, score));
                sensorScores[sensorName] = score;
                
                // Calculate dynamic weight for this sensor
                const baseWeight = weights[sensorName] || 1.0;
                dynamicWeights[sensorName] = calculateDynamicWeight(sensorName, sensorInfo, baseWeight);
            }
            
            // Aggregate scores
            let healthIndex = 0;
            
            if (method === "weighted" || method === "dynamic") {
                // Dynamic weighted average - uses reliability-adjusted weights
                let totalWeight = 0;
                let weightedSum = 0;
                
                for (const [sensorName, score] of Object.entries(sensorScores)) {
                    const dynamicWeight = dynamicWeights[sensorName];
                    const effectiveWeight = method === "dynamic" ? 
                        dynamicWeight.effectiveWeight : 
                        (weights[sensorName] || 1.0);
                    
                    weightedSum += score * effectiveWeight;
                    totalWeight += effectiveWeight;
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
                        score: score,
                        reliability: dynamicWeights[sensorName] ? dynamicWeights[sensorName].reliabilityFactor : 1.0
                    };
                }
            }
            
            return {
                index: healthIndex,
                sensorScores: sensorScores,
                dynamicWeights: dynamicWeights,
                worstSensor: worstSensor,
                contributingFactors: contributingFactors
            };
        }
    }
    
    RED.nodes.registerType("health-index", HealthIndexNode);
};

