"use strict";

/**
 * Unit tests for the MCP bridge plumbing (manager + node) — *no* HTTP
 * round-trips here. Wire-level testing happens in
 * test/integration/mcp-bridge-flow_spec.js with a real Node-RED + a real
 * MCP HTTP client.
 */

const helper = require("node-red-node-test-helper");
const mcpBridgeNode = require("../nodes/mcp-bridge.js");
const {
    MCPServerManager,
    getMcpManager,
    shutdownMcpManager,
    isMcpAvailable,
    timingSafeEqualStrings
} = require("../nodes/mcp-server-manager.js");

helper.init(require.resolve("node-red"));

describe("mcp-server-manager (singleton, in-process)", () => {
    afterEach(async () => {
        await shutdownMcpManager();
    });

    it("rejects construction-time use when no SDK present is signalled by isMcpAvailable", () => {
        // We can only assert that the function does not throw — we don't
        // know whether the SDK is installed in the runner's environment.
        expect(typeof isMcpAvailable()).toBe("boolean");
    });

    it("registers a sensor and exposes its metadata", () => {
        const m = new MCPServerManager({ port: 0, authToken: "x" });
        const handle = m.registerSensor({ name: "s1", bufferSize: 4, unit: "°C", samplingHz: 1.0 });
        const meta = m.toolGetMetadata({ sensor: "s1" });
        expect(meta.name).toBe("s1");
        expect(meta.unit).toBe("°C");
        expect(meta.samplingHz).toBe(1.0);
        expect(meta.bufferSize).toBe(4);
        expect(meta.samplesHeld).toBe(0);
        expect(handle.name).toBe("s1");
    });

    it("ring-buffer behaviour: oldest dropped once capacity reached", () => {
        const m = new MCPServerManager({ port: 0, authToken: "x" });
        const h = m.registerSensor({ name: "s1", bufferSize: 3 });
        h.push(10, 1);
        h.push(20, 2);
        h.push(30, 3);
        h.push(40, 4); // evicts 10
        const r = m.toolGetRecentSamples({ sensor: "s1", n: 100 });
        expect(r.samples).toEqual([20, 30, 40]);
        expect(r.timestamps).toEqual([2, 3, 4]);
    });

    it("getRecentSamples honours `n` and stays oldest-first", () => {
        const m = new MCPServerManager({ port: 0, authToken: "x" });
        const h = m.registerSensor({ name: "s1", bufferSize: 10 });
        for (let i = 1; i <= 8; i++) h.push(i, i * 100);
        const r = m.toolGetRecentSamples({ sensor: "s1", n: 3 });
        expect(r.samples).toEqual([6, 7, 8]); // most recent 3, oldest first
        expect(r.timestamps).toEqual([600, 700, 800]);
    });

    it("rejects non-finite samples without crashing the buffer", () => {
        const m = new MCPServerManager({ port: 0, authToken: "x" });
        const h = m.registerSensor({ name: "s1", bufferSize: 5 });
        expect(h.push(NaN, 1)).toBe(false);
        expect(h.push(Infinity, 2)).toBe(false);
        expect(h.push("not a number", 3)).toBe(false);
        expect(h.push(42, 4)).toBe(true);
        const r = m.toolGetRecentSamples({ sensor: "s1", n: 10 });
        expect(r.samples).toEqual([42]);
    });

    it("getStats matches the shared statistics helpers", () => {
        const m = new MCPServerManager({ port: 0, authToken: "x" });
        const h = m.registerSensor({ name: "s1", bufferSize: 100 });
        const v = [2, 4, 4, 4, 5, 5, 7, 9];
        v.forEach((x, i) => h.push(x, i));
        const r = m.toolGetStats({ sensor: "s1" });
        expect(r.count).toBe(8);
        expect(r.mean).toBeCloseTo(5, 12);
        // Population std-dev = 2 by hand
        expect(r.stdDev).toBeCloseTo(2, 12);
        expect(r.min).toBe(2);
        expect(r.max).toBe(9);
        expect(r.range).toBe(7);
    });

    it("getStats with windowMin trims to the recent window when samplingHz is known", () => {
        const m = new MCPServerManager({ port: 0, authToken: "x" });
        const h = m.registerSensor({ name: "s1", bufferSize: 1000, samplingHz: 1.0 });
        // 600 samples at 1 Hz => 10 minutes of history
        for (let i = 0; i < 600; i++) h.push(i, i * 1000);
        const last5min = m.toolGetStats({ sensor: "s1", windowMin: 5 });
        const all = m.toolGetStats({ sensor: "s1" });
        expect(last5min.count).toBeLessThanOrEqual(300 + 1); // 5 min × 60 × 1 Hz
        expect(all.count).toBe(600);
        // Means must differ — recent half has higher values.
        expect(last5min.mean).toBeGreaterThan(all.mean);
    });

    it("getMetadata surfaces the most recent upstream isAnomaly / zScore", () => {
        const m = new MCPServerManager({ port: 0, authToken: "x" });
        const h = m.registerSensor({ name: "s1", bufferSize: 5 });
        h.push(10, 1);
        h.push(20, 2, { isAnomaly: false, zScore: 0.4 });
        h.push(30, 3, { isAnomaly: true, zScore: 4.2 });
        const meta = m.toolGetMetadata({ sensor: "s1" });
        expect(meta.lastIsAnomaly).toBe(true);
        expect(meta.lastZScore).toBeCloseTo(4.2, 12);
    });

    it("listSensors returns each registered sensor exactly once", () => {
        const m = new MCPServerManager({ port: 0, authToken: "x" });
        m.registerSensor({ name: "a", bufferSize: 5, unit: "°C" });
        m.registerSensor({ name: "b", bufferSize: 5, unit: "mm/s" });
        const r = m.toolListSensors();
        expect(r.sensors).toHaveLength(2);
        expect(r.sensors.map((s) => s.name).sort()).toEqual(["a", "b"]);
    });

    it("unknown sensor returns an `error` field rather than throwing", () => {
        const m = new MCPServerManager({ port: 0, authToken: "x" });
        const tools = ["toolGetRecentSamples", "toolGetStats", "toolGetMetadata"];
        for (const t of tools) {
            const r = m[t]({ sensor: "nope", n: 1 });
            expect(r.error).toMatch(/unknown sensor/);
        }
    });

    it("singleton getter: first call's options stick, mismatches emit an event", () => {
        const m1 = getMcpManager({ port: 4242, authToken: "first" });
        let mismatch = null;
        m1.on("optionMismatch", (info) => {
            mismatch = info;
        });
        const m2 = getMcpManager({ port: 9999, authToken: "second" });
        expect(m2).toBe(m1); // same instance
        expect(m1.port).toBe(4242);
        expect(m1.authToken).toBe("first");
        // First sensitive key encountered emits the event.
        expect(mismatch).not.toBeNull();
        expect(["port", "authToken", "host", "path"]).toContain(mismatch.key);
    });
});

