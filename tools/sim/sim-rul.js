/* RUL confidence band: does a 90 % / 99 % band contain the true failure time 90 % / 99 % of the time? */
"use strict";
const path = require("path");
const H = require("./harness");
const S = require("./signals");
const trendPredictor = require(path.join(H.REPO, "nodes/trend-predictor.js"));

const HOUR = 3600000;
const t0 = Date.UTC(2026, 0, 1);

// Linear wear: y = 10 + 0.5 t + N(0, σ). Failure threshold 60 -> true failure at t = 100 h.
// Observe 40 hourly samples, ask for RUL at t = 39 h: true remaining = 61 h.
const SLOPE = 0.5;
const THRESH = 60;
const N_OBS = 40;
const TRUE_RUL = (THRESH - 10) / SLOPE - (N_OBS - 1);

function series(seed, sigma) {
    const r = S.rng(seed);
    const msgs = [];
    for (let i = 0; i < N_OBS; i++) {
        msgs.push({ payload: 10 + SLOPE * i + sigma * r.normal(), timestamp: t0 + i * HOUR, last: i === N_OBS - 1 });
    }
    return msgs;
}

async function coverage(level, sigma, runs) {
    let covered = 0;
    let widthSum = 0;
    let pointErr = 0;
    let signedErr = 0;
    let n = 0;
    for (let seed = 1; seed <= runs; seed++) {
        const out = await H.run(
            trendPredictor,
            {
                type: "trend-predictor",
                mode: "rul",
                windowSize: N_OBS,
                failureThreshold: THRESH,
                degradationModel: "linear",
                rulUnit: "hours",
                confidenceLevel: level
            },
            series(seed, sigma),
            { expected: N_OBS - 4 }
        );
        const all = out.normal.concat(out.anomaly);
        const last = all.find((m) => m.last);
        if (!last || !last.rul || !Number.isFinite(last.rul.value)) continue;
        n++;
        const lo = last.rul.lower;
        const hi = last.rul.upper;
        if (lo <= TRUE_RUL && TRUE_RUL <= hi) covered++;
        widthSum += hi - lo;
        pointErr += Math.abs(last.rul.value - TRUE_RUL);
        signedErr += last.rul.value - TRUE_RUL;
    }
    return { n, coverage: covered / n, meanWidth: widthSum / n, meanAbsErr: pointErr / n, bias: signedErr / n };
}

(async () => {
    await H.startServer();
    console.log(`Linear wear, true RUL at observation ${N_OBS} = ${TRUE_RUL} h; 60 seeds per cell`);
    console.log("");
    for (const sigma of [1.0, 3.0]) {
        for (const level of [0.9, 0.99]) {
            const c = await coverage(level, sigma, 60);
            console.log(
                `σ=${sigma.toFixed(1)}  level=${level}  coverage=${(c.coverage * 100).toFixed(0)} %  mean band width=${c.meanWidth.toFixed(1)} h  mean |error|=${c.meanAbsErr.toFixed(1)} h  bias=${c.bias >= 0 ? "+" : ""}${c.bias.toFixed(1)} h  (n=${c.n})`
            );
        }
    }
    await H.stopServer();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
