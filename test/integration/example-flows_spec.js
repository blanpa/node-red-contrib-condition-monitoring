"use strict";

/**
 * Validates every shipped example flow (examples/NN-*.json) end-to-end in a
 * real Node-RED runtime: deploy the actual flow, drive it through its own
 * inject → function → node wiring, and assert the node's output is structurally
 * valid and functionally sensible.
 *
 * Two flows depend on external resources that aren't available in CI:
 *   - 07 ml-inference   → needs the ONNX model at the Docker path /data/models
 *   - 10 llm-analyzer   → needs an LLM provider API key (credential)
 * For those we validate that the flow deploys, the data-generator function is
 * valid, and the node processes input without crashing the runtime (the model
 * load / LLM call is expected to fail gracefully). This is called out per test.
 */

const fs = require("fs");
const path = require("path");

const { startRed, captureNode } = require("./red-runtime");

const EXAMPLES_DIR = path.resolve(__dirname, "..", "..", "examples");
const PKG_TYPES = Object.keys(require("../../package.json")["node-red"].nodes);

const CAPTURE_ID = "ncm-capture";

function loadFlow(file) {
    return JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, file), "utf8"));
}

/**
 * Prepare a flow for deterministic driving:
 *   - neutralise inject auto-fire (repeat timers + once-on-deploy)
 *   - append a capture tap to every output wire of the package node
 *   - inject the capture function node into the flow
 * Returns { flow, tabId, targetId, targetType, injects }.
 */
function prepare(rawFlow) {
    const flow = JSON.parse(JSON.stringify(rawFlow));
    const tab = flow.find((n) => n.type === "tab");
    const target = flow.find((n) => PKG_TYPES.includes(n.type));
    const injects = flow.filter((n) => n.type === "inject");

    for (const inj of injects) {
        inj.repeat = "";
        inj.once = false;
    }

    // Tap every output of the target node.
    target.wires = (target.wires || []).map((arr) => arr.concat([CAPTURE_ID]));

    const cap = captureNode(CAPTURE_ID, "capture");
    cap.z = tab.id;
    flow.push(cap);

    return { flow, tabId: tab.id, targetId: target.id, targetType: target.type, injects };
}

/** Fire an inject node `times` times, letting the async chains flush. */
async function fire(harness, nodeId, times, msg) {
    for (let i = 0; i < times; i++) {
        await harness.inject(nodeId, msg || {});
        if (i % 20 === 19) await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 60));
}

function mainInject(injects) {
    // The data-generating inject: ends in "-inject" or is the first one that
    // isn't an explicit control (export/stop/reset/start/fault).
    return (
        injects.find((n) => /-inject$/.test(n.id)) ||
        injects.find((n) => !/(export|stop|reset|start|fault)/.test(n.id)) ||
        injects[0]
    );
}

