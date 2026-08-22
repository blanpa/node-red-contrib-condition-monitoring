"use strict";

const http = require("http");

const { RemotePythonBridge, hashKey } = require("../nodes/remote-python-bridge");

/**
 * These tests exercise the remote bridge against a tiny in-process HTTP server
 * that speaks the same wire protocol as nodes/python/inference_server.py. No
 * Python or ML stack is involved, so they run in the hermetic `unit` project.
 */
function startFakeServer(handlers) {
    return new Promise((resolve) => {
        const calls = [];
        const server = http.createServer((req, res) => {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const parsed = body ? JSON.parse(body) : {};
                calls.push({ method: req.method, path: req.url, body: parsed });
                const key = `${req.method} ${req.url}`;
                const handler = handlers[key];
                if (!handler) {
                    res.writeHead(404, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ success: false, error: "not found" }));
                    return;
                }
                const { status = 200, payload } = handler(parsed, calls.length);
                res.writeHead(status, { "Content-Type": "application/json" });
                res.end(JSON.stringify(payload));
            });
        });
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            resolve({ server, port, calls, url: `http://127.0.0.1:${port}` });
        });
    });
}

function close(server) {
    return new Promise((resolve) => server.close(resolve));
}

describe("RemotePythonBridge", () => {
    describe("input validation", () => {
        it("rejects loadModel / predict / unloadModel with bad arguments", async () => {
            const bridge = new RemotePythonBridge({ serverUrl: "http://127.0.0.1:1" });
            await expect(bridge.loadModel("")).rejects.toThrow("modelPath must be a non-empty string");
            await expect(bridge.predict("", [1])).rejects.toThrow("modelId must be a non-empty string");
            await expect(bridge.predict("m", "nope")).rejects.toThrow("inputData must be an array");
            await expect(bridge.unloadModel(42)).rejects.toThrow("modelId must be a non-empty string");
        });
    });

    describe("against a fake inference server", () => {
        let fake;

        afterEach(async () => {
            if (fake) await close(fake.server);
            fake = null;
        });

        it("start() resolves on a healthy /health response", async () => {
            fake = await startFakeServer({
                "GET /health": () => ({ payload: { status: "healthy", models_loaded: 0 } })
            });
            const bridge = new RemotePythonBridge({ serverUrl: fake.url });
            const info = await bridge.start();
            expect(info.status).toBe("healthy");
            expect(bridge.isReady).toBe(true);
        });

        it("start() rejects when the server is unreachable", async () => {
            const bridge = new RemotePythonBridge({ serverUrl: "http://127.0.0.1:1", startupTimeout: 300 });
            await expect(bridge.start()).rejects.toThrow(/Remote inference server unavailable/);
            expect(bridge.isReady).toBe(false);
        });

        it("loadModel posts model_path/model_id and resolves on success", async () => {
            fake = await startFakeServer({
                "POST /load": (body) => ({
                    payload: { success: true, model_id: body.model_id, model_type: "sklearn" }
                })
            });
            const bridge = new RemotePythonBridge({ serverUrl: fake.url });
            const res = await bridge.loadModel("/data/models/m.pkl", "m1");
            expect(res.model_type).toBe("sklearn");
            expect(fake.calls[0].body).toEqual({ model_path: "/data/models/m.pkl", model_id: "m1" });
        });

        it("predict returns the raw prediction array (local-bridge contract)", async () => {
            fake = await startFakeServer({
                "POST /predict": () => ({ payload: { success: true, prediction: [[0.1, 0.9]] } })
            });
            const bridge = new RemotePythonBridge({ serverUrl: fake.url });
            const prediction = await bridge.predict("m1", [1, 2, 3]);
            expect(prediction).toEqual([[0.1, 0.9]]);
        });

        it("attaches model_path to predict after a load (on-demand self-heal)", async () => {
            fake = await startFakeServer({
                "POST /load": (body) => ({ payload: { success: true, model_id: body.model_id } }),
                "POST /predict": () => ({ payload: { success: true, prediction: [1] } })
            });
            const bridge = new RemotePythonBridge({ serverUrl: fake.url });
            await bridge.loadModel("/data/models/m.pkl", "m1");
            await bridge.predict("m1", [1, 2]);
            const predictCall = fake.calls.find((c) => c.path === "/predict");
            expect(predictCall.body.model_path).toBe("/data/models/m.pkl");
        });

        it("omits model_path when the model was never loaded via this bridge", async () => {
            fake = await startFakeServer({
                "POST /predict": () => ({ payload: { success: true, prediction: [1] } })
            });
            const bridge = new RemotePythonBridge({ serverUrl: fake.url });
            await bridge.predict("unknown", [1, 2]);
            const predictCall = fake.calls.find((c) => c.path === "/predict");
            expect(predictCall.body).not.toHaveProperty("model_path");
        });

        it("surfaces a success:false body as a rejection", async () => {
            fake = await startFakeServer({
                "POST /predict": () => ({ payload: { success: false, error: "Model m1 not loaded" } })
            });
            const bridge = new RemotePythonBridge({ serverUrl: fake.url });
            await expect(bridge.predict("m1", [1])).rejects.toThrow("Model m1 not loaded");
        });

        it("does not retry on 4xx but does retry transport errors", async () => {
            // 404 is a client error -> exactly one attempt, no retry.
            fake = await startFakeServer({
                "POST /unload": () => ({ status: 404, payload: { success: false, error: "not loaded" } })
            });
            const bridge = new RemotePythonBridge({ serverUrl: fake.url, retryAttempts: 3, retryDelay: 1 });
            await expect(bridge.unloadModel("ghost")).rejects.toThrow("not loaded");
            expect(fake.calls.length).toBe(1);
        });

        it("retries a 5xx and succeeds on a later attempt", async () => {
            fake = await startFakeServer({
                "POST /load": (_body, callNo) =>
                    callNo < 2
                        ? { status: 500, payload: { success: false, error: "transient" } }
                        : { payload: { success: true, model_id: "m1", model_type: "keras" } }
            });
            const bridge = new RemotePythonBridge({ serverUrl: fake.url, retryAttempts: 3, retryDelay: 1 });
            const res = await bridge.loadModel("/data/models/m.keras", "m1");
            expect(res.model_type).toBe("keras");
            expect(fake.calls.length).toBe(2);
        });

        it("getStatus passes through the server payload", async () => {
            fake = await startFakeServer({
                "GET /status": () => ({ payload: { status: "running", loaded_models: ["m1"] } })
            });
            const bridge = new RemotePythonBridge({ serverUrl: fake.url });
            const status = await bridge.getStatus();
            expect(status.loaded_models).toEqual(["m1"]);
        });
    });

    describe("multi-replica sharding", () => {
        let a;
        let b;

        afterEach(async () => {
            if (a) await close(a.server);
            if (b) await close(b.server);
            a = null;
            b = null;
        });

        function genericHandlers() {
            return {
                "GET /health": () => ({ payload: { status: "healthy", models_loaded: 0 } }),
                "POST /load": (body) => ({
                    payload: { success: true, model_id: body.model_id, model_type: "sklearn" }
                }),
                "POST /predict": () => ({ payload: { success: true, prediction: [1] } }),
                "POST /unload": () => ({ payload: { success: true } })
            };
        }

        const modelOps = (calls) => calls.filter((c) => c.path !== "/health").length;

        it("start() requires every configured replica to be healthy", async () => {
            a = await startFakeServer(genericHandlers());
            // Second replica is a dead port -> start() must fail fast.
            const bridge = new RemotePythonBridge({
                serverUrl: `${a.url},http://127.0.0.1:1`,
                startupTimeout: 300
            });
            await expect(bridge.start()).rejects.toThrow(/Remote inference server unavailable/);
            expect(bridge.isReady).toBe(false);
        });

        it("co-locates load, predict and unload for a model on one replica", async () => {
            a = await startFakeServer(genericHandlers());
            b = await startFakeServer(genericHandlers());
            const bridge = new RemotePythonBridge({ serverUrls: [a.url, b.url] });
            await bridge.start();

            const id = "model-xyz";
            await bridge.loadModel("/data/models/x.pkl", id);
            await bridge.predict(id, [1, 2]);
            await bridge.unloadModel(id);

            // All three model ops hit exactly one replica; the other sees none.
            expect([modelOps(a.calls), modelOps(b.calls)].sort((x, y) => x - y)).toEqual([0, 3]);
        });

        it("distributes distinct models across replicas", async () => {
            a = await startFakeServer(genericHandlers());
            b = await startFakeServer(genericHandlers());
            const bridge = new RemotePythonBridge({ serverUrls: [a.url, b.url] });
            await bridge.start();

            for (let i = 0; i < 24; i++) {
                await bridge.loadModel(`/m/${i}.pkl`, `model-${i}`);
            }
            const aLoads = a.calls.filter((c) => c.path === "/load").length;
            const bLoads = b.calls.filter((c) => c.path === "/load").length;
            expect(aLoads + bLoads).toBe(24);
            expect(aLoads).toBeGreaterThan(0);
            expect(bLoads).toBeGreaterThan(0);
        });

        it("getStatus aggregates loaded models across all replicas", async () => {
            a = await startFakeServer({
                ...genericHandlers(),
                "GET /status": () => ({ payload: { status: "running", loaded_models: ["m1"] } })
            });
            b = await startFakeServer({
                ...genericHandlers(),
                "GET /status": () => ({ payload: { status: "running", loaded_models: ["m2", "m3"] } })
            });
            const bridge = new RemotePythonBridge({ serverUrls: [a.url, b.url] });
            const status = await bridge.getStatus();
            expect(status.replicaCount).toBe(2);
            expect(status.totalModels).toBe(3);
        });

        it("routes a given model_id to a stable replica (consistent hashing)", () => {
            const bridge = new RemotePythonBridge({
                serverUrls: ["http://h1:8770", "http://h2:8770", "http://h3:8770"]
            });
            expect(bridge._endpointFor("alpha")).toBe(bridge._endpointFor("alpha"));
            expect(hashKey("alpha")).toBe(hashKey("alpha"));
            expect(hashKey("alpha")).not.toBe(hashKey("beta"));
        });
    });

    describe("getGlobalBridge transport selection", () => {
        const ORIGINAL = process.env.CM_INFERENCE_URL;

        afterEach(async () => {
            // Reset the module's singleton between cases so the env var is re-read.
            const mgr = require("../nodes/python-bridge-manager");
            await mgr.shutdownGlobalBridge();
            if (ORIGINAL === undefined) {
                delete process.env.CM_INFERENCE_URL;
            } else {
                process.env.CM_INFERENCE_URL = ORIGINAL;
            }
            jest.resetModules();
        });

        it("returns a RemotePythonBridge when CM_INFERENCE_URL is set", () => {
            process.env.CM_INFERENCE_URL = "http://inference:8770";
            jest.resetModules();
            const mgr = require("../nodes/python-bridge-manager");
            const { RemotePythonBridge: RPB } = require("../nodes/remote-python-bridge");
            const bridge = mgr.getGlobalBridge();
            expect(bridge).toBeInstanceOf(RPB);
        });

        it("returns the subprocess bridge when CM_INFERENCE_URL is unset", () => {
            delete process.env.CM_INFERENCE_URL;
            jest.resetModules();
            const mgr = require("../nodes/python-bridge-manager");
            const bridge = mgr.getGlobalBridge();
            expect(bridge.constructor.name).toBe("PythonBridgeManager");
        });
    });
});
