module.exports = function(RED) {
    function VibrationFeaturesNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        // Configuration
        node.windowSize = parseInt(config.windowSize) || 100;
        node.outputMode = config.outputMode || "all"; // all, separate
        
        // Data buffer for window
        node.dataBuffer = [];
        
        node.on('input', function(msg) {
            // Input validation
            if (typeof msg.payload !== 'number' && !Array.isArray(msg.payload)) {
                node.warn("Payload must be a number or array of numbers");
                return;
            }
            
            var values = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
            
            // Filter non-numeric values
            values = values.filter(v => typeof v === 'number' && !isNaN(v));
            
            if (values.length === 0) {
                node.warn("No valid numeric values found");
                return;
            }
            
            // Add values to buffer
            node.dataBuffer.push(...values);
            
            // Limit buffer to window size
            if (node.dataBuffer.length > node.windowSize) {
                node.dataBuffer = node.dataBuffer.slice(-node.windowSize);
            }
            
            // Only calculate when enough data is available
            if (node.dataBuffer.length < Math.min(10, node.windowSize)) {
                node.status({fill:"yellow", shape:"ring", text:`Collecting data: ${node.dataBuffer.length}/${node.windowSize}`});
                return;
            }
            
            try {
                // Calculate vibration features
                var features = calculateVibrationFeatures(node.dataBuffer);
                
                // Update status
                node.status({
                    fill:"green", 
                    shape:"dot", 
                    text: `RMS: ${features.rms.toFixed(2)} | CF: ${features.crestFactor.toFixed(2)}`
                });
                
                // Output depending on mode
                if (node.outputMode === "all") {
                    // All features in one message
                    var outputMsg = {
                        payload: features,
                        topic: msg.topic || "vibration-features",
                        timestamp: Date.now(),
                        windowSize: node.dataBuffer.length
                    };
                    node.send(outputMsg);
                } else {
                    // Separate outputs for each feature
                    node.send([
                        {payload: features.rms, topic: "rms", feature: "rms", unit: msg.unit || ""},
                        {payload: features.peakToPeak, topic: "peak-to-peak", feature: "peakToPeak", unit: msg.unit || ""},
                        {payload: features.crestFactor, topic: "crest-factor", feature: "crestFactor", unit: ""},
                        {payload: features.kurtosis, topic: "kurtosis", feature: "kurtosis", unit: ""},
                        {payload: features.skewness, topic: "skewness", feature: "skewness", unit: ""},
                        {payload: features, topic: "all-features", feature: "all", timestamp: Date.now()}
                    ]);
                }
                
            } catch (err) {
                node.error("Error calculating features: " + err.message);
                node.status({fill:"red", shape:"ring", text:"Error"});
            }
        });
        
        node.on('close', function() {
            node.dataBuffer = [];
        });
        
        /**
         * Berechnet alle Vibrations-Features
         */
        function calculateVibrationFeatures(data) {
            var n = data.length;
            
            // 1. RMS (Root Mean Square)
            var sumSquares = data.reduce((sum, val) => sum + val * val, 0);
            var rms = Math.sqrt(sumSquares / n);
            
            // 2. Peak-to-Peak
            var max = Math.max(...data);
            var min = Math.min(...data);
            var peakToPeak = max - min;
            
            // 3. Peak (Maximum Absolutwert)
            var peak = Math.max(Math.abs(max), Math.abs(min));
            
            // 4. Crest Factor (Peak / RMS)
            var crestFactor = rms !== 0 ? peak / rms : 0;
            
            // 5. Mean (Mittelwert)
            var mean = data.reduce((sum, val) => sum + val, 0) / n;
            
            // 6. Standardabweichung
            var variance = data.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / n;
            var stdDev = Math.sqrt(variance);
            
            // 7. Kurtosis (Spitzigkeit) - Excess Kurtosis (Normal = 0)
            var m4 = data.reduce((sum, val) => sum + Math.pow(val - mean, 4), 0) / n;
            var kurtosis = stdDev !== 0 ? (m4 / Math.pow(stdDev, 4)) - 3 : 0;
            
            // 8. Skewness (Schiefe)
            var m3 = data.reduce((sum, val) => sum + Math.pow(val - mean, 3), 0) / n;
            var skewness = stdDev !== 0 ? m3 / Math.pow(stdDev, 3) : 0;
            
            // 9. Form Factor (RMS / Mean of Absolute)
            var meanAbs = data.reduce((sum, val) => sum + Math.abs(val), 0) / n;
            var formFactor = meanAbs !== 0 ? rms / meanAbs : 0;
            
            // 10. Impulse Factor (Peak / Mean of Absolute)
            var impulseFactor = meanAbs !== 0 ? peak / meanAbs : 0;
            
            // 11. Clearance Factor (Peak / (Mean of Square Root)^2)
            var meanSqrt = Math.pow(data.reduce((sum, val) => sum + Math.sqrt(Math.abs(val)), 0) / n, 2);
            var clearanceFactor = meanSqrt !== 0 ? peak / meanSqrt : 0;
            
            // Health Indicator (simplified)
            // High values in Crest Factor, Kurtosis indicate damage
            var healthScore = 100;
            if (crestFactor > 5) healthScore -= 20;
            if (Math.abs(kurtosis) > 3) healthScore -= 20;
            if (Math.abs(skewness) > 1) healthScore -= 10;
            healthScore = Math.max(0, Math.min(100, healthScore));
            
            return {
                // Main features
                rms: rms,
                peakToPeak: peakToPeak,
                peak: peak,
                crestFactor: crestFactor,
                kurtosis: kurtosis,
                skewness: skewness,
                
                // Additional features
                mean: mean,
                stdDev: stdDev,
                formFactor: formFactor,
                impulseFactor: impulseFactor,
                clearanceFactor: clearanceFactor,
                
                // Interpretation
                healthScore: healthScore,
                
                // Interpretation Hints
                interpretation: {
                    crestFactor: interpretCrestFactor(crestFactor),
                    kurtosis: interpretKurtosis(kurtosis),
                    skewness: interpretSkewness(skewness)
                }
            };
        }
        
        function interpretCrestFactor(cf) {
            if (cf < 2) return "very-smooth";
            if (cf < 4) return "normal";
            if (cf < 6) return "slight-impulsive";
            if (cf < 10) return "impulsive";
            return "severe-impulsive";
        }
        
        function interpretKurtosis(k) {
            if (k < -1) return "flat-distribution";
            if (k < 1) return "normal";
            if (k < 3) return "peaked";
            if (k < 5) return "very-peaked";
            return "extreme-peaks";
        }
        
        function interpretSkewness(s) {
            if (Math.abs(s) < 0.5) return "symmetric";
            if (s > 0.5) return "right-skewed";
            return "left-skewed";
        }
    }
    
    RED.nodes.registerType("vibration-features", VibrationFeaturesNode);
}

