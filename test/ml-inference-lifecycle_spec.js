"use strict";

/**
 * Lifecycle tests for ml-inference that need neither Node-RED nor an ML
 * runtime: model sources are served by a local HTTP "registry", the Python
 * bridge is the real nodes/python/python_bridge.py (plain Python 3, no ML
 * packages — loading then fails inside the bridge, which is all these tests
 * need to tell "the bridge answered" from "the bridge was gone").
 *
 * The node is driven through a small RED double instead of the test helper so
 * that module-level state (the shared bridges) starts fresh for every test.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const EventEmitter = require("events");
const { spawnSync } = require("child_process");

const hasONNX = (() => {
    try {
        require("onnxruntime-node");
        return true;
    } catch {
        return false;
    }
})();
const hasPython3 = (() => {
    try {
        const r = spawnSync("python3", ["--version"], { stdio: "ignore" });
        return !r.error && r.status === 0;
    } catch {
        return false;
    }
})();
const itIf = (cond) => (cond ? it : it.skip);

const BUNDLED_ONNX = path.join(__dirname, "..", "nodes", "models", "bearing_fault_clf.onnx");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 5000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error("condition not met within " + timeoutMs + "ms");
        await sleep(20);
    }
}

describe("ml-inference lifecycle", () => {
    let userDir;
    let RED;
    let NodeCtor;
    let registry;
    let registryMode;
    let registryHits;
    const nodes = [];

    function loadModule() {
        jest.resetModules();
        RED = {
            settings: { userDir },
            events: new EventEmitter(),
            httpAdmin: { get() {}, post() {}, delete() {} },
            auth: { needsPermission: () => (req, res, next) => next() },
            log: { debug() {}, info() {}, warn() {} },
            util: { cloneMessage: (m) => JSON.parse(JSON.stringify(m)) },
            nodes: {
                createNode(node, config) {
                    const emitter = new EventEmitter();
                    node.on = emitter.on.bind(emitter);
                    node.emit = emitter.emit.bind(emitter);
                    node.id = config.id;
                    node.name = config.name;
                    node.statuses = [];
                    node.errors = [];
                    node.warnings = [];
                    node.status = (s) => node.statuses.push(s);
                    node.error = (m) => node.errors.push(String((m && m.message) || m));
                    node.warn = (m) => node.warnings.push(String(m));
                    node.log = () => {};
                    node.send = () => {};
                },
                registerType(type, ctor) {
                    NodeCtor = ctor;
                }
            }
        };
        require("../nodes/ml-inference.js")(RED);
    }

    function createNode(config) {
        const node = new NodeCtor(config);
        nodes.push(node);
        return node;
    }

    function closeNode(node) {
        return new Promise((resolve) => node.emit("close", resolve));
    }

    function lastStatus(node) {
        return node.statuses.length ? node.statuses[node.statuses.length - 1].text : null;
    }

    /** Send a message; resolves with { sent, error }. */
    function infer(node, msg) {
        return new Promise((resolve) => {
            let sent = null;
            node.emit(
                "input",
                msg,
                (m) => {
                    sent = m;
                },
                (err) => resolve({ sent, error: err || null })
            );
        });
    }

    beforeAll((done) => {
        registry = http.createServer((req, res) => {
            registryHits++;
            if (registryMode === "down") {
                res.statusCode = 503;
                res.end("down");
            } else if (registryMode === "drop") {
                // Headers and a partial body, then the connection dies.
                res.writeHead(200, { "Content-Length": 100000 });
                res.write(Buffer.alloc(1000, 1));
                setTimeout(() => res.socket && res.socket.destroy(), 100);
            } else if (registryMode === "pickle") {
                res.writeHead(200);
                res.end(Buffer.from([0x80, 0x04, 0x95, 0x10, 0x00, 0x00]));
            } else {
                res.writeHead(200);
                res.end(fs.readFileSync(BUNDLED_ONNX));
            }
        });
        registry.listen(0, "127.0.0.1", done);
    });

    afterAll((done) => {
        registry.close(done);
    });

    beforeEach(() => {
        userDir = fs.mkdtempSync(path.join(os.tmpdir(), "ncm-mllife-"));
        registryMode = "ok";
        registryHits = 0;
        loadModule();
    });

    afterEach(async () => {
        for (const node of nodes.splice(0)) await closeNode(node);
        // Runtime stop: shuts down any bridge that is no longer used.
        RED.events.emit("flows:stopped", { type: "full" });
        await sleep(50);
        fs.rmSync(userDir, { recursive: true, force: true });
    });

    function registryUrl() {
        return "http://127.0.0.1:" + registry.address().port;
    }

    function customNode(extra) {
        return createNode(
            Object.assign(
                { id: "n1", modelSource: "custom", customRegistryUrl: registryUrl(), customModelId: "m1" },
                extra
            )
        );
    }

    function cacheFiles() {
        const dir = path.join(userDir, "ml-models", "cache", "custom");
        return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    }

    describe("registry sources", () => {
        it("detects the type of a downloaded artifact with modelType=auto", async () => {
            const node = customNode({ modelType: "auto" });
            await waitFor(() => node.modelLoaded || node.errors.length > 0);
            // Used to fail with "Could not detect model type" (cache file had no usable extension).
            expect(cacheFiles()).toContain("m1.onnx");
            if (hasONNX) {
                expect(node.errors).toEqual([]);
                expect(node.modelFormat).toBe("onnx");
                expect(lastStatus(node)).toBe("onnx ready");
            } else {
                expect(node.errors.join(" ")).toMatch(/ONNX Runtime not available/);
            }
        });

        it("hands the downloaded file (not the empty modelPath) to the tfjs loader", async () => {
            const node = customNode({ modelType: "tfjs" });
            await waitFor(() => node.modelLoaded || node.errors.length > 0);
            expect(cacheFiles()).toContain("m1.json");
            expect(node.errors.join(" ")).not.toMatch(/path must be a non-empty string/);
        });

        it("never auto-selects a pickle", async () => {
            registryMode = "pickle";
            const node = customNode({ modelType: "auto" });
            await waitFor(() => node.errors.length > 0);
            expect(node.errors.join(" ")).toMatch(/looks like a Python pickle/);
            expect(cacheFiles()).toEqual([]);
        });

        it("sanitises revision/version strings used in cache file names", async () => {
            const node = createNode({
                id: "n1",
                modelSource: "mlflow",
                mlflowRegistryUri: registryUrl(),
                mlflowModelName: "m",
                mlflowVersion: "../../../escape",
                modelType: "onnx"
            });
            await waitFor(() => node.errors.length > 0);
            // (The fake registry is no MLflow server, so the load fails — what
            // matters is that nothing was created outside the cache directory.)
            expect(fs.existsSync(path.join(userDir, "escape.model"))).toBe(false);
            expect(fs.readdirSync(userDir)).toEqual(["ml-models"]);
        });

        it("fails the load instead of hanging when the connection drops mid-download", async () => {
            registryMode = "drop";
            const node = customNode({ modelType: "onnx" });
            await waitFor(() => node.errors.length > 0, 4000);
            expect(node.modelLoaded).toBe(false);
            expect(node.errors[0]).toMatch(/Failed to download from custom registry/);
            // No partial file left behind
            expect(cacheFiles()).toEqual([]);
        });

        it("keeps a previously cached artifact when a later download fails", async () => {
            const first = customNode({ modelType: "onnx" });
            await waitFor(() => cacheFiles().includes("m1.onnx"));
            await waitFor(() => first.modelLoaded || first.errors.length > 0);
            const before = fs.readFileSync(path.join(userDir, "ml-models", "cache", "custom", "m1.onnx"));

            registryMode = "down";
            const second = customNode({ id: "n2", modelType: "onnx" });
            await waitFor(() => second.errors.length > 0);
            expect(second.errors[0]).toMatch(/503/);
            expect(cacheFiles()).toEqual(expect.arrayContaining(["m1.onnx"]));
            expect(cacheFiles().some((f) => /\.part$/.test(f))).toBe(false);
            const after = fs.readFileSync(path.join(userDir, "ml-models", "cache", "custom", "m1.onnx"));
            expect(after.equals(before)).toBe(true);
        });
    });

    describe("auto-update", () => {
        itIf(hasONNX)("keeps serving the loaded model when an update check fails", async () => {
            const node = customNode({ modelType: "onnx", autoUpdate: true, updateCheckInterval: 1 });
            await waitFor(() => node.modelLoaded);
            const model = node.model;

            registryMode = "down";
            const hitsBefore = registryHits;
            await waitFor(() => registryHits > hitsBefore, 3000);
            await waitFor(() => node.warnings.some((w) => /Model update failed, keeping the loaded model/.test(w)));

            expect(node.modelLoaded).toBe(true);
            expect(node.model).toBe(model);
            expect(node.errors).toEqual([]);
            expect(lastStatus(node)).toBe("onnx ready");
            expect(cacheFiles()).toContain("m1.onnx");
        });

        itIf(hasONNX)("swaps in the re-downloaded model and releases the old session", async () => {
            const node = customNode({ modelType: "onnx", autoUpdate: true, updateCheckInterval: 1 });
            await waitFor(() => node.modelLoaded);
            const first = node.model;
            const released = jest.spyOn(first, "release");

            await waitFor(() => node.model !== first, 4000);
            expect(node.modelLoaded).toBe(true);
            await waitFor(() => released.mock.calls.length === 1);
        });
    });

    describe("load / close races", () => {
        it("does not install a model on a node that was closed while it loaded", async () => {
            let release;
            const gate = new Promise((resolve) => (release = resolve));
            const slow = http.createServer(async (req, res) => {
                await gate;
                res.writeHead(200);
                res.end(fs.readFileSync(BUNDLED_ONNX));
            });
            await new Promise((resolve) => slow.listen(0, "127.0.0.1", resolve));
            try {
                const node = createNode({
                    id: "n1",
                    modelSource: "custom",
                    customRegistryUrl: "http://127.0.0.1:" + slow.address().port,
                    customModelId: "slow",
                    modelType: "onnx"
                });
                await sleep(100);
                await closeNode(node);
                const statusesAtClose = node.statuses.length;
                release();
                await sleep(500);

                expect(node.modelLoaded).toBe(false);
                expect(node.model).toBeNull();
                expect(node.errors).toEqual([]);
                expect(node.statuses.length).toBe(statusesAtClose);
            } finally {
                release();
                await new Promise((resolve) => slow.close(resolve));
            }
        });

        it("runs overlapping loads one after another", async () => {
            let active = 0;
            let maxActive = 0;
            const counting = http.createServer(async (req, res) => {
                active++;
                maxActive = Math.max(maxActive, active);
                await sleep(150);
                active--;
                res.writeHead(200);
                res.end(fs.readFileSync(BUNDLED_ONNX));
            });
            await new Promise((resolve) => counting.listen(0, "127.0.0.1", resolve));
            try {
                const node = createNode({
                    id: "n1",
                    modelSource: "custom",
                    customRegistryUrl: "http://127.0.0.1:" + counting.address().port,
                    customModelId: "c",
                    modelType: "onnx"
                });
                // Two reload commands while the startup load is still downloading.
                const a = infer(node, { loadModel: "ignored-for-registry-sources" });
                const b = infer(node, { loadModel: "ignored-for-registry-sources" });
                await Promise.all([a, b]);
                expect(maxActive).toBe(1);
            } finally {
                await new Promise((resolve) => counting.close(resolve));
            }
        });

        it("rejects a non-string msg.loadModel without touching the configured path", async () => {
            const node = createNode({ id: "n1", modelPath: "" });
            const result = await infer(node, { loadModel: true });
            expect(result.error.message).toMatch(/msg.loadModel must be a model path/);
            expect(node.modelPath).toBe("");
        });
    });

    describe("input handling", () => {
        itIf(hasONNX)("flags non-numeric input values instead of silently presenting zeros", async () => {
            const node = createNode({ id: "n1", modelPath: BUNDLED_ONNX, modelType: "onnx" });
            await waitFor(() => node.modelLoaded || node.errors.length > 0);
            expect(node.errors).toEqual([]);
            const inputName = node.inputNames[0];
            // Replace the session with a recording stub: this test is about the node, not the model.
            const feeds = [];
            node.model = {
                run: async (f) => {
                    feeds.push(Array.from(f[inputName].data));
                    return { out: { data: Float32Array.from([0.25]), dims: [1, 1] } };
                }
            };
            node.outputNames = ["out"];

            const dirty = await infer(node, { payload: [1.5, null, "n/a", "2.5", NaN] });
            expect(dirty.error).toBeNull();
            expect(feeds[0]).toEqual([1.5, 0, 0, 2.5, 0]);
            expect(dirty.sent.mlInference.invalidInputs).toBe(3);
            expect(node.warnings.some((w) => /3 non-numeric input value/.test(w))).toBe(true);

            const clean = await infer(node, { payload: [1, 2, 3] });
            expect(clean.sent.mlInference.invalidInputs).toBe(0);
        });
    });

    describe("Python bridge", () => {
        const bridgeConfig = (id) => ({
            id,
            modelSource: "local",
            modelPath: path.join(userDir, "m.pkl"),
            modelType: "sklearn"
        });
        // What a node reports when the bridge itself answered the load request
        // (no joblib in the test environment, or a garbage pickle) — as opposed
        // to "Python bridge exited" / "not ready", which mean it was gone.
        const answeredByBridge = (node) =>
            node.errors.length > 0 && !/Python bridge (exited|not ready|stopped)/.test(node.errors.join(" "));

        beforeEach(() => {
            fs.writeFileSync(path.join(userDir, "m.pkl"), "not a real pickle");
        });

        itIf(hasPython3)(
            "nodes re-created right after a deploy get a working bridge",
            async () => {
                const first = createNode(bridgeConfig("n1"));
                await waitFor(() => first.errors.length > 0, 20000);
                expect(answeredByBridge(first)).toBe(true);

                // Deploy: nodes close, Node-RED emits flows:stopped, nodes are re-created.
                await closeNode(nodes.pop());
                RED.events.emit("flows:stopped", { type: "full" });
                const second = createNode(bridgeConfig("n2"));
                await waitFor(() => second.errors.length > 0, 20000);
                expect(second.errors.join(" ")).not.toMatch(/Python bridge (exited|not ready|stopped)/);

                // ...and the same holds for every later deploy (the hook used to be one-shot).
                expect(RED.events.listenerCount("flows:stopped")).toBe(1);
                await closeNode(nodes.pop());
                RED.events.emit("flows:stopped", { type: "full" });
                const third = createNode(bridgeConfig("n3"));
                await waitFor(() => third.errors.length > 0, 20000);
                expect(answeredByBridge(third)).toBe(true);
            },
            60000
        );

        itIf(hasPython3)(
            "starts a new sidecar after the old one was killed",
            async () => {
                const { getGlobalBridge } = require("../nodes/python-bridge-manager");
                const first = createNode(bridgeConfig("n1"));
                await waitFor(() => first.errors.length > 0, 20000);
                expect(answeredByBridge(first)).toBe(true);

                const dying = getGlobalBridge();
                dying.process.kill("SIGKILL");
                await waitFor(() => dying.process === null);

                // Used to fail with "Python bridge not ready" until Node-RED was restarted.
                const second = createNode(bridgeConfig("n2"));
                await waitFor(() => second.errors.length > 0, 20000);
                expect(answeredByBridge(second)).toBe(true);
                expect(getGlobalBridge()).not.toBe(dying);
            },
            60000
        );
    });

    describe("MAX Engine bridge", () => {
        let maxServer;
        let maxCalls;
        let maxHealthy;
        const originalUrl = process.env.MAX_ENGINE_URL;

        beforeEach(async () => {
            maxCalls = [];
            maxHealthy = true;
            maxServer = http.createServer((req, res) => {
                let raw = "";
                req.on("data", (c) => (raw += c));
                req.on("end", () => {
                    maxCalls.push(req.method + " " + req.url);
                    if (!maxHealthy) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "starting up" }));
                        return;
                    }
                    const body = raw ? JSON.parse(raw) : {};
                    res.writeHead(200, { "Content-Type": "application/json" });
                    if (req.url === "/health") res.end(JSON.stringify({ status: "healthy" }));
                    else res.end(JSON.stringify({ success: true, model_id: body.model_id, backend: "onnx" }));
                });
            });
            await new Promise((resolve) => maxServer.listen(0, "127.0.0.1", resolve));
            process.env.MAX_ENGINE_URL = "http://127.0.0.1:" + maxServer.address().port;
        });

        afterEach(async () => {
            if (originalUrl === undefined) delete process.env.MAX_ENGINE_URL;
            else process.env.MAX_ENGINE_URL = originalUrl;
            RED.events.emit("flows:stopped", { type: "full" });
            if (maxServer.closeAllConnections) maxServer.closeAllConnections();
            await new Promise((resolve) => maxServer.close(resolve));
        });

        const maxConfig = (id) => ({ id, modelSource: "local", modelPath: BUNDLED_ONNX, modelType: "max" });

        it("unloads the model from the MAX server when the node closes", async () => {
            const node = createNode(maxConfig("n1"));
            await waitFor(() => node.modelLoaded || node.errors.length > 0);
            expect(node.errors).toEqual([]);
            expect(maxCalls).toContain("POST /load");

            await closeNode(nodes.pop());
            // MAX models were never unloaded: they stayed resident in the server.
            expect(maxCalls).toContain("POST /unload");
        });

        it("retries a bridge that was unavailable once the flows are redeployed", async () => {
            maxHealthy = false;
            const first = createNode(maxConfig("n1"));
            await waitFor(() => first.errors.length > 0);
            expect(first.modelLoaded).toBe(false);

            // The server comes up; the error must not stay cached until a restart.
            maxHealthy = true;
            await closeNode(nodes.pop());
            RED.events.emit("flows:stopped", { type: "full" });
            const second = createNode(maxConfig("n2"));
            await waitFor(() => second.modelLoaded || second.errors.length > 0);
            expect(second.errors).toEqual([]);
            expect(second.modelLoaded).toBe(true);
        });
    });

    it("does not stack flows:stopped listeners when the module is loaded repeatedly", () => {
        const events = RED.events;
        for (let i = 0; i < 5; i++) {
            jest.resetModules();
            require("../nodes/ml-inference.js")(Object.assign({}, RED, { events }));
        }
        expect(events.listenerCount("flows:stopped")).toBe(1);
    });
});
