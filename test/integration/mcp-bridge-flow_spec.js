"use strict";

const http = require("http");

const { startRed, buildFlow } = require("./red-runtime");
const { shutdownMcpManager } = require("../../nodes/mcp-server-manager");

/**
 * End-to-end test: real Node-RED, real `mcp-bridge` nodes, real HTTP client
 * making JSON-RPC tool calls. Verifies Phase 1 of the SPEC.
 */

function jsonRpcCall(port, token, method, params) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                method: "POST",
                hostname: "127.0.0.1",
                port,
                path: "/mcp",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json, text/event-stream",
                    Authorization: token ? "Bearer " + token : "",
                    "Content-Length": Buffer.byteLength(body)
                },
                timeout: 5000
            },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    let parsed = null;
                    try {
                        parsed = JSON.parse(text);
                    } catch (_) {
                        /* leave parsed null on non-JSON (e.g. 401 body) */
                    }
                    resolve({ status: res.statusCode, body: text, json: parsed });
                });
            }
        );
        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy(new Error("request timeout"));
        });
        req.write(body);
        req.end();
    });
}

function unwrapTool(rpcResponse) {
    // tools/call wraps the actual payload as content[0].text — JSON-decode it
    // so individual assertions don't have to care.
    const text = rpcResponse?.json?.result?.content?.[0]?.text;
    if (typeof text !== "string") return null;
    try {
        return JSON.parse(text);
    } catch (_) {
        return null;
    }
}

