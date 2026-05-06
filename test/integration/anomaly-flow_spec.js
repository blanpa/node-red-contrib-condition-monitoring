"use strict";

const { startRed, captureNode, buildFlow } = require("./red-runtime");

/**
 * End-to-end test for the Z-Score anomaly detector.
 *
 * Pipeline:
 *
 *     anomaly-detector(zscore) ─[output 1: normal]─ capture-normal
 *                              └[output 2: anomaly]─ capture-anomaly
 *
 * We feed in a stream of stable readings around 100 (within sigma) and one
 * obvious outlier at 1000. The detector should route exactly one message to
 * the anomaly capture once the buffer is filled.
 *
 * This proves PR4 — `detectZScoreWithConfig` now goes through the shared
 * `stats.calculateZScore` helper rather than re-implementing mean/stddev.
 * If that refactor changed the math, the threshold crossing would shift.
 */
describe("integration: anomaly-detector Z-Score flow", () => {
    let harness;
    const TAB = "anom-tab";
    const DETECTOR = "anom-detector";
    const NORMAL_CAP = "anom-cap-normal";
    const ANOMALY_CAP = "anom-cap-anomaly";

    beforeAll(async () => {
        harness = await startRed();
        const flow = buildFlow(TAB, "anomaly z-score", [
            {
                id: DETECTOR,
                type: "anomaly-detector",
                name: "z-score detector",
                method: "zscore",
                windowSize: 30,
                zscoreThreshold: 3,
                zscoreWarning: 2,
                hysteresisEnabled: false,
                wires: [[NORMAL_CAP], [ANOMALY_CAP]]
            },
            captureNode(NORMAL_CAP, "normal capture"),
            captureNode(ANOMALY_CAP, "anomaly capture")
        ]);
        await harness.deploy(flow);
    }, 30000);

    afterAll(async () => {
        if (harness) await harness.shutdown();
    }, 15000);

    it("routes obvious outliers to the anomaly output and stable values to normal", async () => {
        // Seed with stable values centred on 100 ± small noise. Window is 30,
        // so the first ~20 messages may be in warmup ("not yet enough data");
        // the detector decides per-message based on whatever buffer it has.
        const baseline = [];
        for (let i = 0; i < 30; i++) {
            const v = 100 + (Math.random() - 0.5) * 2;
            baseline.push(v);
            await harness.inject(DETECTOR, { payload: v });
        }

        // Now drive an obvious outlier through the same node.
        await harness.inject(DETECTOR, { payload: 1000 });

        // Give the runtime a moment to dispatch outputs.
        await new Promise((r) => setTimeout(r, 100));

        const anomalyMsgs = await harness.collect(ANOMALY_CAP, 1, 5000);
        expect(anomalyMsgs.length).toBeGreaterThanOrEqual(1);

        const last = anomalyMsgs[anomalyMsgs.length - 1];
        expect(last.payload).toBe(1000);
        expect(last.isAnomaly).toBe(true);
        expect(last.severity).toBe("critical");
        expect(typeof last.zScore).toBe("number");
        // The detector pushes the new sample into its sliding window *before*
        // computing the z-score, so the outlier is itself part of the
        // statistics. With a 30-element window of ~100s + one 1000 value:
        //   mean ≈ 130, stddev ≈ 161, z ≈ 5.4
        // — well above both warning (2) and critical (3) thresholds.
        expect(Math.abs(last.zScore)).toBeGreaterThan(3);
        expect(Math.abs(last.zScore)).toBeLessThan(15);

        // The 30 stable injections should have produced 30 messages on the
        // normal output (one per input). The first sample is the warmup
        // path — Node-RED forwards the unmodified msg with no `isAnomaly`
        // field — so we only assert that no normal-output message was
        // mistakenly marked as an anomaly.
        const normalMsgs = await harness.collect(NORMAL_CAP, 30, 5000);
        expect(normalMsgs.length).toBe(30);
        for (const m of normalMsgs) {
            expect(m.isAnomaly === undefined || m.isAnomaly === false).toBe(true);
        }
    }, 30000);

    it("preserves the topic from the original message", async () => {
        harness.reset(NORMAL_CAP);
        harness.reset(ANOMALY_CAP);

        // Inject a single normal value with a custom topic.
        await harness.inject(DETECTOR, { payload: 100.0, topic: "machine-A/temp" });
        const out = await harness.collect(NORMAL_CAP, 1, 1500);
        expect(out[0].topic).toBe("machine-A/temp");
    });
});
