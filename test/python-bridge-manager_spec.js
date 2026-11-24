"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
    PythonBridgeManager,
    getGlobalBridge,
    shutdownGlobalBridge,
    resetGlobalCrashLedger
} = require("../nodes/python-bridge-manager");

/**
 * These tests exercise the bridge protocol without any Python ML stack.
 * Process-level tests use a tiny fake bridge script (plain Python 3, no
 * third-party imports) that speaks the same JSON-lines protocol as
 * nodes/python/python_bridge.py. They are skipped when no Python
 * interpreter is installed at all.
 */
function pythonAvailable() {
    for (const cmd of ["python3", "python"]) {
        try {
            const r = spawnSync(cmd, ["--version"], { stdio: "ignore" });
            if (!r.error && r.status === 0) return true;
        } catch {
            /* not available */
        }
    }
    return false;
}

const describeWithPython = pythonAvailable() ? describe : describe.skip;

/** Wait for a single event on an EventEmitter, with a timeout. */
function once(emitter, event, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}" event`)), timeoutMs);
        emitter.once(event, (payload) => {
            clearTimeout(timer);
            resolve(payload);
        });
    });
}

// NOTE: the 0.25s sleep before the ready line is deliberate. start() in
// python-bridge-manager.js only registers its "response" listener ~100ms
// after spawning (the _tryStart settle timer), so a bridge that prints
// "ready" faster than that is never seen and start() times out. The real
// bridge is slow enough (ML imports) that this doesn't bite in production.
const FAKE_BRIDGE_PY = [
    "import sys, json, time",
    "",
    "time.sleep(0.25)",
    'print(json.dumps({"id": "ready", "success": True, "result": {"python": "fake", "packages": {}}}))',
    "sys.stdout.flush()",
    "",
    "for line in sys.stdin:",
    "    line = line.strip()",
    "    if not line:",
    "        continue",
    "    req = json.loads(line)",
    '    cmd = req.get("command")',
    '    if cmd == "ping":',
    '        print(json.dumps({"id": req["id"], "success": True, "result": {"pong": True}}))',
    '    elif cmd == "fail":',
    '        print(json.dumps({"id": req["id"], "success": False, "error": "synthetic failure"}))',
    '    elif cmd == "crash":',
    "        sys.exit(3)",
    '    elif cmd == "noise":',
    '        print("1/1 [==============================] - 0s 20ms/step")',
    '        print(json.dumps({"id": req["id"], "success": True, "result": {"noisy": True}}))',
    '    elif cmd == "closestdin":',
    "        import os",
    "        os.close(0)",
    "        time.sleep(1.5)",
    "        sys.exit(0)",
    '    elif cmd == "shutdown":',
    '        print(json.dumps({"id": req["id"], "success": True, "result": "bye"}))',
    "        sys.stdout.flush()",
    "        sys.exit(0)",
    "    else:",
    '        print(json.dumps({"id": req["id"], "success": False, "error": "unknown command"}))',
    "    sys.stdout.flush()",
    ""
].join("\n");

const NEVER_READY_PY = ["import time", "time.sleep(60)", ""].join("\n");

// Survives the 100ms spawn settle window, then dies without ever signalling ready.
const DIES_EARLY_PY = ["import sys, time", "time.sleep(0.4)", "sys.exit(7)", ""].join("\n");

