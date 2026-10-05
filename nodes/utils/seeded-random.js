/**
 * Seeded pseudo-random numbers
 * ============================
 *
 * One deterministic generator (mulberry32) for the simulator nodes
 * (condition-monitoring-source, json-source, image-source). A configured seed
 * must keep producing exactly the same stream from release to release —
 * `test/seeded-sources-pin_spec.js` pins it — so do not change the arithmetic.
 *
 * @module utils/seeded-random
 */

"use strict";

/**
 * Create a mulberry32 generator.
 *
 * @param {number} seed  Any number; it is reduced to a 32-bit integer.
 * @returns {function(): number} Generator returning floats in [0, 1).
 */
function mulberry32(seed) {
    let a = seed;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

module.exports = { mulberry32 };
