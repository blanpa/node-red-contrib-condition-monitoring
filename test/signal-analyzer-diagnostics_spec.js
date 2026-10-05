/**
 * Signal-analyzer: ISO 20816-3 groups, acceleration-to-velocity integration,
 * per-message shaft speed, geometry-derived bearing frequencies and the
 * envelope diagnostic rules (BPFI sidebands, looseness, sub-synchronous).
 */
const helper = require("node-red-node-test-helper");
const signalAnalyzerNode = require("../nodes/signal-analyzer.js");

helper.init(require.resolve("node-red"));

/** Sinusoid mix: [{f, a}] at sampling rate fs, n samples. */
function tones(components, fs, n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        let v = 0;
        for (const c of components) v += c.a * Math.sin(2 * Math.PI * c.f * (i / fs));
        out[i] = v;
    }
    return out;
}

/**
 * Amplitude-modulated carrier: a resonance at fc whose amplitude is modulated
 * by the given low frequencies. After band-pass + envelope detection the
 * envelope spectrum shows the modulation frequencies.
 */
function modulatedCarrier(fc, modulators, fs, n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        const t = i / fs;
        let env = 1;
        for (const m of modulators) env += m.a * Math.sin(2 * Math.PI * m.f * t);
        out[i] = env * Math.sin(2 * Math.PI * fc * t);
    }
    return out;
}

