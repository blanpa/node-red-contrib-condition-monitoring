/**
 * Remote Python Bridge
 * ====================
 *
 * Drop-in replacement for PythonBridgeManager that talks to one or more separate
 * inference *containers* over HTTP instead of spawning a local Python
 * subprocess. The container(s) run `nodes/python/inference_server.py`, which
 * expose the same model operations (load / predict / unload) that the
 * stdin/stdout bridge does — so ml-inference's keras/sklearn/tflite paths work
 * unchanged.
 *
 * Why a separate container?
 * - Keeps the heavy ML runtime (TensorFlow, scikit-learn, native libs) out of
 *   the Node-RED image and off the Node-RED event loop.
 * - A crashing/OOM-ing model can't take Node-RED down with it.
 * - The inference service can be scaled / GPU-pinned independently.
 *
 * Horizontal scaling (load distribution):
 * - `CM_INFERENCE_URL` may list several replica URLs, comma-separated.
 * - Requests are sharded by a consistent hash of `model_id`, so `load` and the
 *   subsequent `predict`/`unload` for a model always hit the SAME replica. That
 *   preserves the server's stateful in-memory model cache without an external
 *   load balancer, and spreads distinct models across replicas.
 * - The shard mapping is modulo the replica count: changing the replica list
 *   reshuffles models, so treat the list as fixed for a deployment (restart
 *   Node-RED to re-shard). For elastic autoscaling, front a single URL with a
 *   model-server stack (Triton/KServe) instead — see docs/REMOTE-INFERENCE.md.
 *
 * This is the network-transport sibling of max-bridge-manager.js (which targets
 * the MAX Engine / ONNX server). It is selected automatically by
 * python-bridge-manager.js when `CM_INFERENCE_URL` is set.
 *
 * The public surface intentionally mirrors PythonBridgeManager: start(),
 * loadModel(), predict(), unloadModel(), getStatus(), ping(), stop(),
 * getStats(), plus EventEmitter events.
 */

const http = require("http");
const https = require("https");
const EventEmitter = require("events");

/**
 * Deterministic string hash (djb2). Used to map a model_id to a replica index;
 * stable across the process so a model always shards to the same endpoint.
 */
function hashKey(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    }
    return h;
}

class RemotePythonBridge extends EventEmitter {
    constructor(options = {}) {
        super();

        // Accept a comma-separated list (env) or an explicit array.
        const raw = options.serverUrls || options.serverUrl || process.env.CM_INFERENCE_URL || "http://localhost:8770";
        const urls = (Array.isArray(raw) ? raw : String(raw).split(",")).map((u) => u.trim()).filter(Boolean);

        this.requestTimeout = options.requestTimeout || 60000;
        this.startupTimeout = options.startupTimeout || 30000;
        this.retryAttempts = options.retryAttempts || 3;
        this.retryDelay = options.retryDelay || 1000;

        this.endpoints = urls.map((u) => {
            const url = new URL(u);
            return {
                url: u,
                protocol: url.protocol === "https:" ? https : http,
                hostname: url.hostname,
                port: url.port || (url.protocol === "https:" ? 443 : 80)
            };
        });
        if (this.endpoints.length === 0) {
            throw new Error("RemotePythonBridge requires at least one server URL");
        }

        this.isReady = false;
        this.serverInfo = null;

        // Remember each model's path so predict() can carry it: a replica that
        // never saw the explicit load (replicas:N round-robin) or that lost its
        // cache after a restart can then load on demand. See the server's
        // do_predict auto-load path.
        this.modelPaths = new Map();

        this.stats = {
            requestsProcessed: 0,
            errors: 0,
            avgResponseTime: 0,
            lastResponseTime: null
        };
    }

    /** Pick the replica that owns a given model_id (consistent hashing). */
    _endpointFor(modelId) {
        if (this.endpoints.length === 1) return this.endpoints[0];
        return this.endpoints[hashKey(String(modelId)) % this.endpoints.length];
    }

