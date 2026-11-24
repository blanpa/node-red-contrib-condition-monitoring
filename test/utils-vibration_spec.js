const vibration = require("../nodes/utils/vibration");

describe("utils/vibration", function () {
    describe("ISO severity tables", function () {
        it("carries the ISO 20816-3 group tables and the legacy classes", function () {
            const t = vibration.ISO_SEVERITY_TABLES;
            expect(t.group1_rigid).toMatchObject({ ab: 2.3, bc: 4.5, cd: 7.1, standard: "ISO 20816-3" });
            expect(t.group1_flexible).toMatchObject({ ab: 3.5, bc: 7.1, cd: 11.0 });
            expect(t.group2_rigid).toMatchObject({ ab: 1.4, bc: 2.8, cd: 4.5 });
            expect(t.group2_flexible).toMatchObject({ ab: 2.3, bc: 4.5, cd: 7.1 });
            // Legacy ISO 10816-1 / ISO 2372 classes keep their historical numbers
            expect(t.class1).toMatchObject({ ab: 0.71, bc: 1.8, cd: 4.5 });
            expect(t.class4).toMatchObject({ ab: 2.8, bc: 7.1, cd: 18.0, standard: "ISO 10816-1 (legacy)" });
        });

        it("rates zones against the selected table", function () {
            expect(vibration.evaluateVibrationSeverity(1.0, "group2_rigid", "mm_s").zone).toBe("A");
            expect(vibration.evaluateVibrationSeverity(2.0, "group2_rigid", "mm_s").zone).toBe("B");
            expect(vibration.evaluateVibrationSeverity(3.0, "group2_rigid", "mm_s").zone).toBe("C");
            expect(vibration.evaluateVibrationSeverity(5.0, "group2_rigid", "mm_s").zone).toBe("D");
            // The same 3.0 mm/s is still zone B for a large flexibly mounted machine
            const g1 = vibration.evaluateVibrationSeverity(3.0, "group1_flexible", "mm_s");
            expect(g1.zone).toBe("A");
            expect(g1.standard).toBe("ISO 20816-3");
            expect(g1.isWarning).toBe(false);
        });

        it("falls back to the default group for unknown keys and disables the rating for raw input", function () {
            const unknown = vibration.evaluateVibrationSeverity(1, "nope", "mm_s");
            expect(unknown.machineClass).toBe(vibration.DEFAULT_MACHINE_CLASS);
            const raw = vibration.evaluateVibrationSeverity(1, "group2_rigid", "raw");
            expect(raw.zone).toBe("N/A");
            expect(raw.isValid).toBe(false);
            expect(raw.limits).toBeNull();
        });
    });

    describe("bearingFaultFrequencies", function () {
        it("matches the textbook 6205-type example", function () {
            // 9 balls, d = 7.94 mm, D = 39.04 mm, α = 0, 1800 rpm (30 Hz)
            const f = vibration.bearingFaultFrequencies(30, 9, 7.94, 39.04, 0);
            expect(f.BPFO).toBeCloseTo(107.5, 0);
            expect(f.BPFI).toBeCloseTo(162.5, 0);
            expect(f.FTF).toBeCloseTo(11.95, 1);
            expect(f.BSF).toBeCloseTo(70.7, 0);
            // Sanity: BPFO + BPFI = n · f_r, FTF = BPFO / n
            expect(f.BPFO + f.BPFI).toBeCloseTo(9 * 30, 6);
            expect(f.FTF).toBeCloseTo(f.BPFO / 9, 6);
        });

        it("applies the contact angle", function () {
            const a0 = vibration.bearingFaultFrequencies(30, 9, 7.94, 39.04, 0);
            const a40 = vibration.bearingFaultFrequencies(30, 9, 7.94, 39.04, 40);
            // cos α < 1 pulls BPFO up and BPFI down toward n/2 · f_r
            expect(a40.BPFO).toBeGreaterThan(a0.BPFO);
            expect(a40.BPFI).toBeLessThan(a0.BPFI);
        });

        it("returns null for unusable geometry", function () {
            expect(vibration.bearingFaultFrequencies(0, 9, 7.94, 39.04)).toBeNull();
            expect(vibration.bearingFaultFrequencies(30, 0, 7.94, 39.04)).toBeNull();
            expect(vibration.bearingFaultFrequencies(30, 9, 40, 39.04)).toBeNull(); // d >= D
            expect(vibration.bearingFaultFrequencies(30, 9, 7.94, 0)).toBeNull();
        });
    });

    describe("velocityRmsFromAccelerationSpectrum", function () {
        it("recovers the velocity RMS of a single sinusoid in band", function () {
            // v = 1 mm/s amplitude at 100 Hz -> a = 2π·100·0.001 = 0.628 m/s²
            // Two-sided-scaled magnitude |X_k|/N of amplitude A is A/2.
            const freqs = [0, 50, 100, 150, 2000];
            const mags = [0, 0, 0.628 / 2, 0, 0.5];
            const r = vibration.velocityRmsFromAccelerationSpectrum(freqs, mags, 10, 1000);
            expect(r.rms * 1000).toBeCloseTo(1 / Math.SQRT2, 3); // mm/s RMS
            expect(r.bins).toBe(3); // every bin inside the band counts, zero or not
            expect(r.fHigh).toBe(1000);
        });

        it("ignores bins outside the band and DC", function () {
            const r = vibration.velocityRmsFromAccelerationSpectrum([0, 5, 1500], [1, 1, 1], 10, 1000);
            expect(r.rms).toBe(0);
            expect(r.bins).toBe(0);
        });
    });

    describe("normalQuantile / zScoreForConfidence", function () {
        it("reproduces the standard z-scores", function () {
            expect(vibration.zScoreForConfidence(0.95)).toBeCloseTo(1.95996, 4);
            expect(vibration.zScoreForConfidence(0.99)).toBeCloseTo(2.57583, 4);
            expect(vibration.zScoreForConfidence(0.9)).toBeCloseTo(1.64485, 4);
            expect(vibration.normalQuantile(0.5)).toBeCloseTo(0, 9);
            expect(vibration.normalQuantile(0.975)).toBeCloseTo(1.95996, 4);
            expect(vibration.normalQuantile(0.01)).toBeCloseTo(-2.32635, 4);
        });

        it("falls back to 95 % for out-of-range levels", function () {
            expect(vibration.zScoreForConfidence(0)).toBeCloseTo(1.95996, 4);
            expect(vibration.zScoreForConfidence(1)).toBeCloseTo(1.95996, 4);
            expect(vibration.zScoreForConfidence(undefined)).toBeCloseTo(1.95996, 4);
            expect(vibration.normalQuantile(0)).toBe(-Infinity);
            expect(vibration.normalQuantile(1)).toBe(Infinity);
            expect(Number.isNaN(vibration.normalQuantile(2))).toBe(true);
        });
    });
});
