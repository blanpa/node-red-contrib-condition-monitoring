/* Envelope-mode diagnostics on physically simulated bearing signals. */
"use strict";
const path = require("path");
const H = require("./harness");
const S = require("./signals");
const signalAnalyzer = require(path.join(H.REPO, "nodes/signal-analyzer.js"));

const fs = 25600; // PRONOSTIA-like
const n = 32768; // 1.28 s
const rpm = 1800;
const shaftHz = rpm / 60;
const F = S.faultFreqs(shaftHz);

const base = {
    type: "signal-analyzer",
    mode: "envelope",
    fftSize: n,
    samplingRate: fs,
    envelopeBandLow: 2000,
    envelopeBandHigh: 6000,
    shaftSpeed: rpm,
    bearingBalls: S.GEOMETRY.balls,
    bearingBallDiameter: S.GEOMETRY.d,
    bearingPitchDiameter: S.GEOMETRY.D,
    bearingContactAngle: 0
};

function summarize(out) {
    const m = out.anomaly[0] || out.normal[0];
    const types = {};
    (m.bearingFaults || []).forEach((f) => {
        types[f.type] = (types[f.type] || 0) + 1;
    });
    return { hasFault: m.hasFault, types, freqs: m.bearingFreqs, shaft: m.shaftFrequency, msg: m };
}

function line(name, expect, r) {
    const t = Object.entries(r.types)
        .map(([k, v]) => k + "×" + v)
        .join(" ");
    console.log(`  ${name.padEnd(34)} hasFault=${String(r.hasFault).padEnd(5)} ${t || "-"}`);
    console.log(`  ${"".padEnd(34)} expected: ${expect}`);
}

(async () => {
    await H.startServer();
    console.log(
        `Bearing 6205-like @ ${rpm} rpm: BPFO=${F.BPFO.toFixed(1)} BPFI=${F.BPFI.toFixed(1)} BSF=${F.BSF.toFixed(1)} FTF=${F.FTF.toFixed(1)} Hz`
    );
    console.log("");

    const scenarios = [
        {
            name: "healthy (noise + 1X only)",
            expect: "no faults",
            seeds: [1, 2, 3, 4, 5],
            sig: (seed) => S.bearingSignal({ fs, n, seed, shaftHz, unbalanceG: 0.05, noiseG: 0.03 })
        },
        {
            name: "healthy, noisy (σ=0.1 g)",
            expect: "no faults",
            seeds: [11, 12, 13],
            sig: (seed) => S.bearingSignal({ fs, n, seed, shaftHz, unbalanceG: 0.05, noiseG: 0.1 })
        },
        {
            name: "outer-race defect (BPFO, no modulation)",
            expect: "BPFO harmonics, no BPFI-Sideband",
            seeds: [21, 22, 23],
            sig: (seed) =>
                S.bearingSignal({
                    fs,
                    n,
                    seed,
                    shaftHz,
                    faultHz: F.BPFO,
                    impactG: 0.3,
                    loadModulation: 0,
                    noiseG: 0.03
                })
        },
        {
            name: "inner-race defect (BPFI, 1X modulated)",
            expect: "BPFI + BPFI-Sideband, no BPFO",
            seeds: [31, 32, 33],
            sig: (seed) =>
                S.bearingSignal({
                    fs,
                    n,
                    seed,
                    shaftHz,
                    faultHz: F.BPFI,
                    impactG: 0.3,
                    loadModulation: 0.7,
                    noiseG: 0.03
                })
        },
        {
            name: "inner-race, weak (0.08 g in 0.05 g noise)",
            expect: "BPFI (early stage)",
            seeds: [41, 42, 43],
            sig: (seed) =>
                S.bearingSignal({
                    fs,
                    n,
                    seed,
                    shaftHz,
                    faultHz: F.BPFI,
                    impactG: 0.08,
                    loadModulation: 0.7,
                    noiseG: 0.05
                })
        },
        {
            name: "looseness (1X impact train)",
            expect: "Looseness (1X harmonics), no bearing lines",
            seeds: [51, 52, 53],
            sig: (seed) => S.bearingSignal({ fs, n, seed, shaftHz, loosenessG: 0.3, noiseG: 0.03 })
        }
    ];

    const FLOORS = (process.env.FLOORS || "8").split(",").map(Number);
    for (const sc of scenarios) {
        console.log(sc.name);
        for (const seed of sc.seeds) {
            for (const floor of FLOORS) {
                const out = await H.run(
                    signalAnalyzer,
                    base,
                    [{ payload: sc.sig(seed), config: { envelopePeakFloor: floor } }],
                    { expected: 1 }
                );
                line("seed " + seed + " floor " + floor, sc.expect, summarize(out));
            }
        }
        console.log("");
    }

    // Variable speed: the same inner-race fault at 1200 rpm
    console.log("variable speed: inner-race fault at 1200 rpm, node configured for 1800 rpm");
    const rpm2 = 1200;
    const F2 = S.faultFreqs(rpm2 / 60);
    const sig2 = S.bearingSignal({
        fs,
        n,
        seed: 61,
        shaftHz: rpm2 / 60,
        faultHz: F2.BPFI,
        impactG: 0.3,
        loadModulation: 0.7,
        noiseG: 0.03
    });
    const without = summarize(await H.run(signalAnalyzer, base, [{ payload: sig2 }], { expected: 1 }));
    line("without msg.rpm", "misses or misreads (freqs for 1800 rpm)", without);
    console.log(`  ${"".padEnd(34)} used BPFI=${without.freqs.BPFI.toFixed(1)} Hz, true BPFI=${F2.BPFI.toFixed(1)} Hz`);
    const withRpm = summarize(await H.run(signalAnalyzer, base, [{ payload: sig2, rpm: rpm2 }], { expected: 1 }));
    line("with msg.rpm = 1200", "BPFI + sidebands", withRpm);
    console.log(`  ${"".padEnd(34)} used BPFI=${withRpm.freqs.BPFI.toFixed(1)} Hz (source=${withRpm.freqs.source})`);

    await H.stopServer();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
