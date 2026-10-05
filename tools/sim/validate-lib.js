/* Shared pieces of the validation campaign (tools/sim/validate.js): a
 * synchronous way to drive a node, realistic signal generators with known
 * ground truth, and small statistics / reporting helpers. */
"use strict";

const path = require("path");
const { buildStubbedNode, feed } = require(path.join("..", "..", "test", "stub-runtime"));
const { rng } = require("./signals");

/** Build a node from this package against the synchronous stub runtime. */
function makeNode(file, config) {
    const stub = buildStubbedNode(require(path.join("..", "..", "nodes", file)), Object.assign({ id: "v1" }, config));
    return {
        stub: stub,
        /** @returns the message the node sent for this input (either output), or undefined */
        send: function (msg) {
            const r = feed(stub, msg);
            return r.out2 || r.out1;
        },
        /** @returns {{msg, anomalyOutput:boolean}|null} */
        route: function (msg) {
            const r = feed(stub, msg);
            if (r.out2) return { msg: r.out2, anomalyOutput: true };
            if (r.out1) return { msg: r.out1, anomalyOutput: false };
            return null;
        }
    };
}

// ---------------------------------------------------------------- generators

/**
 * A process value as a plant historian would log it: a slow ambient swing,
 * autocorrelated (AR(1)) measurement/process noise and ADC quantisation.
 * Autocorrelation matters: it makes a short window underestimate the spread,
 * which is where real detectors get their false alarms from.
 */
function processSignal(opts) {
    const o = Object.assign(
        { n: 3000, seed: 1, level: 60, sigma: 0.5, phi: 0.8, swing: 1, swingPeriod: 2000, quantum: 0.1 },
        opts
    );
    const r = rng(o.seed);
    const innovation = o.sigma * Math.sqrt(1 - o.phi * o.phi);
    const x = new Array(o.n);
    let e = 0;
    for (let i = 0; i < o.n; i++) {
        e = o.phi * e + innovation * r.normal();
        const v = o.level + o.swing * Math.sin((2 * Math.PI * i) / o.swingPeriod) + e;
        x[i] = o.quantum > 0 ? Math.round(v / o.quantum) * o.quantum : v;
    }
    return x;
}

/** Inject a fault into a copy of `x` from index `at`. Sizes are in units of `sigma`. */
function injectFault(x, type, at, sigma, seed) {
    const y = x.slice();
    const r = rng(seed + 7919);
    if (type === "spike") {
        // three isolated outliers, 6σ, 40 samples apart
        [0, 40, 80].forEach((d, k) => (y[at + d] += (k % 2 ? -1 : 1) * 6 * sigma));
        return { y, window: [at, at + 81], points: [at, at + 40, at + 80] };
    }
    if (type === "step") {
        for (let i = at; i < y.length; i++) y[i] += 3 * sigma;
        return { y, window: [at, at + 100] };
    }
    if (type === "drift") {
        // ramp to +6σ over 600 samples, then hold
        for (let i = at; i < y.length; i++) y[i] += 6 * sigma * Math.min(1, (i - at) / 600);
        return { y, window: [at, at + 600] };
    }
    if (type === "variance") {
        for (let i = at; i < y.length; i++) y[i] += 2.5 * sigma * r.normal();
        return { y, window: [at, at + 300] };
    }
    throw new Error("unknown fault type " + type);
}

/**
 * Centrifugal pump with a wandering operating point (affinity laws):
 * flow ∝ n, pressure ∝ n², power ∝ n³, bearing temperature follows power with
 * a thermal lag. Each channel has its own sensor noise. The operating point
 * moves far more than any fault does, so no single channel can flag the fault.
 */
function pumpSignals(opts) {
    const o = Object.assign({ n: 900, seed: 1 }, opts);
    const r = rng(o.seed);
    const rows = [];
    let speed = 0.8;
    let target = 0.8;
    let temp = 45;
    for (let i = 0; i < o.n; i++) {
        if (i % 60 === 0) target = 0.6 + 0.4 * r.u(); // new set point every 60 samples
        speed += 0.1 * (target - speed) + 0.004 * r.normal();
        const flow = 120 * speed;
        const pressure = 6.5 * speed * speed;
        const power = 45 * speed * speed * speed;
        temp += 0.08 * (35 + 0.55 * power - temp);
        rows.push({
            flow: flow * (1 + 0.006 * r.normal()),
            pressure: pressure * (1 + 0.006 * r.normal()),
            power: power * (1 + 0.008 * r.normal()),
            temperature: temp + 0.15 * r.normal()
        });
    }
    return rows;
}

