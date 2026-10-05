/**
 * signal-analyzer: regression tests for results that used to be wrong.
 *
 *  - cepstrum quefrencies were off by a factor of two,
 *  - a DC offset hid every spectral peak in FFT mode,
 *  - "peaks" mode ignored Min Peak Height,
 *  - large windows overflowed the stack (Math.max.apply),
 *  - the overlap setting had no effect on sample-by-sample streams,
 *  - an envelope band above Nyquist was replaced silently.
 */
const helper = require("node-red-node-test-helper");
const signalAnalyzerNode = require("../nodes/signal-analyzer.js");

helper.init(require.resolve("node-red"));

function sine(n, fs, parts, dc) {
    return Array.from({ length: n }, (_, i) =>
        parts.reduce((sum, [f, a]) => sum + a * Math.sin((2 * Math.PI * f * i) / fs), dc || 0)
    );
}

function run(config, messages) {
    const flow = [
        Object.assign({ id: "n1", type: "signal-analyzer", wires: [["n2"], ["n3"]] }, config),
        { id: "n2", type: "helper" },
        { id: "n3", type: "helper" }
    ];
    return new Promise((resolve, reject) => {
        helper.load(signalAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const out = [];
            const errors = [];
            const warnings = [];
            helper.getNode("n2").on("input", (m) => out.push(m));
            helper.getNode("n3").on("input", (m) => out.push(m));
            n1.on("call:error", (call) => errors.push(String(call.firstArg)));
            n1.on("call:warn", (call) => warnings.push(String(call.firstArg)));
            try {
                messages.forEach((m) => n1.receive(m));
            } catch (e) {
                reject(e);
                return;
            }
            setTimeout(() => resolve({ out, errors, warnings, last: out[out.length - 1] }), 150);
        });
    });
}

describe("signal-analyzer regressions", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("cepstrum reports the true quefrency of a harmonic series", async () => {
        const fs = 4096;
        const parts = [];
        for (let h = 1; h <= 30; h++) parts.push([50 * h, 1 / h]);
        const cfg = { mode: "cepstrum", fftSize: 4096, samplingRate: fs, quefrencyRangeLow: 0.002 };
        const { last } = await run(cfg, [{ payload: sine(4096, fs, parts) }]);
        // 50 Hz spacing -> 0.020 s (the half-spectrum transform reported 0.010 s / 100 Hz)
        expect(last.cepstrum.dominantQuefrency).toBeCloseTo(0.02, 3);
        expect(last.cepstrum.dominantFrequency).toBeGreaterThan(48);
        expect(last.cepstrum.dominantFrequency).toBeLessThan(52);
    });

    it("cepstrum does not diagnose gears from an assumed shaft speed", async () => {
        const fs = 4096;
        const parts = [];
        for (let h = 1; h <= 30; h++) parts.push([50 * h, 1 / h]);
        const cfg = { mode: "cepstrum", fftSize: 4096, samplingRate: fs, gearToothCount: "20,40" };
        const { last, warnings } = await run(cfg, [{ payload: sine(4096, fs, parts) }]);
        expect(last.gearFaults).toEqual([]);
        expect(last.shaftSpeed).toBe(0);
        expect(warnings.some((w) => /shaft speed is unknown/.test(w))).toBe(true);
    });

    it("FFT mode finds a small line riding on a large DC offset", async () => {
        const cfg = { mode: "fft", fftSize: 1024, samplingRate: 1024, windowFunction: "hann" };
        const { last } = await run(cfg, [{ payload: sine(1024, 1024, [[100, 0.05]], 9.81) }]);
        expect(last.dominantFrequency).toBe(100);
        expect(last.dcOffset).toBeCloseTo(9.81, 6);
        // physical single-sided amplitude next to the legacy |X|/N magnitude
        expect(last.peaks[0].amplitude).toBeCloseTo(0.05, 4);
        expect(last.peaks[0].magnitude).toBeCloseTo(0.0125, 4);
    });

    it("peaks mode honours Min Peak Height", async () => {
        const cfg = { mode: "peaks", windowSize: 50, minPeakHeight: "50", minPeakDistance: 1, peakType: "positive" };
        const low = await run(
            cfg,
            [1, 2, 1, 2, 1, 3, 1].map((v) => ({ payload: v }))
        );
        expect(low.last.peakCount).toBe(0);
        await helper.unload();
        const high = await run(
            cfg,
            [1, 60, 1, 2, 1, 70, 1].map((v) => ({ payload: v }))
        );
        expect(high.last.peaks.map((p) => p.value)).toEqual([60, 70]);
    });

    it("peaks mode without a height uses mean ± 2σ instead of accepting every local maximum", async () => {
        const data = [];
        for (let i = 0; i < 40; i++) data.push(i % 2 ? 1.1 : 0.9);
        data[20] = 9;
        data.push(1);
        const cfg = { mode: "peaks", windowSize: 100, minPeakDistance: 1, peakType: "positive" };
        const { last } = await run(
            cfg,
            data.map((v) => ({ payload: v }))
        );
        expect(last.peaks.map((p) => p.value)).toEqual([9]);
    });

    it("handles FFT sizes and vibration windows beyond the argument-count limit", async () => {
        const N = 262144;
        const noise = Array.from({ length: N }, (_, i) => Math.sin(i * 0.37) + Math.sin(i * 0.011));
        const fft = await run({ mode: "fft", fftSize: N, samplingRate: 50000 }, [{ payload: noise }]);
        expect(fft.errors).toEqual([]);
        expect(fft.out.length).toBe(1);
        await helper.unload();
        const vib = await run({ mode: "vibration", windowSize: N }, [{ payload: noise }]);
        expect(vib.errors).toEqual([]);
        expect(vib.out.length).toBe(1);
    });

    it("analyses a sample-by-sample stream once per overlap hop, a frame once per message", async () => {
        const samples = sine(64 + 32 * 3, 64, [[8, 1]]).map((v) => ({ payload: v }));
        const stream = await run({ mode: "fft", fftSize: 64, samplingRate: 64, overlapPercent: 50 }, samples);
        // first analysis when the buffer fills, then every 32 samples
        expect(stream.out.length).toBe(4);
        await helper.unload();
        const frames = await run({ mode: "fft", fftSize: 64, samplingRate: 64, overlapPercent: 50 }, [
            { payload: sine(64, 64, [[8, 1]]) },
            { payload: sine(8, 64, [[8, 1]]) },
            { payload: sine(8, 64, [[8, 1]]) }
        ]);
        expect(frames.out.length).toBe(3);
    });

    it("warns once when the envelope band does not fit the sampling rate", async () => {
        const frame = sine(256, 1000, [[120, 1]]);
        // defaults: 500-5000 Hz at 1 kHz sampling - nothing of that band exists below Nyquist
        const bad = await run({ mode: "envelope", fftSize: 256, samplingRate: 1000 }, [
            { payload: frame },
            { payload: frame }
        ]);
        expect(bad.warnings.filter((w) => /Envelope/.test(w)).length).toBe(1);
        expect(bad.last.envelope.filter).toBe("moving-average");
        await helper.unload();
        // upper edge above Nyquist only: clamped, still a proper band-pass
        const clamped = await run(
            { mode: "envelope", fftSize: 256, samplingRate: 8000, envelopeBandLow: 500, envelopeBandHigh: 5000 },
            [{ payload: sine(256, 8000, [[1000, 1]]) }]
        );
        expect(clamped.last.envelope.filter).toBe("butterworth");
        expect(clamped.last.envelope.bandHigh).toBeCloseTo(3600, 6);
        expect(clamped.warnings.length).toBe(1);
    });
});