describe("integration: every example flow produces valid output", () => {
    let harness;

    beforeAll(async () => {
        harness = await startRed();
    }, 40000);

    afterAll(async () => {
        if (harness) await harness.shutdown();
    }, 20000);

    afterEach(() => harness.reset());

    test("01 anomaly-detector — detects the injected temperature spike", async () => {
        const { flow, injects } = prepare(loadFlow("01-anomaly-detector-zscore.json"));
        await harness.deploy(flow);
        await fire(harness, mainInject(injects).id, 130);

        const out = await harness.collect(CAPTURE_ID, 1, 4000);
        const classified = out.filter((m) => typeof m.isAnomaly === "boolean");
        expect(classified.length).toBeGreaterThan(0);
        expect(classified.some((m) => m.isAnomaly === true)).toBe(true);
        classified.forEach((m) => expect(typeof m.zScore === "number" || typeof m.value === "number").toBe(true));
    }, 20000);

    test("02 isolation-forest — classifies after the learning window", async () => {
        const { flow, injects } = prepare(loadFlow("02-isolation-forest-learning.json"));
        await harness.deploy(flow);
        await fire(harness, mainInject(injects).id, 80);

        const out = await harness.collect(CAPTURE_ID, 1, 4000);
        const classified = out.filter((m) => typeof m.isAnomaly === "boolean");
        expect(classified.length).toBeGreaterThan(0);
        classified.forEach((m) => expect(typeof m.method).toBe("string"));
    }, 20000);

    test("03 multi-value-processor — splits the sensor record", async () => {
        const { flow, injects } = prepare(loadFlow("03-multi-value-processor.json"));
        await harness.deploy(flow);
        await fire(harness, mainInject(injects).id, 40);

        const out = await harness.collect(CAPTURE_ID, 1, 4000);
        expect(out.length).toBeGreaterThan(0);
        out.forEach((m) => expect(m.payload !== undefined).toBe(true));
    }, 20000);

    test("04 signal-analyzer — FFT recovers the 50 Hz / 120 Hz components", async () => {
        const { flow, injects } = prepare(loadFlow("04-signal-analyzer-vibration.json"));
        await harness.deploy(flow);
        await fire(harness, mainInject(injects).id, 5);

        const out = await harness.collect(CAPTURE_ID, 1, 4000);
        expect(out.length).toBeGreaterThan(0);
        // Gather any frequency values reported (peaks list or dominantFrequency).
        const freqs = [];
        for (const m of out) {
            const p = m.payload || {};
            if (Array.isArray(p.peaks)) p.peaks.forEach((pk) => freqs.push(pk.frequency));
            if (Array.isArray(p)) p.forEach((pk) => pk && freqs.push(pk.frequency));
            if (typeof p.dominantFrequency === "number") freqs.push(p.dominantFrequency);
            if (typeof m.dominantFrequency === "number") freqs.push(m.dominantFrequency);
        }
        const near = (f, t) => Math.abs(f - t) <= 8;
        expect(freqs.some((f) => typeof f === "number" && (near(f, 50) || near(f, 120)))).toBe(true);
    }, 20000);

    test("05 trend-predictor — emits RUL estimate from the rising trend", async () => {
        const { flow, injects } = prepare(loadFlow("05-trend-predictor-rul.json"));
        await harness.deploy(flow);
        await fire(harness, mainInject(injects).id, 30);

        const out = await harness.collect(CAPTURE_ID, 1, 4000);
        expect(out.length).toBeGreaterThan(0);
        const hasRul = out.some((m) => {
            const p = m.payload || {};
            return [m.rul, m.timeToFailure, p.rul, p.timeToFailure, p.prediction, m.prediction, p.slope].some(
                (v) => v !== undefined
            );
        });
        expect(hasRul).toBe(true);
    }, 20000);

    test("06 health-index — 0..100 score that degrades on the bad channel", async () => {
        const { flow, injects } = prepare(loadFlow("06-health-index-weighted.json"));
        await harness.deploy(flow);
        await fire(harness, mainInject(injects).id, 40);

        const out = await harness.collect(CAPTURE_ID, 1, 4000);
        const scores = out
            .map((m) => (typeof m.healthIndex === "number" ? m.healthIndex : m.payload && m.payload.healthIndex))
            .filter((v) => typeof v === "number");
        expect(scores.length).toBeGreaterThan(0);
        scores.forEach((s) => {
            expect(s).toBeGreaterThanOrEqual(0);
            expect(s).toBeLessThanOrEqual(100);
        });
        // The vibration channel degrades every ~10th cycle → not always perfect.
        expect(Math.min(...scores)).toBeLessThan(100);
    }, 20000);

    test("07 ml-inference — deploys and handles the missing model without crashing", async () => {
        // Model path is the Docker path /data/models/anomaly-model.onnx, absent
        // here (and outside the path-validator allowlist), so inference can't
        // run. We validate the flow deploys, the node is live, and driving it
        // doesn't throw / take the runtime down.
        const { flow, injects, targetId } = prepare(loadFlow("07-ml-inference-onnx.json"));
        await harness.deploy(flow);
        expect(await harness.getNodeAsync(targetId)).toBeTruthy();
        await fire(harness, mainInject(injects).id, 5);
        // Runtime still healthy: the node is still registered after driving it.
        expect(harness.getNode(targetId)).toBeTruthy();
    }, 20000);

    test("08 pca-anomaly — emits T²/SPE statistics after training", async () => {
        const { flow, injects } = prepare(loadFlow("08-pca-anomaly-multivariate.json"));
        await harness.deploy(flow);
        await fire(harness, mainInject(injects).id, 90);

        const out = await harness.collect(CAPTURE_ID, 1, 5000);
        const stats = out.filter((m) => {
            const p = m.payload || {};
            return (
                typeof m.t2 === "number" ||
                typeof p.t2 === "number" ||
                typeof m.spe === "number" ||
                typeof p.spe === "number" ||
                typeof m.isAnomaly === "boolean"
            );
        });
        expect(stats.length).toBeGreaterThan(0);
    }, 25000);

    test("09 training-data-collector — collects samples and exports", async () => {
        const { flow, injects } = prepare(loadFlow("09-training-data-collector.json"));
        await harness.deploy(flow);
        await fire(harness, mainInject(injects).id, 30);

        const exportInject = injects.find((n) => /export/.test(n.id));
        if (exportInject) await harness.inject(exportInject.id, { action: "export" });

        const out = await harness.collect(CAPTURE_ID, 1, 5000);
        expect(out.length).toBeGreaterThan(0);
        out.forEach((m) => expect(m.payload !== undefined || m.topic !== undefined).toBe(true));
    }, 25000);

    test("10 llm-analyzer — buffers samples and handles missing API key gracefully", async () => {
        // No provider credential in the test runtime, so the LLM call can't
        // succeed. We validate the flow deploys, the node buffers/processes the
        // 30-sample batch, and driving it doesn't crash the runtime.
        const { flow, injects, targetId } = prepare(loadFlow("10-llm-analyzer.json"));
        await harness.deploy(flow);
        expect(await harness.getNodeAsync(targetId)).toBeTruthy();
        await fire(harness, mainInject(injects).id, 35);
        expect(harness.getNode(targetId)).toBeTruthy();
    }, 20000);

    test("11 condition-monitoring-source — emits a full condition sample", async () => {
        const { flow, targetId } = prepare(loadFlow("11-condition-monitoring-source.json"));
        await harness.deploy(flow);
        // Any non-command input triggers one manual sample.
        await fire(harness, targetId, 5, { topic: "tick" });

        const out = await harness.collect(CAPTURE_ID, 1, 4000);
        expect(out.length).toBeGreaterThan(0);
        const sample = out[0];

        // Health (0..100%) is present at the top level on every message.
        expect(typeof sample.health).toBe("number");
        expect(sample.health).toBeGreaterThanOrEqual(0);
        expect(sample.health).toBeLessThanOrEqual(100);

        // The condition detail lives on payload (object mode) or msg.condition
        // (value / waveform modes); sensors are nested under `.sensors`.
        const cond =
            sample.payload && typeof sample.payload === "object" && sample.payload.sensors
                ? sample.payload
                : sample.condition;
        expect(cond).toBeTruthy();
        const s = cond.sensors || {};
        const hasSensor = ["vibrationRMS", "temperature", "current", "pressure"].some((k) => typeof s[k] === "number");
        expect(hasSensor).toBe(true);
        expect(cond.rul && typeof cond.rul === "object").toBe(true);
    }, 20000);
});
