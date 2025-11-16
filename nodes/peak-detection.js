module.exports = function(RED) {
    function PeakDetectionNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        // Configuration
        const minPeakHeight = parseFloat(config.minPeakHeight) || null;
        const minPeakDistance = parseInt(config.minPeakDistance) || 5;
        const peakType = config.peakType || "both"; // "positive", "negative", "both"
        const windowSize = parseInt(config.windowSize) || 20;
        
        // Buffer for peak detection
        let buffer = [];
        let timestamps = [];
        let sampleCount = 0;
        
        node.on('input', function(msg) {
            const value = parseFloat(msg.payload);
            const timestamp = msg.timestamp || Date.now();
            
            if (isNaN(value)) {
                node.warn("Invalid payload: not a number");
                return;
            }
            
            sampleCount++;
            
            // Add to buffer
            buffer.push(value);
            timestamps.push(timestamp);
            
            // Maintain window size
            if (buffer.length > windowSize) {
                buffer.shift();
                timestamps.shift();
            }
            
            // Need enough samples for peak detection
            if (buffer.length < 3) {
                return;
            }
            
            // Detect peaks
            const peaks = detectPeaks(buffer, timestamps);
            
            // Calculate statistics
            const stats = calculatePeakStatistics(peaks, buffer);
            
            // Check if current value is a peak
            const currentIndex = buffer.length - 1;
            const isPeak = peaks.some(p => p.index === currentIndex);
            
            // Prepare output
            const outputMsg = {
                payload: value,
                isPeak: isPeak,
                peaks: peaks,
                peakCount: peaks.length,
                stats: stats,
                sampleCount: sampleCount,
                timestamp: timestamp
            };
            
            // Copy original message properties
            Object.keys(msg).forEach(key => {
                if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                    outputMsg[key] = msg[key];
                }
            });
            
            // Set status
            const color = isPeak ? "yellow" : "green";
            node.status({
                fill: color, 
                shape: isPeak ? "ring" : "dot", 
                text: `Peaks: ${peaks.length} | Current: ${value.toFixed(2)}`
            });
            
            // Send to appropriate output
            if (isPeak) {
                node.send([null, outputMsg]); // Output 2: Peak detected
            } else {
                node.send([outputMsg, null]); // Output 1: Normal
            }
        });
        
        function detectPeaks(data, times) {
            const peaks = [];
            
            // Calculate threshold if not provided
            let threshold = minPeakHeight;
            if (threshold === null) {
                // Use mean + 2*std as threshold
                const mean = data.reduce((a, b) => a + b, 0) / data.length;
                const variance = data.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / data.length;
                const std = Math.sqrt(variance);
                threshold = mean + 2 * std;
            }
            
            let lastPeakIndex = -minPeakDistance;
            
            for (let i = 1; i < data.length - 1; i++) {
                const current = data[i];
                const prev = data[i - 1];
                const next = data[i + 1];
                
                let isPeak = false;
                let peakDirection = null;
                
                // Check for positive peak (local maximum)
                if ((peakType === "positive" || peakType === "both") &&
                    current > prev && current > next) {
                    if (minPeakHeight === null || current >= threshold) {
                        isPeak = true;
                        peakDirection = "positive";
                    }
                }
                
                // Check for negative peak (local minimum)
                if ((peakType === "negative" || peakType === "both") &&
                    current < prev && current < next) {
                    if (minPeakHeight === null || current <= -threshold) {
                        isPeak = true;
                        peakDirection = "negative";
                    }
                }
                
                // Check minimum distance constraint
                if (isPeak && (i - lastPeakIndex >= minPeakDistance)) {
                    peaks.push({
                        index: i,
                        value: current,
                        timestamp: times[i],
                        direction: peakDirection
                    });
                    lastPeakIndex = i;
                }
            }
            
            return peaks;
        }
        
        function calculatePeakStatistics(peaks, data) {
            if (peaks.length === 0) {
                return {
                    averagePeakHeight: null,
                    maxPeakHeight: null,
                    minPeakHeight: null,
                    peakFrequency: 0
                };
            }
            
            const peakValues = peaks.map(p => Math.abs(p.value));
            const averagePeakHeight = peakValues.reduce((a, b) => a + b, 0) / peakValues.length;
            const maxPeakHeight = Math.max(...peakValues);
            const minPeakHeight = Math.min(...peakValues);
            
            // Calculate peak frequency (peaks per sample)
            const peakFrequency = peaks.length / data.length;
            
            // Calculate time between peaks if we have timestamps
            let averageTimeBetweenPeaks = null;
            if (peaks.length >= 2) {
                const timeDiffs = [];
                for (let i = 1; i < peaks.length; i++) {
                    timeDiffs.push(peaks[i].timestamp - peaks[i-1].timestamp);
                }
                averageTimeBetweenPeaks = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;
            }
            
            return {
                averagePeakHeight: averagePeakHeight,
                maxPeakHeight: maxPeakHeight,
                minPeakHeight: minPeakHeight,
                peakFrequency: peakFrequency,
                averageTimeBetweenPeaks: averageTimeBetweenPeaks
            };
        }
    }
    
    RED.nodes.registerType("peak-detection", PeakDetectionNode);
};