/**
 * Health indicator of a wearing component, sampled about once a minute with
 * jitter and occasional gaps. `shape`:
 *   linear      – steady wear
 *   exponential – accelerating wear (y = a·e^(bt))
 *   twoStage    – a long healthy plateau, then accelerating wear (typical
 *                 bearing RMS trend)
 * Returns the samples and the true time at which the threshold is crossed.
 */
function degradation(opts) {
    const o = Object.assign({ shape: "linear", seed: 1, noise: 0.03, threshold: 10, lifeMin: 3000, gaps: true }, opts);
    const r = rng(o.seed);
    const start = 1;
    const clean = function (tMin) {
        const u = tMin / o.lifeMin; // 1 at failure
        if (o.shape === "linear") return start + (o.threshold - start) * u;
        if (o.shape === "exponential") return start * Math.pow(o.threshold / start, u);
        // twoStage: flat until 40 % of life, exponential afterwards
        if (u <= 0.4) return start;
        return start * Math.pow(o.threshold / start, (u - 0.4) / 0.6);
    };
    const samples = [];
    let t = 0;
    while (t < o.lifeMin * 1.02) {
        const level = clean(t);
        // multiplicative noise (a vibration level scatters in proportion to itself)
        samples.push({ tMin: t, value: level * (1 + o.noise * r.normal()), clean: level });
        let dt = 1 + 0.2 * r.normal();
        if (o.gaps && r.u() < 0.01) dt += 20 + 40 * r.u(); // logger dropout
        t += Math.max(0.2, dt);
    }
    return { samples, failureMin: o.lifeMin, threshold: o.threshold };
}

/**
 * Gearbox acceleration: gear-mesh frequency and harmonics; a damaged gear
 * modulates the mesh once per shaft revolution (amplitude + phase), which
 * shows as sidebands spaced at the shaft frequency.
 */
function gearSignal(opts) {
    const o = Object.assign({ fs: 20000, n: 16384, seed: 1, shaftHz: 25, teeth: 23, damage: 0, noiseG: 0.05 }, opts);
    const r = rng(o.seed);
    const gmf = o.shaftHz * o.teeth;
    const x = new Array(o.n);
    const phase = 2 * Math.PI * r.u();
    for (let i = 0; i < o.n; i++) {
        const t = i / o.fs;
        const am =
            1 + o.damage * (0.6 * Math.cos(2 * Math.PI * o.shaftHz * t) + 0.3 * Math.cos(4 * Math.PI * o.shaftHz * t));
        const pm = o.damage * 0.4 * Math.sin(2 * Math.PI * o.shaftHz * t);
        let v = 0;
        for (let h = 1; h <= 3; h++) {
            v += (0.5 / h) * am * Math.cos(2 * Math.PI * h * gmf * t + h * pm + phase);
        }
        x[i] = v + 0.03 * Math.sin(2 * Math.PI * o.shaftHz * t) + o.noiseG * r.normal();
    }
    return x;
}

// ----------------------------------------------------------------- reporting

function mean(a) {
    return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
}
function median(a) {
    if (!a.length) return NaN;
    const s = a.slice().sort((p, q) => p - q);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function quantile(a, q) {
    if (!a.length) return NaN;
    const s = a.slice().sort((p, c) => p - c);
    const i = (s.length - 1) * q;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
function pct(x, digits) {
    return Number.isFinite(x) ? (100 * x).toFixed(digits === undefined ? 0 : digits) + " %" : "–";
}
function num(x, digits) {
    return Number.isFinite(x) ? x.toFixed(digits === undefined ? 1 : digits) : "–";
}

/** Markdown table from a header row and data rows. */
function table(header, rows) {
    const line = (cells) => "| " + cells.join(" | ") + " |";
    return [line(header), line(header.map(() => "---"))].concat(rows.map(line)).join("\n");
}

module.exports = {
    makeNode,
    rng,
    processSignal,
    injectFault,
    pumpSignals,
    degradation,
    gearSignal,
    mean,
    median,
    quantile,
    pct,
    num,
    table
};
