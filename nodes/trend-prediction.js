module.exports = function(RED) {
    function TrendPredictionNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        // Configuration
        const method = config.method || "linear";
        const predictionSteps = parseInt(config.predictionSteps) || 10;
        const windowSize = parseInt(config.windowSize) || 50;
        const threshold = parseFloat(config.threshold) || null;
        
        // Data buffer
        let buffer = [];
        let timestamps = [];
        
        node.on('input', function(msg) {
            const value = parseFloat(msg.payload);
            const timestamp = msg.timestamp || Date.now();
            
            if (isNaN(value)) {
                node.warn("Invalid payload: not a number");
                return;
            }
            
            // Add to buffer
            buffer.push(value);
            timestamps.push(timestamp);
            
            // Maintain window size
            if (buffer.length > windowSize) {
                buffer.shift();
                timestamps.shift();
            }
            
            // Need at least 3 points for meaningful prediction
            if (buffer.length < 3) {
                return;
            }
            
            let prediction = null;
            
            // Calculate trend and prediction
            if (method === "linear") {
                prediction = linearRegression(buffer, predictionSteps, timestamps);
            } else if (method === "exponential") {
                prediction = exponentialSmoothing(buffer, predictionSteps);
            }
            
            // Calculate time to threshold (RUL)
            let timeToThreshold = null;
            let stepsToThreshold = null;
            
            if (threshold !== null && prediction) {
                stepsToThreshold = calculateStepsToThreshold(prediction.predictedValues, threshold);
                if (stepsToThreshold !== null && timestamps.length >= 2) {
                    // Calculate average time between samples
                    const timeDiffs = [];
                    for (let i = 1; i < timestamps.length; i++) {
                        timeDiffs.push(timestamps[i] - timestamps[i-1]);
                    }
                    const avgTimeDiff = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;
                    timeToThreshold = stepsToThreshold * avgTimeDiff;
                }
            }
            
            // Prepare output message
            const outputMsg = {
                payload: value,
                trend: prediction ? prediction.trend : null,
                slope: prediction ? prediction.slope : null,
                predictedValues: prediction ? prediction.predictedValues : [],
                timeToThreshold: timeToThreshold,
                stepsToThreshold: stepsToThreshold,
                bufferSize: buffer.length,
                method: method,
                timestamp: timestamp
            };
            
            // Copy original message properties
            Object.keys(msg).forEach(key => {
                if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                    outputMsg[key] = msg[key];
                }
            });
            
            // Set status
            if (prediction) {
                const trendIcon = prediction.slope > 0 ? "↗" : prediction.slope < 0 ? "↘" : "→";
                let statusText = `${trendIcon} ${prediction.slope.toFixed(3)}`;
                if (timeToThreshold !== null) {
                    const hours = Math.floor(timeToThreshold / 3600000);
                    statusText += ` | RUL: ${hours}h`;
                }
                node.status({fill: "green", shape: "dot", text: statusText});
            }
            
            node.send(outputMsg);
        });
        
        // Linear Regression
        function linearRegression(data, steps, times) {
            const n = data.length;
            const x = Array.from({length: n}, (_, i) => i);
            
            // Calculate means
            const meanX = x.reduce((a, b) => a + b, 0) / n;
            const meanY = data.reduce((a, b) => a + b, 0) / n;
            
            // Calculate slope and intercept
            let numerator = 0;
            let denominator = 0;
            
            for (let i = 0; i < n; i++) {
                numerator += (x[i] - meanX) * (data[i] - meanY);
                denominator += (x[i] - meanX) ** 2;
            }
            
            const slope = denominator !== 0 ? numerator / denominator : 0;
            const intercept = meanY - slope * meanX;
            
            // Predict future values
            const predictedValues = [];
            for (let i = 1; i <= steps; i++) {
                const futureX = n + i - 1;
                predictedValues.push(slope * futureX + intercept);
            }
            
            // Determine trend
            let trend = "stable";
            if (Math.abs(slope) > 0.01) {
                trend = slope > 0 ? "increasing" : "decreasing";
            }
            
            return {
                slope: slope,
                intercept: intercept,
                predictedValues: predictedValues,
                trend: trend
            };
        }
        
        // Exponential Smoothing for prediction
        function exponentialSmoothing(data, steps) {
            const alpha = 0.3;
            const beta = 0.1;
            
            // Initialize
            let level = data[0];
            let trend = data.length > 1 ? data[1] - data[0] : 0;
            
            // Update level and trend
            for (let i = 1; i < data.length; i++) {
                const prevLevel = level;
                level = alpha * data[i] + (1 - alpha) * (level + trend);
                trend = beta * (level - prevLevel) + (1 - beta) * trend;
            }
            
            // Predict
            const predictedValues = [];
            for (let i = 1; i <= steps; i++) {
                predictedValues.push(level + i * trend);
            }
            
            // Determine trend direction
            let trendDirection = "stable";
            if (Math.abs(trend) > 0.01) {
                trendDirection = trend > 0 ? "increasing" : "decreasing";
            }
            
            return {
                slope: trend,
                intercept: level,
                predictedValues: predictedValues,
                trend: trendDirection
            };
        }
        
        // Calculate steps until threshold is reached
        function calculateStepsToThreshold(predictedValues, threshold) {
            for (let i = 0; i < predictedValues.length; i++) {
                if (predictedValues[i] >= threshold) {
                    return i + 1;
                }
            }
            return null; // Threshold not reached within prediction window
        }
    }
    
    RED.nodes.registerType("trend-prediction", TrendPredictionNode);
};

