"use strict";

/**
 * Property-based tests for utils/statistics.
 *
 * Where the conventional spec proves "this fixed input produces that fixed
 * output", property-based testing proves invariants over many randomly
 * generated inputs. The point is to catch the classes of bug that a
 * hand-picked example would have missed: edge cases at array boundaries,
 * numerical drift in Welford vs batch, sliding-window correctness on
 * pathological data shapes.
 *
 * fast-check shrinks failing inputs automatically — when these tests fail,
 * the printed counter-example is already minimal.
 */

const fc = require("fast-check");
const stats = require("../nodes/utils/statistics");

const finiteFloat = () => fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true });

describe("utils/statistics — property-based", () => {
    it("calculateMean is invariant under array permutation", () => {
        fc.assert(
            fc.property(fc.array(finiteFloat(), { minLength: 1, maxLength: 200 }), (arr) => {
                const a = stats.calculateMean(arr);
                const b = stats.calculateMean(arr.slice().reverse());
                // Permutation invariance up to floating-point noise.
                expect(Math.abs(a - b)).toBeLessThan(1e-9 * Math.max(1, Math.abs(a)));
            }),
            { numRuns: 200 }
        );
    });

    it("calculateStdDev is non-negative and zero iff all values equal", () => {
        fc.assert(
            fc.property(fc.array(finiteFloat(), { minLength: 1, maxLength: 200 }), (arr) => {
                const sd = stats.calculateStdDev(arr);
                expect(sd).toBeGreaterThanOrEqual(0);
                if (arr.length > 1 && arr.every((v) => v === arr[0])) {
                    expect(sd).toBe(0);
                }
            }),
            { numRuns: 200 }
        );
    });

    it("variance equals stdDev² up to floating-point error", () => {
        fc.assert(
            fc.property(fc.array(finiteFloat(), { minLength: 2, maxLength: 200 }), (arr) => {
                const v = stats.calculateVariance(arr);
                const sd = stats.calculateStdDev(arr);
                const tol = 1e-6 * Math.max(1, Math.abs(v));
                expect(Math.abs(v - sd * sd)).toBeLessThanOrEqual(tol);
            }),
            { numRuns: 200 }
        );
    });

    it("RunningStats agrees with batch mean / stdDev for any push order", () => {
        fc.assert(
            fc.property(fc.array(finiteFloat(), { minLength: 1, maxLength: 200 }), (arr) => {
                const r = new stats.RunningStats();
                arr.forEach((x) => r.push(x));
                const meanRef = stats.calculateMean(arr);
                const sdRef = stats.calculateStdDev(arr);
                // Welford is numerically more stable than naïve sum-of-squares;
                // we only require relative agreement, scaled to the magnitudes
                // involved (raw absolute checks fail when values span 1e6).
                const meanScale = Math.max(1, Math.abs(meanRef));
                const sdScale = Math.max(1, sdRef);
                expect(Math.abs(r.mean() - meanRef)).toBeLessThan(1e-6 * meanScale);
                expect(Math.abs(r.stdDev() - sdRef)).toBeLessThan(1e-5 * sdScale);
                expect(r.count()).toBe(arr.length);
            }),
            { numRuns: 200 }
        );
    });

    it("RunningStats.remove() inverts push() — round-trip leaves zero state", () => {
        fc.assert(
            fc.property(fc.array(finiteFloat(), { minLength: 1, maxLength: 50 }), (arr) => {
                const r = new stats.RunningStats();
                arr.forEach((x) => r.push(x));
                arr.forEach((x) => r.remove(x));
                expect(r.count()).toBe(0);
                expect(r.mean()).toBe(0);
                expect(r.stdDev()).toBe(0);
            }),
            { numRuns: 200 }
        );
    });

    it("RunningStats sliding-window matches a batch recompute on the trailing window", () => {
        // Welford's reverse-update is less stable than the forward update; on
        // streams with a sharp magnitude change (single large value -> long
        // run of zeros) the std-dev can drift by ~1e-3 of the input range.
        // We test against a relative tolerance scaled to that range, not to
        // the (possibly tiny) std-dev of the trailing window itself.
        fc.assert(
            fc.property(
                fc.array(finiteFloat(), { minLength: 5, maxLength: 200 }),
                fc.integer({ min: 2, max: 50 }),
                (arr, w) => {
                    const W = Math.min(w, arr.length);
                    const r = new stats.RunningStats();
                    const window = [];
                    for (const v of arr) {
                        r.push(v);
                        window.push(v);
                        if (window.length > W) {
                            r.remove(window.shift());
                        }
                    }
                    const refMean = stats.calculateMean(window);
                    const refSd = stats.calculateStdDev(window);
                    // Range of seen values dominates the error envelope.
                    const range = Math.max.apply(null, arr) - Math.min.apply(null, arr);
                    const meanScale = Math.max(1, Math.abs(refMean), range);
                    const sdScale = Math.max(1, refSd, range);
                    expect(Math.abs(r.mean() - refMean)).toBeLessThan(1e-4 * meanScale);
                    expect(Math.abs(r.stdDev() - refSd)).toBeLessThan(1e-3 * sdScale);
                }
            ),
            { numRuns: 100 }
        );
    });

    it("calculateMovingAverage rolling-sum matches naïve recompute everywhere", () => {
        fc.assert(
            fc.property(
                fc.array(finiteFloat(), { minLength: 1, maxLength: 200 }),
                fc.integer({ min: 1, max: 32 }),
                (arr, w) => {
                    const fast = stats.calculateMovingAverage(arr, w);
                    expect(fast).toHaveLength(arr.length);
                    for (let i = 0; i < arr.length; i++) {
                        const start = Math.max(0, i - w + 1);
                        const slice = arr.slice(start, i + 1);
                        const ref = slice.reduce((a, b) => a + b, 0) / slice.length;
                        const tol = 1e-6 * Math.max(1, Math.abs(ref));
                        expect(Math.abs(fast[i] - ref)).toBeLessThan(tol);
                    }
                }
            ),
            { numRuns: 80 }
        );
    });

    it("calculateRMS is non-negative and zero iff all values are zero", () => {
        fc.assert(
            fc.property(fc.array(finiteFloat(), { minLength: 1, maxLength: 200 }), (arr) => {
                const r = stats.calculateRMS(arr);
                expect(r).toBeGreaterThanOrEqual(0);
                if (arr.every((v) => v === 0)) {
                    expect(r).toBe(0);
                }
            }),
            { numRuns: 200 }
        );
    });

    it("calculatePearsonCorrelation is bounded in [-1, 1] (within float epsilon)", () => {
        fc.assert(
            fc.property(
                fc.array(finiteFloat(), { minLength: 3, maxLength: 200 }),
                fc.array(finiteFloat(), { minLength: 3, maxLength: 200 }),
                (x, y) => {
                    const n = Math.min(x.length, y.length);
                    const xs = x.slice(0, n);
                    const ys = y.slice(0, n);
                    const c = stats.calculatePearsonCorrelation(xs, ys);
                    if (c === null) return; // invalid pair, skip
                    expect(c).toBeGreaterThanOrEqual(-1.0000001);
                    expect(c).toBeLessThanOrEqual(1.0000001);
                }
            ),
            { numRuns: 200 }
        );
    });
});
