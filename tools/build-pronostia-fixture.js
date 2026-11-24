#!/usr/bin/env node
/**
 * Build a small, deterministic degradation fixture from the PRONOSTIA / FEMTO-ST
 * bearing run-to-failure data (IEEE PHM 2012 Data Challenge), Bearing1_1.
 *
 * The raw set is ~2 800 CSV snapshots of 2 560 samples each (25.6 kHz, 0.1 s
 * every 10 s, first operating condition: 1 800 rpm, 4 000 N). Committing it is
 * out of the question, so this script downloads every N-th snapshot, reduces
 * each to a handful of time-domain indicators and writes them to
 * `test/fixtures/pronostia-bearing1_1-trend.json` (a few kB). The unit tests use
 * that trend as a real, non-synthetic input for trend-predictor and
 * anomaly-detector.
 *
 * Usage:
 *   node tools/build-pronostia-fixture.js --download [--step 50] [--out <file>]
 *   node tools/build-pronostia-fixture.js --from <dir-with-acc_*.csv> [--out <file>]
 *
 * The download source is the public mirror
 *   https://github.com/wkzs111/phm-ieee-2012-data-challenge-dataset
 * Column layout of each row: hour, minute, second, microsecond, accel_h (g), accel_v (g).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const BASE_URL =
    "https://raw.githubusercontent.com/wkzs111/phm-ieee-2012-data-challenge-dataset/master/Learning_set/Bearing1_1/";
const TOTAL_FILES = 2803;
const SNAPSHOT_INTERVAL_S = 10;
const SAMPLE_RATE_HZ = 25600;

function parseArgs(argv) {
    const args = { step: 50, out: path.join(__dirname, "..", "test", "fixtures", "pronostia-bearing1_1-trend.json") };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--download") args.download = true;
        else if (a === "--from") args.from = argv[++i];
        else if (a === "--step") args.step = parseInt(argv[++i], 10);
        else if (a === "--out") args.out = argv[++i];
        else if (a === "--help" || a === "-h") args.help = true;
        else throw new Error("Unknown argument: " + a);
    }
    return args;
}

function fetchText(url) {
    return new Promise(function (resolve, reject) {
        https
            .get(url, function (res) {
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error("HTTP " + res.statusCode + " for " + url));
                    return;
                }
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            })
            .on("error", reject);
    });
}

function fileName(index) {
    return "acc_" + String(index).padStart(5, "0") + ".csv";
}

function indicators(values) {
    const n = values.length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[i];
    const mean = sum / n;
    let ss = 0;
    let m4 = 0;
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
        const v = values[i];
        const dv = v - mean;
        ss += dv * dv;
        m4 += dv * dv * dv * dv;
        sumSq += v * v;
        if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    const variance = ss / n;
    const rms = Math.sqrt(sumSq / n);
    const kurtosis = variance > 0 ? m4 / n / (variance * variance) : 0;
    return {
        rms: round(rms, 4),
        peak: round(peak, 4),
        crest: round(rms > 0 ? peak / rms : 0, 3),
        kurtosis: round(kurtosis, 3)
    };
}

function round(x, digits) {
    const f = Math.pow(10, digits);
    return Math.round(x * f) / f;
}

function reduceSnapshot(csv) {
    const h = [];
    const v = [];
    const lines = csv.split(/\r?\n/);
    for (const line of lines) {
        if (!line) continue;
        const cols = line.split(",");
        if (cols.length < 6) continue;
        const ah = parseFloat(cols[4]);
        const av = parseFloat(cols[5]);
        if (Number.isFinite(ah)) h.push(ah);
        if (Number.isFinite(av)) v.push(av);
    }
    if (h.length === 0) throw new Error("no samples parsed");
    return { horizontal: indicators(h), vertical: indicators(v), samples: h.length };
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help || (!args.download && !args.from)) {
        console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\*\*?/, ""));
        process.exit(args.help ? 0 : 1);
    }

    const indices = [];
    for (let i = 1; i <= TOTAL_FILES; i += args.step) indices.push(i);
    if (indices[indices.length - 1] !== TOTAL_FILES) indices.push(TOTAL_FILES);

    const points = [];
    for (const idx of indices) {
        const name = fileName(idx);
        let csv;
        if (args.from) {
            const p = path.join(args.from, name);
            if (!fs.existsSync(p)) {
                console.warn("skip (missing): " + p);
                continue;
            }
            csv = fs.readFileSync(p, "utf8");
        } else {
            process.stdout.write("fetch " + name + "\r");
            csv = await fetchText(BASE_URL + name);
        }
        const r = reduceSnapshot(csv);
        points.push({
            index: idx,
            t_s: (idx - 1) * SNAPSHOT_INTERVAL_S,
            h: r.horizontal,
            v: r.vertical
        });
    }
    if (points.length < 10) throw new Error("only " + points.length + " snapshots reduced — refusing to write");

    const fixture = {
        source: "PRONOSTIA / FEMTO-ST, IEEE PHM 2012 Data Challenge, Learning_set/Bearing1_1",
        mirror: BASE_URL,
        license: "Data published for the IEEE PHM 2012 challenge; this file holds derived per-snapshot indicators only.",
        operatingCondition: { speed_rpm: 1800, load_N: 4000 },
        sampleRate_hz: SAMPLE_RATE_HZ,
        snapshotInterval_s: SNAPSHOT_INTERVAL_S,
        samplesPerSnapshot: 2560,
        totalSnapshots: TOTAL_FILES,
        step: args.step,
        fields: {
            index: "1-based snapshot number",
            t_s: "seconds since run start",
            h: "horizontal accelerometer, g: rms, peak, crest factor, kurtosis (unnormalised, healthy ≈ 3)",
            v: "vertical accelerometer, same indicators"
        },
        points: points
    };

    fs.writeFileSync(args.out, JSON.stringify(fixture, null, 2) + "\n");
    console.log("\nwrote " + points.length + " snapshots to " + args.out);
}

main().catch(function (err) {
    console.error(err.message);
    process.exit(1);
});
