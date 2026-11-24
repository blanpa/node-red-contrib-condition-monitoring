/* Physically motivated vibration signal generators (acceleration in g). */
"use strict";

// Deterministic PRNG (mulberry32) + Box-Muller normal
function rng(seed) {
    let a = seed >>> 0;
    const u = () => {
        a += 0x6d2b79f5;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const normal = () => {
        const u1 = Math.max(u(), 1e-12);
        const u2 = u();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    return { u, normal };
}

/**
 * Rolling-element bearing model.
 *  - Each defect impact excites a damped structural resonance (fRes, zeta).
 *  - Impacts repeat at the fault frequency with random slip jitter.
 *  - Inner-race defects rotate through the load zone -> amplitude modulated at 1X;
 *    a rolling-element defect is carried round by the cage -> modulated at FTF.
 *  - Plus 1X unbalance, broadband noise, optional harmonics series (looseness).
 */
function bearingSignal(p) {
    const {
        fs,
        n,
        seed = 1,
        shaftHz,
        unbalanceG = 0.05, // 1X sinusoid amplitude (g)
        noiseG = 0.02, // white noise σ (g)
        fRes = 4000,
        zeta = 0.05,
        faultHz = 0, // impact repetition frequency (0 = healthy)
        impactG = 0.3, // impact amplitude (g)
        loadModulation = 0, // 0..1, amplitude modulation depth (inner race / rolling element)
        modulationHz = 0, // modulation frequency; 0 = shaft frequency (inner race). A ball defect is modulated at the cage frequency.
        slip = 0.01, // relative jitter of impact spacing
        loosenessG = 0 // amplitude of a 1X impact train (rattling)
    } = p;
    const r = rng(seed);
    const x = new Float64Array(n);
    const dt = 1 / fs;
    // 1X unbalance + noise
    for (let i = 0; i < n; i++) {
        x[i] = unbalanceG * Math.sin(2 * Math.PI * shaftHz * i * dt) + noiseG * r.normal();
    }
    const ring = (t0, amp) => {
        // decaying sinusoid at fRes, ~ 8 time constants long
        const tau = 1 / (2 * Math.PI * fRes * zeta);
        const len = Math.min(n, Math.round((8 * tau) / dt));
        const i0 = Math.round(t0 / dt);
        for (let k = 0; k < len && i0 + k < n; k++) {
            const t = k * dt;
            x[i0 + k] += amp * Math.exp(-t / tau) * Math.sin(2 * Math.PI * fRes * t);
        }
    };
    if (faultHz > 0) {
        let t = r.u() / faultHz;
        while (t < n * dt) {
            const mod = 1 + loadModulation * Math.cos(2 * Math.PI * (modulationHz > 0 ? modulationHz : shaftHz) * t);
            ring(t, impactG * Math.max(0, mod) * (0.8 + 0.4 * r.u()));
            t += (1 / faultHz) * (1 + slip * r.normal());
        }
    }
    if (loosenessG > 0) {
        let t = r.u() / shaftHz;
        while (t < n * dt) {
            ring(t, loosenessG * (0.7 + 0.6 * r.u()));
            t += (1 / shaftHz) * (1 + 0.005 * r.normal());
        }
    }
    return Array.from(x);
}

/** Bearing 6205-like geometry: 9 balls, d = 7.94 mm, D = 39.04 mm */
const GEOMETRY = { balls: 9, d: 7.94, D: 39.04, alpha: 0 };
function faultFreqs(shaftHz, g = GEOMETRY) {
    const ratio = (g.d / g.D) * Math.cos((g.alpha * Math.PI) / 180);
    return {
        BPFO: (g.balls / 2) * shaftHz * (1 - ratio),
        BPFI: (g.balls / 2) * shaftHz * (1 + ratio),
        BSF: (g.D / (2 * g.d)) * shaftHz * (1 - ratio * ratio),
        FTF: (shaftHz / 2) * (1 - ratio)
    };
}

module.exports = { rng, bearingSignal, faultFreqs, GEOMETRY };
