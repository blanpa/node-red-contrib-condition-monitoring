"use strict";

const stats = require("../nodes/utils/statistics");

describe("utils/statistics", () => {
    describe("calculateMean", () => {
        it("computes arithmetic mean", () => {
            expect(stats.calculateMean([1, 2, 3, 4, 5])).toBeCloseTo(3.0, 12);
        });
        it("throws on empty array", () => {
            expect(() => stats.calculateMean([])).toThrow();
        });
    });

    describe("calculateStdDev / calculateVariance", () => {
        it("matches the manual reference for a known sample", () => {
            const v = [2, 4, 4, 4, 5, 5, 7, 9];
            // Population std dev = 2 by hand
            expect(stats.calculateStdDev(v)).toBeCloseTo(2.0, 12);
            expect(stats.calculateVariance(v)).toBeCloseTo(4.0, 12);
        });
        it("uses Bessel's correction in calculateSampleStdDev", () => {
            const v = [2, 4, 4, 4, 5, 5, 7, 9];
            // Sample std dev = sqrt(32/7)
            expect(stats.calculateSampleStdDev(v)).toBeCloseTo(Math.sqrt(32 / 7), 12);
        });
        it("returns 0 for empty / single-value inputs", () => {
            expect(stats.calculateStdDev([])).toBe(0);
            expect(stats.calculateSampleStdDev([7])).toBe(0);
        });
    });

    describe("calculateRMS / calculateCrestFactor", () => {
        it("calculates RMS for a known signal", () => {
            // RMS of [3, 4] = sqrt((9+16)/2) = sqrt(12.5)
            expect(stats.calculateRMS([3, 4])).toBeCloseTo(Math.sqrt(12.5), 12);
        });
        it("calculates crest factor without Math.max(...spread) overflow", () => {
            // 10k samples, alternating ±1, peak=1, rms=1 → crest=1
            const big = new Array(10000).fill(0).map((_, i) => (i % 2 === 0 ? 1 : -1));
            expect(stats.calculateCrestFactor(big)).toBeCloseTo(1.0, 12);
        });
        it("returns 0 when rms is 0", () => {
            expect(stats.calculateCrestFactor([0, 0, 0])).toBe(0);
        });
    });

    describe("calculateMovingAverage (rolling sum O(n))", () => {
        it("matches naive moving average for a simple input", () => {
            const v = [1, 2, 3, 4, 5];
            const naive = v.map((_, i) => {
                const slice = v.slice(Math.max(0, i - 2), i + 1);
                return slice.reduce((a, b) => a + b, 0) / slice.length;
            });
            const got = stats.calculateMovingAverage(v, 3);
            expect(got.length).toBe(naive.length);
            for (let i = 0; i < naive.length; i++) {
                expect(got[i]).toBeCloseTo(naive[i], 12);
            }
        });
        it("matches a brute-force reference for random input", () => {
            const v = Array.from({ length: 256 }, () => Math.random() * 1000 - 500);
            const window = 16;
            const fast = stats.calculateMovingAverage(v, window);
            for (let i = 0; i < v.length; i++) {
                const start = Math.max(0, i - window + 1);
                const slice = v.slice(start, i + 1);
                const ref = slice.reduce((a, b) => a + b, 0) / slice.length;
                expect(fast[i]).toBeCloseTo(ref, 9);
            }
        });
        it("returns [] for invalid input", () => {
            expect(stats.calculateMovingAverage([], 3)).toEqual([]);
            expect(stats.calculateMovingAverage([1, 2, 3], 0)).toEqual([]);
        });
    });

    describe("RunningStats (Welford online algorithm)", () => {
        it("matches batch mean / std-dev for a known sequence", () => {
            const v = [2, 4, 4, 4, 5, 5, 7, 9];
            const r = new stats.RunningStats();
            v.forEach((x) => r.push(x));
            expect(r.count()).toBe(v.length);
            expect(r.mean()).toBeCloseTo(stats.calculateMean(v), 12);
            expect(r.stdDev()).toBeCloseTo(stats.calculateStdDev(v), 12);
            expect(r.sampleStdDev()).toBeCloseTo(stats.calculateSampleStdDev(v), 12);
        });

        it("agrees with batch stats on a large random stream", () => {
            const v = Array.from({ length: 5000 }, () => (Math.random() - 0.5) * 1e6);
            const r = new stats.RunningStats();
            v.forEach((x) => r.push(x));
            // Welford is numerically stable — should match batch within float precision
            expect(r.mean()).toBeCloseTo(stats.calculateMean(v), 6);
            expect(r.stdDev()).toBeCloseTo(stats.calculateStdDev(v), 6);
        });

        it("supports remove() to roll a sliding window", () => {
            const r = new stats.RunningStats();
            const window = [];
            const W = 50;
            // push 200 samples, evict oldest after window fills
            for (let i = 0; i < 200; i++) {
                const x = Math.sin(i / 7) * 100 + 50;
                window.push(x);
                r.push(x);
                if (window.length > W) {
                    const evicted = window.shift();
                    r.remove(evicted);
                }
            }
            expect(r.count()).toBe(W);
            expect(r.mean()).toBeCloseTo(stats.calculateMean(window), 6);
            expect(r.stdDev()).toBeCloseTo(stats.calculateStdDev(window), 6);
        });

        it("ignores non-finite values silently", () => {
            const r = new stats.RunningStats();
            r.push(1);
            r.push(NaN);
            r.push(Infinity);
            r.push(2);
            expect(r.count()).toBe(2);
            expect(r.mean()).toBeCloseTo(1.5, 12);
        });

        it("reset() clears all state", () => {
            const r = new stats.RunningStats();
            [1, 2, 3].forEach((x) => r.push(x));
            r.reset();
            expect(r.count()).toBe(0);
            expect(r.mean()).toBe(0);
            expect(r.stdDev()).toBe(0);
        });
    });
});
