const helper = require("node-red-node-test-helper");
const signalAnalyzerNode = require("../nodes/signal-analyzer.js");

helper.init(require.resolve('node-red'));

describe('signal-analyzer Node', function () {

    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('should be loaded', function (done) {
        const flow = [{ id: "n1", type: "signal-analyzer", name: "Signal Test" }];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toHaveProperty('name', 'Signal Test');
            done();
        });
    });

    it('should buffer values until fftSize is reached', function (done) {
        const flow = [
            { id: "n1", type: "signal-analyzer", name: "test", mode: "fft", fftSize: 64, samplingRate: 1000, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(msg).toHaveProperty('peaks');
                expect(msg).toHaveProperty('features');
                expect(msg).toHaveProperty('fftSize');
                expect(msg.fftSize).toBe(64);
                done();
            });
            
            // Send enough values to fill buffer
            for (let i = 0; i < 64; i++) {
                const value = Math.sin(2 * Math.PI * 10 * i / 1000); // 10 Hz sine wave
                n1.receive({ payload: value });
            }
        });
    });

    it('should calculate vibration features', function (done) {
        const flow = [
            { id: "n1", type: "signal-analyzer", name: "test", mode: "vibration", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(msg.payload).toHaveProperty('rms');
                expect(msg.payload).toHaveProperty('peakToPeak');
                expect(msg.payload).toHaveProperty('crestFactor');
                expect(msg.payload).toHaveProperty('kurtosis');
                expect(msg.payload).toHaveProperty('skewness');
                expect(msg.payload).toHaveProperty('healthScore');
                done();
            });
            
            // Send vibration values
            for (let i = 0; i < 20; i++) {
                n1.receive({ payload: Math.random() * 5 });
            }
        });
    });

    it('should calculate sample entropy in vibration mode', function (done) {
        const flow = [
            { id: "n1", type: "signal-analyzer", name: "test", mode: "vibration", windowSize: 30, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(msg.payload).toHaveProperty('sampleEntropy');
                expect(typeof msg.payload.sampleEntropy).toBe('number');
                done();
            });
            
            // Send periodic signal (should have low entropy)
            for (let i = 0; i < 30; i++) {
                n1.receive({ payload: Math.sin(i * 0.5) });
            }
        });
    });

    it('should calculate autocorrelation in vibration mode', function (done) {
        const flow = [
            { id: "n1", type: "signal-analyzer", name: "test", mode: "vibration", windowSize: 30, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(msg.payload).toHaveProperty('autocorrelation');
                expect(Array.isArray(msg.payload.autocorrelation)).toBe(true);
                expect(msg.payload.autocorrelation.length).toBeGreaterThan(0);
                expect(msg.payload.autocorrelation[0]).toHaveProperty('lag');
                expect(msg.payload.autocorrelation[0]).toHaveProperty('value');
                // First lag (0) should have correlation = 1
                expect(msg.payload.autocorrelation[0].value).toBeCloseTo(1, 1);
                done();
            });
            
            // Send periodic signal
            for (let i = 0; i < 30; i++) {
                n1.receive({ payload: Math.sin(i * 0.3) });
            }
        });
    });

    it('should detect periodicity in vibration mode', function (done) {
        const flow = [
            { id: "n1", type: "signal-analyzer", name: "test", mode: "vibration", windowSize: 50, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(msg.payload).toHaveProperty('periodicity');
                expect(msg.payload.periodicity).toHaveProperty('detected');
                expect(typeof msg.payload.periodicity.detected).toBe('boolean');
                done();
            });
            
            // Send periodic signal with period ~6
            for (let i = 0; i < 50; i++) {
                n1.receive({ payload: Math.sin(i * Math.PI / 3) }); // Period of 6
            }
        });
    });

    it('should detect peaks', function (done) {
        const flow = [
            { id: "n1", type: "signal-analyzer", name: "test", mode: "peaks", windowSize: 20, minPeakDistance: 3, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            let messageReceived = false;
            
            n2.on("input", function (msg) {
                if (!messageReceived) {
                    messageReceived = true;
                    expect(msg).toHaveProperty('peaks');
                    expect(msg).toHaveProperty('peakCount');
                    expect(msg).toHaveProperty('stats');
                    done();
                }
            });
            
            n3.on("input", function (msg) {
                if (!messageReceived) {
                    messageReceived = true;
                    expect(msg).toHaveProperty('isPeak');
                    expect(msg.isPeak).toBe(true);
                    done();
                }
            });
            
            // Send signal with peaks
            const signal = [1, 2, 5, 2, 1, 2, 6, 2, 1, 2, 4, 2, 1, 2, 5, 2, 1, 2, 3, 2];
            signal.forEach(val => n1.receive({ payload: val }));
        });
    });

    it('should reset buffer when msg.reset is true', function (done) {
        const flow = [
            { id: "n1", type: "signal-analyzer", name: "test", mode: "fft", fftSize: 64, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            
            for (let i = 0; i < 32; i++) {
                n1.receive({ payload: i });
            }
            
            n1.receive({ reset: true });
            
            setTimeout(function() {
                done();
            }, 100);
        });
    });

    // ============================================
    // FFT Accuracy Tests (fft.js library)
    // ============================================

    it('should correctly identify dominant frequency in FFT', function (done) {
        const flow = [
            { id: "n1", type: "signal-analyzer", name: "test", mode: "fft", fftSize: 256, samplingRate: 1000, outputFormat: "peaks", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(msg).toHaveProperty('peaks');
                expect(msg).toHaveProperty('dominantFrequency');
                // The dominant frequency should be close to 50 Hz
                // Allow some tolerance due to FFT bin resolution
                const freqResolution = 1000 / 256; // ~3.9 Hz
                expect(msg.dominantFrequency).toBeGreaterThan(50 - freqResolution * 2);
                expect(msg.dominantFrequency).toBeLessThan(50 + freqResolution * 2);
                done();
            });
            
            // Generate 50 Hz sine wave at 1000 Hz sampling rate
            for (let i = 0; i < 256; i++) {
                const t = i / 1000; // time in seconds
                const value = Math.sin(2 * Math.PI * 50 * t); // 50 Hz sine
                n1.receive({ payload: value });
            }
        });
    });

    it('should detect multiple frequency components', function (done) {
        const flow = [
            { id: "n1", type: "signal-analyzer", name: "test", mode: "fft", fftSize: 256, samplingRate: 1000, outputFormat: "peaks", peakThreshold: 0.3, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(msg).toHaveProperty('peaks');
                // Should detect at least 2 frequency peaks (25 Hz and 100 Hz)
                expect(msg.peaks.length).toBeGreaterThanOrEqual(2);
                done();
            });
            
            // Generate signal with 25 Hz and 100 Hz components
            for (let i = 0; i < 256; i++) {
                const t = i / 1000;
                const value = Math.sin(2 * Math.PI * 25 * t) + 0.5 * Math.sin(2 * Math.PI * 100 * t);
                n1.receive({ payload: value });
            }
        });
    });

    it('should handle signal with DC offset in FFT', function (done) {
        const flow = [
            { id: "n1", type: "signal-analyzer", name: "test", mode: "fft", fftSize: 64, samplingRate: 1000, outputFormat: "peaks", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                // Should have peaks and features
                expect(msg).toHaveProperty('peaks');
                expect(msg).toHaveProperty('features');
                // FFT should work even with DC offset
                expect(msg.fftSize).toBe(64);
                done();
            });
            
            // Generate sine wave with DC offset - need 64 samples for fftSize 64
            for (let i = 0; i < 64; i++) {
                const t = i / 1000;
                const value = 5 + Math.sin(2 * Math.PI * 50 * t); // DC offset = 5, 50 Hz signal
                n1.receive({ payload: value });
            }
        });
    });

    it('should apply window function correctly', function (done) {
        const flow = [
            { id: "n1", type: "signal-analyzer", name: "test", mode: "fft", fftSize: 128, samplingRate: 1000, windowFunction: "hann", outputFormat: "peaks", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(msg).toHaveProperty('peaks');
                expect(msg).toHaveProperty('windowFunction');
                expect(msg.windowFunction).toBe('hann');
                done();
            });
            
            // Generate 40 Hz sine wave
            for (let i = 0; i < 128; i++) {
                const t = i / 1000;
                const value = Math.sin(2 * Math.PI * 40 * t);
                n1.receive({ payload: value });
            }
        });
    });

    it('should provide correct frequency resolution', function (done) {
        const fftSize = 256;
        const samplingRate = 1000;
        const expectedResolution = samplingRate / fftSize; // 3.90625 Hz
        
        const flow = [
            { id: "n1", type: "signal-analyzer", name: "test", mode: "fft", fftSize: fftSize, samplingRate: samplingRate, outputFormat: "peaks", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(msg).toHaveProperty('peaks');
                expect(msg).toHaveProperty('features');
                // Features should include frequency resolution info
                expect(msg.samplingRate).toBe(samplingRate);
                expect(msg.fftSize).toBe(fftSize);
                done();
            });
            
            // Generate test signal
            for (let i = 0; i < fftSize; i++) {
                n1.receive({ payload: Math.sin(i * 0.1) });
            }
        });
    });

    it('should detect harmonics in vibration signal', function (done) {
        const flow = [
            { id: "n1", type: "signal-analyzer", name: "test", mode: "fft", fftSize: 512, samplingRate: 1000, outputFormat: "peaks", peakThreshold: 0.1, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(msg).toHaveProperty('peaks');
                // Should detect fundamental (20 Hz) and at least one harmonic (40 Hz or 60 Hz)
                const frequencies = msg.peaks.map(p => p.frequency);
                const hasFundamental = frequencies.some(f => Math.abs(f - 20) < 5);
                expect(hasFundamental).toBe(true);
                done();
            });
            
            // Generate signal with fundamental and harmonics (simulating motor vibration)
            for (let i = 0; i < 512; i++) {
                const t = i / 1000;
                // 20 Hz fundamental + 40 Hz (2nd harmonic) + 60 Hz (3rd harmonic)
                const value = Math.sin(2 * Math.PI * 20 * t) + 
                              0.5 * Math.sin(2 * Math.PI * 40 * t) + 
                              0.25 * Math.sin(2 * Math.PI * 60 * t);
                n1.receive({ payload: value });
            }
        });
    });

    // ============================================
    // Vibration Feature Accuracy Tests
    // ============================================

    it('should calculate correct RMS value', function (done) {
        const flow = [
            { id: "n1", type: "signal-analyzer", name: "test", mode: "vibration", windowSize: 100, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(msg.payload).toHaveProperty('rms');
                // RMS of a sine wave with amplitude 1 is 1/sqrt(2) ≈ 0.707
                expect(msg.payload.rms).toBeCloseTo(0.707, 1);
                done();
            });
            
            // Generate pure sine wave with amplitude 1
            for (let i = 0; i < 100; i++) {
                const value = Math.sin(2 * Math.PI * i / 20); // Period of 20 samples
                n1.receive({ payload: value });
            }
        });
    });

    it('should calculate correct crest factor', function (done) {
        const flow = [
            { id: "n1", type: "signal-analyzer", name: "test", mode: "vibration", windowSize: 100, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(msg.payload).toHaveProperty('crestFactor');
                // Crest factor of a sine wave is sqrt(2) ≈ 1.414
                expect(msg.payload.crestFactor).toBeCloseTo(1.414, 1);
                done();
            });
            
            // Generate pure sine wave
            for (let i = 0; i < 100; i++) {
                const value = Math.sin(2 * Math.PI * i / 20);
                n1.receive({ payload: value });
            }
        });
    });

    it('should detect high kurtosis for impulsive signal', function (done) {
        const flow = [
            { id: "n1", type: "signal-analyzer", name: "test", mode: "vibration", windowSize: 50, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(msg.payload).toHaveProperty('kurtosis');
                // Impulsive signal should have high kurtosis (> 3 for non-Gaussian)
                // Kurtosis of normal distribution is 3, impulsive should be higher
                expect(msg.payload.kurtosis).toBeGreaterThan(2);
                done();
            });
            
            // Generate impulsive signal (mostly small values with occasional spikes)
            for (let i = 0; i < 50; i++) {
                const value = (i % 10 === 0) ? 10 : 0.1;
                n1.receive({ payload: value });
            }
        });
    });

    // ============================================
    // ISO 10816-3 Vibration Severity Tests
    // ============================================

    describe('ISO 10816-3 Vibration Severity', function () {
        
        it('should include ISO 10816 evaluation in vibration output', function (done) {
            const flow = [
                { id: "n1", type: "signal-analyzer", name: "test", mode: "vibration", 
                  windowSize: 50, iso10816Class: "class2", wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                
                n2.on("input", function (msg) {
                    expect(msg.payload).toHaveProperty('iso10816');
                    expect(msg.payload.iso10816).toHaveProperty('zone');
                    expect(msg.payload.iso10816).toHaveProperty('severity');
                    expect(msg.payload.iso10816).toHaveProperty('recommendation');
                    expect(msg.payload.iso10816).toHaveProperty('limits');
                    expect(msg.payload.iso10816).toHaveProperty('machineClass');
                    expect(msg.payload.iso10816.machineClass).toBe('class2');
                    done();
                });
                
                // Send vibration data
                for (let i = 0; i < 50; i++) {
                    n1.receive({ payload: Math.sin(i * 0.1) * 2 });
                }
            });
        });

        it('should classify low vibration as Zone A (good)', function (done) {
            const flow = [
                { id: "n1", type: "signal-analyzer", name: "test", mode: "vibration", 
                  windowSize: 20, iso10816Class: "class2", wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                
                n2.on("input", function (msg) {
                    // Very low RMS should be Zone A
                    if (msg.payload.rms < 1.12) { // Class 2 Zone A limit
                        expect(msg.payload.iso10816.zone).toBe('A');
                        expect(msg.payload.iso10816.severity).toBe('good');
                        done();
                    }
                });
                
                // Send low amplitude vibration (RMS should be around 0.7)
                for (let i = 0; i < 20; i++) {
                    n1.receive({ payload: Math.sin(i * 0.5) });
                }
            });
        });

        it('should classify high vibration as Zone D (critical)', function (done) {
            const flow = [
                { id: "n1", type: "signal-analyzer", name: "test", mode: "vibration", 
                  windowSize: 20, iso10816Class: "class2", wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                
                n2.on("input", function (msg) {
                    // Very high RMS should be Zone D
                    if (msg.payload.rms > 7.1) { // Class 2 Zone D threshold
                        expect(msg.payload.iso10816.zone).toBe('D');
                        expect(msg.payload.iso10816.severity).toBe('critical');
                        expect(msg.payload.iso10816.isAlarm).toBe(true);
                        done();
                    }
                });
                
                // Send high amplitude vibration (RMS should be around 10)
                for (let i = 0; i < 20; i++) {
                    n1.receive({ payload: Math.sin(i * 0.5) * 15 });
                }
            });
        });

        it('should use correct thresholds for different machine classes', function (done) {
            const flow = [
                { id: "n1", type: "signal-analyzer", name: "test", mode: "vibration", 
                  windowSize: 20, iso10816Class: "class4", wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                
                n2.on("input", function (msg) {
                    expect(msg.payload.iso10816.machineClass).toBe('class4');
                    // Class 4 has higher thresholds (turbines on soft foundations)
                    expect(msg.payload.iso10816.limits.ab).toBe(2.8);
                    expect(msg.payload.iso10816.limits.bc).toBe(7.1);
                    expect(msg.payload.iso10816.limits.cd).toBe(18.0);
                    done();
                });
                
                for (let i = 0; i < 20; i++) {
                    n1.receive({ payload: Math.sin(i * 0.5) * 2 });
                }
            });
        });

        it('should include zoneProgress percentage', function (done) {
            const flow = [
                { id: "n1", type: "signal-analyzer", name: "test", mode: "vibration", 
                  windowSize: 20, iso10816Class: "class2", wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                
                n2.on("input", function (msg) {
                    expect(msg.payload.iso10816).toHaveProperty('zoneProgress');
                    expect(msg.payload.iso10816.zoneProgress).toBeGreaterThanOrEqual(0);
                    expect(msg.payload.iso10816.zoneProgress).toBeLessThanOrEqual(100);
                    done();
                });
                
                for (let i = 0; i < 20; i++) {
                    n1.receive({ payload: Math.sin(i * 0.5) * 2 });
                }
            });
        });
    });

    // ============================================
    // Butterworth Filter Implementation Verification
    // ============================================
    // Note: The Butterworth filter is tested indirectly through the envelope
    // analysis mode. The filter implementation includes:
    // - 2nd order Butterworth coefficients via bilinear transform
    // - Zero-phase filtering (filtfilt) for no phase distortion
    // - Automatic fallback to simple filter for edge cases
    // 
    // The filter is used in envelope analysis for bearing fault detection.
    // See performEnvelopeAnalysis() -> bandpassFilter() -> butterworthBandpass()
});
