"use strict";

const { startRed, captureNode, buildFlow } = require("./red-runtime");

/**
 * Two-node pipeline test: a source feeds multi-sensor payloads directly
 * into health-index, which aggregates and emits a health score.
 *
 * Verifies:
 *   - Multi-sensor object payload handling end-to-end
 *   - Health-index aggregation produces a value in [0..100]
 *   - Object.prototype.hasOwnProperty.call() refactor (PR1) didn't break
 *     the `msg`-property pass-through in either node
 *   - Custom topic survives the pipeline
 */
describe("integration: health-index multi-sensor pipeline", () => {
    let harness;
    const TAB = "hx-tab";
    const HX = "hx-node";
    const CAP = "hx-cap";

    beforeAll(async () => {
        harness = await startRed();
        const flow = buildFlow(TAB, "health pipeline", [
            {
                id: HX,
                type: "health-index",
                name: "health index",
                aggregationMethod: "weighted",
                outputScale: "0-100",
                sensorWeights: JSON.stringify({ temp: 0.4, vibration: 0.4, pressure: 0.2 }),
                healthyThreshold: 80,
                warningThreshold: 60,
                degradedThreshold: 40,
                criticalThreshold: 20,
                wires: [[CAP]]
            },
            captureNode(CAP, "health capture")
        ]);
        await harness.deploy(flow);
    }, 30000);

    afterAll(async () => {
        if (harness) await harness.shutdown();
    }, 15000);

    it("computes a healthy score and degrades when an upstream sensor flags anomalies", async () => {
        // health-index doesn't compute baselines itself — it aggregates
        // pre-tagged anomaly signals (isAnomaly / zScore / deviationPercent).
        // We feed shapes that match what the upstream anomaly nodes produce.
        const goodPayload = {
            temp: { value: 60, isAnomaly: false, zScore: 0.2 },
            vibration: { value: 0.5, isAnomaly: false, zScore: -0.1 },
            pressure: { value: 50, isAnomaly: false, zScore: 0.0 }
        };
        await harness.inject(HX, { payload: goodPayload, topic: "machine-A" });

        const out1 = await harness.collect(CAP, 1, 2000);
        expect(out1).toHaveLength(1);
        const m1 = out1[0];
        expect(typeof m1.payload).toBe("number");
        expect(m1.payload).toBeGreaterThanOrEqual(0);
        expect(m1.payload).toBeLessThanOrEqual(100);
        // All sensors clean → close to the top of the scale.
        expect(m1.payload).toBeGreaterThanOrEqual(80);
        expect(["healthy", "attention"]).toContain(m1.status);
        // hasOwnProperty refactor: original `topic` must propagate through.
        expect(m1.topic).toBe("machine-A");
        expect(m1.healthIndex).toBe(m1.payload);
        expect(m1.scale).toBe("0-100");

        // Now flag a sensor as anomalous with a strong z-score.
        harness.reset(CAP);
        const badPayload = {
            temp: { value: 95, isAnomaly: true, zScore: 4.2 },
            vibration: { value: 4.5, isAnomaly: false, zScore: 1.5 },
            pressure: { value: 90, isAnomaly: false, zScore: 1.0 }
        };
        await harness.inject(HX, { payload: badPayload, topic: "machine-A" });
        const out2 = await harness.collect(CAP, 1, 2000);
        expect(out2[0].payload).toBeLessThan(m1.payload);
        // sensorScores must be an object keyed by sensor name.
        expect(out2[0].sensorScores).toBeDefined();
        expect(typeof out2[0].sensorScores).toBe("object");
        expect(out2[0].sensorScores.temp).toBeDefined();
        // The anomalous sensor should score worse than the rest.
        expect(out2[0].sensorScores.temp).toBeLessThan(out2[0].sensorScores.pressure);
    }, 30000);
});
