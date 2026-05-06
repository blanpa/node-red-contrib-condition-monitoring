"use strict";

const { startRed, captureNode, buildFlow } = require("./red-runtime");

describe("integration: real Node-RED runtime", () => {
    let harness;

    beforeAll(async () => {
        harness = await startRed();
    }, 30000);

    afterAll(async () => {
        if (harness) await harness.shutdown();
    }, 15000);

    it("starts Node-RED and registers all condition-monitoring nodes", async () => {
        // Note: the npm package.json keys these as "isolation-forest" etc.,
        // but the actual `RED.nodes.registerType(...)` calls inside the source
        // use the long form "isolation-forest-anomaly". The runtime cares about
        // the registered type, not the package.json key.
        const required = [
            "anomaly-detector",
            "isolation-forest-anomaly",
            "multi-value-processor",
            "signal-analyzer",
            "trend-predictor",
            "health-index",
            "ml-inference",
            "pca-anomaly",
            "training-data-collector"
        ];
        const types = await harness.listRegisteredTypes();
        for (const t of required) {
            expect(types).toContain(t);
        }
    });

    it("deploys a trivial flow and routes a message through a capture node", async () => {
        const flow = buildFlow("smoke-tab", "smoke", [captureNode("smoke-cap-1", "smoke capture")]);
        await harness.deploy(flow);
        await harness.inject("smoke-cap-1", { payload: 42, topic: "ping" });
        const out = await harness.collect("smoke-cap-1", 1);
        expect(out).toHaveLength(1);
        expect(out[0].payload).toBe(42);
        expect(out[0].topic).toBe("ping");
    });
});
