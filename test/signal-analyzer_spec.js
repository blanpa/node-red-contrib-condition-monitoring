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
});
