/* ISO 20816 rating from an accelerometer waveform: spectral integration vs the old single-frequency rule. */
"use strict";
const path = require("path");
const H = require("./harness");
const S = require("./signals");
const signalAnalyzer = require(path.join(H.REPO, "nodes/signal-analyzer.js"));

const fs = 20000;
const n = 16384; // 0.82 s
const G = 9.80665;

// Motor at 1800 rpm. Velocity content (what ISO rates): 1X and 2X in mm/s.
// Acceleration content that carries almost no velocity: bearing resonance at 3.2 kHz.
function motor(p) {
    const { v1x, v2x = 0, resG = 0, noiseG = 0.02, seed = 7 } = p;
    const r = S.rng(seed);
    const f1 = 30;
    const a1 = (2 * Math.PI * f1 * v1x) / 1000 / G; // m/s -> m/s² -> g
    const a2 = (2 * Math.PI * 2 * f1 * v2x) / 1000 / G;
    const x = new Array(n);
    for (let i = 0; i < n; i++) {
        const t = i / fs;
        x[i] =
            a1 * Math.sin(2 * Math.PI * f1 * t) +
            a2 * Math.sin(2 * Math.PI * 2 * f1 * t) +
            resG * Math.sin(2 * Math.PI * 3200 * t) * (1 + 0.5 * Math.sin(2 * Math.PI * 107.5 * t)) +
            noiseG * r.normal();
    }
    return x;
}

const cases = [
    { name: "smooth motor: 1X = 1.0 mm/s, no HF", v1x: 1.0, resG: 0 },
    { name: "1X = 2.0 mm/s + 2X = 0.8 mm/s", v1x: 2.0, v2x: 0.8, resG: 0 },
    { name: "1X = 2.0 mm/s + bearing HF 0.5 g @3.2 kHz", v1x: 2.0, resG: 0.5 },
    { name: "1X = 2.0 mm/s + bearing HF 2.0 g @3.2 kHz", v1x: 2.0, resG: 2.0 },
    { name: "1X = 5.0 mm/s (real zone D case)", v1x: 5.0, resG: 0.3 }
];

(async () => {
    await H.startServer();
    console.log("ISO 20816-3, group2_rigid (A/B 1.4, B/C 2.8, C/D 4.5 mm/s), accelerometer input in g");
    console.log("");
    for (const c of cases) {
        const sig = motor(c);
        const out = await H.run(
            signalAnalyzer,
            {
                type: "signal-analyzer",
                mode: "vibration",
                windowSize: n,
                samplingRate: fs,
                vibInputUnit: "g",
                shaftSpeed: 1800,
                iso10816Class: "group2_rigid"
            },
            [{ payload: sig }],
            { expected: 1 }
        );
        const m = (out.normal[0] || out.anomaly[0]).payload;
        const iso = m.iso20816;
        // expected true velocity RMS from the velocity content only
        const vTrue = Math.sqrt((c.v1x ** 2 + (c.v2x || 0) ** 2) / 2);
        // what the old single-frequency rule would say: rms_a / (2π·30)
        const oldV = (m.rms * G * 1000) / (2 * Math.PI * 30);
        const zoneOf = (v) => (v <= 1.4 ? "A" : v <= 2.8 ? "B" : v <= 4.5 ? "C" : "D");
        console.log(c.name);
        console.log(
            `   true v_rms ≈ ${vTrue.toFixed(2)} mm/s (zone ${zoneOf(vTrue)}) | node: ${iso.rmsVelocity.toFixed(2)} mm/s zone ${iso.zone} via ${iso.conversion} | old rule: ${oldV.toFixed(2)} mm/s zone ${zoneOf(oldV)}`
        );
    }
    await H.stopServer();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
