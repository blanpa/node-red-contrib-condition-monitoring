"use strict";

/**
 * Sliding-window building blocks of utils/statistics: the ring buffer that
 * replaced the `{timestamp, value}` arrays of the detector nodes, and the
 * streaming covariance behind multi-value-processor's Mahalanobis path.
 */
const stats = require("../nodes/utils/statistics");
const { seededRandom } = require("./stub-runtime");

// Reference: two-pass sample covariance of a list of rows
function batchCovariance(rows) {
    const m = rows.length;
    const p = rows[0].length;
    const means = new Array(p).fill(0);
    rows.forEach((row) => {
        for (let i = 0; i < p; i++) means[i] += row[i];
    });
    for (let i = 0; i < p; i++) means[i] /= m;
    const cov = [];
    for (let i = 0; i < p; i++) cov.push(new Array(p).fill(0));
    rows.forEach((row) => {
        for (let i = 0; i < p; i++) {
            for (let j = 0; j < p; j++) cov[i][j] += (row[i] - means[i]) * (row[j] - means[j]);
        }
    });
    for (let i = 0; i < p; i++) {
        for (let j = 0; j < p; j++) cov[i][j] /= m - 1;
    }
    return { means: means, covariance: cov };
}

function expectClose(actual, expected, relTol) {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(relTol * Math.max(1, Math.abs(expected)));
}

describe("createRingBuffer", () => {
    it("rejects a capacity that is not a positive integer", () => {
        [0, -1, 1.5, "10", NaN, undefined].forEach((bad) => {
            expect(() => stats.createRingBuffer(bad)).toThrow(/capacity/);
        });
    });

    it("fills up, then evicts the oldest sample and returns it", () => {
        const ring = stats.createRingBuffer(3);
        expect(ring.length).toBe(0);
        expect(ring.last()).toBeUndefined();

        expect(ring.push(1)).toBeUndefined();
        expect(ring.push(2)).toBeUndefined();
        expect(ring.push(3)).toBeUndefined();
        expect(ring.length).toBe(3);
        expect(ring.toArray()).toEqual([1, 2, 3]);

        expect(ring.push(4)).toBe(1);
        expect(ring.push(5)).toBe(2);
        expect(ring.length).toBe(3);
        expect(ring.toArray()).toEqual([3, 4, 5]);
        expect(ring.get(0)).toBe(3);
        expect(ring.get(2)).toBe(5);
        expect(ring.get(3)).toBeUndefined();
        expect(ring.get(-1)).toBeUndefined();
        expect(ring.last()).toBe(5);
        expect(ring.capacity).toBe(3);
    });

    it("serialises as the plain array of its samples", () => {
        const ring = stats.createRingBuffer(2);
        ring.push(1.5);
        ring.push(-2);
        ring.push(7);
        expect(JSON.parse(JSON.stringify({ w: ring }))).toEqual({ w: [-2, 7] });
    });

    it("clears", () => {
        const ring = stats.createRingBuffer(4);
        [1, 2, 3, 4, 5].forEach((v) => ring.push(v));
        ring.clear();
        expect(ring.length).toBe(0);
        expect(ring.toArray()).toEqual([]);
        ring.push(9);
        expect(ring.toArray()).toEqual([9]);
    });

    it("holds exactly what an array with shift() held, through growth and many turnovers", () => {
        // The backing store starts at 64 slots and grows towards the capacity
        [1, 2, 63, 64, 65, 100, 1000].forEach((capacity) => {
            const ring = stats.createRingBuffer(capacity);
            const reference = [];
            const rng = seededRandom(capacity);
            for (let i = 0; i < 3000; i++) {
                const v = rng.gauss();
                reference.push(v);
                const evicted = ring.push(v);
                if (reference.length > capacity) {
                    expect(evicted).toBe(reference.shift());
                } else {
                    expect(evicted).toBeUndefined();
                }
                expect(ring.length).toBe(reference.length);
                if (i % 97 === 0 || i < 70) {
                    expect(ring.toArray()).toEqual(reference);
                    expect(ring.get(0)).toBe(reference[0]);
                    expect(ring.last()).toBe(reference[reference.length - 1]);
                }
            }
            expect(ring.toArray()).toEqual(reference);
        });
    });
});