    /**
     * Issue a single HTTP request to a specific endpoint. Resolves with the
     * parsed JSON body; rejects with an Error carrying `.statusCode` on HTTP
     * errors so the retry layer can tell client (4xx) from server/transport
     * failures.
     */
    _request(method, path, data, endpoint, timeoutMs = this.requestTimeout) {
        const ep = endpoint || this.endpoints[0];
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            // Serialize up front and send an explicit Content-Length. Without it
            // Node uses chunked transfer-encoding, which the stdlib http.server in
            // inference_server.py does not decode (it reads Content-Length only).
            const payload = data ? Buffer.from(JSON.stringify(data)) : null;
            const headers = { Accept: "application/json" };
            if (payload) {
                headers["Content-Type"] = "application/json";
                headers["Content-Length"] = payload.length;
            }
            const options = {
                hostname: ep.hostname,
                port: ep.port,
                path,
                method,
                headers,
                timeout: timeoutMs
            };

            const req = ep.protocol.request(options, (res) => {
                let body = "";
                res.on("data", (chunk) => (body += chunk));
                res.on("end", () => {
                    this._updateStats(Date.now() - startTime, res.statusCode < 400);
                    let parsed;
                    try {
                        parsed = body ? JSON.parse(body) : {};
                    } catch (e) {
                        reject(new Error(`Invalid JSON response: ${body.substring(0, 100)}`));
                        return;
                    }
                    if (res.statusCode >= 400) {
                        const err = new Error(parsed.error || `HTTP ${res.statusCode}`);
                        err.statusCode = res.statusCode;
                        reject(err);
                    } else {
                        resolve(parsed);
                    }
                });
            });

            req.on("error", (err) => {
                this._updateStats(Date.now() - startTime, false);
                reject(err);
            });
            req.on("timeout", () => {
                req.destroy();
                this._updateStats(Date.now() - startTime, false);
                reject(new Error(`Request timeout: ${method} ${path}`));
            });

            if (payload) req.write(payload);
            req.end();
        });
    }

    _updateStats(responseTime, success) {
        this.stats.lastResponseTime = responseTime;
        if (success) {
            this.stats.requestsProcessed++;
            this.stats.avgResponseTime =
                (this.stats.avgResponseTime * (this.stats.requestsProcessed - 1) + responseTime) /
                this.stats.requestsProcessed;
        } else {
            this.stats.errors++;
        }
    }

    /** Retry transport/5xx failures; never retry 4xx (a bad request stays bad). */
    async _requestWithRetry(method, path, data, endpoint) {
        let lastError;
        for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
            try {
                return await this._request(method, path, data, endpoint);
            } catch (err) {
                lastError = err;
                const status = err.statusCode;
                if (typeof status === "number" && status >= 400 && status < 500) {
                    throw err;
                }
                if (attempt < this.retryAttempts - 1) {
                    await new Promise((resolve) => setTimeout(resolve, this.retryDelay * (attempt + 1)));
                }
            }
        }
        throw lastError;
    }

    /**
     * Establish connectivity. Mirrors PythonBridgeManager.start(): resolves once
     * every configured replica reports healthy, rejects otherwise. All replicas
     * must be up at start because models are sharded across them.
     */
    async start() {
        const results = await Promise.allSettled(
            this.endpoints.map((ep) => this._request("GET", "/health", null, ep, this.startupTimeout))
        );

        const failures = [];
        results.forEach((r, i) => {
            const ep = this.endpoints[i];
            if (r.status === "fulfilled" && r.value && r.value.status === "healthy") {
                if (i === 0) this.serverInfo = r.value;
            } else {
                const reason = r.status === "rejected" ? r.reason.message : `unhealthy: ${JSON.stringify(r.value)}`;
                failures.push(`${ep.url} (${reason})`);
            }
        });

        if (failures.length > 0) {
            this.isReady = false;
            if (this.listenerCount("error") > 0) this.emit("error", new Error(failures.join("; ")));
            throw new Error(`Remote inference server unavailable: ${failures.join("; ")}`);
        }

        this.isReady = true;
        this.emit("ready", this.serverInfo);
        return this.serverInfo;
    }

    async loadModel(modelPath, modelId = null) {
        if (!modelPath || typeof modelPath !== "string") {
            throw new Error("modelPath must be a non-empty string");
        }
        // model_id drives sharding; fall back to the path so a null id still
        // routes deterministically (and the server derives the same default).
        const shardKey = modelId || modelPath;
        const res = await this._requestWithRetry(
            "POST",
            "/load",
            { model_path: modelPath, model_id: modelId },
            this._endpointFor(shardKey)
        );
        if (!res.success) throw new Error(res.error || "Failed to load model");
        // Track the path under the id the caller will predict with, so predict()
        // can pass it along for on-demand loading on any replica.
        if (modelId) this.modelPaths.set(modelId, modelPath);
        this.emit("modelLoaded", { modelId: res.model_id, modelType: res.model_type });
        return res;
    }

    async predict(modelId, inputData) {
        if (!modelId || typeof modelId !== "string") {
            throw new Error("modelId must be a non-empty string");
        }
        if (!Array.isArray(inputData)) {
            throw new Error("inputData must be an array");
        }
        const body = { model_id: modelId, input_data: inputData };
        // Attach the known path so a replica without this model resident can
        // load it on demand (replicas:N round-robin / post-restart self-heal).
        const knownPath = this.modelPaths.get(modelId);
        if (knownPath) body.model_path = knownPath;
        const res = await this._requestWithRetry("POST", "/predict", body, this._endpointFor(modelId));
        if (!res.success) throw new Error(res.error || "Prediction failed");
        // Return the raw prediction so callers match the local bridge contract
        // (PythonBridgeManager.predict resolves the prediction value directly).
        return res.prediction;
    }

    async unloadModel(modelId) {
        if (!modelId || typeof modelId !== "string") {
            throw new Error("modelId must be a non-empty string");
        }
        const res = await this._requestWithRetry("POST", "/unload", { model_id: modelId }, this._endpointFor(modelId));
        if (!res.success) throw new Error(res.error || "Failed to unload model");
        this.modelPaths.delete(modelId);
        this.emit("modelUnloaded", { modelId });
        return res;
    }

    /**
     * Aggregate status. With one replica this is the server payload; with many
     * it returns a per-replica array plus the total models loaded.
     */
    async getStatus() {
        if (this.endpoints.length === 1) {
            return this._requestWithRetry("GET", "/status", null, this.endpoints[0]);
        }
        const replicas = await Promise.all(
            this.endpoints.map((ep) =>
                this._requestWithRetry("GET", "/status", null, ep)
                    .then((s) => ({ url: ep.url, ...s }))
                    .catch((e) => ({ url: ep.url, error: e.message }))
            )
        );
        const totalModels = replicas.reduce(
            (n, r) => n + (Array.isArray(r.loaded_models) ? r.loaded_models.length : 0),
            0
        );
        return { replicas, replicaCount: this.endpoints.length, totalModels };
    }

    async ping() {
        const info = await this._request("GET", "/health", null, this.endpoints[0]);
        return { message: "pong", server: info };
    }

    /**
     * Tear down. There is no local process to kill — we just drop the ready
     * flag and detach listeners so the node can be reconstructed cleanly.
     */
    async stop() {
        this.isReady = false;
        this.removeAllListeners();
    }

    getStats() {
        return {
            ...this.stats,
            isReady: this.isReady,
            endpoints: this.endpoints.map((e) => e.url),
            serverInfo: this.serverInfo
        };
    }
}

module.exports = { RemotePythonBridge, hashKey };