describe("PythonBridgeManager", () => {
    let tmpDir;
    let fakeBridgeScript;
    let neverReadyScript;
    let diesEarlyScript;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ncm-pybridge-"));
        fakeBridgeScript = path.join(tmpDir, "fake_bridge.py");
        neverReadyScript = path.join(tmpDir, "never_ready.py");
        fs.writeFileSync(fakeBridgeScript, FAKE_BRIDGE_PY);
        fs.writeFileSync(neverReadyScript, NEVER_READY_PY);
        diesEarlyScript = path.join(tmpDir, "dies_early.py");
        fs.writeFileSync(diesEarlyScript, DIES_EARLY_PY);
    });

    afterAll(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            /* best effort */
        }
    });

    /**
     * Bridge whose "process" is an inert stub: lets us drive the real
     * request/response bookkeeping (_handleResponse, timeouts, stats)
     * without spawning anything.
     */
    function makeStubbedBridge(options = {}) {
        const bridge = new PythonBridgeManager({ requestTimeout: 200, ...options });
        bridge.isReady = true;
        bridge.process = {
            stdin: { write: jest.fn() },
            killed: false,
            kill: jest.fn()
        };
        return bridge;
    }

    describe("input validation", () => {
        it("rejects sendCommand when the bridge is not ready", async () => {
            const bridge = new PythonBridgeManager();
            await expect(bridge.sendCommand("ping")).rejects.toThrow("Python bridge not ready");
        });

        it("rejects an empty command", async () => {
            const bridge = makeStubbedBridge();
            await expect(bridge.sendCommand("")).rejects.toThrow("command must be a non-empty string");
            await expect(bridge.sendCommand(null)).rejects.toThrow(/not ready|non-empty string/);
        });

        it("rejects loadModel with an invalid modelPath", async () => {
            const bridge = makeStubbedBridge();
            await expect(bridge.loadModel("")).rejects.toThrow("modelPath must be a non-empty string");
            await expect(bridge.loadModel(42)).rejects.toThrow("modelPath must be a non-empty string");
        });

        it("rejects predict with an invalid modelId or input", async () => {
            const bridge = makeStubbedBridge();
            await expect(bridge.predict("", [1, 2])).rejects.toThrow("modelId must be a non-empty string");
            await expect(bridge.predict("model", "not-an-array")).rejects.toThrow("inputData must be an array");
        });
    });

    describe("request/response handling (stubbed process)", () => {
        it("resolves a pending request on a success response and updates stats", async () => {
            const bridge = makeStubbedBridge();
            const pending = bridge.sendCommand("ping");
            expect(bridge.getStats().pendingRequests).toBe(1);

            bridge._handleResponse(JSON.stringify({ id: "req_1", success: true, result: { pong: true } }));

            await expect(pending).resolves.toEqual({ pong: true });
            const stats = bridge.getStats();
            expect(stats.requestsProcessed).toBe(1);
            expect(stats.pendingRequests).toBe(0);
            expect(stats.errors).toBe(0);
        });

        it("rejects a pending request on a failure response and counts the error", async () => {
            const bridge = makeStubbedBridge();
            const pending = bridge.sendCommand("fail");

            bridge._handleResponse(JSON.stringify({ id: "req_1", success: false, error: "synthetic failure" }));

            await expect(pending).rejects.toThrow("synthetic failure");
            expect(bridge.getStats().errors).toBe(1);
            expect(bridge.getStats().pendingRequests).toBe(0);
        });

        it("emits an error event when a response line is not JSON", async () => {
            const bridge = makeStubbedBridge();
            const errorPromise = once(bridge, "error");
            bridge._handleResponse("definitely not json");
            const err = await errorPromise;
            expect(err.message).toMatch(/Failed to parse response/);
        });

        it("does not throw on a non-JSON line when nobody listens for 'error'", async () => {
            // ml-inference only subscribes to 'stderr' and 'exit'. A bare
            // 'error' emit would throw here and crash the runtime.
            const bridge = makeStubbedBridge();
            const protocolErrors = [];
            bridge.on("protocolError", (e) => protocolErrors.push(e));
            expect(() => bridge._handleResponse("1/1 [=====] - 0s 20ms/step")).not.toThrow();
            expect(() => bridge._handleResponse("null")).not.toThrow();
            expect(() => bridge._handleResponse("42")).not.toThrow();
            expect(protocolErrors).toHaveLength(3);
            expect(protocolErrors[0].message).toMatch(/Failed to parse response/);
        });

        it("rejects pending requests when stop() detaches the process", async () => {
            const bridge = makeStubbedBridge({ requestTimeout: 5000 });
            const pending = bridge.sendCommand("ping");
            // The stub never answers "shutdown"; don't wait for its timeout.
            bridge.sendCommand = jest.fn().mockRejectedValue(new Error("no answer"));
            await bridge.stop();
            await expect(pending).rejects.toThrow("Python bridge stopped");
            expect(bridge.getStats().pendingRequests).toBe(0);
        });

        it("emits 'response' but leaves pending requests alone for unknown ids", async () => {
            const bridge = makeStubbedBridge();
            const pending = bridge.sendCommand("ping");
            const responsePromise = once(bridge, "response");

            bridge._handleResponse(JSON.stringify({ id: "req_999", success: true, result: 1 }));

            const response = await responsePromise;
            expect(response.id).toBe("req_999");
            expect(bridge.getStats().pendingRequests).toBe(1);

            // Clean up the still-pending request.
            bridge._handleResponse(JSON.stringify({ id: "req_1", success: true, result: null }));
            await pending;
        });

        it("times out a request that never gets a response", async () => {
            const bridge = makeStubbedBridge({ requestTimeout: 40 });
            await expect(bridge.sendCommand("ping")).rejects.toThrow("Request timeout: ping");
            expect(bridge.getStats().pendingRequests).toBe(0);
        });

        it("rejects immediately when writing to stdin throws", async () => {
            const bridge = makeStubbedBridge();
            bridge.process.stdin.write = () => {
                throw new Error("EPIPE: broken pipe");
            };
            await expect(bridge.sendCommand("ping")).rejects.toThrow("EPIPE");
            expect(bridge.getStats().pendingRequests).toBe(0);
        });

        it("rejects with EBUSY once maxPendingRequests are in flight, without writing to Python", async () => {
            const bridge = makeStubbedBridge({ requestTimeout: 5000, maxPendingRequests: 2 });
            const a = bridge.sendCommand("ping");
            const b = bridge.sendCommand("ping");

            const err = await bridge.sendCommand("ping").catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.code).toBe("EBUSY");
            expect(err.message).toMatch(/busy: 2 requests pending \(limit 2\)/);
            expect(bridge.getStats().pendingRequests).toBe(2);
            expect(bridge.process.stdin.write).toHaveBeenCalledTimes(2);

            bridge._handleResponse(JSON.stringify({ id: "req_1", success: true, result: 1 }));
            bridge._handleResponse(JSON.stringify({ id: "req_2", success: true, result: 2 }));
            await expect(Promise.all([a, b])).resolves.toEqual([1, 2]);

            // Capacity is back once the backlog drained.
            const c = bridge.sendCommand("ping");
            bridge._handleResponse(JSON.stringify({ id: "req_3", success: true, result: 3 }));
            await expect(c).resolves.toBe(3);
        });

        it("caps pending requests at 64 by default", () => {
            expect(new PythonBridgeManager().maxPendingRequests).toBe(64);
        });
    });

    describe("crash backoff (ledger driven, no process)", () => {
        it("refuses start() inside the backoff window after a crash and says how long", async () => {
            const bridge = new PythonBridgeManager({ crashBackoffMs: 30000 });
            bridge._recordCrash(Date.now() - 5000);

            const err = await bridge.start().catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.code).toBe("EBRIDGEBACKOFF");
            expect(err.message).toMatch(/crashed 5 s ago; not restarting it for another 25 s/);
            expect(bridge.process).toBeNull();
        });

        it("allows start() again once the backoff has passed", () => {
            const bridge = new PythonBridgeManager({ crashBackoffMs: 30000 });
            bridge._recordCrash(Date.now() - 31000);
            expect(bridge._restartRefusal()).toBeNull();
        });

        it("locks out after maxCrashRestarts crashes within the window, until the window has passed", () => {
            const bridge = new PythonBridgeManager({ crashBackoffMs: 0, maxCrashRestarts: 3, crashWindowMs: 600000 });
            const now = Date.now();
            bridge._recordCrash(now - 3000);
            bridge._recordCrash(now - 2000);
            expect(bridge._restartRefusal(now)).toBeNull();

            bridge._recordCrash(now - 1000);
            const err = bridge._restartRefusal(now);
            expect(err.code).toBe("EBRIDGELOCKOUT");
            expect(err.message).toMatch(/crashed 3 times within 10 min; not restarting it for another 599 s/);
            expect(err.message).toMatch(/restart Node-RED to retry now/);

            // Crashes age out of the window; one fresh attempt is allowed then.
            expect(bridge._restartRefusal(now + 600000)).toBeNull();
        });

        it("shares one ledger across the instances getGlobalBridge hands out after a crash", async () => {
            resetGlobalCrashLedger();
            const a = getGlobalBridge();
            a._recordCrash();
            // What ml-inference's forgetPythonBridge does on `exit`: drop the
            // singleton, so the next predict() constructs a new instance.
            await shutdownGlobalBridge();
            const b = getGlobalBridge();
            expect(b).not.toBe(a);

            const err = await b.start().catch((e) => e);
            expect(err.code).toBe("EBRIDGEBACKOFF");
            expect(b.process).toBeNull();

            resetGlobalCrashLedger();
            expect(b._restartRefusal()).toBeNull();
            await shutdownGlobalBridge();
        });

        it("a clean stop() of a running bridge ends the crash series", async () => {
            const bridge = makeStubbedBridge({ requestTimeout: 50 });
            bridge._recordCrash(Date.now() - 1000);
            bridge.sendCommand = jest.fn().mockRejectedValue(new Error("no answer"));
            await bridge.stop();
            expect(bridge._restartRefusal()).toBeNull();
        });
    });

    describe("startup error paths", () => {
        it("reports 'Python not found' when no candidate executable exists", (done) => {
            const bridge = new PythonBridgeManager();
            bridge._tryStart(["definitely-not-a-python-xyz", "also-not-python-abc"], 0, (err) => {
                try {
                    expect(err).toBeInstanceOf(Error);
                    expect(err.message).toMatch(/Python not found/);
                    expect(bridge.process).toBeNull();
                    done();
                } catch (assertionErr) {
                    done(assertionErr);
                }
            });
        });

        it("resolves stop() when the bridge was never started", async () => {
            const bridge = new PythonBridgeManager();
            await expect(bridge.stop()).resolves.toBeUndefined();
        });
    });

    describe("singleton helpers", () => {
        it("shutdownGlobalBridge frees the singleton before the old bridge has stopped", async () => {
            const a = getGlobalBridge();
            let release;
            a.stop = () => new Promise((resolve) => (release = resolve));
            const shuttingDown = shutdownGlobalBridge();
            // A node re-created during the shutdown window must not get the dying bridge.
            const b = getGlobalBridge();
            expect(b).not.toBe(a);
            release();
            await shuttingDown;
            expect(getGlobalBridge()).toBe(b);
            await shutdownGlobalBridge();
        });

        it("getGlobalBridge returns the same instance until shutdown", async () => {
            const a = getGlobalBridge();
            expect(getGlobalBridge()).toBe(a);
            await shutdownGlobalBridge();
            const b = getGlobalBridge();
            expect(b).not.toBe(a);
            await shutdownGlobalBridge();
        });
    });

    describeWithPython("with a fake python bridge process", () => {
        let bridge = null;

        afterEach(async () => {
            if (bridge && bridge.process) {
                try {
                    await bridge.stop();
                } catch {
                    /* best effort */
                }
            }
            bridge = null;
        });

        it("starts, reports ready and answers a round-trip command", async () => {
            bridge = new PythonBridgeManager({
                bridgeScript: fakeBridgeScript,
                startupTimeout: 10000,
                requestTimeout: 5000
            });

            const readyInfo = await bridge.start();
            expect(bridge.isReady).toBe(true);
            expect(readyInfo).toEqual({ python: "fake", packages: {} });

            const pong = await bridge.sendCommand("ping");
            expect(pong).toEqual({ pong: true });

            const stats = bridge.getStats();
            expect(stats.isReady).toBe(true);
            expect(stats.requestsProcessed).toBeGreaterThanOrEqual(1);

            await bridge.stop();
            expect(bridge.isReady).toBe(false);
            expect(bridge.process).toBeNull();
        });

        it("propagates a success:false response as a rejection", async () => {
            bridge = new PythonBridgeManager({
                bridgeScript: fakeBridgeScript,
                startupTimeout: 10000,
                requestTimeout: 5000
            });
            await bridge.start();
            await expect(bridge.sendCommand("fail")).rejects.toThrow("synthetic failure");
            expect(bridge.getStats().errors).toBe(1);
        });

        it("rejects pending requests and emits 'exit' when the process crashes", async () => {
            bridge = new PythonBridgeManager({
                bridgeScript: fakeBridgeScript,
                startupTimeout: 10000,
                requestTimeout: 5000
            });
            await bridge.start();

            const exitPromise = once(bridge, "exit");
            await expect(bridge.sendCommand("crash")).rejects.toThrow("Python bridge exited with code 3");
            const exitInfo = await exitPromise;
            expect(exitInfo.code).toBe(3);
            expect(bridge.isReady).toBe(false);
            expect(bridge.process).toBeNull();
            expect(bridge.getStats().pendingRequests).toBe(0);
        });

        it("refuses to respawn inside the backoff window after a crash (no respawn storm)", async () => {
            bridge = new PythonBridgeManager({
                bridgeScript: fakeBridgeScript,
                startupTimeout: 10000,
                requestTimeout: 5000,
                crashBackoffMs: 60000
            });
            await bridge.start();

            const exitPromise = once(bridge, "exit");
            await expect(bridge.sendCommand("crash")).rejects.toThrow(/exited with code 3/);
            await exitPromise;

            const started = Date.now();
            const err = await bridge.start().catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.code).toBe("EBRIDGEBACKOFF");
            expect(err.message).toMatch(/Python bridge crashed 0 s ago; not restarting it for another 60 s/);
            // Refused up front: no interpreter was spawned.
            expect(Date.now() - started).toBeLessThan(500);
            expect(bridge.process).toBeNull();
            expect(bridge.isReady).toBe(false);
        });

        it("stays down with a clear error after too many crashes in the window", async () => {
            bridge = new PythonBridgeManager({
                bridgeScript: fakeBridgeScript,
                startupTimeout: 10000,
                requestTimeout: 5000,
                crashBackoffMs: 0,
                maxCrashRestarts: 2,
                crashWindowMs: 600000
            });
            for (let i = 0; i < 2; i++) {
                await bridge.start();
                const exitPromise = once(bridge, "exit");
                await bridge.sendCommand("crash").catch(() => {});
                await exitPromise;
            }
            const err = await bridge.start().catch((e) => e);
            expect(err.code).toBe("EBRIDGELOCKOUT");
            expect(err.message).toMatch(/crashed 2 times within 10 min/);
            expect(bridge.process).toBeNull();
        }, 20000);

        it("does not count a death before ready as a crash", async () => {
            bridge = new PythonBridgeManager({
                bridgeScript: diesEarlyScript,
                startupTimeout: 20000,
                requestTimeout: 1000
            });
            await expect(bridge.start()).rejects.toThrow(/exited during startup/);
            expect(bridge._restartRefusal()).toBeNull();
        });

        it("survives stdout noise from the child without an 'error' listener", async () => {
            bridge = new PythonBridgeManager({
                bridgeScript: fakeBridgeScript,
                startupTimeout: 10000,
                requestTimeout: 5000
            });
            await bridge.start();
            await expect(bridge.sendCommand("noise")).resolves.toEqual({ noisy: true });
        });

        it("turns an EPIPE on the child's stdin into rejected requests, not a crash", async () => {
            bridge = new PythonBridgeManager({
                bridgeScript: fakeBridgeScript,
                startupTimeout: 10000,
                requestTimeout: 800
            });
            await bridge.start();
            // The child closes its end of the pipe but stays alive for a while.
            bridge.sendCommand("closestdin").catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 300));
            const big = new Array(200000).fill(1.5);
            const results = [];
            for (let i = 0; i < 4; i++) {
                results.push(bridge.sendCommand("predict", { input_data: big }).catch((e) => e));
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            const settled = await Promise.all(results);
            settled.forEach((r) => expect(r).toBeInstanceOf(Error));
        });

        it("fails start() promptly when the child dies before signalling ready", async () => {
            bridge = new PythonBridgeManager({
                bridgeScript: diesEarlyScript,
                startupTimeout: 20000,
                requestTimeout: 1000
            });
            const started = Date.now();
            await expect(bridge.start()).rejects.toThrow(/exited during startup \(code 7/);
            expect(Date.now() - started).toBeLessThan(5000);
            expect(bridge.process).toBeNull();
        });

        it("ignores the late exit of a stopped child after a restart", async () => {
            bridge = new PythonBridgeManager({
                bridgeScript: fakeBridgeScript,
                startupTimeout: 10000,
                requestTimeout: 5000
            });
            const exits = [];
            bridge.on("exit", (info) => exits.push(info));
            await bridge.start();
            await bridge.stop();
            await bridge.start();
            // Leave time for anything the first child still had to say.
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(bridge.isReady).toBe(true);
            await expect(bridge.sendCommand("ping")).resolves.toEqual({ pong: true });
            expect(exits).toHaveLength(0);
        });

        it("speaks the protocol with the real bridge script (no ML packages needed)", async () => {
            bridge = new PythonBridgeManager({ startupTimeout: 20000, requestTimeout: 10000 });
            await bridge.start();
            await expect(bridge.ping()).resolves.toEqual({ message: "pong" });
            await expect(bridge.loadModel("/nonexistent/model.txt", "m")).rejects.toThrow(/Unsupported model format/);
        }, 30000);

        it("rejects start() when the bridge never signals ready", async () => {
            bridge = new PythonBridgeManager({
                bridgeScript: neverReadyScript,
                startupTimeout: 500,
                requestTimeout: 1000
            });
            await expect(bridge.start()).rejects.toThrow("Python bridge startup timeout");
            // start() kicks off an async stop(); give it time to SIGTERM the child.
            await new Promise((resolve) => setTimeout(resolve, 800));
            expect(bridge.process).toBeNull();
        });
    });

    // Anything that needs a *real* model (load_model/predict against keras,
    // sklearn or onnx artifacts) requires a Python ML environment and is out
    // of scope for hermetic unit tests — covered by manual/integration runs.
    test.skip("loadModel/predict against a real ML model requires a Python ML stack", () => {});
});