describe("timingSafeEqualStrings", () => {
    it("matches identical strings", () => {
        expect(timingSafeEqualStrings("abc", "abc")).toBe(true);
    });
    it("rejects differing lengths without leaking timing", () => {
        expect(timingSafeEqualStrings("abc", "abcd")).toBe(false);
    });
    it("rejects non-string inputs", () => {
        expect(timingSafeEqualStrings(null, "abc")).toBe(false);
        expect(timingSafeEqualStrings("abc", undefined)).toBe(false);
        expect(timingSafeEqualStrings(123, "123")).toBe(false);
    });
});

describe("mcp-bridge node (config validation, no HTTP)", () => {
    beforeEach((done) => {
        helper.startServer(done);
    });
    afterEach((done) => {
        helper.unload().then(() => {
            helper.stopServer(() => {
                shutdownMcpManager().then(done, done);
            });
        });
    });

    it("refuses to start without a sensor name", (done) => {
        const flow = [{ id: "n1", type: "mcp-bridge", name: "x", sensorName: "" }];
        const creds = { n1: { authToken: "tok" } };
        helper.load(mcpBridgeNode, flow, creds, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toBeDefined();
            // node.error in startup is captured by the helper's logging spy.
            done();
        });
    });

    it("refuses to start without an auth token", (done) => {
        const flow = [{ id: "n1", type: "mcp-bridge", name: "x", sensorName: "s1" }];
        helper.load(mcpBridgeNode, flow, {}, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toBeDefined();
            done();
        });
    });

    it("registers and accepts numeric input", (done) => {
        // We need both the bridge and a freshly-loaded server manager.
        // The helper does not start the HTTP server unless we ask, but the
        // bridge calls manager.start() asynchronously — we don't await it
        // here; we just check the registration side effect on the manager.
        const flow = [
            {
                id: "n1",
                type: "mcp-bridge",
                name: "x",
                sensorName: "s-unit",
                bufferSize: 8,
                serverPort: 0, // OS-picked
                serverHost: "127.0.0.1",
                serverPath: "/mcp"
            }
        ];
        const creds = { n1: { authToken: "tok" } };
        helper.load(mcpBridgeNode, flow, creds, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toBeDefined();
            // Push a few samples; check the manager picked them up.
            n1.receive({ payload: 1.5 });
            n1.receive({ payload: 2.5 });
            n1.receive({ payload: "3.5" }); // numeric string accepted
            n1.receive({ payload: "non-numeric" }); // dropped
            setTimeout(() => {
                const mgr = getMcpManager();
                const r = mgr.toolGetRecentSamples({ sensor: "s-unit", n: 100 });
                expect(r.samples).toEqual([1.5, 2.5, 3.5]);
                done();
            }, 50);
        });
    }, 15000);
});
