const helper = require("node-red-node-test-helper");
const srcNode = require("../nodes/condition-monitoring-source.js");
const sigNode = require("../nodes/signal-analyzer.js");

helper.init(require.resolve("node-red"));

describe("condition-monitoring-source waveform mode + signal-analyzer array input", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });
    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("emits a vibration waveform frame (array) with the configured sample rate", function (done) {
        const flow = [
            {
                id: "n1",
                type: "condition-monitoring-source",
                rpm: 1500,
                outputFormat: "waveform",
                sampleRate: 2560,
                frameSize: 256,
                faultImbalance: 0.8,
                seed: 42,
                autoStart: false,
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        helper.load(srcNode, flow, function () {
            const n2 = helper.getNode("n2"),
                n1 = helper.getNode("n1");
            n2.on("input", function (msg) {
                try {
                    expect(Array.isArray(msg.payload)).toBe(true);
                    expect(msg.payload.length).toBe(256);
                    expect(msg.samplingRate).toBe(2560);
                    expect(msg.payload.every((v) => typeof v === "number" && isFinite(v))).toBe(true);
                    done();
                } catch (e) {
                    done(e);
                }
            });
            n1.receive({ payload: "tick" });
        });
    });

    it("signal-analyzer FFT accepts a whole frame (array) in one message", function (done) {
        // pure 8 Hz sine, Fs=64, 64-pt FFT -> dominant frequency = 8 Hz
        const N = 64,
            Fs = 64;
        const frame = [];
        for (let n = 0; n < N; n++) frame.push(Math.sin((2 * Math.PI * 8 * n) / Fs));
        const flow = [
            {
                id: "n1",
                type: "signal-analyzer",
                mode: "fft",
                fftSize: N,
                samplingRate: Fs,
                windowFunction: "rectangular",
                outputFormat: "peaks",
                wires: [["n2"], ["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        helper.load(sigNode, flow, function () {
            const n2 = helper.getNode("n2"),
                n1 = helper.getNode("n1");
            n2.on("input", function (msg) {
                try {
                    expect(msg.dominantFrequency).toBeCloseTo(8, 0);
                    done();
                } catch (e) {
                    done(e);
                }
            });
            n1.receive({ payload: frame }); // one array, not 64 scalars
        });
    });

    it("end-to-end: source waveform (imbalance) → signal-analyzer FFT recovers the shaft frequency", function (done) {
        const flow = [
            {
                id: "s",
                type: "condition-monitoring-source",
                rpm: 1500,
                outputFormat: "waveform",
                sampleRate: 2560,
                frameSize: 2048,
                faultImbalance: 0.8,
                noise: 0.2,
                seed: 42,
                autoStart: false,
                wires: [["a"]]
            },
            {
                id: "a",
                type: "signal-analyzer",
                mode: "fft",
                fftSize: 2048,
                samplingRate: 2560,
                windowFunction: "hann",
                outputFormat: "peaks",
                peakThreshold: 0.1,
                wires: [["c"], ["c"]]
            },
            { id: "c", type: "helper" }
        ];
        helper.load([srcNode, sigNode], flow, function () {
            const s = helper.getNode("s"),
                c = helper.getNode("c");
            c.on("input", function (msg) {
                try {
                    // shaft frequency = 1500/60 = 25 Hz (where imbalance lives)
                    expect(Math.abs(msg.dominantFrequency - 25)).toBeLessThanOrEqual(2);
                    done();
                } catch (e) {
                    done(e);
                }
            });
            s.receive({ payload: "tick" });
        });
    });
});
