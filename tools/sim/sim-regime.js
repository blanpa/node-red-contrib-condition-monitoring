/* Two-speed pump: anomaly detection with and without operating-point regimes. */
"use strict";
const path = require("path");
const H = require("./harness");
const S = require("./signals");
const anomalyDetector = require(path.join(H.REPO, "nodes/anomaly-detector.js"));

// Vibration RMS (mm/s) per operating point, with realistic scatter.
const LEVELS = { "1500rpm": { mean: 1.2, sd: 0.06 }, "3000rpm": { mean: 2.8, sd: 0.12 } };

function stream(seed) {
    const r = S.rng(seed);
    const msgs = [];
    // Phase 1: 12 blocks of 40 samples alternating between speeds (480 samples)
    for (let b = 0; b < 12; b++) {
        const key = b % 2 === 0 ? "1500rpm" : "3000rpm";
        for (let i = 0; i < 40; i++) {
            msgs.push({ payload: LEVELS[key].mean + LEVELS[key].sd * r.normal(), regime: key, phase: "alternating" });
        }
    }
    // Phase 2: bearing wear at 3000 rpm: RMS rises 2.8 -> 4.6 over 120 samples, 1500 rpm block in between
    for (let i = 0; i < 120; i++) {
        if (i === 60) {
            for (let j = 0; j < 40; j++) {
                msgs.push({ payload: 1.2 + 0.06 * r.normal(), regime: "1500rpm", phase: "fault-interlude" });
            }
        }
        const mean = 2.8 + (1.8 * i) / 120;
        msgs.push({ payload: mean + 0.12 * r.normal(), regime: "3000rpm", phase: "fault", faultStep: i });
    }
    return msgs;
}

function report(label, out) {
    const all = out.normal.concat(out.anomaly);
    const alarms = out.anomaly;
    const byPhase = {};
    alarms.forEach((m) => (byPhase[m.phase] = (byPhase[m.phase] || 0) + 1));
    const firstFault = alarms.filter((m) => m.phase === "fault").sort((a, b) => a.faultStep - b.faultStep)[0];
    console.log(label);
    console.log(
        `   samples=${all.length} alarms=${alarms.length}  false alarms while alternating: ${byPhase["alternating"] || 0}, during interlude: ${byPhase["fault-interlude"] || 0}`
    );
    console.log(
        `   fault alarms: ${byPhase["fault"] || 0}, first at fault step ${firstFault ? firstFault.faultStep : "-"} (RMS ≈ ${firstFault ? firstFault.payload.toFixed(2) : "-"} mm/s, wear +${firstFault ? (((firstFault.payload - 2.8) / 1.8) * 100).toFixed(0) : "-"} %)`
    );
}

(async () => {
    await H.startServer();
    const cfg = {
        type: "anomaly-detector",
        method: "zscore",
        zscoreThreshold: 3,
        zscoreWarning: 2,
        windowSize: 60,
        consecutiveCount: 2
    };
    for (const seed of [1, 2]) {
        const msgs = stream(seed);
        console.log(`--- seed ${seed}: ${msgs.length} samples`);
        report("single baseline (no regime)", await H.run(anomalyDetector, cfg, msgs, { expected: msgs.length }));
        report(
            "regimeProperty = 'regime'",
            await H.run(anomalyDetector, Object.assign({ regimeProperty: "regime" }, cfg), msgs, {
                expected: msgs.length
            })
        );
    }
    await H.stopServer();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