describe("RunningCovariance", () => {
    it("rejects a dimension count that is not a positive integer", () => {
        expect(() => new stats.RunningCovariance(0)).toThrow();
        expect(() => new stats.RunningCovariance(2.5)).toThrow();
    });

    it("matches the two-pass covariance after pushes only", () => {
        const rng = seededRandom(1);
        const acc = new stats.RunningCovariance(3);
        const rows = [];
        expect(acc.covariance()).toBeNull();
        for (let n = 0; n < 500; n++) {
            const x = rng.gauss();
            const row = [10 + x, -5 + 2 * x + 0.1 * rng.gauss(), 100 * rng.gauss()];
            rows.push(row);
            acc.push(row);
            if (n >= 1 && n % 7 === 0) {
                const ref = batchCovariance(rows);
                expect(acc.count()).toBe(rows.length);
                for (let i = 0; i < 3; i++) {
                    expectClose(acc.means()[i], ref.means[i], 1e-12);
                    for (let j = 0; j < 3; j++) expectClose(acc.covariance()[i][j], ref.covariance[i][j], 1e-12);
                }
            }
        }
    });

    it("matches the two-pass covariance of a sliding window to 1e-9 (reverse update)", () => {
        const rng = seededRandom(2);
        const windowSize = 50;
        const acc = new stats.RunningCovariance(3);
        const window = [];
        let removals = 0;
        for (let n = 0; n < 3000; n++) {
            const x = rng.gauss();
            const row = [x, x + 0.3 * rng.gauss(), rng.gauss() + (n % 500 < 250 ? 0 : 20)];
            window.push(row);
            acc.push(row);
            if (window.length > windowSize) {
                acc.remove(window.shift());
                // The nodes rebuild once per window turnover for exactly this
                // reason: the reverse update accumulates rounding error.
                if (++removals >= windowSize) {
                    acc.reset();
                    window.forEach((r) => acc.push(r));
                    removals = 0;
                }
            }
            if (window.length >= 2) {
                const ref = batchCovariance(window);
                expect(acc.count()).toBe(window.length);
                for (let i = 0; i < 3; i++) {
                    expectClose(acc.means()[i], ref.means[i], 1e-9);
                    expectClose(acc.variance(i), (ref.covariance[i][i] * (window.length - 1)) / window.length, 1e-9);
                    for (let j = 0; j < 3; j++) expectClose(acc.covariance()[i][j], ref.covariance[i][j], 1e-9);
                }
            }
        }
    });

    it("ignores rows of the wrong length or with non-finite entries", () => {
        const acc = new stats.RunningCovariance(2);
        acc.push([1, 2]);
        acc.push([3, 4, 5]);
        acc.push([NaN, 1]);
        acc.push([1, Infinity]);
        acc.push(null);
        acc.push("12");
        expect(acc.count()).toBe(1);
        acc.remove([NaN, 1]);
        expect(acc.count()).toBe(1);
    });

    it("empties cleanly when the last row is removed, and on reset", () => {
        const acc = new stats.RunningCovariance(2);
        acc.push([1, 2]);
        acc.push([2, 4]);
        acc.remove([1, 2]);
        expect(acc.count()).toBe(1);
        expect(acc.means()).toEqual([2, 4]);
        expect(acc.variance(0)).toBeCloseTo(0, 12);
        acc.remove([2, 4]);
        expect(acc.count()).toBe(0);
        expect(acc.means()).toEqual([0, 0]);
        acc.push([5, 5]);
        acc.reset();
        expect(acc.count()).toBe(0);
        expect(acc.covariance()).toBeNull();
    });
});