describe("integration: mcp-bridge end-to-end", () => {
    let harness;
    const TAB = "mcp-tab";
    const MCP_PORT = 24000 + Math.floor(Math.random() * 4000);
    const TOKEN = "integration-secret-9b7f";

    beforeAll(async () => {
        harness = await startRed();
        const flow = buildFlow(TAB, "mcp", [
            {
                id: "bridge-A",
                type: "mcp-bridge",
                name: "bridge A",
                sensorName: "machine-A/temp",
                bufferSize: 32,
                unit: "°C",
                samplingHz: 1.0,
                serverPort: MCP_PORT,
                serverHost: "127.0.0.1",
                serverPath: "/mcp",
                authToken: TOKEN, // inline token (credentials path is unit-tested)
                persistState: false,
                wires: []
            },
            {
                id: "bridge-B",
                type: "mcp-bridge",
                name: "bridge B",
                sensorName: "machine-B/vibration",
                bufferSize: 16,
                unit: "mm/s",
                samplingHz: 100.0,
                serverPort: MCP_PORT,
                serverHost: "127.0.0.1",
                serverPath: "/mcp",
                authToken: TOKEN,
                persistState: false,
                wires: []
            }
        ]);
        await harness.deploy(flow);
        // Manager.start() resolves async; give it a moment to bind.
        await new Promise((r) => setTimeout(r, 250));
    }, 30000);

    afterAll(async () => {
        await shutdownMcpManager();
        if (harness) await harness.shutdown();
    }, 15000);

    it("rejects requests without the bearer token (401)", async () => {
        const r = await jsonRpcCall(MCP_PORT, null, "tools/list", {});
        expect(r.status).toBe(401);
        expect(r.json).toBeNull();
    });

    it("rejects requests with the wrong bearer token (401)", async () => {
        const r = await jsonRpcCall(MCP_PORT, "wrong-token", "tools/list", {});
        expect(r.status).toBe(401);
    });

    it("tools/list advertises the four Phase-1 tools", async () => {
        const r = await jsonRpcCall(MCP_PORT, TOKEN, "tools/list", {});
        expect(r.status).toBe(200);
        const names = (r.json?.result?.tools || []).map((t) => t.name).sort();
        expect(names).toEqual(["getMetadata", "getRecentSamples", "getStats", "listSensors"]);
    });

    it("listSensors shows both deployed bridges", async () => {
        const r = await jsonRpcCall(MCP_PORT, TOKEN, "tools/call", {
            name: "listSensors",
            arguments: {}
        });
        expect(r.status).toBe(200);
        const payload = unwrapTool(r);
        expect(payload).not.toBeNull();
        const names = payload.sensors.map((s) => s.name).sort();
        expect(names).toEqual(["machine-A/vibration".replace("vibration", "temp"), "machine-B/vibration"]);
        const a = payload.sensors.find((s) => s.name === "machine-A/temp");
        expect(a.unit).toBe("°C");
        expect(a.samplingHz).toBe(1.0);
        expect(a.bufferSize).toBe(32);
    });

    it("getRecentSamples returns the most recent samples in oldest-first order", async () => {
        // Push 5 values into bridge A.
        await harness.inject("bridge-A", { payload: 10, timestamp: 1000 });
        await harness.inject("bridge-A", { payload: 11, timestamp: 1100 });
        await harness.inject("bridge-A", { payload: 12, timestamp: 1200 });
        await harness.inject("bridge-A", { payload: 13, timestamp: 1300 });
        await harness.inject("bridge-A", { payload: 14, timestamp: 1400 });
        // Tiny settle so the sync receive() has propagated to the manager.
        await new Promise((r) => setTimeout(r, 50));

        const r = await jsonRpcCall(MCP_PORT, TOKEN, "tools/call", {
            name: "getRecentSamples",
            arguments: { sensor: "machine-A/temp", n: 3 }
        });
        expect(r.status).toBe(200);
        const payload = unwrapTool(r);
        expect(payload.samples).toEqual([12, 13, 14]);
        expect(payload.timestamps).toEqual([1200, 1300, 1400]);
        expect(payload.unit).toBe("°C");
    });

    it("getStats returns count + mean + stdDev that match a hand calculation", async () => {
        // Fresh injections into bridge B, six samples we can verify by hand.
        await harness.inject("bridge-B", { payload: 1 });
        await harness.inject("bridge-B", { payload: 2 });
        await harness.inject("bridge-B", { payload: 3 });
        await harness.inject("bridge-B", { payload: 4 });
        await harness.inject("bridge-B", { payload: 5 });
        await harness.inject("bridge-B", { payload: 6 });
        await new Promise((r) => setTimeout(r, 50));

        const r = await jsonRpcCall(MCP_PORT, TOKEN, "tools/call", {
            name: "getStats",
            arguments: { sensor: "machine-B/vibration" }
        });
        expect(r.status).toBe(200);
        const payload = unwrapTool(r);
        expect(payload.count).toBe(6);
        expect(payload.mean).toBeCloseTo(3.5, 6);
        // Population std-dev of [1..6] = sqrt(35/12) ≈ 1.7078
        expect(payload.stdDev).toBeCloseTo(Math.sqrt(35 / 12), 6);
        expect(payload.min).toBe(1);
        expect(payload.max).toBe(6);
        expect(payload.range).toBe(5);
    });

    it("getMetadata surfaces upstream isAnomaly / zScore tagging", async () => {
        await harness.inject("bridge-A", { payload: 100, isAnomaly: false, zScore: 0.4 });
        await harness.inject("bridge-A", { payload: 999, isAnomaly: true, zScore: 6.7 });
        await new Promise((r) => setTimeout(r, 50));

        const r = await jsonRpcCall(MCP_PORT, TOKEN, "tools/call", {
            name: "getMetadata",
            arguments: { sensor: "machine-A/temp" }
        });
        expect(r.status).toBe(200);
        const payload = unwrapTool(r);
        expect(payload.lastIsAnomaly).toBe(true);
        expect(payload.lastZScore).toBeCloseTo(6.7, 6);
        expect(payload.unit).toBe("°C");
        expect(payload.bufferSize).toBe(32);
    });

    it("unknown sensor returns an MCP-level error response", async () => {
        const r = await jsonRpcCall(MCP_PORT, TOKEN, "tools/call", {
            name: "getMetadata",
            arguments: { sensor: "no-such-sensor" }
        });
        expect(r.status).toBe(200);
        // The tool returns isError: true and the error text in content.
        expect(r.json?.result?.isError).toBe(true);
        const text = r.json?.result?.content?.[0]?.text || "";
        expect(text).toMatch(/unknown sensor/);
    });
});
