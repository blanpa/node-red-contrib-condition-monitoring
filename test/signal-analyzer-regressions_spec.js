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

    describe("vibration mode analyses a frame whole", () => {
        // 25 Hz (1500 rpm) at 1 m/s² peak: v = a / (2πf) = 6.37 mm/s peak = 4.50 mm/s RMS,
        // zone D for a group 2 machine on a rigid foundation (C/D at 4.5)
        const fs = 10000;
        const frame = sine(4096, fs, [[25, 1]]);
        const cfg = {
            mode: "vibration",
            samplingRate: fs,
            vibInputUnit: "m_s2",
            iso10816Class: "group2_rigid",
            outputTopic: "forced-topic"
        };

        it("integrates the ISO velocity over the whole frame with the default window size", async () => {
            // windowSize left at its default (256): cutting the frame to it put the
            // 25 Hz line into a 39 Hz bin next to the excluded DC bin (2.65 mm/s, zone B)
            const { out, last, errors } = await run(cfg, [{ payload: frame, topic: "in" }]);
            expect(errors).toEqual([]);
            expect(out.length).toBe(1);
            const iso = last.payload.iso20816;
            expect(iso.conversion).toBe("spectral-integration");
            expect(Math.abs(iso.rmsVelocity - 4.5) / 4.5).toBeLessThan(0.05);
            expect(iso.zone).toBe("D");
            expect(last.windowSize).toBe(4096);
            expect(last.samplingRate).toBe(fs);
            // 10.24 cycles in the frame: the mean is small but not zero, and it is reported
            const mean = frame.reduce((a, b) => a + b, 0) / frame.length;
            expect(last.payload.dcOffset).toBeCloseTo(mean, 9);
            expect(last.payload.mean).toBeCloseTo(mean, 9);
        });

        it("routes an ISO zone D frame to output 2 and applies the output topic", async () => {
            const { out, errors } = await run(Object.assign({ windowSize: 4096 }, cfg), [
                { payload: frame, topic: "in" }
            ]);
            expect(errors).toEqual([]);
            // zone D → anomaly output; a quiet frame goes to output 1
            expect(out.length).toBe(1);
            expect(out[0].payload.iso20816.isAlarm).toBe(true);
            expect(out[0].topic).toBe("forced-topic");
            await helper.unload();
            const quiet = await run(cfg, [{ payload: sine(4096, fs, [[25, 0.1]]), topic: "in" }]);
            expect(quiet.last.payload.iso20816.zone).toBe("A");
            expect(quiet.last.topic).toBe("forced-topic");
        });

        it("centres a frame so a DC offset does not swamp rms and crest factor", async () => {
            // 1 g gravity on a vertically mounted MEMS accelerometer + 0.1 g at 50 Hz
            // (20 whole cycles in 4000 samples): a sine has crest factor √2 and RMS A/√2
            const gframe = sine(4000, fs, [[50, 0.1]], 1);
            const { last } = await run({ mode: "vibration", samplingRate: fs, vibInputUnit: "g" }, [
                { payload: gframe }
            ]);
            expect(last.payload.dcOffset).toBeCloseTo(1, 6);
            expect(last.payload.mean).toBeCloseTo(1, 6);
            expect(last.payload.rms).toBeCloseTo(0.1 / Math.SQRT2, 4);
            expect(last.payload.crestFactor).toBeCloseTo(Math.SQRT2, 3);
            expect(last.payload.formFactor).toBeCloseTo(Math.PI / (2 * Math.SQRT2), 2);
            // the ISO integration already removed the mean: 0.1 g at 50 Hz = 3.12 mm/s peak = 2.21 mm/s RMS
            // (integrated over the 2048-sample power-of-two tail, so a little leakage)
            expect(Math.abs(last.payload.iso20816.rmsVelocity - 2.21) / 2.21).toBeLessThan(0.05);
        });

        it("keeps the mean of a scalar stream and applies the window size to it", async () => {
            const msgs = [];
            for (let i = 0; i < 30; i++) msgs.push({ payload: 5 + (i % 2 ? 0.1 : -0.1) });
            const { last } = await run({ mode: "vibration", windowSize: 20 }, msgs);
            expect(last.windowSize).toBe(20);
            expect(last.payload.dcOffset).toBeNull();
            expect(last.payload.mean).toBeCloseTo(5, 6);
            expect(last.payload.rms).toBeCloseTo(Math.sqrt(25 + 0.01), 6);
        });

        it("takes the sampling rate from the message when it carries one", async () => {
            // the node is configured for 1 kHz; the frame was captured at 10 kHz
            const wrong = await run({ mode: "vibration", samplingRate: 1000, vibInputUnit: "m_s2" }, [
                { payload: frame }
            ]);
            expect(wrong.last.payload.iso20816.rmsVelocity).not.toBeCloseTo(4.5, 0);
            await helper.unload();
            const viaMsg = await run({ mode: "vibration", samplingRate: 1000, vibInputUnit: "m_s2" }, [
                { payload: frame, samplingRate: fs }
            ]);
            expect(Math.abs(viaMsg.last.payload.iso20816.rmsVelocity - 4.5) / 4.5).toBeLessThan(0.05);
            expect(viaMsg.last.samplingRate).toBe(fs);
            await helper.unload();
            // FFT mode: a 125 Hz line at 2 kHz lands on bin 16 of 256; read at the
            // configured 1 kHz it would be reported as 62.5 Hz
            const fft = await run({ mode: "fft", fftSize: 256, samplingRate: 1000 }, [
                { payload: sine(256, 2000, [[125, 1]]), config: { samplingRate: 2000 } }
            ]);
            expect(fft.last.dominantFrequency).toBe(125);
            expect(fft.last.samplingRate).toBe(2000);
        });
    });

    describe("peaks mode", () => {
        it("reports a peak on the sample that confirms it and routes that message to output 2", async () => {
            // five peaks of height ≥ 3 (indices 2, 6, 10, 14, 18), each confirmed by the next sample
            const signal = [1, 2, 5, 2, 1, 2, 6, 2, 1, 2, 4, 2, 1, 2, 5, 2, 1, 2, 3, 2, 1];
            const cfg = {
                mode: "peaks",
                windowSize: 50,
                minPeakHeight: 3,
                minPeakDistance: 1,
                peakType: "positive",
                outputTopic: "forced-topic"
            };
            const { out } = await run(
                cfg,
                signal.map((v) => ({ payload: v, topic: "in" }))
            );
            const confirmed = out.filter((m) => m.isPeak);
            expect(confirmed.length).toBe(5);
            expect(confirmed.map((m) => m.peak.value)).toEqual([5, 6, 4, 5, 3]);
            expect(confirmed.map((m) => m.peak.index)).toEqual([2, 6, 10, 14, 18]);
            // the confirming sample itself is the payload, the peak rides along in msg.peak
            expect(confirmed.map((m) => m.payload)).toEqual([2, 2, 2, 2, 2]);
            expect(out.filter((m) => !m.isPeak).every((m) => m.peak === null)).toBe(true);
            expect(out[out.length - 1].peakCount).toBe(5);
            expect(out.every((m) => m.topic === "forced-topic")).toBe(true);
        });

        it("sends the confirming message to output 2 only", async () => {
            const signal = [1, 2, 5, 2, 1, 2, 6, 2, 1];
            const flow = [
                {
                    id: "n1",
                    type: "signal-analyzer",
                    mode: "peaks",
                    windowSize: 50,
                    minPeakHeight: 3,
                    minPeakDistance: 1,
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            await new Promise((resolve, reject) => {
                helper.load(signalAnalyzerNode, flow, function () {
                    const n1 = helper.getNode("n1");
                    const normal = [];
                    const anomaly = [];
                    helper.getNode("n2").on("input", (m) => normal.push(m));
                    helper.getNode("n3").on("input", (m) => anomaly.push(m));
                    signal.forEach((v) => n1.receive({ payload: v }));
                    setTimeout(() => {
                        try {
                            expect(anomaly.map((m) => m.peak.value)).toEqual([5, 6]);
                            expect(anomaly.every((m) => m.isPeak === true)).toBe(true);
                            expect(normal.every((m) => m.isPeak === false)).toBe(true);
                            // 9 samples, results from the third one on: 7 messages in all
                            expect(normal.length + anomaly.length).toBe(7);
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    }, 150);
                });
            });
        });
    });
});
