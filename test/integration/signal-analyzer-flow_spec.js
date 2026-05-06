"use strict";

const { startRed, captureNode, buildFlow } = require("./red-runtime");

/**
 * End-to-end test for the signal-analyzer FFT mode.
 *
 * We feed a 50 Hz sine wave (sampling at 1024 Hz) through the node and
 * expect the dominant peak to come back near 50 Hz. This proves the
 * fft.js fast path is wired correctly — that path was touched in PR1
 * (the unused `complexInput` stub was removed; if the call sequence got
 * broken the spectrum would come out as zeros / a wrong peak).
 */
describe("integration: signal-analyzer FFT flow", () => {
    let harness;
    const TAB = "sig-tab";
    const ANALYZER = "sig-analyzer";
    const CAP = "sig-cap";

    beforeAll(async () => {
        harness = await startRed();
        const flow = buildFlow(TAB, "signal fft", [
            {
                id: ANALYZER,
                type: "signal-analyzer",
                name: "fft analyzer",
                mode: "fft",
                fftSize: 256,
                samplingRate: 1024,
                windowFunction: "hann",
                outputFormat: "peaks",
                peakThreshold: 0.05,
                wires: [[CAP], []]
            },
            captureNode(CAP, "fft capture")
        ]);
        await harness.deploy(flow);
    }, 30000);

    afterAll(async () => {
        if (harness) await harness.shutdown();
    }, 15000);

    it("locates the dominant frequency of a 50 Hz sine wave", async () => {
        const fs = 1024;
        const f = 50;
        const N = 256;

        // Drip-feed exactly N samples — the analyzer needs the buffer to
        // fill before it emits anything. We send N+1 to push past the
        // threshold by one sample (the buffer trims after the first emit).
        for (let i = 0; i <= N; i++) {
            const t = i / fs;
            const v = Math.sin(2 * Math.PI * f * t);
            await harness.inject(ANALYZER, { payload: v });
        }

        const out = await harness.collect(CAP, 1, 3000);
        expect(out.length).toBeGreaterThanOrEqual(1);
        const last = out[out.length - 1];

        expect(typeof last.dominantFrequency).toBe("number");
        // FFT bin width = 1024/256 = 4 Hz, so the peak should land within
        // one bin of the true 50 Hz.
        expect(Math.abs(last.dominantFrequency - 50)).toBeLessThanOrEqual(4);

        // peaks array sanity-checks
        expect(Array.isArray(last.peaks)).toBe(true);
        expect(last.peaks.length).toBeGreaterThanOrEqual(1);
        expect(typeof last.peaks[0].frequency).toBe("number");
        expect(typeof last.peaks[0].magnitude).toBe("number");
        expect(last.peaks[0].magnitude).toBeGreaterThan(0);

        // Spectral feature object is present
        expect(last.features).toBeDefined();
        expect(typeof last.features).toBe("object");
    }, 30000);
});
