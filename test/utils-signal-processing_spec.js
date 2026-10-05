/**
 * utils/signal-processing: the pure DSP functions behind the signal-analyzer
 * node, tested directly (no Node-RED runtime).
 */
const dsp = require("../nodes/utils/signal-processing");

function sine(n, fs, parts, dc) {
    return Array.from({ length: n }, (_, i) =>
        parts.reduce((sum, [f, a]) => sum + a * Math.sin((2 * Math.PI * f * i) / fs), dc || 0)
    );
}

function rms(x) {
    return Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
}

describe("signal-processing", function () {
    it("arrayMax / arrayMin handle arrays beyond the argument-count limit", function () {
        const big = new Array(300000).fill(1);
        big[1234] = 7;
        big[250000] = -3;
        expect(dsp.arrayMax(big)).toBe(7);
        expect(dsp.arrayMin(big)).toBe(-3);
    });

    it("applyWindow tapers to zero at both ends for Hann and leaves rectangular alone", function () {
        const ones = new Array(8).fill(1);
        const hann = dsp.applyWindow(ones, "hann");
        expect(hann[0]).toBeCloseTo(0, 12);
        expect(hann[7]).toBeCloseTo(0, 12);
        expect(Math.max(...hann)).toBeLessThanOrEqual(1);
        expect(dsp.applyWindow(ones, "rectangular")).toEqual(ones);
    });

    it("performFFT puts a bin-centred sine at its frequency with |X|/N scaling", function () {
        const { frequencies, magnitudes } = dsp.performFFT(sine(256, 256, [[32, 1]]), 256, 256, "rectangular");
        expect(frequencies.length).toBe(128);
        expect(frequencies[32]).toBe(32);
        expect(magnitudes[32]).toBeCloseTo(0.5, 9); // two-sided: A / 2
        expect(dsp.arrayMax(magnitudes.filter((_, k) => k !== 32))).toBeLessThan(1e-9);
        // single-sided amplitude = magnitude × amplitudeScale(window)
        expect(magnitudes[32] * dsp.amplitudeScale("rectangular")).toBeCloseTo(1, 9);
        expect(dsp.amplitudeScale("hann")).toBe(4);
    });

    it("performFFT rounds a non-power-of-two size up and zero-pads", function () {
        const { frequencies } = dsp.performFFT(sine(100, 1000, [[50, 1]]), 100, 1000, "hann");
        expect(frequencies.length).toBe(64); // 128-point transform
        expect(frequencies[1]).toBeCloseTo(1000 / 128, 9);
    });

    it("findSpectralPeaks returns local maxima above the relative threshold, strongest first", function () {
        const freqs = [0, 1, 2, 3, 4, 5, 6];
        const mags = [0, 1, 0, 0.4, 0, 0.05, 0];
        const peaks = dsp.findSpectralPeaks(freqs, mags, 0.1);
        expect(peaks.map((p) => p.frequency)).toEqual([1, 3]);
        expect(peaks[1].normalized).toBeCloseTo(0.4, 12);
        expect(dsp.findSpectralPeaks(freqs, new Array(7).fill(0), 0.1)).toEqual([]);
    });

    it("the Butterworth band-pass keeps the pass band and removes the stop bands", function () {
        const fs = 8000;
        const pass = dsp.bandpassFilter(sine(4096, fs, [[1000, 1]]), fs, 500, 2000);
        const low = dsp.bandpassFilter(sine(4096, fs, [[50, 1]]), fs, 500, 2000);
        const high = dsp.bandpassFilter(sine(4096, fs, [[3800, 1]]), fs, 500, 2000);
        const mid = (x) => x.slice(512, 3584); // away from the edge transients
        expect(rms(mid(pass))).toBeGreaterThan(0.6);
        expect(rms(mid(low))).toBeLessThan(0.02);
        expect(rms(mid(high))).toBeLessThan(0.05);
    });

    it("bandpassFilter reports an unusable band through the logger and still returns a signal", function () {
        const logged = [];
        const out = dsp.bandpassFilter(sine(64, 1000, [[100, 1]]), 1000, 500, 5000, (m) => logged.push(m));
        expect(out.length).toBe(64);
        expect(logged.length).toBe(1);
        expect(logged[0]).toMatch(/Invalid frequencies/);
    });

    it("the envelope of an amplitude-modulated carrier oscillates at the modulation frequency", function () {
        const fs = 8000;
        const n = 8192;
        const signal = Array.from({ length: n }, (_, i) => {
            const t = i / fs;
            return (1 + 0.8 * Math.sin(2 * Math.PI * 40 * t)) * Math.sin(2 * Math.PI * 1500 * t);
        });
        const envelope = dsp.performEnvelopeAnalysis(signal, fs, 1000, 2000);
        const mean = envelope.reduce((a, b) => a + b, 0) / n;
        const spectrum = dsp.performFFT(
            envelope.map((v) => v - mean),
            n,
            fs,
            "hann"
        );
        const peaks = dsp.findSpectralPeaks(spectrum.frequencies, spectrum.magnitudes, 0.5);
        expect(peaks[0].frequency).toBeCloseTo(40, 0);
    });

    it("detectPeaks applies an explicit height, or mean ± 2σ when none is given", function () {
        const data = [0, 5, 0, 1, 0, 9, 0, -9, 0];
        const times = data.map((_, i) => i);
        expect(dsp.detectPeaks(data, times, 4, 1, "positive").map((p) => p.value)).toEqual([5, 9]);
        expect(dsp.detectPeaks(data, times, 4, 1, "both").map((p) => p.value)).toEqual([5, 9, -9]);
        // peaks closer together than minPeakDistance: only the first counts
        expect(dsp.detectPeaks(data, times, 4, 5, "positive").map((p) => p.index)).toEqual([1]);
        const quiet = [];
        for (let i = 0; i < 40; i++) quiet.push(i % 2 ? 1.1 : 0.9);
        quiet[20] = 9;
        const auto = dsp.detectPeaks(
            quiet,
            quiet.map((_, i) => i),
            null,
            1,
            "positive"
        );
        expect(auto.map((p) => p.value)).toEqual([9]);
    });

    it("the real cepstrum peaks at the period of a harmonic family", function () {
        const fs = 4096;
        const parts = [];
        for (let h = 1; h <= 30; h++) parts.push([50 * h, 1 / h]);
        const { quefrencies, cepstrum } = dsp.performCepstrum(sine(4096, fs, parts), 4096, fs);
        const rahmonics = dsp.findRahmonics(quefrencies, cepstrum, 0.002, 0.1, 0.1);
        expect(rahmonics[0].quefrency).toBeCloseTo(0.02, 3);
        expect(rahmonics[0].fundamentalFrequency).toBeGreaterThan(48);
        expect(rahmonics[0].fundamentalFrequency).toBeLessThan(52);
    });

    describe("gear sideband analysis", function () {
        // mesh line of a 20-tooth gear at 25 Hz shaft speed (500 Hz) with
        // sidebands of relative amplitude `depth / 2` at ±25 Hz
        function meshSpectrum(depth, shaftHz, fsHz, n) {
            const x = Array.from({ length: n }, (_, i) => {
                const t = i / fsHz;
                return (1 + depth * Math.cos(2 * Math.PI * shaftHz * t)) * Math.cos(2 * Math.PI * 20 * shaftHz * t);
            });
            return dsp.performFFT(x, n, fsHz, "hann");
        }

        it("reports no sidebands and a ratio of 0 for an unmodulated mesh", function () {
            const sp = meshSpectrum(0, 25, 8192, 8192);
            const g = dsp.gearSidebandAnalysis(sp.frequencies, sp.magnitudes, 25, 20);
            expect(g.meshFound).toBe(true);
            expect(g.detectedGmf).toBe(500);
            expect(g.sidebands).toEqual([]);
            expect(g.sidebandEnergyRatio).toBe(0);
        });

        it("measures the sideband energy ratio of an amplitude-modulated mesh", function () {
            // AM of depth m puts m/2 of the carrier into each first sideband: SER = m
            const sp = meshSpectrum(0.6, 25, 8192, 8192);
            const g = dsp.gearSidebandAnalysis(sp.frequencies, sp.magnitudes, 25, 20);
            expect(g.sidebands.map((b) => b.order).sort()).toEqual([-1, 1]);
            expect(g.sidebands.map((b) => b.frequency).sort()).toEqual([475, 525]);
            expect(g.sidebandEnergyRatio).toBeCloseTo(0.6, 2);
        });

        it("follows a mesh line that sits slightly off its nominal position", function () {
            // true speed 25.1 Hz, node told 25 Hz (0.4 % low)
            const sp = meshSpectrum(0.6, 25.1, 8192, 8192);
            const g = dsp.gearSidebandAnalysis(sp.frequencies, sp.magnitudes, 25, 20);
            expect(g.detectedGmf).toBe(502);
            expect(g.sidebandEnergyRatio).toBeGreaterThan(0.5);
        });

        it("declines to rate sidebands the spectrum cannot separate, or a mesh outside it", function () {
            const coarse = meshSpectrum(0.6, 25, 8192, 512); // 16 Hz bins, 25 Hz spacing
            const g = dsp.gearSidebandAnalysis(coarse.frequencies, coarse.magnitudes, 25, 20);
            expect(g.resolved).toBe(false);
            expect(g.sidebandEnergyRatio).toBeNull();
            const sp = meshSpectrum(0.6, 25, 8192, 8192);
            expect(dsp.gearSidebandAnalysis(sp.frequencies, sp.magnitudes, 25, 400)).toBeNull();
            expect(dsp.gearSidebandAnalysis(sp.frequencies, sp.magnitudes, 0, 20)).toBeNull();
        });

        it("detectGearFaults reports gears above the limit, high above twice the limit", function () {
            const gear = (ser) => ({
                teeth: 20,
                gmf: 500,
                detectedGmf: 500,
                sidebands: [{}, {}],
                sidebandEnergyRatio: ser
            });
            const faults = dsp.detectGearFaults([gear(0.4), gear(1.3), null, gear(2.5), gear(null)], 1);
            expect(faults.map((f) => [f.gear, f.type, f.severity])).toEqual([
                [2, "Sideband", "medium"],
                [4, "Sideband", "high"]
            ]);
            expect(faults[0].sidebandEnergyRatio).toBe(1.3);
            expect(dsp.detectGearFaults([gear(0.4)], 0.2).length).toBe(1);
            expect(dsp.detectGearFaults([], 1)).toEqual([]);
        });
    });

    it("sample entropy is lower for a regular signal than for an irregular one", function () {
        const regular = sine(400, 100, [[5, 1]]);
        let seed = 7;
        const irregular = Array.from({ length: 400 }, () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648 - 0.5;
        });
        const sd = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
        const eRegular = dsp.calculateSampleEntropy(regular, 2, 0.2 * sd(regular));
        const eIrregular = dsp.calculateSampleEntropy(irregular, 2, 0.2 * sd(irregular));
        expect(eRegular).toBeLessThan(eIrregular);
    });

    it("autocorrelation finds the period of a periodic signal", function () {
        const acf = dsp.calculateAutocorrelation(sine(200, 100, [[20, 1]]), 10); // period 5 samples
        expect(acf[0].value).toBeCloseTo(1, 9);
        const p = dsp.detectPeriodicity(acf);
        expect(p.detected).toBe(true);
        expect(p.period).toBe(5);
        expect(dsp.calculateAutocorrelation(new Array(20).fill(3), 5)).toEqual([]);
    });
});
