#!/usr/bin/env node
/* Validation campaign: drive the real nodes with simulated, physically
 * motivated data whose ground truth is known, and measure what a user cares
 * about — detection rate, false alarms, diagnosis accuracy, RUL error.
 *
 *   node tools/sim/validate.js                 # all sections, prints a report
 *   node tools/sim/validate.js bearing rul     # selected sections
 *   node tools/sim/validate.js --write         # also write docs/VALIDATION.md
 *   SEEDS=40 node tools/sim/validate.js        # more Monte-Carlo runs per case
 *
 * Everything is seeded, so a run is reproducible. Not part of `npm test`: it
 * reports numbers rather than asserting them (the regression tests pin the
 * individual behaviours).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const lib = require("./validate-lib");
const { bearingSignal, faultFreqs, GEOMETRY } = require("./signals");
const { makeNode, rng, mean, median, quantile, pct, num, table } = lib;

const SEEDS = Math.max(2, parseInt(process.env.SEEDS, 10) || 20);
const sections = {};
const report = [];
const say = function (text) {
    report.push(text);
    console.log(text);
};

// ============================================================ bearing faults
sections.bearing = function () {
    say("## Bearing diagnosis (signal-analyzer, envelope mode)\n");
    say(
        "Accelerometer frames (20 kHz, 32768 samples ≈ 1.6 s) of a 6205-type bearing: every defect impact " +
            "rings a 4 kHz structural resonance, impacts repeat at the fault frequency with 1 % slip, an " +
            "inner-race defect is modulated at shaft speed. Background: 0.05 g of 1X unbalance and 0.05 g RMS " +
            "broadband noise. The node knows only the bearing geometry and `msg.rpm`.\n"
    );
    const fsHz = 20000;
    const n = 32768;
    const speeds = [900, 1500, 2970];
    const seeds = Math.max(2, Math.round(SEEDS / 2));
    const classes = ["healthy", "outer", "inner", "ball", "looseness"];
    const severities = { weak: 0.05, medium: 0.1, strong: 0.3 };

    const classify = function (out) {
        const f = out.bearingFaults || [];
        // the line a diagnosis rests on: the fundamental, or 2 × BSF for a ball defect
        const fundamental = (type) =>
            f.filter(
                (x) =>
                    x.type === type && !x.coincidesWith1X && (x.harmonic === 1 || (type === "BSF" && x.harmonic === 2))
            );
        const scores = { outer: fundamental("BPFO"), inner: fundamental("BPFI"), ball: fundamental("BSF") };
        let best = null;
        Object.keys(scores).forEach(function (k) {
            if (scores[k].length && (!best || scores[k][0].magnitude > best.mag)) {
                best = { cls: k, mag: scores[k][0].magnitude };
            }
        });
        if (best) return best.cls;
        if (f.some((x) => x.type === "Looseness")) return "looseness";
        return "healthy";
    };

    const confusion = {};
    const bySeverity = {};
    let healthyFlagged = 0;
    let healthyTotal = 0;
    classes.forEach(function (truth) {
        const levels = truth === "healthy" ? { "–": 0 } : severities;
        Object.keys(levels).forEach(function (sevName) {
            speeds.forEach(function (rpm) {
                for (let s = 1; s <= seeds; s++) {
                    const shaftHz = rpm / 60;
                    const ff = faultFreqs(shaftHz);
                    const p = { fs: fsHz, n: n, seed: s * 131 + rpm, shaftHz: shaftHz, noiseG: 0.05, unbalanceG: 0.05 };
                    const g = levels[sevName];
                    if (truth === "outer") Object.assign(p, { faultHz: ff.BPFO, impactG: g });
                    if (truth === "inner") Object.assign(p, { faultHz: ff.BPFI, impactG: g, loadModulation: 0.8 });
                    // a ball defect strikes both races: twice per ball revolution
                    // (and is carried through the load zone by the cage)
                    if (truth === "ball") {
                        Object.assign(p, {
                            faultHz: 2 * ff.BSF,
                            impactG: g,
                            loadModulation: 0.5,
                            modulationHz: ff.FTF
                        });
                    }
                    if (truth === "looseness") Object.assign(p, { loosenessG: g * 2 });
                    const node = makeNode("signal-analyzer.js", {
                        mode: "envelope",
                        fftSize: n,
                        samplingRate: fsHz,
                        envelopeBandLow: 2000,
                        envelopeBandHigh: 6000,
                        bearingBalls: GEOMETRY.balls,
                        bearingBallDiameter: GEOMETRY.d,
                        bearingPitchDiameter: GEOMETRY.D,
                        bearingContactAngle: GEOMETRY.alpha
                    });
                    const out = node.send({ payload: bearingSignal(p), rpm: rpm });
                    const predicted = classify(out);
                    confusion[truth] = confusion[truth] || {};
                    confusion[truth][predicted] = (confusion[truth][predicted] || 0) + 1;
                    const key = truth + "/" + sevName;
                    bySeverity[key] = bySeverity[key] || { hit: 0, total: 0 };
                    bySeverity[key].total++;
                    if (predicted === truth) bySeverity[key].hit++;
                    if (truth === "healthy") {
                        healthyTotal++;
                        if (out.hasFault) healthyFlagged++;
                    }
                }
            });
        });
    });

    say("Confusion matrix (rows: truth, columns: diagnosis; all severities and speeds pooled):\n");
    say(
        table(
            ["truth \\ diagnosis"].concat(classes).concat(["n"]),
            classes.map(function (truth) {
                const row = confusion[truth] || {};
                const total = classes.reduce((a, c) => a + (row[c] || 0), 0);
                return [truth].concat(classes.map((c) => String(row[c] || 0))).concat([String(total)]);
            })
        ) + "\n"
    );
    say("Correct diagnosis by defect size (impact amplitude against 0.05 g noise):\n");
    say(
        table(
            ["defect", "weak (0.05 g)", "medium (0.1 g)", "strong (0.3 g)"],
            ["outer", "inner", "ball", "looseness"].map(function (c) {
                return [c].concat(
                    Object.keys(severities).map(function (sev) {
                        const b = bySeverity[c + "/" + sev];
                        return pct(b.hit / b.total) + " (" + b.hit + "/" + b.total + ")";
                    })
                );
            })
        ) + "\n"
    );
    say("Healthy machine flagged (`hasFault`, any line at all): **" + healthyFlagged + " of " + healthyTotal + "**.\n");
    return { confusion, bySeverity, healthyFlagged, healthyTotal };
};

// ======================================================= ISO 20816 rating
sections.iso = function () {
    say("## Vibration severity (signal-analyzer, vibration mode, ISO 20816-3)\n");
    say(
        "Accelerometer waveforms (g, 10 kHz, 8192 samples) built from a known velocity spectrum: 1X, 2X, a blade-pass " +
            "line and a 3 kHz bearing tone that carries acceleration but almost no velocity, plus noise. Truth is the " +
            "RMS velocity of the components inside 10–1000 Hz.\n"
    );
    const fsHz = 10000;
    const n = 8192;
    const errors = [];
    let zoneOk = 0;
    let total = 0;
    const order = ["A", "B", "C", "D"];
    let offByMore = 0;
    for (let s = 1; s <= SEEDS * 3; s++) {
        const r = rng(9000 + s);
        const shaftHz = 12 + 38 * r.u();
        // velocity amplitudes in mm/s (peak) at each line
        const lines = [
            [shaftHz, 0.5 + 6 * r.u()],
            [2 * shaftHz, 2 * r.u()],
            [7 * shaftHz, 1.5 * r.u()]
        ];
        const trueRms = Math.sqrt(lines.reduce((a, l) => a + (l[1] * l[1]) / 2, 0));
        const x = new Array(n);
        const ph = lines.map(() => 2 * Math.PI * r.u());
        for (let i = 0; i < n; i++) {
            const t = i / fsHz;
            let acc = 0; // m/s²
            lines.forEach(function (l, k) {
                const w = 2 * Math.PI * l[0];
                acc += (l[1] / 1000) * w * Math.cos(w * t + ph[k]);
            });
            acc += 4 * Math.sin(2 * Math.PI * 3000 * t); // bearing tone: 0.4 g, ~0.2 mm/s
            x[i] = acc / 9.80665 + 0.02 * r.normal();
        }
        const node = makeNode("signal-analyzer.js", {
            mode: "vibration",
            windowSize: n,
            samplingRate: fsHz,
            vibInputUnit: "g",
            iso10816Class: "group2_rigid"
        });
        const out = node.send({ payload: x, rpm: shaftHz * 60 });
        const iso = out.payload.iso20816;
        const limits = iso.limits;
        const trueZone = trueRms <= limits.ab ? "A" : trueRms <= limits.bc ? "B" : trueRms <= limits.cd ? "C" : "D";
        errors.push((iso.rmsVelocity - trueRms) / trueRms);
        total++;
        if (iso.zone === trueZone) zoneOk++;
        else if (Math.abs(order.indexOf(iso.zone) - order.indexOf(trueZone)) > 1) offByMore++;
    }
    say(
        table(
            ["cases", "median error", "5th … 95th percentile", "zone correct", "zone off by more than one"],
            [
                [
                    String(total),
                    pct(median(errors), 1),
                    pct(quantile(errors, 0.05), 1) + " … " + pct(quantile(errors, 0.95), 1),
                    pct(zoneOk / total) + " (" + zoneOk + "/" + total + ")",
                    String(offByMore)
                ]
            ]
        ) + "\n"
    );
    return { medianError: median(errors), zoneOk, total };
};

// ============================================================ gear sidebands
sections.gear = function () {
    say("## Gear diagnosis (signal-analyzer, cepstrum mode)\n");
    say(
        "Gearbox acceleration (20 kHz, 16384 samples): mesh frequency of a 23-tooth pinion with two harmonics, 1X " +
            "unbalance and 0.05 g noise. A damaged gear modulates the mesh once per revolution in amplitude and " +
            "phase, with modulation depth m. The node gets the tooth count and `msg.rpm` and reports the Sideband " +
            "Energy Ratio (SER) of the mesh; a gear is flagged above the configured SER limit.\n"
    );
    const rows = [];
    const res = {};
    [
        ["healthy (m = 0)", 0],
        ["incipient (m = 0.1)", 0.1],
        ["moderate (m = 0.3)", 0.3],
        ["advanced (m = 0.6)", 0.6],
        ["severe (m = 1.2)", 1.2]
    ].forEach(function (c) {
        const sers = [];
        let flaggedDefault = 0;
        let flaggedLow = 0;
        let total = 0;
        [600, 1500, 2400].forEach(function (rpm) {
            for (let s = 1; s <= Math.max(2, Math.round(SEEDS / 2)); s++) {
                const shaftHz = rpm / 60;
                const signal = lib.gearSignal({ seed: s * 17 + rpm, shaftHz: shaftHz, damage: c[1] });
                const cfg = { mode: "cepstrum", fftSize: 16384, samplingRate: 20000, gearToothCount: "23" };
                // the node is told a speed that is 0.3 % off, as a tacho would be
                const told = rpm * 1.003;
                const outDefault = makeNode("signal-analyzer.js", cfg).send({ payload: signal, rpm: told });
                const outLow = makeNode("signal-analyzer.js", Object.assign({ gearSerThreshold: 0.2 }, cfg)).send({
                    payload: signal,
                    rpm: told
                });
                total++;
                sers.push(outDefault.gears[0].sidebandEnergyRatio);
                if (outDefault.hasFault) flaggedDefault++;
                if (outLow.hasFault) flaggedLow++;
            }
        });
        res[c[0]] = { medianSer: median(sers), flaggedDefault, flaggedLow, total };
        rows.push([
            c[0],
            num(median(sers), 2) +
                " (" +
                num(Math.min.apply(null, sers), 2) +
                " … " +
                num(Math.max.apply(null, sers), 2) +
                ")",
            pct(flaggedLow / total),
            pct(flaggedDefault / total)
        ]);
    });
    say(table(["gear", "SER median (range)", "flagged at limit 0.2", "flagged at limit 1.0 (default)"], rows) + "\n");
    return res;
};

// ======================================================== anomaly detection
sections.anomaly = function () {
    say("## Univariate anomaly detection (anomaly-detector, isolation-forest-anomaly)\n");
    say(
        "A process value as a historian logs it: level 60, slow ambient swing (±1 over 2000 samples), AR(1) noise " +
            "(σ = 0.5, φ = 0.8) and 0.1 quantisation; 3000 samples, fault from sample 2000. Faults: three 6σ spikes, " +
            "a sustained 3σ step, a ramp to 6σ over 600 samples, and a noise increase (σ × 2.7). Window 200, default " +
            "thresholds. An *alarm* is a message with severity `critical` (the anomaly output also carries " +
            "`warning` messages; their rate is listed separately). False alarms are counted on the fault-free " +
            "samples 300–1999; *detected* means at least one alarm inside the fault window (for spikes: on a " +
            "spike itself).\n"
    );
    const sigma = 0.5;
    const at = 2000;
    const faults = ["spike", "step", "drift", "variance"];
    const detectors = [
        ["z-score", "anomaly-detector.js", { method: "zscore", windowSize: 200 }],
        ["z-score, 3 consecutive", "anomaly-detector.js", { method: "zscore", windowSize: 200, consecutiveCount: 3 }],
        ["IQR", "anomaly-detector.js", { method: "iqr", windowSize: 200 }],
        ["moving average", "anomaly-detector.js", { method: "moving-average", windowSize: 200 }],
        ["EMA (α = 0.3)", "anomaly-detector.js", { method: "ema", windowSize: 200 }],
        ["CUSUM (σ units)", "anomaly-detector.js", { method: "cusum", cusumMode: "sigma", windowSize: 200 }],
        [
            "percentile 1–99",
            "anomaly-detector.js",
            { method: "percentile", windowSize: 200, lowerPercentile: 1, upperPercentile: 99 }
        ],
        [
            "isolation forest (1 %)",
            "isolation-forest-anomaly.js",
            { windowSize: 200, contamination: 0.01, learningMode: "incremental", retrainInterval: 100 }
        ]
    ];
    const res = {};
    const rows = [];
    detectors.forEach(function (d) {
        const fa = [];
        const warn = [];
        const det = {};
        const delay = {};
        faults.forEach(function (f) {
            det[f] = 0;
            delay[f] = [];
        });
        for (let s = 1; s <= SEEDS; s++) {
            const clean = lib.processSignal({ seed: s });
            faults.forEach(function (f, fi) {
                const inj = lib.injectFault(clean, f, at, sigma, s);
                const node = makeNode(d[1], d[2]);
                let falseAlarms = 0;
                let warnings = 0;
                let first = -1;
                for (let i = 0; i < inj.y.length && i < inj.window[1]; i++) {
                    const r = node.route({ payload: inj.y[i] });
                    const flagged = !!(r && r.anomalyOutput);
                    // detectors without severity levels (isolation forest) alarm on every flag
                    const alarm = flagged && (r.msg.severity === undefined || r.msg.severity === "critical");
                    if (i >= 300 && i < at && alarm) falseAlarms++;
                    if (i >= 300 && i < at && flagged && !alarm) warnings++;
                    if (alarm && first < 0) {
                        if (inj.points ? inj.points.indexOf(i) !== -1 : i >= inj.window[0]) first = i;
                    }
                }
                if (fi === 0) {
                    fa.push((1000 * falseAlarms) / (at - 300));
                    warn.push((1000 * warnings) / (at - 300));
                }
                if (first >= 0) {
                    det[f]++;
                    delay[f].push(first - at);
                }
            });
        }
        res[d[0]] = { falseAlarmsPer1000: mean(fa), detected: det };
        rows.push(
            [d[0], num(mean(fa), 1), num(mean(warn), 1)].concat(
                faults.map(function (f) {
                    const share = pct(det[f] / SEEDS);
                    return f === "spike" || !delay[f].length ? share : share + " (" + num(median(delay[f]), 0) + ")";
                })
            )
        );
    });
    say(
        table(
            [
                "detector",
                "false alarms / 1000",
                "warnings / 1000",
                "spikes",
                "step (delay)",
                "drift (delay)",
                "noise ↑ (delay)"
            ],
            rows
        ) + "\n"
    );
    say("Delay = median number of samples from fault onset to the first alarm.\n");
    return res;
};

// ============================================================ multivariate
sections.multivariate = function () {
    say("## Multivariate anomaly detection (pca-anomaly, multi-value-processor Mahalanobis)\n");
    say(
        "A centrifugal pump with a wandering set point: flow ∝ n, pressure ∝ n², power ∝ n³, bearing temperature " +
            "follows power with a thermal lag; 0.6–0.8 % sensor noise. 3000 samples, fault from sample 2400. The " +
            "operating point moves the channels by ±30 %, the faults by a few percent — so a per-channel z-score " +
            "(last row) cannot see them. Faults: pressure sensor reads 6 % high; power draw up 10 % (wear); flow " +
            "sensor frozen. Window 1000 (about 16 set-point changes), false alarms counted on samples 1100–2399.\n"
    );
    const at = 2400;
    const window = 1000;
    const faults = {
        "pressure +6 %": function (row) {
            row.pressure *= 1.06;
        },
        "power +10 %": function (row) {
            row.power *= 1.1;
        },
        "flow frozen": function (row, i, rows) {
            row.flow = rows[at - 1].flow;
        }
    };
    const culprit = { "pressure +6 %": "pressure", "power +10 %": "power", "flow frozen": "flow" };
    // The affinity laws are power laws: taking logarithms makes them linear,
    // which is what PCA can model.
    const logInputs = function (row) {
        return {
            flow: Math.log(row.flow),
            pressure: Math.log(row.pressure),
            power: Math.log(row.power),
            temperature: row.temperature
        };
    };
    const asIs = function (row) {
        return Object.assign({}, row);
    };
    const detectors = [
        [
            "PCA, defaults (95 % variance)",
            "pca-anomaly.js",
            { method: "combined", windowSize: window, threshold: 3 },
            asIs
        ],
        [
            "PCA, log inputs, 99.9 % variance",
            "pca-anomaly.js",
            { method: "combined", windowSize: window, threshold: 3, varianceThreshold: 0.999 },
            logInputs
        ],
        [
            "Mahalanobis",
            "multi-value-processor.js",
            { mode: "analyze", anomalyMethod: "mahalanobis", windowSize: window, threshold: 3 },
            asIs
        ],
        [
            "per-channel z-score",
            "multi-value-processor.js",
            { mode: "analyze", anomalyMethod: "zscore", windowSize: window, threshold: 3 },
            asIs
        ]
    ];
    const res = {};
    const rows = [];
    detectors.forEach(function (d) {
        const fa = [];
        const cells = [];
        Object.keys(faults).forEach(function (fname, fi) {
            const rates = [];
            let named = 0;
            let namedOf = 0;
            for (let s = 1; s <= SEEDS; s++) {
                const data = lib.pumpSignals({ seed: s, n: 3000 });
                for (let i = at; i < data.length; i++) faults[fname](data[i], i, data);
                const node = makeNode(d[1], d[2]);
                let falseAlarms = 0;
                let scored = 0;
                let alarms = 0;
                data.forEach(function (row, i) {
                    const r = node.route({ payload: d[3](row) });
                    const alarm = !!(r && r.anomalyOutput);
                    if (i >= window + 100 && i < at) {
                        scored++;
                        if (alarm) falseAlarms++;
                    }
                    if (i >= at && alarm) {
                        alarms++;
                        if (r.msg.topContributor) {
                            namedOf++;
                            if (r.msg.topContributor === culprit[fname]) named++;
                        }
                    }
                });
                if (fi === 0) fa.push((1000 * falseAlarms) / Math.max(1, scored));
                rates.push(alarms / (data.length - at));
            }
            cells.push(pct(mean(rates)) + (namedOf ? " / " + pct(named / namedOf) : ""));
            res[d[0] + " | " + fname] = { alarmShare: mean(rates), named: namedOf ? named / namedOf : null };
        });
        res[d[0] + " | falseAlarmsPer1000"] = mean(fa);
        rows.push([d[0], num(mean(fa), 1)].concat(cells));
    });
    say(table(["detector", "false alarms / 1000"].concat(Object.keys(faults)), rows) + "\n");
    say(
        "Per fault: share of the 600 faulty samples that alarmed / share of those alarms naming the faulty " +
            "channel as top contributor (PCA only). Compare the share with the false-alarm rate: a detector whose " +
            "share is no higher than its false-alarm rate does not see the fault.\n"
    );

    // The same healthy pump with a baseline that is too short to have seen the
    // operating range.
    const shortFa = [];
    for (let s = 1; s <= SEEDS; s++) {
        const node = makeNode("pca-anomaly.js", { method: "combined", windowSize: 300, threshold: 3 });
        let alarms = 0;
        let scored = 0;
        lib.pumpSignals({ seed: s, n: 900 }).forEach(function (row, i) {
            const r = node.route({ payload: row });
            if (i >= 320) {
                scored++;
                if (r && r.anomalyOutput) alarms++;
            }
        });
        shortFa.push((1000 * alarms) / scored);
    }
    say(
        "With a baseline of only 300 samples (five set points) the same healthy pump raises **" +
            num(median(shortFa), 0) +
            " false alarms per 1000** in PCA (median over runs; worst run " +
            num(Math.max.apply(null, shortFa), 0) +
            "): the model has not seen the operating range yet and reads every new set point as abnormal.\n"
    );
    res.shortBaselineFalseAlarms = median(shortFa);
    return res;
};

// ====================================================================== RUL
sections.rul = function () {
    say("## Remaining useful life (trend-predictor, RUL mode)\n");
    say(
        "A wear indicator rising from 1 to its failure threshold of 10 over 3000 minutes, sampled about once a " +
            "minute with ±20 % jitter and occasional 20–60 min logger gaps, 3 % multiplicative noise. Three shapes: " +
            "steady (linear) wear, accelerating (exponential) wear, and a healthy plateau followed by accelerating " +
            "wear. The estimate is read at 50 %, 75 % and 90 % of the true life. Window 200, 95 % band.\n"
    );
    const cases = [
        ["linear wear", "linear", "linear"],
        ["exponential wear", "exponential", "linear"],
        ["exponential wear", "exponential", "exponential"],
        ["plateau, then exponential", "twoStage", "linear"],
        ["plateau, then exponential", "twoStage", "exponential"]
    ];
    const checkpoints = [0.5, 0.75, 0.9];
    const rows = [];
    const res = {};
    cases.forEach(function (c) {
        const err = {};
        const covered = {};
        const none = {};
        checkpoints.forEach(function (cp) {
            err[cp] = [];
            covered[cp] = 0;
            none[cp] = 0;
        });
        for (let s = 1; s <= SEEDS; s++) {
            const d = lib.degradation({ shape: c[1], seed: s });
            const node = makeNode("trend-predictor.js", {
                mode: "rul",
                windowSize: 200,
                failureThreshold: d.threshold,
                rulUnit: "minutes",
                degradationModel: c[2],
                confidenceLevel: 0.95
            });
            let next = 0;
            for (let i = 0; i < d.samples.length && next < checkpoints.length; i++) {
                const smp = d.samples[i];
                const out = node.send({ payload: smp.value, timestamp: Math.round(smp.tMin * 60000) });
                if (smp.tMin >= checkpoints[next] * d.failureMin) {
                    const cp = checkpoints[next++];
                    const trueRul = d.failureMin - smp.tMin;
                    const rul = out && out.rul;
                    if (!rul || !Number.isFinite(rul.value) || rul.status === "failed") {
                        none[cp]++;
                    } else {
                        err[cp].push((rul.value - trueRul) / trueRul);
                        if (rul.lower !== null && rul.upper !== null && rul.lower <= trueRul && trueRul <= rul.upper) {
                            covered[cp]++;
                        }
                    }
                }
            }
        }
        res[c[0] + " / " + c[2]] = { err, covered, none };
        rows.push(
            [c[0], c[2]].concat(
                checkpoints.map(function (cp) {
                    if (!err[cp].length) return "no estimate";
                    return (
                        (median(err[cp]) >= 0 ? "+" : "") +
                        pct(median(err[cp])) +
                        " [" +
                        pct(covered[cp] / SEEDS) +
                        "]" +
                        (none[cp] ? " (" + none[cp] + " none)" : "")
                    );
                })
            )
        );
    });
    say(table(["true wear", "model", "at 50 % of life", "at 75 %", "at 90 %"], rows) + "\n");
    say(
        "Cell: median error of the RUL estimate relative to the true remaining life (+ = too optimistic) " +
            '[share of runs whose 95 % band contained the truth]; "none" = no finite estimate (trend not yet ' +
            "significant).\n"
    );
    return res;
};

// ================================================================== main
function header() {
    return [
        "# Validation against simulated data with known ground truth",
        "",
        "Generated by `node tools/sim/validate.js --write` (" + SEEDS + " Monte-Carlo runs per case, all seeded —",
        "re-running reproduces these numbers). The data is simulated from physical models of the machine, not",
        "recorded, so the results show whether each node does what its method promises under realistic noise,",
        "drift and sampling — not how it performs on a particular plant. Signal models: `tools/sim/signals.js`",
        "and `tools/sim/validate-lib.js`.",
        "",
        "How to read it:",
        "",
        "- **Bearing, ISO and gear diagnosis** are judged against the defect that was simulated. Weak defects",
        "  (impacts no larger than the noise) are deliberately included: missing those is the price of raising no",
        "  alarm on a healthy machine at the default peak floor.",
        "- **Anomaly detectors** trade false alarms against delay; the table shows where each default sits on a",
        "  signal with autocorrelated noise, which is harder than the white noise the thresholds are named after.",
        "- **Multivariate detection** depends on configuration far more than on the method: the baseline must span",
        "  the operating range, inputs that follow power laws should be fed as logarithms, and the retained",
        "  variance must be high enough that a small sensor fault is not lost in the discarded components.",
        "- **RUL** is only as good as the chosen wear model: a straight line through accelerating wear is always",
        "  optimistic. The confidence band is indicative (it covers the truth less often than its nominal level).",
        "",
        ""
    ].join("\n");
}

(function main() {
    const args = process.argv.slice(2);
    const write = args.includes("--write");
    const wanted = args.filter((a) => !a.startsWith("--"));
    const names = wanted.length ? wanted : Object.keys(sections);
    const results = {};
    const started = Date.now();
    names.forEach(function (name) {
        if (!sections[name]) {
            console.error("unknown section: " + name + " (have: " + Object.keys(sections).join(", ") + ")");
            process.exit(1);
        }
        const t0 = Date.now();
        results[name] = sections[name]();
        console.error("[" + name + " done in " + ((Date.now() - t0) / 1000).toFixed(1) + " s]");
    });
    console.error("total " + ((Date.now() - started) / 1000).toFixed(1) + " s");
    if (write) {
        const out = path.join(__dirname, "..", "..", "docs", "VALIDATION.md");
        fs.writeFileSync(out, header() + report.join("\n") + "\n");
        console.error("wrote " + out);
    }
})();
