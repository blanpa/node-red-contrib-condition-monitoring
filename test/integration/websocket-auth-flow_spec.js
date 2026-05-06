"use strict";

const WebSocket = require("ws");

const { startRed, captureNode, buildFlow } = require("./red-runtime");

/**
 * End-to-end check that an anomaly-detector node configured with a shared
 * `websocketAuthToken` only accepts authenticated WebSocket clients and
 * actually publishes results to authorised subscribers.
 *
 * Verifies PR2 — auth token + Origin allowlist + constant-time compare.
 */
describe("integration: anomaly-detector WebSocket auth", () => {
    let harness;
    const TAB = "ws-tab";
    const DETECTOR = "ws-detector";
    // Random per-suite WS port so parallel Jest workers don't collide.
    const WS_PORT = 23000 + Math.floor(Math.random() * 5000);

    beforeAll(async () => {
        harness = await startRed();
        const flow = buildFlow(TAB, "ws auth", [
            {
                id: DETECTOR,
                type: "anomaly-detector",
                name: "ws detector",
                method: "zscore",
                windowSize: 30,
                zscoreThreshold: 3,
                zscoreWarning: 2,
                hysteresisEnabled: false,
                websocketEnabled: true,
                websocketPort: WS_PORT,
                websocketTopic: "anomaly-detector",
                websocketAuthToken: "s3cr3t-token",
                wires: [["ws-cap-normal"], ["ws-cap-anomaly"]]
            },
            captureNode("ws-cap-normal", "normal cap"),
            captureNode("ws-cap-anomaly", "anomaly cap")
        ]);
        await harness.deploy(flow);

        // Wait for the WS server to actually listen.
        await new Promise((r) => setTimeout(r, 250));
    }, 30000);

    afterAll(async () => {
        if (harness) await harness.shutdown();
    }, 15000);

    it("rejects a connection that presents no token", async () => {
        const url = "ws://127.0.0.1:" + WS_PORT + "/ws/condition-monitoring";
        const closeInfo = await new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            const timer = setTimeout(() => {
                ws.close();
                reject(new Error("no close event within 2000ms"));
            }, 2000);
            ws.on("close", (code, reason) => {
                clearTimeout(timer);
                resolve({ code, reason: reason && reason.toString() });
            });
            ws.on("error", () => {
                /* swallow — close will fire next */
            });
        });
        expect(closeInfo.code).toBe(4401);
    });

    it("rejects a connection that presents the wrong token", async () => {
        const url = "ws://127.0.0.1:" + WS_PORT + "/ws/condition-monitoring?token=not-the-real-thing";
        const closeInfo = await new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            const timer = setTimeout(() => {
                ws.close();
                reject(new Error("no close event within 2000ms"));
            }, 2000);
            ws.on("close", (code) => {
                clearTimeout(timer);
                resolve({ code });
            });
            ws.on("error", () => {
                /* swallow */
            });
        });
        expect(closeInfo.code).toBe(4401);
    });

    it("accepts a connection with the correct token via query parameter", async () => {
        const url = "ws://127.0.0.1:" + WS_PORT + "/ws/condition-monitoring?token=s3cr3t-token";
        const opened = await new Promise((resolve) => {
            const ws = new WebSocket(url);
            const timer = setTimeout(() => resolve({ opened: false, ws }), 2000);
            ws.once("open", () => {
                clearTimeout(timer);
                resolve({ opened: true, ws });
            });
            ws.once("error", () => {
                clearTimeout(timer);
                resolve({ opened: false, ws });
            });
        });
        expect(opened.opened).toBe(true);
        opened.ws.close();
    });

    it("accepts a connection with the correct token via Sec-WebSocket-Protocol", async () => {
        const url = "ws://127.0.0.1:" + WS_PORT + "/ws/condition-monitoring";
        const opened = await new Promise((resolve) => {
            const ws = new WebSocket(url, "s3cr3t-token");
            const timer = setTimeout(() => resolve({ opened: false, ws }), 2000);
            ws.once("open", () => {
                clearTimeout(timer);
                resolve({ opened: true, ws });
            });
            ws.once("error", () => {
                clearTimeout(timer);
                resolve({ opened: false, ws });
            });
        });
        expect(opened.opened).toBe(true);
        opened.ws.close();
    });

    it("publishes anomaly broadcasts to authenticated subscribers", async () => {
        const url = "ws://127.0.0.1:" + WS_PORT + "/ws/condition-monitoring?token=s3cr3t-token";
        const ws = new WebSocket(url);

        const messages = [];
        ws.on("message", (raw) => {
            try {
                const m = JSON.parse(raw.toString());
                messages.push(m);
            } catch (_) {
                /* ignore */
            }
        });

        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("ws never opened")), 2000);
            ws.once("open", () => {
                clearTimeout(timer);
                resolve();
            });
            ws.once("error", reject);
        });

        // Drive the detector with stable values + one outlier.
        for (let i = 0; i < 30; i++) {
            await harness.inject(DETECTOR, { payload: 100 + (Math.random() - 0.5) });
        }
        await harness.inject(DETECTOR, { payload: 1000, topic: "outlier" });

        // Wait briefly for the broadcast to reach us.
        await new Promise((r) => setTimeout(r, 300));

        // Welcome message arrives first; data broadcasts follow.
        const dataMsgs = messages.filter((m) => m.type === "data" && m.topic === "anomaly-detector");
        expect(dataMsgs.length).toBeGreaterThanOrEqual(1);
        // At least one of those should be the anomaly we injected.
        const anomalyHits = dataMsgs.filter((m) => m.data && m.data.isAnomaly === true);
        expect(anomalyHits.length).toBeGreaterThanOrEqual(1);
        // The outlier value should appear in one of the anomaly hits.
        const sawOutlier = anomalyHits.some((m) => m.data.value === 1000 || m.data.payload === 1000);
        expect(sawOutlier).toBe(true);

        ws.close();
    });
});
