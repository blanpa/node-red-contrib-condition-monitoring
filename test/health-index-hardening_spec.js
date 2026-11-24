/**
 * health-index: weight validation, msg.config overrides, missing data,
 * trend scaling, dynamic weighting, per-group state and persistence.
 * Driven through the synchronous RED stub.
 */
const healthIndexNode = require("../nodes/health-index.js");
const { buildStubbedNode, feed, output, closeNode, settle } = require("./stub-runtime");

function build(config, seeded) {
    return buildStubbedNode(healthIndexNode, Object.assign({ id: "n1" }, config), seeded);
}

const FAULTY = { isAnomaly: true, zScore: 5 }; // scores 30
const FINE = {}; // scores 100

describe("health-index hardening", function () {
    describe("sensor weights", function () {
        it("excludes a sensor with weight 0 from the index", function () {
            const stub = build({ sensorWeights: '{"a":0,"b":1}' });

            const msg = output(feed(stub, { payload: { a: FAULTY, b: FINE } }));

            expect(msg.healthIndex).toBe(100);
            expect(msg.sensorScores.a).toBe(30); // still reported
            expect(msg.worstSensor).toBeNull();
        });

        it("applies the configured weights", function () {
            const stub = build({ sensorWeights: '{"a":3,"b":1}' });

            const msg = output(feed(stub, { payload: { a: FAULTY, b: FINE } }));

            expect(msg.healthIndex).toBeCloseTo((30 * 3 + 100) / 4, 10);
        });

        it("rejects negative and non-numeric weights with a warning instead of reporting 100", function () {
            const stub = build({ sensorWeights: '{"a":-3,"b":"high","c":"2"}' });

            const msg = output(feed(stub, { payload: { a: FAULTY, b: FINE, c: FINE } }));

            expect(stub.warnings.length).toBe(1);
            expect(stub.warnings[0]).toMatch(/a, b/);
            // a and b fall back to weight 1, c parses to 2
            expect(msg.healthIndex).toBeCloseTo((30 + 100 + 200) / 4, 10);
        });

        it("validates msg.config.sensorWeights the same way", function () {
            const stub = build({});

            const zero = output(feed(stub, { payload: { a: FAULTY, b: FINE }, config: { sensorWeights: { a: 0 } } }));
            const bad = output(feed(stub, { payload: { a: FAULTY, b: FINE }, config: { sensorWeights: { a: -1 } } }));

            expect(zero.healthIndex).toBe(100);
            expect(bad.healthIndex).toBe(65);
            expect(stub.warnings.length).toBe(1);
        });

        it("copes with sensors named like Object.prototype members", function () {
            const stub = build({});

            const msg = output(feed(stub, { payload: { constructor: FAULTY, toString: FINE } }));

            expect(stub.errors).toEqual([]);
            expect(msg.healthIndex).toBe(65);
            expect(msg.worstSensor.name).toBe("constructor");
        });
    });

    describe("msg.config overrides", function () {
        it("ignores an unknown aggregation method instead of reporting 0 / critical", function () {
            const stub = build({ aggregationMethod: "minimum" });

            const msg = output(
                feed(stub, { payload: { a: { isAnomaly: true }, b: FINE }, config: { aggregationMethod: "median" } })
            );

            expect(msg.healthIndex).toBe(70);
            expect(msg.method).toBe("minimum");
            expect(stub.warnings.length).toBe(1);
        });

        it("reports the method and thresholds actually applied", function () {
            const stub = build({ aggregationMethod: "weighted" });

            const res = feed(stub, {
                payload: { a: { isAnomaly: true }, b: FINE },
                config: { aggregationMethod: "minimum", healthyThreshold: 95, warningThreshold: 75 }
            });

            // minimum = 70, below the overridden warning threshold of 75
            expect(res.out2).toBeDefined();
            expect(res.out2.status).toBe("warning");
            expect(res.out2.method).toBe("minimum");
            expect(res.out2.thresholds).toEqual({ healthy: 95, warning: 75, degraded: 40, critical: 20 });
        });

        it("falls back to 'weighted' for an unknown configured method", function () {
            const stub = build({ aggregationMethod: "bogus" });

            expect(stub.warnings.length).toBe(1);
            expect(output(feed(stub, { payload: { a: FINE } })).method).toBe("weighted");
        });
    });

    describe("thresholds", function () {
        it("applies thresholds in descending order even when configured out of order", function () {
            const stub = build({
                healthyThreshold: 20,
                warningThreshold: 40,
                degradedThreshold: 60,
                criticalThreshold: 80
            });

            expect(stub.warnings.length).toBe(1);

            const res = feed(stub, { payload: { a: { isAnomaly: true } } }); // 70

            expect(res.out1).toBeDefined();
            expect(res.out1.status).toBe("attention");
            expect(res.out1.thresholds).toEqual({ healthy: 80, warning: 60, degraded: 40, critical: 20 });
        });
    });

    describe("missing and unusable data", function () {
        it("emits nothing for an empty payload rather than a healthy 100", function () {
            const stub = build({});

            const res = feed(stub, { payload: {} });

            expect(res.all).toEqual([]);
            expect(res.error).toBeUndefined();
            expect(stub.statuses[stub.statuses.length - 1].text).toBe("no valid sensor data");
        });

        it("emits nothing when every entry is unusable", function () {
            const stub = build({});

            expect(feed(stub, { payload: { a: null, b: "n/a", c: NaN } }).all).toEqual([]);
            expect(feed(stub, { payload: [null, undefined] }).all).toEqual([]);
            expect(stub.errors).toEqual([]);
        });

        it("scores the usable sensors and lists the skipped ones", function () {
            const stub = build({});

            const msg = output(feed(stub, { payload: { a: null, b: FAULTY, c: 21.5, d: "22" } }));

            expect(msg.skippedSensors).toEqual(["a"]);
            expect(msg.sensorScores).toEqual({ b: 30, c: 100, d: 100 });
            expect(msg.healthIndex).toBeCloseTo(230 / 3, 10);
        });

        it("accepts flags and metrics that arrive as strings", function () {
            const stub = build({});

            const msg = output(
                feed(stub, { payload: { a: { isAnomaly: "true", zScore: "3.5", deviationPercent: "abc" } } })
            );

            expect(msg.sensorScores.a).toBe(30);
        });
    });

    describe("aggregation", function () {
        it("keeps the geometric mean finite for many sensors", function () {
            const stub = build({ aggregationMethod: "geometric" });
            const payload = {};
            for (let i = 0; i < 400; i++) payload["s" + i] = FINE;

            const msg = output(feed(stub, { payload: payload }));

            expect(msg.healthIndex).toBeCloseTo(100, 8);
            expect(msg.healthIndex).toBeLessThanOrEqual(100);
            expect(msg.status).toBe("healthy");
        });

        it("computes the geometric mean of mixed scores", function () {
            const stub = build({ aggregationMethod: "geometric" });

            const msg = output(feed(stub, { payload: { a: FAULTY, b: FINE } }));

            expect(msg.healthIndex).toBeCloseTo(Math.sqrt(30 * 100), 8);
        });

        it("does not let a persistently anomalous sensor raise the dynamic index", function () {
            const dynamic = build({ aggregationMethod: "dynamic" });
            const weighted = build({ aggregationMethod: "weighted" });
            let d;
            let w;
            for (let i = 0; i < 30; i++) {
                const payload = { a: { value: 5, isAnomaly: true, zScore: 5 }, b: { value: 5 } };
                d = output(feed(dynamic, { payload: payload }));
                w = output(feed(weighted, { payload: payload }));
            }

            expect(d.dynamicWeights.a.anomalyRate).toBe(1);
            expect(d.dynamicWeights.a.reliabilityFactor).toBe(1);
            expect(d.healthIndex).toBe(w.healthIndex);
            expect(d.healthIndex).toBe(65);
        });

        it("still lowers the dynamic weight of a low-confidence sensor", function () {
            const stub = build({ aggregationMethod: "dynamic" });

            const msg = output(feed(stub, { payload: { a: { confidence: 0.2 }, b: { confidence: 1 } } }));

            expect(msg.dynamicWeights.a.effectiveWeight).toBeCloseTo(0.2, 10);
            expect(msg.dynamicWeights.b.effectiveWeight).toBe(1);
        });
    });

    describe("trend", function () {
        function collapse(outputScale) {
            const stub = build({ outputScale: outputScale });
            let msg;
            for (let i = 0; i < 10; i++) {
                msg = output(
                    feed(stub, { payload: { a: i < 5 ? FINE : { isAnomaly: true, zScore: 5, deviationPercent: 50 } } })
                );
            }
            return msg.healthTrend;
        }

        it("reports a collapse as degrading on the 0-1 scale too", function () {
            expect(collapse("0-100").trend).toBe("degrading");
            expect(collapse("0-1").trend).toBe("degrading");
            expect(collapse("0-1").change).toBeCloseTo(-1, 10);
        });

        it("treats a sub-band wobble as stable on both scales", function () {
            ["0-100", "0-1"].forEach(function (outputScale) {
                const stub = build({ outputScale: outputScale, sensorWeights: '{"a":1,"b":99}' });
                let msg;
                for (let i = 0; i < 10; i++) {
                    // index alternates between 100 and 99.9
                    msg = output(
                        feed(stub, { payload: { a: i % 2 ? { trend: "increasing", slope: 1 } : FINE, b: FINE } })
                    );
                }
                expect(msg.healthTrend.trend).toBe("stable");
            });
        });
    });

    describe("per-group state", function () {
        it("keeps history and trend apart per group value", function () {
            const stub = build({ groupBy: "topic" });
            let good;
            let bad;
            for (let i = 0; i < 10; i++) {
                good = output(feed(stub, { topic: "m1", payload: { a: FINE } }));
                bad = output(feed(stub, { topic: "m2", payload: { a: i < 5 ? FINE : FAULTY } }));
            }

            expect(good.healthTrend.trend).toBe("stable");
            expect(good.healthTrend.samples).toBe(10);
            expect(good.group).toBe("m1");
            expect(bad.healthTrend.trend).toBe("degrading");
            expect(stub.node.groups.get("m2").lastStatus).toBe("degraded");
        });

        it("evicts the least recently used group and resets one group at a time", function () {
            const stub = build({ groupBy: "topic", maxGroups: 2 });
            ["a", "b", "a", "c"].forEach(function (topic) {
                feed(stub, { topic: topic, payload: { s: FINE } });
            });
            expect(Array.from(stub.node.groups.keys())).toEqual(["a", "c"]);

            feed(stub, { topic: "c", reset: true });
            expect(Array.from(stub.node.groups.keys())).toEqual(["a"]);
        });

        it("shares one history when groupBy is empty (legacy behaviour)", function () {
            const stub = build({});
            feed(stub, { topic: "m1", payload: { a: FINE } });
            const msg = output(feed(stub, { topic: "m2", payload: { a: FINE } }));

            expect(stub.node.healthHistory.length).toBe(2);
            expect(stub.node.lastStatus).toBe("healthy");
            expect(msg.group).toBeUndefined();
            expect(msg.topic).toBe("m2");
        });
    });

    describe("state persistence", function () {
        it("restores the flat v1 history, with debug enabled", async function () {
            const stub = build(
                { persistState: true, debug: true },
                {
                    healthIndexState: {
                        healthHistory: [
                            { timestamp: 1, index: 100, status: "healthy" },
                            { timestamp: 2, index: 100, status: "healthy" },
                            { timestamp: 3, index: 100, status: "healthy" },
                            { timestamp: 4, index: 100, status: "healthy" }
                        ],
                        lastHealthIndex: 100,
                        lastStatus: "healthy"
                    }
                }
            );
            await settle();

            expect(stub.warnings).toEqual([]);
            expect(typeof stub.node.debug).toBe("function");
            expect(stub.node.healthHistory.length).toBe(4);
            expect(stub.node.lastStatus).toBe("healthy");
            expect(
                stub.debugLines.some(function (l) {
                    return l.indexOf("Restored 4 health history entries") === 0;
                })
            ).toBe(true);

            // The restored history feeds the trend of the very next sample
            const msg = output(feed(stub, { payload: { a: FAULTY } }));
            expect(msg.healthTrend.samples).toBe(5);
            expect(msg.healthTrend.trend).toBe("degrading");

            await closeNode(stub.node);
            const saved = stub.store.healthIndexState;
            expect(saved.version).toBe(2);
            expect(saved.groups[""].healthHistory.length).toBe(5);
            expect(saved.healthHistory).toBeUndefined();
        });

        it("saves and restores history and reliability per group", async function () {
            const first = build({ persistState: true, groupBy: "topic", aggregationMethod: "dynamic" }, {});
            await settle();
            for (let i = 0; i < 12; i++) {
                feed(first, { topic: "m1", payload: { a: { value: i, isAnomaly: i % 2 === 0 } } });
                feed(first, { topic: "m2", payload: { a: { value: 1 } } });
            }
            await closeNode(first.node);

            const saved = first.store.healthIndexState;
            expect(Object.keys(saved.groups).sort()).toEqual(["m1", "m2"]);
            expect(saved.groups.m1.sensorReliability.a.totalCount).toBe(12);

            const second = build({ persistState: true, groupBy: "topic", aggregationMethod: "dynamic" }, first.store);
            await settle();

            expect(second.node.groups.get("m1").healthHistory.length).toBe(12);
            const msg = output(feed(second, { topic: "m1", payload: { a: { value: 3 } } }));
            // 6 anomalies in 13 samples: the counters carried over
            expect(msg.dynamicWeights.a.anomalyRate).toBeCloseTo(6 / 13, 10);

            await closeNode(second.node);
        });
    });

    describe("missing sensors", function () {
        const WEIGHTS = '{"temp":1,"vibration":1.5}';
        const FAULTED_VIB = { value: 9, isAnomaly: true, zScore: 4 }; // scores 30
        function faulted(stub) {
            let msg;
            for (let i = 0; i < 5; i++) {
                msg = output(feed(stub, { payload: { temp: { value: 70 }, vibration: FAULTED_VIB } }));
            }
            return msg;
        }

        it("flags a configured sensor that disappears from the payload and warns once", function () {
            const stub = build({ sensorWeights: WEIGHTS });
            expect(faulted(stub).healthIndex).toBe(58);

            // the faulted vibration sensor goes offline
            const res = feed(stub, { payload: { temp: { value: 70 } } });
            const msg = output(res);
            // the index rises (nothing is held) - but never silently
            expect(msg.healthIndex).toBe(100);
            expect(msg.missingSensors).toEqual(["vibration"]);
            expect(msg.heldSensors).toEqual([]);
            expect(msg.skippedSensors).toBeUndefined();
            expect(res.out1).toBeDefined();
            expect(stub.warnings.length).toBe(1);
            expect(stub.warnings[0]).toMatch(/missing from the payload: vibration/);

            feed(stub, { payload: { temp: { value: 70 } } });
            expect(stub.warnings.length).toBe(1);

            // a payload carrying every configured sensor has no missingSensors field
            const full = output(feed(stub, { payload: { temp: { value: 70 }, vibration: FAULTED_VIB } }));
            expect(full.missingSensors).toBeUndefined();
        });

        it("holds the last score of a missing sensor while it is younger than staleAfterMs", async function () {
            const stub = build({ sensorWeights: WEIGHTS, staleAfterMs: 60000 });
            expect(faulted(stub).healthIndex).toBe(58);

            const res = feed(stub, { payload: { temp: { value: 70 } } });
            const msg = output(res);
            expect(msg.healthIndex).toBe(58);
            expect(msg.status).toBe("warning");
            expect(res.out2).toBeDefined();
            expect(msg.missingSensors).toEqual(["vibration"]);
            expect(msg.heldSensors).toEqual(["vibration"]);
            expect(msg.sensorScores.vibration).toBe(30);
            expect(msg.dynamicWeights.vibration.held).toBe(true);
            expect(msg.worstSensor.name).toBe("vibration");
            expect(msg.contributingFactors.some((f) => f.sensor === "vibration" && /held/.test(f.reason))).toBe(true);
            expect(stub.warnings[0]).toMatch(/held for 60000 ms/);
        });

        it("drops a missing sensor once its last score is stale", async function () {
            const stub = build({ sensorWeights: WEIGHTS, staleAfterMs: 5 });
            faulted(stub);
            await settle(); // 20 ms > staleAfterMs

            const msg = output(feed(stub, { payload: { temp: { value: 70 } } }));
            expect(msg.healthIndex).toBe(100);
            expect(msg.missingSensors).toEqual(["vibration"]);
            expect(msg.heldSensors).toEqual([]);
            expect(msg.sensorScores.vibration).toBeUndefined();
        });

        it("does not hold a sensor that was never seen, nor one with weight 0", function () {
            const stub = build({ sensorWeights: '{"temp":1,"vibration":1.5,"off":0}', staleAfterMs: 60000 });

            const msg = output(feed(stub, { payload: { temp: { value: 70 } } }));
            expect(msg.healthIndex).toBe(100);
            expect(msg.missingSensors).toEqual(["vibration"]);
            expect(msg.heldSensors).toEqual([]);
        });
    });

    describe("scoring assumptions", function () {
        it("penalises a decreasing trend on a falling-is-bad sensor", function () {
            const stub = build({});
            const base = { pressure: { value: 2, trend: "decreasing", slope: -0.5 } };

            // default direction: rising is bad, so a fall is not penalised
            expect(output(feed(stub, { payload: base })).sensorScores.pressure).toBe(100);
            // per-message direction
            const withDir = output(
                feed(stub, { payload: { pressure: Object.assign({ direction: "falling" }, base.pressure) } })
            );
            expect(withDir.sensorScores.pressure).toBe(90);
            expect(withDir.contributingFactors[0]).toEqual({
                sensor: "pressure",
                reason: "decreasing trend",
                impact: -10
            });
            // trend-predictor's field name is accepted too
            expect(
                output(
                    feed(stub, { payload: { pressure: Object.assign({ failureDirection: "falling" }, base.pressure) } })
                ).sensorScores.pressure
            ).toBe(90);
            // a rising trend on a falling-is-bad sensor is an improvement
            expect(
                output(
                    feed(stub, {
                        payload: { pressure: { value: 2, trend: "increasing", slope: 0.5, direction: "falling" } }
                    })
                ).sensorScores.pressure
            ).toBe(100);
        });

        it("takes the failure direction from the node configuration", function () {
            const stub = build({ sensorDirections: '{"pressure":"falling","bogus":"sideways"}' });
            expect(stub.warnings.length).toBe(1);
            expect(stub.warnings[0]).toMatch(/bogus/);

            const msg = output(
                feed(stub, {
                    payload: {
                        pressure: { value: 2, trend: "decreasing", slope: -0.5 },
                        temp: { value: 70, trend: "increasing", slope: 0.5 }
                    }
                })
            );
            expect(msg.sensorScores).toEqual({ pressure: 90, temp: 90 });
            // the message overrides the node setting
            const overridden = output(
                feed(stub, {
                    payload: { pressure: { value: 2, trend: "decreasing", slope: -0.5, direction: "rising" } }
                })
            );
            expect(overridden.sensorScores.pressure).toBe(100);
        });

        it("does not apply the coefficient-of-variation penalty to a zero-mean indicator", function () {
            const stub = build({ aggregationMethod: "dynamic" });
            let msg;
            for (let i = 0; i < 12; i++) {
                // a healthy residual oscillating around zero, next to a noisy positive sensor
                // (70 ± 50: mean 70, σ 50, CV 0.71) and a quiet one
                msg = output(
                    feed(stub, {
                        payload: {
                            residual: { value: Math.sin(i) * 0.5 },
                            noisy: { value: 70 + (i % 2 ? 50 : -50) },
                            temp: { value: 70 }
                        }
                    })
                );
            }
            expect(msg.dynamicWeights.residual.reliabilityFactor).toBe(1);
            expect(msg.dynamicWeights.temp.reliabilityFactor).toBe(1);
            // CV 0.714 → factor 1 − (0.714 − 0.5)
            expect(msg.dynamicWeights.noisy.reliabilityFactor).toBeCloseTo(1 - (50 / 70 - 0.5), 6);
        });
    });
});
