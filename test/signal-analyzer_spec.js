const helper = require("node-red-node-test-helper");
const signalAnalyzerNode = require("../nodes/signal-analyzer.js");

helper.init(require.resolve("node-red"));

describe("signal-analyzer Node", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("should be loaded", function (done) {
        const flow = [{ id: "n1", type: "signal-analyzer", name: "Signal Test" }];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toHaveProperty("name", "Signal Test");
            done();
        });
    });

    it("should buffer values until fftSize is reached", function (done) {
        const flow = [
            {
                id: "n1",
                type: "signal-analyzer",
                name: "test",
                mode: "fft",
                fftSize: 64,
                samplingRate: 1000,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                expect(msg).toHaveProperty("peaks");
                expect(msg).toHaveProperty("features");
                expect(msg).toHaveProperty("fftSize");
                expect(msg.fftSize).toBe(64);
                done();
            });

            // Send enough values to fill buffer
            for (let i = 0; i < 64; i++) {
                const value = Math.sin((2 * Math.PI * 10 * i) / 1000); // 10 Hz sine wave
                n1.receive({ payload: value });
            }
        });
    });

    it("should calculate vibration features", function (done) {
        const flow = [
            {
                id: "n1",
                type: "signal-analyzer",
                name: "test",
                mode: "vibration",
                windowSize: 20,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                expect(msg.payload).toHaveProperty("rms");
                expect(msg.payload).toHaveProperty("peakToPeak");
                expect(msg.payload).toHaveProperty("crestFactor");
                expect(msg.payload).toHaveProperty("kurtosis");
                expect(msg.payload).toHaveProperty("skewness");
                expect(msg.payload).toHaveProperty("healthScore");
                done();
            });

            // Send vibration values
            for (let i = 0; i < 20; i++) {
                n1.receive({ payload: Math.random() * 5 });
            }
        });
    });

    it("should calculate sample entropy in vibration mode", function (done) {
        const flow = [
            {
                id: "n1",
                type: "signal-analyzer",
                name: "test",
                mode: "vibration",
                windowSize: 30,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                expect(msg.payload).toHaveProperty("sampleEntropy");
                expect(typeof msg.payload.sampleEntropy).toBe("number");
                done();
            });

            // Send periodic signal (should have low entropy)
            for (let i = 0; i < 30; i++) {
                n1.receive({ payload: Math.sin(i * 0.5) });
            }
        });
    });

    it("should calculate autocorrelation in vibration mode", function (done) {
        const flow = [
            {
                id: "n1",
                type: "signal-analyzer",
                name: "test",
                mode: "vibration",
                windowSize: 30,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                expect(msg.payload).toHaveProperty("autocorrelation");
                expect(Array.isArray(msg.payload.autocorrelation)).toBe(true);
                expect(msg.payload.autocorrelation.length).toBeGreaterThan(0);
                expect(msg.payload.autocorrelation[0]).toHaveProperty("lag");
                expect(msg.payload.autocorrelation[0]).toHaveProperty("value");
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

    it("should detect periodicity in vibration mode", function (done) {
        const flow = [
            {
                id: "n1",
                type: "signal-analyzer",
                name: "test",
                mode: "vibration",
                windowSize: 50,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                expect(msg.payload).toHaveProperty("periodicity");
                expect(msg.payload.periodicity).toHaveProperty("detected");
                expect(typeof msg.payload.periodicity.detected).toBe("boolean");
                done();
            });

            // Send periodic signal with period ~6
            for (let i = 0; i < 50; i++) {
                n1.receive({ payload: Math.sin((i * Math.PI) / 3) }); // Period of 6
            }
        });
    });

    it("should detect peaks", function (done) {
        const flow = [
            {
                id: "n1",
                type: "signal-analyzer",
                name: "test",
                mode: "peaks",
                windowSize: 20,
                minPeakDistance: 3,
                wires: [["n2"], ["n3"]]
            },
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
                    expect(msg).toHaveProperty("peaks");
                    expect(msg).toHaveProperty("peakCount");
                    expect(msg).toHaveProperty("stats");
                    done();
                }
            });

            n3.on("input", function (msg) {
                if (!messageReceived) {
                    messageReceived = true;
                    expect(msg).toHaveProperty("isPeak");
                    expect(msg.isPeak).toBe(true);
                    done();
                }
            });

            // Send signal with peaks
            const signal = [1, 2, 5, 2, 1, 2, 6, 2, 1, 2, 4, 2, 1, 2, 5, 2, 1, 2, 3, 2];
            signal.forEach((val) => n1.receive({ payload: val }));
        });
    });

    it("should reset buffer when msg.reset is true", function (done) {
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

            setTimeout(function () {
                done();
            }, 100);
        });
    });

    // ============================================
    // FFT Accuracy Tests (fft.js library)
    // ============================================

    it("should correctly identify dominant frequency in FFT", function (done) {
        const flow = [
            {
                id: "n1",
                type: "signal-analyzer",
                name: "test",
                mode: "fft",
                fftSize: 256,
                samplingRate: 1000,
                outputFormat: "peaks",
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                expect(msg).toHaveProperty("peaks");
                expect(msg).toHaveProperty("dominantFrequency");
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

    it("should detect multiple frequency components", function (done) {
        const flow = [
            {
                id: "n1",
                type: "signal-analyzer",
                name: "test",
                mode: "fft",
                fftSize: 256,
                samplingRate: 1000,
                outputFormat: "peaks",
                peakThreshold: 0.3,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                expect(msg).toHaveProperty("peaks");
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

    it("should handle signal with DC offset in FFT", function (done) {
        const flow = [
            {
                id: "n1",
                type: "signal-analyzer",
                name: "test",
                mode: "fft",
                fftSize: 64,
                samplingRate: 1000,
                outputFormat: "peaks",
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                // Should have peaks and features
                expect(msg).toHaveProperty("peaks");
                expect(msg).toHaveProperty("features");
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

    it("should apply window function correctly", function (done) {
        const flow = [
            {
                id: "n1",
                type: "signal-analyzer",
                name: "test",
                mode: "fft",
                fftSize: 128,
                samplingRate: 1000,
                windowFunction: "hann",
                outputFormat: "peaks",
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                expect(msg).toHaveProperty("peaks");
                expect(msg).toHaveProperty("windowFunction");
                expect(msg.windowFunction).toBe("hann");
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

    it("should provide correct frequency resolution", function (done) {
        const fftSize = 256;
        const samplingRate = 1000;
        const _expectedResolution = samplingRate / fftSize; // 3.90625 Hz

        const flow = [
            {
                id: "n1",
                type: "signal-analyzer",
                name: "test",
                mode: "fft",
                fftSize: fftSize,
                samplingRate: samplingRate,
                outputFormat: "peaks",
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                expect(msg).toHaveProperty("peaks");
                expect(msg).toHaveProperty("features");
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

    it("should detect harmonics in vibration signal", function (done) {
        const flow = [
            {
                id: "n1",
                type: "signal-analyzer",
                name: "test",
                mode: "fft",
                fftSize: 512,
                samplingRate: 1000,
                outputFormat: "peaks",
                peakThreshold: 0.1,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                expect(msg).toHaveProperty("peaks");
                // Should detect fundamental (20 Hz) and at least one harmonic (40 Hz or 60 Hz)
                const frequencies = msg.peaks.map((p) => p.frequency);
                const hasFundamental = frequencies.some((f) => Math.abs(f - 20) < 5);
                expect(hasFundamental).toBe(true);
                done();
            });

            // Generate signal with fundamental and harmonics (simulating motor vibration)
            for (let i = 0; i < 512; i++) {
                const t = i / 1000;
                // 20 Hz fundamental + 40 Hz (2nd harmonic) + 60 Hz (3rd harmonic)
                const value =
                    Math.sin(2 * Math.PI * 20 * t) +
                    0.5 * Math.sin(2 * Math.PI * 40 * t) +
                    0.25 * Math.sin(2 * Math.PI * 60 * t);
                n1.receive({ payload: value });
            }
        });
    });

    // ============================================
    // Vibration Feature Accuracy Tests
    // ============================================

    it("should calculate correct RMS value", function (done) {
        const flow = [
            {
                id: "n1",
                type: "signal-analyzer",
                name: "test",
                mode: "vibration",
                windowSize: 100,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                expect(msg.payload).toHaveProperty("rms");
                // RMS of a sine wave with amplitude 1 is 1/sqrt(2) ≈ 0.707
                expect(msg.payload.rms).toBeCloseTo(0.707, 1);
                done();
            });

            // Generate pure sine wave with amplitude 1
            for (let i = 0; i < 100; i++) {
                const value = Math.sin((2 * Math.PI * i) / 20); // Period of 20 samples
                n1.receive({ payload: value });
            }
        });
    });

    it("should calculate correct crest factor", function (done) {
        const flow = [
            {
                id: "n1",
                type: "signal-analyzer",
                name: "test",
                mode: "vibration",
                windowSize: 100,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                expect(msg.payload).toHaveProperty("crestFactor");
                // Crest factor of a sine wave is sqrt(2) ≈ 1.414
                expect(msg.payload.crestFactor).toBeCloseTo(1.414, 1);
                done();
            });

            // Generate pure sine wave
            for (let i = 0; i < 100; i++) {
                const value = Math.sin((2 * Math.PI * i) / 20);
                n1.receive({ payload: value });
            }
        });
    });

    it("should detect high kurtosis for impulsive signal", function (done) {
        const flow = [
            {
                id: "n1",
                type: "signal-analyzer",
                name: "test",
                mode: "vibration",
                windowSize: 50,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                expect(msg.payload).toHaveProperty("kurtosis");
                // Impulsive signal should have high kurtosis (> 3 for non-Gaussian)
                // Kurtosis of normal distribution is 3, impulsive should be higher
                expect(msg.payload.kurtosis).toBeGreaterThan(2);
                done();
            });

            // Generate impulsive signal (mostly small values with occasional spikes)
            for (let i = 0; i < 50; i++) {
                const value = i % 10 === 0 ? 10 : 0.1;
                n1.receive({ payload: value });
            }
        });
    });

    // ============================================
    // ISO 10816-3 Vibration Severity Tests
    // ============================================

    describe("ISO 10816-3 Vibration Severity", function () {
        it("should include ISO 10816 evaluation in vibration output", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "signal-analyzer",
                    name: "test",
                    mode: "vibration",
                    windowSize: 50,
                    iso10816Class: "class2",
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");

                n2.on("input", function (msg) {
                    expect(msg.payload).toHaveProperty("iso10816");
                    expect(msg.payload.iso10816).toHaveProperty("zone");
                    expect(msg.payload.iso10816).toHaveProperty("severity");
                    expect(msg.payload.iso10816).toHaveProperty("recommendation");
                    expect(msg.payload.iso10816).toHaveProperty("limits");
                    expect(msg.payload.iso10816).toHaveProperty("machineClass");
                    expect(msg.payload.iso10816.machineClass).toBe("class2");
                    done();
                });

                // Send vibration data
                for (let i = 0; i < 50; i++) {
                    n1.receive({ payload: Math.sin(i * 0.1) * 2 });
                }
            });
        });

        it("should classify low vibration as Zone A (good)", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "signal-analyzer",
                    name: "test",
                    mode: "vibration",
                    windowSize: 20,
                    iso10816Class: "class2",
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");

                n2.on("input", function (msg) {
                    // Very low RMS should be Zone A
                    if (msg.payload.rms < 1.12) {
                        // Class 2 Zone A limit
                        expect(msg.payload.iso10816.zone).toBe("A");
                        expect(msg.payload.iso10816.severity).toBe("good");
                        done();
                    }
                });

                // Send low amplitude vibration (RMS should be around 0.7)
                for (let i = 0; i < 20; i++) {
                    n1.receive({ payload: Math.sin(i * 0.5) });
                }
            });
        });

        it("should classify high vibration as Zone D (critical)", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "signal-analyzer",
                    name: "test",
                    mode: "vibration",
                    windowSize: 20,
                    iso10816Class: "class2",
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");

                n2.on("input", function (msg) {
                    // Very high RMS should be Zone D
                    if (msg.payload.rms > 7.1) {
                        // Class 2 Zone D threshold
                        expect(msg.payload.iso10816.zone).toBe("D");
                        expect(msg.payload.iso10816.severity).toBe("critical");
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

        it("should use correct thresholds for different machine classes", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "signal-analyzer",
                    name: "test",
                    mode: "vibration",
                    windowSize: 20,
                    iso10816Class: "class4",
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");

                n2.on("input", function (msg) {
                    expect(msg.payload.iso10816.machineClass).toBe("class4");
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

        it("should include zoneProgress percentage", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "signal-analyzer",
                    name: "test",
                    mode: "vibration",
                    windowSize: 20,
                    iso10816Class: "class2",
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");

                n2.on("input", function (msg) {
                    expect(msg.payload.iso10816).toHaveProperty("zoneProgress");
                    expect(msg.payload.iso10816.zoneProgress).toBeGreaterThanOrEqual(0);
                    expect(msg.payload.iso10816.zoneProgress).toBeLessThanOrEqual(100);
                    done();
                });

                for (let i = 0; i < 20; i++) {
                    n1.receive({ payload: Math.sin(i * 0.5) * 2 });
                }
            });
        });

        it("should disable ISO 10816 for raw/dimensionless input", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "signal-analyzer",
                    name: "test",
                    mode: "vibration",
                    windowSize: 20,
                    vibInputUnit: "raw",
                    iso10816Class: "class2",
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");

                n2.on("input", function (msg) {
                    expect(msg.payload.iso10816.zone).toBe("N/A");
                    expect(msg.payload.iso10816.severity).toBe("unknown");
                    expect(msg.payload.iso10816.isValid).toBe(false);
                    done();
                });

                for (let i = 0; i < 20; i++) {
                    n1.receive({ payload: Math.sin(i * 0.5) * 2 });
                }
            });
        });

        it("should convert m/s to mm/s correctly", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "signal-analyzer",
                    name: "test",
                    mode: "vibration",
                    windowSize: 20,
                    vibInputUnit: "m_s",
                    iso10816Class: "class2",
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");

                n2.on("input", function (msg) {
                    // Input is in m/s, so RMS of 0.001 m/s = 1 mm/s -> Zone A for class2
                    expect(msg.payload.iso10816.isValid).toBe(true);
                    expect(msg.payload.iso10816.inputUnit).toBe("m_s");
                    // RMS velocity should be 1000x the input RMS
                    expect(msg.payload.iso10816.rmsVelocity).toBeCloseTo(msg.payload.rms * 1000, 1);
                    done();
                });

                // Send very small values (in m/s)
                for (let i = 0; i < 20; i++) {
                    n1.receive({ payload: Math.sin(i * 0.5) * 0.001 });
                }
            });
        });

        it("should include inputUnit and isValid in ISO output", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "signal-analyzer",
                    name: "test",
                    mode: "vibration",
                    windowSize: 20,
                    vibInputUnit: "mm_s",
                    iso10816Class: "class2",
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");

                n2.on("input", function (msg) {
                    expect(msg.payload.iso10816).toHaveProperty("inputUnit");
                    expect(msg.payload.iso10816).toHaveProperty("isValid");
                    expect(msg.payload.iso10816.inputUnit).toBe("mm_s");
                    expect(msg.payload.iso10816.isValid).toBe(true);
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

    // ============================================
    // Per-device grouping (issue #25)
    // ============================================
    describe("per-device grouping (groupBy)", function () {
        const SETTLE_MS = 150;

        // Deterministic alternating signal: |value| is constant, so RMS equals
        // the amplitude exactly and a mixed buffer is trivially distinguishable.
        function alternating(amplitude, i) {
            return i % 2 === 0 ? amplitude : -amplitude;
        }

        function twoOutputFlow(extra) {
            return [
                Object.assign({ id: "n1", type: "signal-analyzer", name: "test", wires: [["n2"], ["n3"]] }, extra),
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
        }

        // Collect from both outputs; grouping is orthogonal to routing.
        function collectBoth(n2, n3, sink) {
            n2.on("input", function (msg) {
                sink.push(msg);
            });
            n3.on("input", function (msg) {
                sink.push(msg);
            });
        }

        it("keeps one shared buffer when groupBy is not set (legacy behaviour)", function (done) {
            const flow = twoOutputFlow({ mode: "fft", fftSize: 64, samplingRate: 1000 });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const received = [];
                collectBoth(helper.getNode("n2"), helper.getNode("n3"), received);

                // 32 samples per topic — mixed into a single buffer this reaches
                // fftSize on the 64th message.
                for (let i = 0; i < 64; i++) {
                    n1.receive({ topic: i % 2 === 0 ? "pump-01" : "pump-02", payload: Math.sin(i * 0.3) });
                }

                setTimeout(function () {
                    expect(received.length).toBe(1);
                    // No group tagging while grouping is off
                    expect(received[0].group).toBeUndefined();
                    done();
                }, SETTLE_MS);
            });
        });

        it("buffers each topic independently and emits one result per device", function (done) {
            const flow = twoOutputFlow({ mode: "fft", fftSize: 64, samplingRate: 1000, groupBy: "topic" });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const received = [];
                collectBoth(helper.getNode("n2"), helper.getNode("n3"), received);

                // 63 samples for each of two topics: neither buffer is full yet.
                for (let i = 0; i < 63; i++) {
                    n1.receive({ topic: "pump-01", payload: Math.sin(i * 0.3) });
                    n1.receive({ topic: "pump-02", payload: Math.cos(i * 0.3) });
                }

                setTimeout(function () {
                    expect(received.length).toBe(0);

                    // 64th sample completes pump-01's buffer only
                    n1.receive({ topic: "pump-01", payload: 0.5 });

                    setTimeout(function () {
                        expect(received.length).toBe(1);
                        expect(received[0].group).toBe("pump-01");
                        expect(received[0].topic).toBe("pump-01");

                        // ...then pump-02 completes on its own 64th sample
                        n1.receive({ topic: "pump-02", payload: 0.5 });

                        setTimeout(function () {
                            expect(received.length).toBe(2);
                            expect(received[1].group).toBe("pump-02");
                            expect(received[1].topic).toBe("pump-02");
                            done();
                        }, SETTLE_MS);
                    }, SETTLE_MS);
                }, SETTLE_MS);
            });
        });

        it("computes vibration features per topic without cross-contamination", function (done) {
            const flow = twoOutputFlow({ mode: "vibration", windowSize: 10, groupBy: "topic" });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const received = [];
                collectBoth(helper.getNode("n2"), helper.getNode("n3"), received);

                // Interleaved: amplitude 1 on pump-01, amplitude 10 on pump-02.
                // A shared buffer would yield RMS ~7.1 for both.
                for (let i = 0; i < 10; i++) {
                    n1.receive({ topic: "pump-01", payload: alternating(1, i) });
                    n1.receive({ topic: "pump-02", payload: alternating(10, i) });
                }

                setTimeout(function () {
                    expect(received.length).toBe(2);

                    const first = received.find(function (m) {
                        return m.group === "pump-01";
                    });
                    const second = received.find(function (m) {
                        return m.group === "pump-02";
                    });

                    expect(first).toBeDefined();
                    expect(second).toBeDefined();
                    expect(first.payload.rms).toBeCloseTo(1, 6);
                    expect(second.payload.rms).toBeCloseTo(10, 6);
                    expect(first.windowSize).toBe(10);
                    expect(second.windowSize).toBe(10);
                    done();
                }, SETTLE_MS);
            });
        });

        it("counts samples per topic in peaks mode", function (done) {
            const flow = twoOutputFlow({ mode: "peaks", windowSize: 50, groupBy: "topic" });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const received = [];
                collectBoth(helper.getNode("n2"), helper.getNode("n3"), received);

                // Monotonically rising ramps — deterministic, no random baselines.
                for (let i = 1; i <= 5; i++) {
                    n1.receive({ topic: "pump-01", payload: i });
                }
                for (let i = 1; i <= 3; i++) {
                    n1.receive({ topic: "pump-02", payload: i });
                }

                setTimeout(function () {
                    const forTopic = function (topic) {
                        return received.filter(function (m) {
                            return m.group === topic;
                        });
                    };

                    const a = forTopic("pump-01");
                    const b = forTopic("pump-02");

                    // Emission starts at the 3rd sample of each buffer
                    expect(a.length).toBe(3);
                    expect(b.length).toBe(1);
                    expect(a[a.length - 1].sampleCount).toBe(5);
                    expect(b[b.length - 1].sampleCount).toBe(3);
                    done();
                }, SETTLE_MS);
            });
        });

        it("supports a nested group property path", function (done) {
            const flow = twoOutputFlow({ mode: "vibration", windowSize: 10, groupBy: "meta.device" });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const received = [];
                collectBoth(helper.getNode("n2"), helper.getNode("n3"), received);

                for (let i = 0; i < 10; i++) {
                    n1.receive({ payload: alternating(1, i), meta: { device: "mixer-a" } });
                    n1.receive({ payload: alternating(10, i), meta: { device: "mixer-b" } });
                }

                setTimeout(function () {
                    expect(received.length).toBe(2);
                    const keys = received
                        .map(function (m) {
                            return m.group;
                        })
                        .sort();
                    expect(keys).toEqual(["mixer-a", "mixer-b"]);
                    done();
                }, SETTLE_MS);
            });
        });

        it("routes messages without a group value into one shared ungrouped buffer", function (done) {
            const flow = twoOutputFlow({ mode: "vibration", windowSize: 10, groupBy: "topic" });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const received = [];
                collectBoth(helper.getNode("n2"), helper.getNode("n3"), received);

                for (let i = 0; i < 10; i++) {
                    n1.receive({ payload: alternating(2, i) });
                }

                setTimeout(function () {
                    expect(received.length).toBe(1);
                    expect(received[0].group).toBe("");
                    expect(received[0].payload.rms).toBeCloseTo(2, 6);
                    // The ungrouped bucket is what the legacy node.buffer view exposes
                    expect(n1.buffer.length).toBe(10);
                    done();
                }, SETTLE_MS);
            });
        });

        it("keeps the legacy node.buffer view scoped to ungrouped traffic", function (done) {
            const flow = twoOutputFlow({ mode: "vibration", windowSize: 50, groupBy: "topic" });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");

                for (let i = 0; i < 5; i++) {
                    n1.receive({ topic: "pump-01", payload: i });
                }

                setTimeout(function () {
                    expect(n1.buffer.length).toBe(0);

                    for (let i = 0; i < 3; i++) {
                        n1.receive({ payload: i });
                    }

                    setTimeout(function () {
                        expect(n1.buffer.length).toBe(3);
                        expect(n1.groups.get("pump-01").buffer.length).toBe(5);
                        done();
                    }, SETTLE_MS);
                }, SETTLE_MS);
            });
        });

        it("evicts the least recently used buffer once maxGroups is exceeded", function (done) {
            const flow = twoOutputFlow({ mode: "fft", fftSize: 8, samplingRate: 1000, groupBy: "topic", maxGroups: 2 });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const received = [];
                collectBoth(helper.getNode("n2"), helper.getNode("n3"), received);

                // Fill two buffers to one sample short of fftSize
                for (let i = 0; i < 7; i++) {
                    n1.receive({ topic: "pump-01", payload: Math.sin(i * 0.3) });
                }
                for (let i = 0; i < 7; i++) {
                    n1.receive({ topic: "pump-02", payload: Math.sin(i * 0.3) });
                }

                setTimeout(function () {
                    expect(n1.groups.size).toBe(2);

                    // A third topic evicts pump-01 (least recently used)
                    n1.receive({ topic: "pump-03", payload: 0.1 });

                    setTimeout(function () {
                        expect(n1.groups.size).toBe(2);
                        expect(n1.groups.has("pump-01")).toBe(false);

                        // pump-01 starts from scratch, so its 8th message must NOT
                        // complete a buffer. It also evicts pump-02 in turn.
                        n1.receive({ topic: "pump-01", payload: 0.2 });

                        setTimeout(function () {
                            expect(received.length).toBe(0);
                            expect(n1.groups.size).toBe(2);
                            expect(n1.groups.has("pump-02")).toBe(false);
                            expect(n1.groups.get("pump-01").buffer.length).toBe(1);
                            done();
                        }, SETTLE_MS);
                    }, SETTLE_MS);
                }, SETTLE_MS);
            });
        });

        it("resets only the group the reset message belongs to", function (done) {
            const flow = twoOutputFlow({ mode: "fft", fftSize: 8, samplingRate: 1000, groupBy: "topic" });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const received = [];
                collectBoth(helper.getNode("n2"), helper.getNode("n3"), received);

                for (let i = 0; i < 7; i++) {
                    n1.receive({ topic: "pump-01", payload: Math.sin(i * 0.3) });
                    n1.receive({ topic: "pump-02", payload: Math.sin(i * 0.3) });
                }

                setTimeout(function () {
                    n1.receive({ topic: "pump-01", reset: true });

                    setTimeout(function () {
                        expect(n1.groups.get("pump-01").buffer.length).toBe(0);
                        expect(n1.groups.get("pump-02").buffer.length).toBe(7);

                        // pump-02 still completes on its 8th sample, pump-01 does not
                        n1.receive({ topic: "pump-01", payload: 0.1 });
                        n1.receive({ topic: "pump-02", payload: 0.1 });

                        setTimeout(function () {
                            expect(received.length).toBe(1);
                            expect(received[0].group).toBe("pump-02");
                            done();
                        }, SETTLE_MS);
                    }, SETTLE_MS);
                }, SETTLE_MS);
            });
        });

        it("clears every group on msg.reset === 'all'", function (done) {
            const flow = twoOutputFlow({ mode: "fft", fftSize: 8, samplingRate: 1000, groupBy: "topic" });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const received = [];
                collectBoth(helper.getNode("n2"), helper.getNode("n3"), received);

                for (let i = 0; i < 7; i++) {
                    n1.receive({ topic: "pump-01", payload: Math.sin(i * 0.3) });
                    n1.receive({ topic: "pump-02", payload: Math.sin(i * 0.3) });
                }

                setTimeout(function () {
                    n1.receive({ reset: "all" });

                    setTimeout(function () {
                        expect(n1.groups.size).toBe(0);

                        n1.receive({ topic: "pump-01", payload: 0.1 });
                        n1.receive({ topic: "pump-02", payload: 0.1 });

                        setTimeout(function () {
                            expect(received.length).toBe(0);
                            expect(n1.groups.get("pump-01").buffer.length).toBe(1);
                            done();
                        }, SETTLE_MS);
                    }, SETTLE_MS);
                }, SETTLE_MS);
            });
        });

        it("still resets the single buffer when grouping is off", function (done) {
            const flow = twoOutputFlow({ mode: "vibration", windowSize: 50 });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");

                for (let i = 0; i < 5; i++) {
                    n1.receive({ payload: i });
                }

                setTimeout(function () {
                    expect(n1.buffer.length).toBe(5);
                    n1.receive({ payload: 0, reset: true });

                    setTimeout(function () {
                        expect(n1.buffer.length).toBe(0);
                        done();
                    }, SETTLE_MS);
                }, SETTLE_MS);
            });
        });
    });

    // ============================================
    // Per-group state persistence (v1 -> v2 format)
    // ============================================
    // The helper-based tests above cannot pre-seed context storage before the
    // node's async state load runs, so these drive the node against a minimal
    // RED stub with a controlled context store.
    describe("grouped state persistence", function () {
        const EventEmitter = require("events");

        function buildStubbedNode(config, seededContext) {
            const store = Object.assign({}, seededContext);
            const context = {
                get: function (key, storeName, cb) {
                    if (typeof cb === "function") {
                        cb(null, store[key]);
                        return undefined;
                    }
                    return store[key];
                },
                set: function (key, value, storeName, cb) {
                    store[key] = value;
                    if (typeof cb === "function") cb(null);
                }
            };

            let Constructor = null;
            signalAnalyzerNode({
                nodes: {
                    createNode: function (node) {
                        node.status = function () {};
                        node.debug = function () {};
                        node.warn = function () {};
                        node.error = function () {};
                        node.log = function () {};
                        node.send = function () {};
                        node.context = function () {
                            return context;
                        };
                    },
                    registerType: function (name, ctor) {
                        Constructor = ctor;
                    }
                },
                util: {
                    getMessageProperty: function (msg, path) {
                        return path.split(".").reduce(function (obj, key) {
                            return obj === null || obj === undefined ? undefined : obj[key];
                        }, msg);
                    }
                },
                httpAdmin: { get: function () {} }
            });

            const node = new EventEmitter();
            Constructor.call(node, config);
            return { node: node, store: store };
        }

        function feed(node, msg) {
            return new Promise(function (resolve, reject) {
                node.emit(
                    "input",
                    msg,
                    function () {},
                    function (err) {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });
        }

        function closeNode(node) {
            return new Promise(function (resolve) {
                node.emit("close", resolve);
            });
        }

        // Let the async context load settle
        function settle() {
            return new Promise(function (resolve) {
                setTimeout(resolve, 20);
            });
        }

        it("migrates a legacy flat buffer into the ungrouped bucket", async function () {
            const stub = buildStubbedNode(
                { id: "n1", mode: "vibration", windowSize: 50, persistState: true, groupBy: "topic" },
                {
                    signalAnalyzerState: {
                        buffer: [1, 2, 3, 4, 5],
                        timestamps: [10, 20, 30, 40, 50],
                        sampleCount: 5,
                        lastProcessedIndex: 2
                    }
                }
            );

            await settle();

            expect(stub.node.groups.size).toBe(1);
            expect(stub.node.groups.get("").buffer).toEqual([1, 2, 3, 4, 5]);
            expect(stub.node.groups.get("").sampleCount).toBe(5);
            expect(stub.node.groups.get("").lastProcessedIndex).toBe(2);
            // Legacy view still reports the same buffer
            expect(stub.node.buffer.length).toBe(5);

            await closeNode(stub.node);

            // Saved back in v2 form, with the stale flat keys dropped
            const saved = stub.store.signalAnalyzerState;
            expect(saved.version).toBe(2);
            expect(saved.groups[""].buffer).toEqual([1, 2, 3, 4, 5]);
            expect(saved.buffer).toBeUndefined();
            expect(saved.sampleCount).toBeUndefined();
        });

        it("restores one buffer per group from v2 state", async function () {
            const stub = buildStubbedNode(
                { id: "n1", mode: "vibration", windowSize: 50, persistState: true, groupBy: "topic" },
                {
                    signalAnalyzerState: {
                        version: 2,
                        groups: {
                            "pump-01": { buffer: [1, 2, 3], timestamps: [], sampleCount: 3, lastProcessedIndex: 0 },
                            "pump-02": { buffer: [4, 5], timestamps: [], sampleCount: 2, lastProcessedIndex: 0 }
                        }
                    }
                }
            );

            await settle();

            expect(stub.node.groups.size).toBe(2);
            expect(stub.node.groups.get("pump-01").buffer).toEqual([1, 2, 3]);
            expect(stub.node.groups.get("pump-02").buffer).toEqual([4, 5]);
            expect(stub.node.groups.get("pump-02").sampleCount).toBe(2);

            await closeNode(stub.node);
        });

        it("saves every group on close", async function () {
            const stub = buildStubbedNode(
                { id: "n1", mode: "vibration", windowSize: 50, persistState: true, groupBy: "topic" },
                {}
            );

            await settle();

            await feed(stub.node, { topic: "pump-01", payload: 1 });
            await feed(stub.node, { topic: "pump-01", payload: 2 });
            await feed(stub.node, { topic: "pump-02", payload: 3 });

            await closeNode(stub.node);

            const saved = stub.store.signalAnalyzerState;
            expect(saved.version).toBe(2);
            expect(Object.keys(saved.groups).sort()).toEqual(["pump-01", "pump-02"]);
            expect(saved.groups["pump-01"].buffer).toEqual([1, 2]);
            expect(saved.groups["pump-02"].buffer).toEqual([3]);
        });

        it("does not exceed maxGroups when restoring persisted state", async function () {
            const groups = {};
            for (let i = 0; i < 5; i++) {
                groups["pump-0" + i] = { buffer: [i], timestamps: [], sampleCount: 1, lastProcessedIndex: 0 };
            }

            const stub = buildStubbedNode(
                {
                    id: "n1",
                    mode: "vibration",
                    windowSize: 50,
                    persistState: true,
                    groupBy: "topic",
                    maxGroups: 2
                },
                { signalAnalyzerState: { version: 2, groups: groups } }
            );

            await settle();

            expect(stub.node.groups.size).toBe(2);

            await closeNode(stub.node);
        });
    });
});
