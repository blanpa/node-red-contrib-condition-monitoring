module.exports = function(RED) {
    function FFTAnalysisNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        // Configuration
        const fftSize = parseInt(config.fftSize) || 256;
        const samplingRate = parseFloat(config.samplingRate) || 1000;
        const peakThreshold = parseFloat(config.peakThreshold) || 0.1;
        const outputFormat = config.outputFormat || "peaks";
        
        // Data buffer
        let buffer = [];
        
        node.on('input', function(msg) {
            const value = parseFloat(msg.payload);
            
            if (isNaN(value)) {
                node.warn("Invalid payload: not a number");
                return;
            }
            
            // Add to buffer
            buffer.push(value);
            
            // Wait until we have enough samples
            if (buffer.length < fftSize) {
                node.status({fill: "yellow", shape: "ring", text: `Buffering: ${buffer.length}/${fftSize}`});
                return;
            }
            
            // Maintain buffer size (sliding window)
            if (buffer.length > fftSize) {
                buffer.shift();
            }
            
            // Perform FFT
            const fftResult = performFFT(buffer);
            const frequencies = fftResult.frequencies;
            const magnitudes = fftResult.magnitudes;
            
            // Find peaks
            const peaks = findPeaks(frequencies, magnitudes, peakThreshold);
            
            // Calculate spectral features
            const features = calculateSpectralFeatures(frequencies, magnitudes, samplingRate);
            
            // Prepare output based on format
            let outputMsg = {
                payload: value,
                peaks: peaks,
                dominantFrequency: peaks.length > 0 ? peaks[0].frequency : null,
                features: features,
                samplingRate: samplingRate,
                fftSize: fftSize
            };
            
            if (outputFormat === "full") {
                outputMsg.frequencies = frequencies;
                outputMsg.magnitudes = magnitudes;
            }
            
            // Copy original message properties
            Object.keys(msg).forEach(key => {
                if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                    outputMsg[key] = msg[key];
                }
            });
            
            // Set status
            if (peaks.length > 0) {
                node.status({
                    fill: "green", 
                    shape: "dot", 
                    text: `Peak: ${peaks[0].frequency.toFixed(1)} Hz`
                });
            } else {
                node.status({fill: "green", shape: "dot", text: "No peaks"});
            }
            
            node.send(outputMsg);
        });
        
        // Simple FFT implementation using Cooley-Tukey algorithm
        function performFFT(signal) {
            const n = fftSize;
            
            // Pad signal if needed and apply Hanning window
            const paddedSignal = new Array(n);
            for (let i = 0; i < n; i++) {
                if (i < signal.length) {
                    // Apply Hanning window
                    const window = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
                    paddedSignal[i] = signal[i] * window;
                } else {
                    paddedSignal[i] = 0;
                }
            }
            
            // Perform DFT (simplified for real signals)
            const real = new Array(n / 2);
            const imag = new Array(n / 2);
            
            for (let k = 0; k < n / 2; k++) {
                let sumReal = 0;
                let sumImag = 0;
                
                for (let t = 0; t < n; t++) {
                    const angle = -2 * Math.PI * k * t / n;
                    sumReal += paddedSignal[t] * Math.cos(angle);
                    sumImag += paddedSignal[t] * Math.sin(angle);
                }
                
                real[k] = sumReal;
                imag[k] = sumImag;
            }
            
            // Calculate magnitudes and frequencies
            const magnitudes = new Array(n / 2);
            const frequencies = new Array(n / 2);
            
            for (let k = 0; k < n / 2; k++) {
                magnitudes[k] = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]) / n;
                frequencies[k] = k * samplingRate / n;
            }
            
            return { frequencies, magnitudes };
        }
        
        // Find peaks in spectrum
        function findPeaks(frequencies, magnitudes, threshold) {
            const peaks = [];
            const maxMagnitude = Math.max(...magnitudes);
            
            for (let i = 1; i < magnitudes.length - 1; i++) {
                // Check if it's a local maximum and above threshold
                if (magnitudes[i] > magnitudes[i-1] && 
                    magnitudes[i] > magnitudes[i+1] &&
                    magnitudes[i] / maxMagnitude > threshold) {
                    
                    peaks.push({
                        frequency: frequencies[i],
                        magnitude: magnitudes[i],
                        normalized: magnitudes[i] / maxMagnitude
                    });
                }
            }
            
            // Sort by magnitude (descending)
            peaks.sort((a, b) => b.magnitude - a.magnitude);
            
            return peaks;
        }
        
        // Calculate spectral features
        function calculateSpectralFeatures(frequencies, magnitudes, samplingRate) {
            const n = magnitudes.length;
            
            // Spectral Centroid (center of mass of spectrum)
            let numerator = 0;
            let denominator = 0;
            
            for (let i = 0; i < n; i++) {
                numerator += frequencies[i] * magnitudes[i];
                denominator += magnitudes[i];
            }
            
            const spectralCentroid = denominator > 0 ? numerator / denominator : 0;
            
            // Spectral Spread (variance around centroid)
            let variance = 0;
            for (let i = 0; i < n; i++) {
                variance += Math.pow(frequencies[i] - spectralCentroid, 2) * magnitudes[i];
            }
            const spectralSpread = denominator > 0 ? Math.sqrt(variance / denominator) : 0;
            
            // RMS (Root Mean Square)
            const rms = Math.sqrt(magnitudes.reduce((sum, m) => sum + m * m, 0) / n);
            
            // Peak-to-RMS ratio
            const peak = Math.max(...magnitudes);
            const crestFactor = rms > 0 ? peak / rms : 0;
            
            return {
                spectralCentroid: spectralCentroid,
                spectralSpread: spectralSpread,
                rms: rms,
                crestFactor: crestFactor,
                totalEnergy: magnitudes.reduce((sum, m) => sum + m * m, 0)
            };
        }
    }
    
    RED.nodes.registerType("fft-analysis", FFTAnalysisNode);
};