describe("signal-analyzer diagnostics", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    describe("ISO 20816-3 machine groups", function () {
        it("defaults new nodes to group2_rigid and reports the standard", function (done) {
            const flow = [
                { id: "n1", type: "signal-analyzer", mode: "vibration", windowSize: 32, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                n2.on("input", function (msg) {
                    expect(msg.payload.iso20816.machineClass).toBe("group2_rigid");
                    expect(msg.payload.iso20816.standard).toBe("ISO 20816-3");
                    expect(msg.payload.iso20816.limits).toEqual({ ab: 1.4, bc: 2.8, cd: 4.5 });
                    // alias for existing flows
                    expect(msg.payload.iso10816).toBe(msg.payload.iso20816);
                    done();
                });
                n1.receive({ payload: tones([{ f: 25, a: 1 }], 1000, 32) });
            });
        });

        it("rates the same velocity differently per group", function (done) {
            // 2 mm/s amplitude sinusoid -> 1.41 mm/s RMS: zone B for group2_rigid
            // (A/B = 1.4) but zone A for group1_flexible (A/B = 3.5).
            const flow = [
                {
                    id: "n1",
                    type: "signal-analyzer",
                    mode: "vibration",
                    windowSize: 64,
                    vibInputUnit: "mm_s",
                    iso10816Class: "group1_flexible",
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                n2.on("input", function (msg) {
                    expect(msg.payload.rms).toBeCloseTo(1.414, 1);
                    expect(msg.payload.iso20816.zone).toBe("A");
                    expect(msg.payload.iso20816.limits.ab).toBe(3.5);
                    done();
                });
                n1.receive({ payload: tones([{ f: 62.5, a: 2 }], 1000, 64) });
            });
        });

        it("keeps legacy class tables for existing flows", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "signal-analyzer",
                    mode: "vibration",
                    windowSize: 32,
                    iso10816Class: "class3",
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                n2.on("input", function (msg) {
                    expect(msg.payload.iso20816.machineClass).toBe("class3");
                    expect(msg.payload.iso20816.standard).toBe("ISO 10816-1 (legacy)");
                    expect(msg.payload.iso20816.limits).toEqual({ ab: 1.8, bc: 4.5, cd: 11.2 });
                    done();
                });
                n1.receive({ payload: tones([{ f: 25, a: 1 }], 1000, 32) });
            });
        });
    });

    describe("acceleration to velocity", function () {
        it("integrates the spectrum instead of assuming a single frequency", function (done) {
            // Two tones in m/s²: 100 Hz with 1 mm/s velocity amplitude and 400 Hz
            // with 0.5 mm/s velocity amplitude. Expected velocity RMS:
            // sqrt((1² + 0.5²) / 2) = 0.7906 mm/s. The old single-frequency
            // conversion at the 1800 rpm shaft frequency (30 Hz) would have
            // reported far more.
            const fs = 1024;
            const n = 256; // bins of 4 Hz: both tones sit on a bin
            const a100 = 2 * Math.PI * 100 * 0.001;
            const a400 = 2 * Math.PI * 400 * 0.0005;
            const flow = [
                {
                    id: "n1",
                    type: "signal-analyzer",
                    mode: "vibration",
                    windowSize: n,
                    samplingRate: fs,
                    vibInputUnit: "m_s2",
                    shaftSpeed: 1800,
                    iso10816Class: "group2_rigid",
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                n2.on("input", function (msg) {
                    const iso = msg.payload.iso20816;
                    expect(iso.conversion).toBe("spectral-integration");
                    expect(iso.band).toEqual([10, 512]);
                    expect(iso.rmsVelocity).toBeCloseTo(0.7906, 2);
                    expect(iso.zone).toBe("A");
                    done();
                });
                n1.receive({
                    payload: tones(
                        [
                            { f: 100, a: a100 },
                            { f: 400, a: a400 }
                        ],
                        fs,
                        n
                    )
                });
            });
        });

        it("never integrates a stream of scalar readings, even in g", function (done) {
            // One acceleration value per message: the buffer is a series of
            // readings, not a waveform, so the spectral path must stay off.
            const flow = [
                {
                    id: "n1",
                    type: "signal-analyzer",
                    mode: "vibration",
                    windowSize: 32,
                    samplingRate: 1000,
                    vibInputUnit: "g",
                    shaftSpeed: 1800,
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                let checked = false;
                const check = function (msg) {
                    if (checked || msg.windowSize < 32) return;
                    checked = true;
                    expect(msg.payload.iso20816.conversion).toBe("single-frequency");
                    expect(msg.payload.iso20816.conversionFrequency).toBe(30);
                    done();
                };
                helper.getNode("n2").on("input", check);
                helper.getNode("n3").on("input", check);
                for (let i = 0; i < 32; i++) n1.receive({ payload: 0.2 + (i % 2) * 0.01 });
            });
        });

        it("falls back to the single-frequency relation when the sampling rate is too low", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "signal-analyzer",
                    mode: "vibration",
                    windowSize: 32,
                    samplingRate: 10, // Nyquist 5 Hz: below the ISO band
                    vibInputUnit: "g",
                    shaftSpeed: 3000, // 50 Hz
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                n2.on("input", function (msg) {
                    const iso = msg.payload.iso20816;
                    expect(iso.conversion).toBe("single-frequency");
                    expect(iso.conversionFrequency).toBe(50);
                    // 0.1 g RMS at 50 Hz -> 0.1 · 9.80665 · 1000 / (2π · 50) = 3.12 mm/s
                    expect(iso.rmsVelocity).toBeCloseTo((msg.payload.rms * 9806.65) / (2 * Math.PI * 50), 6);
                    done();
                });
                const samples = [];
                for (let i = 0; i < 32; i++) samples.push(i % 2 ? 0.1 : -0.1);
                n1.receive({ payload: samples });
            });
        });
    });

    describe("envelope: shaft speed and bearing geometry", function () {
        const fs = 20000;
        const fftSize = 4096;

        function envelopeFlow(extra) {
            return [
                Object.assign(
                    {
                        id: "n1",
                        type: "signal-analyzer",
                        mode: "envelope",
                        fftSize: fftSize,
                        samplingRate: fs,
                        envelopeBandLow: 2000,
                        envelopeBandHigh: 6000,
                        wires: [["n2"], ["n3"]]
                    },
                    extra
                ),
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
        }

        it("derives BPFO/BPFI/BSF/FTF from geometry and the configured speed", function (done) {
            const flow = envelopeFlow({
                shaftSpeed: 1800,
                bearingBalls: 9,
                bearingBallDiameter: 7.94,
                bearingPitchDiameter: 39.04
            });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const check = function (msg) {
                    expect(msg.shaftSpeed).toBe(1800);
                    expect(msg.shaftFrequency).toBe(30);
                    expect(msg.bearingFreqs.source).toBe("geometry");
                    expect(msg.bearingFreqs.BPFO).toBeCloseTo(107.5, 0);
                    expect(msg.bearingFreqs.BPFI).toBeCloseTo(162.5, 0);
                    done();
                };
                helper.getNode("n2").on("input", check);
                helper.getNode("n3").on("input", check);
                n1.receive({ payload: tones([{ f: 4000, a: 1 }], fs, fftSize) });
            });
        });

        it("lets a typed-in value win over the derived one (mixed source)", function (done) {
            const flow = envelopeFlow({
                shaftSpeed: 1800,
                bearingBalls: 9,
                bearingBallDiameter: 7.94,
                bearingPitchDiameter: 39.04,
                bearingBPFO: 99
            });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const check = function (msg) {
                    expect(msg.bearingFreqs.source).toBe("mixed");
                    expect(msg.bearingFreqs.BPFO).toBe(99);
                    expect(msg.bearingFreqs.BPFI).toBeCloseTo(162.5, 0);
                    done();
                };
                helper.getNode("n2").on("input", check);
                helper.getNode("n3").on("input", check);
                n1.receive({ payload: tones([{ f: 4000, a: 1 }], fs, fftSize) });
            });
        });

        it("takes the shaft speed from msg.rpm and rescales the derived frequencies", function (done) {
            const flow = envelopeFlow({
                shaftSpeed: 1800,
                bearingBalls: 9,
                bearingBallDiameter: 7.94,
                bearingPitchDiameter: 39.04
            });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const check = function (msg) {
                    expect(msg.shaftSpeed).toBe(900);
                    expect(msg.shaftFrequency).toBe(15);
                    expect(msg.bearingFreqs.BPFO).toBeCloseTo(107.5 / 2, 0);
                    done();
                };
                helper.getNode("n2").on("input", check);
                helper.getNode("n3").on("input", check);
                n1.receive({ payload: tones([{ f: 4000, a: 1 }], fs, fftSize), rpm: 900 });
            });
        });

        it("flags an inner-race defect with ±1X sidebands", function (done) {
            // Resonance at 4 kHz modulated by BPFI (162.5 Hz) and its ±1X
            // sidebands (132.5 / 192.5 Hz) at 30 Hz shaft speed.
            const flow = envelopeFlow({
                shaftSpeed: 1800,
                bearingBPFI: 162.5,
                bearingBPFO: 107.5
            });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                helper.getNode("n3").on("input", function (msg) {
                    const types = msg.bearingFaults.map((f) => f.type);
                    expect(types).toContain("BPFI");
                    expect(types).toContain("BPFI-Sideband");
                    const sb = msg.bearingFaults.filter((f) => f.type === "BPFI-Sideband" && f.harmonic === 1);
                    expect(sb.map((f) => f.sideband).sort()).toEqual(expect.arrayContaining([-1, 1]));
                    expect(types).not.toContain("BPFO");
                    done();
                });
                n1.receive({
                    payload: modulatedCarrier(
                        4000,
                        [
                            { f: 162.5, a: 0.6 },
                            { f: 132.5, a: 0.3 },
                            { f: 192.5, a: 0.3 }
                        ],
                        fs,
                        fftSize
                    )
                });
            });
        });

        it("flags mechanical looseness from a harmonic series of 1X", function (done) {
            const flow = envelopeFlow({ shaftSpeed: 1800 });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                helper.getNode("n3").on("input", function (msg) {
                    const loose = msg.bearingFaults.find((f) => f.type === "Looseness");
                    expect(loose).toBeDefined();
                    expect(loose.harmonics.length).toBeGreaterThanOrEqual(4);
                    expect(loose.harmonics).toEqual(expect.arrayContaining([1, 2, 3, 4]));
                    done();
                });
                n1.receive({
                    payload: modulatedCarrier(
                        4000,
                        [30, 60, 90, 120, 150, 180].map((f) => ({ f: f, a: 0.15 })),
                        fs,
                        fftSize
                    )
                });
            });
        });

        it("flags a sub-synchronous component, but not when it is the cage frequency", function (done) {
            // 0.41X = 12.2 Hz at 30 Hz shaft speed. Low modulation frequencies
            // need a long record: 16384 samples at 20 kHz give 1.22 Hz bins.
            const flow = envelopeFlow({ shaftSpeed: 1800, fftSize: 16384 });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                helper.getNode("n3").on("input", function (msg) {
                    const sub = msg.bearingFaults.find((f) => f.type === "SubSynchronous");
                    expect(sub).toBeDefined();
                    expect(sub.order).toBeCloseTo(0.41, 1);
                    done();
                });
                n1.receive({ payload: modulatedCarrier(4000, [{ f: 12.2, a: 0.8 }], fs, 16384) });
            });
        });

        it("treats a 0.4X peak as FTF when the cage frequency is configured", function (done) {
            const flow = envelopeFlow({ shaftSpeed: 1800, bearingFTF: 12.2, fftSize: 16384 });
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                helper.getNode("n3").on("input", function (msg) {
                    const types = msg.bearingFaults.map((f) => f.type);
                    expect(types).toContain("FTF");
                    expect(types).not.toContain("SubSynchronous");
                    done();
                });
                n1.receive({ payload: modulatedCarrier(4000, [{ f: 12.2, a: 0.8 }], fs, 16384) });
            });
        });
    });

    describe("cepstrum: shaft speed per message", function () {
        it("uses msg.rpm for the gear-mesh frequency", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "signal-analyzer",
                    mode: "cepstrum",
                    fftSize: 256,
                    samplingRate: 1000,
                    shaftSpeed: 1800,
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                const check = function (msg) {
                    expect(msg.shaftSpeed).toBe(1200);
                    expect(msg.shaftFrequency).toBe(20);
                    done();
                };
                helper.getNode("n2").on("input", check);
                helper.getNode("n3").on("input", check);
                n1.receive({ payload: tones([{ f: 100, a: 1 }], 1000, 256), rpm: 1200 });
            });
        });
    });
});
