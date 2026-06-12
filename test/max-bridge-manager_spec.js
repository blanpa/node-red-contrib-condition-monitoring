"use strict";

const http = require("http");

const {
    MaxBridgeManager,
    getMaxBridge,
    isMaxBridgeAvailable,
    shutdownMaxBridge
} = require("../nodes/max-bridge-manager");

/** Wait for a single event on an EventEmitter, with a timeout. */
function once(emitter, event, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}" event`)), timeoutMs);
        emitter.once(event, (payload) => {
            clearTimeout(timer);
            resolve(payload);
        });
    });
}

describe("MaxBridgeManager", () => {
    const servers = [];
    const managers = [];

    /** Spin up a local HTTP server simulating the MAX Engine bridge. */
    function startServer(handler) {
        return new Promise((resolve) => {
            const server = http.createServer(handler);
            server.listen(0, "127.0.0.1", () => {
                servers.push(server);
                resolve({ server, port: server.address().port });
            });
        });
    }

    /** Handler that records each hit and replies with a fixed JSON (or raw string) body. */
    function jsonResponder(statusCode, body, hits) {
        return (req, res) => {
            let raw = "";
            req.on("data", (chunk) => {
                raw += chunk;
            });
            req.on("end", () => {
                if (hits) hits.push({ method: req.method, url: req.url, body: raw });
                res.writeHead(statusCode, { "Content-Type": "application/json" });
                res.end(typeof body === "string" ? body : JSON.stringify(body));
            });
        };
    }

    function makeManager(port, options = {}) {
        const manager = new MaxBridgeManager({
            serverUrl: `http://127.0.0.1:${port}`,
            requestTimeout: 2000,
            retryAttempts: 2,
            retryDelay: 10,
            ...options
        });
        managers.push(manager);
        return manager;
    }

    /** Reserve a port that is guaranteed to be closed when used. */
    async function closedPort() {
        const { server, port } = await startServer(() => {});
        await new Promise((resolve) => server.close(resolve));
        return port;
    }

    afterEach(async () => {
        for (const manager of managers.splice(0)) {
            manager.destroy();
        }
        shutdownMaxBridge();
        await Promise.all(
            servers.splice(0).map(
                (server) =>
                    new Promise((resolve) => {
                        if (typeof server.closeAllConnections === "function") {
                            server.closeAllConnections();
                        }
                        server.close(resolve);
                    })
            )
        );
    });

    describe("checkHealth", () => {
        it("marks the bridge connected on a healthy response and emits 'health'", async () => {
            const hits = [];
            const { port } = await startServer(jsonResponder(200, { status: "healthy", backend: "onnx" }, hits));
            const manager = makeManager(port);

            const healthPromise = once(manager, "health");
            const response = await manager.checkHealth();
            const event = await healthPromise;

            expect(response).toEqual({ status: "healthy", backend: "onnx" });
            expect(event).toEqual(response);
            expect(manager.isConnected).toBe(true);
            expect(manager.serverInfo).toEqual(response);
            expect(hits[0]).toMatchObject({ method: "GET", url: "/health" });
        });

        it("resolves but stays disconnected when the status is not 'healthy'", async () => {
            const { port } = await startServer(jsonResponder(200, { status: "degraded" }));
            const manager = makeManager(port);
            const response = await manager.checkHealth();
            expect(response.status).toBe("degraded");
            expect(manager.isConnected).toBe(false);
        });

        it("rejects and emits 'unhealthy' when the connection is refused", async () => {
            const port = await closedPort();
            const manager = makeManager(port);
            const unhealthyPromise = once(manager, "unhealthy");

            await expect(manager.checkHealth()).rejects.toThrow(/ECONNREFUSED/);
            const err = await unhealthyPromise;
            expect(err.code).toBe("ECONNREFUSED");
            expect(manager.isConnected).toBe(false);
            expect(manager.serverInfo).toBeNull();
        });

        it("rejects with 'Request timeout' when the server never responds", async () => {
            const { port } = await startServer(() => {
                /* accept the request, never reply */
            });
            const manager = makeManager(port, { requestTimeout: 150 });
            manager.on("unhealthy", () => {
                /* expected */
            });
            await expect(manager.checkHealth()).rejects.toThrow("Request timeout");
            expect(manager.getStats().failedRequests).toBe(1);
        });

        it("rejects on an invalid (non-JSON) response body", async () => {
            const { port } = await startServer(jsonResponder(200, "<html>definitely not json</html>"));
            const manager = makeManager(port);
            manager.on("unhealthy", () => {
                /* expected */
            });
            await expect(manager.checkHealth()).rejects.toThrow(/Invalid JSON response/);
        });
    });

    describe("retry logic", () => {
        it("retries on HTTP 500 and surfaces the server error message", async () => {
            const hits = [];
            const { port } = await startServer(jsonResponder(500, { error: "boom" }, hits));
            const manager = makeManager(port, { retryAttempts: 3, retryDelay: 5 });

            await expect(manager.getStatus()).rejects.toThrow("boom");
            expect(hits.length).toBe(3);
        });

        it("retries on HTTP 503 and falls back to a generic HTTP error message", async () => {
            const hits = [];
            const { port } = await startServer(jsonResponder(503, {}, hits));
            const manager = makeManager(port, { retryAttempts: 2, retryDelay: 5 });

            await expect(manager.getStatus()).rejects.toThrow("HTTP 503");
            expect(hits.length).toBe(2);
        });

        it("does not retry on a 4xx client error", async () => {
            const hits = [];
            const { port } = await startServer(jsonResponder(404, {}, hits));
            const manager = makeManager(port, { retryAttempts: 3, retryDelay: 5 });

            await expect(manager.getStatus()).rejects.toThrow("HTTP 404");
            expect(hits.length).toBe(1);
        });

        it("succeeds when a retry attempt gets a good response", async () => {
            let calls = 0;
            const { port } = await startServer((req, res) => {
                calls++;
                if (calls === 1) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "transient" }));
                } else {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ models: [] }));
                }
            });
            const manager = makeManager(port, { retryAttempts: 2, retryDelay: 5 });

            await expect(manager.getStatus()).resolves.toEqual({ models: [] });
            expect(calls).toBe(2);
        });
    });

    describe("model operations", () => {
        it("loadModel posts the model details and emits 'modelLoaded'", async () => {
            const hits = [];
            const { port } = await startServer(
                jsonResponder(200, { success: true, model_id: "m1", backend: "max", load_time_ms: 12 }, hits)
            );
            const manager = makeManager(port);

            const loadedPromise = once(manager, "modelLoaded");
            const response = await manager.loadModel("/models/anomaly.onnx", "m1", "max");
            const event = await loadedPromise;

            expect(response.success).toBe(true);
            expect(event).toEqual({ modelId: "m1", backend: "max", loadTime: 12 });
            expect(hits[0].method).toBe("POST");
            expect(hits[0].url).toBe("/load");
            expect(JSON.parse(hits[0].body)).toEqual({
                model_path: "/models/anomaly.onnx",
                model_id: "m1",
                backend: "max"
            });
        });

        it("loadModel rejects when the server reports success:false", async () => {
            const { port } = await startServer(jsonResponder(200, { success: false, error: "unsupported format" }));
            const manager = makeManager(port);
            await expect(manager.loadModel("/models/bad.onnx")).rejects.toThrow("unsupported format");
        });

        it("loadModel validates modelPath without touching the network", async () => {
            const manager = makeManager(1); // port never used
            await expect(manager.loadModel("")).rejects.toThrow("modelPath must be a non-empty string");
            await expect(manager.loadModel(null)).rejects.toThrow("modelPath must be a non-empty string");
        });

        it("predict maps the server response and sends the right payload", async () => {
            const hits = [];
            const { port } = await startServer(
                jsonResponder(200, { success: true, prediction: [0.07], inference_time_ms: 3, backend: "onnx" }, hits)
            );
            const manager = makeManager(port);

            const result = await manager.predict("m1", [0.5, 1.2, 0.8]);

            expect(result).toEqual({ prediction: [0.07], inferenceTime: 3, backend: "onnx" });
            expect(hits[0].url).toBe("/predict");
            expect(JSON.parse(hits[0].body)).toEqual({ model_id: "m1", input_data: [0.5, 1.2, 0.8] });
        });

        it("predict rejects when the server reports success:false", async () => {
            const { port } = await startServer(jsonResponder(200, { success: false, error: "model not loaded" }));
            const manager = makeManager(port);
            await expect(manager.predict("m1", [1, 2, 3])).rejects.toThrow("model not loaded");
        });

        it("predict validates its inputs without touching the network", async () => {
            const manager = makeManager(1);
            await expect(manager.predict("", [1])).rejects.toThrow("modelId must be a non-empty string");
            await expect(manager.predict("m1", "nope")).rejects.toThrow("inputData must be an array");
        });

        it("batchPredict maps the batch response fields", async () => {
            const { port } = await startServer(
                jsonResponder(200, {
                    success: true,
                    predictions: [[0.1], [0.9]],
                    batch_size: 2,
                    inference_time_ms: 8,
                    per_sample_ms: 4,
                    backend: "max"
                })
            );
            const manager = makeManager(port);

            const result = await manager.batchPredict("m1", [[1], [2]]);

            expect(result).toEqual({
                predictions: [[0.1], [0.9]],
                batchSize: 2,
                inferenceTime: 8,
                perSampleTime: 4,
                backend: "max"
            });
        });

        it("batchPredict rejects an empty input batch", async () => {
            const manager = makeManager(1);
            await expect(manager.batchPredict("m1", [])).rejects.toThrow("inputs must be a non-empty array");
        });

        it("unloadModel emits 'modelUnloaded' on success", async () => {
            const hits = [];
            const { port } = await startServer(jsonResponder(200, { success: true }, hits));
            const manager = makeManager(port);

            const unloadedPromise = once(manager, "modelUnloaded");
            await manager.unloadModel("m1");
            const event = await unloadedPromise;

            expect(event).toEqual({ modelId: "m1" });
            expect(hits[0].url).toBe("/unload");
            expect(JSON.parse(hits[0].body)).toEqual({ model_id: "m1" });
        });
    });

    describe("statistics", () => {
        it("tracks successful and failed requests", async () => {
            const { port } = await startServer(jsonResponder(200, { status: "healthy" }));
            const manager = makeManager(port);

            await manager.checkHealth();
            await manager.checkHealth();

            let stats = manager.getStats();
            expect(stats.requestsTotal).toBe(2);
            expect(stats.successfulRequests).toBe(2);
            expect(stats.failedRequests).toBe(0);
            expect(stats.avgResponseTime).toBeGreaterThanOrEqual(0);
            expect(stats.isConnected).toBe(true);

            const refusedManager = makeManager(await closedPort());
            refusedManager.on("unhealthy", () => {
                /* expected */
            });
            await expect(refusedManager.checkHealth()).rejects.toThrow();
            stats = refusedManager.getStats();
            expect(stats.requestsTotal).toBe(1);
            expect(stats.failedRequests).toBe(1);
        });
    });

    describe("periodic health checks", () => {
        it("startHealthCheck polls the server and stopHealthCheck stops it", async () => {
            const hits = [];
            const { port } = await startServer(jsonResponder(200, { status: "healthy" }, hits));
            const manager = makeManager(port, { healthCheckInterval: 50 });

            const firstHealth = once(manager, "health");
            manager.startHealthCheck();
            expect(manager.healthCheckTimer).not.toBeNull();
            await firstHealth;

            // Let at least one interval tick fire on top of the initial check.
            await once(manager, "health");

            manager.stopHealthCheck();
            expect(manager.healthCheckTimer).toBeNull();
            const hitsAfterStop = hits.length;
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(hits.length).toBe(hitsAfterStop);
        });

        it("startHealthCheck is idempotent", async () => {
            const { port } = await startServer(jsonResponder(200, { status: "healthy" }));
            const manager = makeManager(port, { healthCheckInterval: 60000 });
            manager.startHealthCheck();
            const timer = manager.healthCheckTimer;
            manager.startHealthCheck();
            expect(manager.healthCheckTimer).toBe(timer);
            manager.stopHealthCheck();
        });

        it("destroy stops the health check and removes listeners", async () => {
            const { port } = await startServer(jsonResponder(200, { status: "healthy" }));
            const manager = makeManager(port, { healthCheckInterval: 60000 });
            manager.on("health", () => {});
            manager.startHealthCheck();
            manager.destroy();
            expect(manager.healthCheckTimer).toBeNull();
            expect(manager.listenerCount("health")).toBe(0);
        });
    });

    describe("singleton helpers", () => {
        it("getMaxBridge returns the same instance until shutdown", () => {
            const port = 18999;
            const a = getMaxBridge({ serverUrl: `http://127.0.0.1:${port}` });
            expect(getMaxBridge()).toBe(a);
            shutdownMaxBridge();
            const b = getMaxBridge({ serverUrl: `http://127.0.0.1:${port}` });
            expect(b).not.toBe(a);
            shutdownMaxBridge();
        });

        it("isMaxBridgeAvailable reflects server reachability", async () => {
            const { port } = await startServer(jsonResponder(200, { status: "healthy" }));
            shutdownMaxBridge();
            getMaxBridge({ serverUrl: `http://127.0.0.1:${port}`, requestTimeout: 1000 });
            await expect(isMaxBridgeAvailable()).resolves.toBe(true);

            shutdownMaxBridge();
            getMaxBridge({ serverUrl: `http://127.0.0.1:${await closedPort()}`, requestTimeout: 1000 });
            await expect(isMaxBridgeAvailable()).resolves.toBe(false);
        });
    });
});
