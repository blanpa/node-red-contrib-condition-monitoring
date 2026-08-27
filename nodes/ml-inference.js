module.exports = function (RED) {
    "use strict";

    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const https = require("https");
    const http = require("http");
    const crypto = require("crypto");

    // Import persistent Python bridge
    const { getGlobalBridge, shutdownGlobalBridge } = require("./python-bridge-manager");

    // Import MAX Engine bridge
    const { getMaxBridge, shutdownMaxBridge } = require("./max-bridge-manager");
    const registerAdminRoutes = require("./ml-inference-admin");

    // Path validator for sandboxed model loading
    const { assertPath } = require("./utils/path-validator");
    const { clampInt } = require("./utils/config-validator");

    // Model storage directory
    const MODELS_DIR = path.join(RED.settings.userDir || os.homedir(), "ml-models");

    // Allowlisted base directories for `loadXxxModel(modelPath)` calls.
    //
    // Defaults to the model dir, the Node-RED user dir and CWD. Operators can
    // extend the list via `settings.js`:
    //
    //     conditionMonitoring: { allowedModelPaths: [ '/srv/models', '/data/models' ] }
    //
    // Anything outside this allowlist (including `..` traversal and symlinks
    // pointing outside) is refused with EPATHFORBIDDEN.
    function getModelPathAllowlist() {
        const cmCfg = (RED.settings && RED.settings.conditionMonitoring) || {};
        const extra = Array.isArray(cmCfg.allowedModelPaths) ? cmCfg.allowedModelPaths : [];
        const bases = [MODELS_DIR];
        if (RED.settings && RED.settings.userDir) bases.push(RED.settings.userDir);
        bases.push(process.cwd());
        // models bundled with this package (catalog "bundled" entries)
        bases.push(path.join(__dirname, "models"));
        for (const e of extra) {
            if (typeof e === "string" && e.length > 0) bases.push(e);
        }
        return bases;
    }

    /**
     * Resolve a user-supplied local model path against the allowlist.
     *
     * Use only for *local* paths — URLs are filtered out by callers before
     * they reach this helper.
     *
     * @param {string} modelPath
     * @returns {string} resolved absolute path
     * @throws {Error} EPATHFORBIDDEN when the path escapes the allowlist
     */
    function resolveLocalModelPath(modelPath) {
        return assertPath(modelPath, {
            allowedBases: getModelPathAllowlist(),
            base: process.cwd(),
            followSymlinks: true
        });
    }

    // Global Python bridge instance (shared across all ml-inference nodes)
    let pythonBridge = null;
    let pythonBridgeReady = false;
    let pythonBridgeError = null;
    let pythonBridgeStartPromise = null; // Track pending startup

    // Global MAX Engine bridge instance
    let maxBridge = null;
    let maxBridgeReady = false;
    let maxBridgeError = null;

    // Initialize Python bridge on first node creation
    async function ensurePythonBridge() {
        // Already ready - return immediately
        if (pythonBridge && pythonBridgeReady) {
            return pythonBridge;
        }

        // Previous startup failed - throw cached error
        if (pythonBridgeError) {
            throw pythonBridgeError;
        }

        // Startup in progress - wait for it
        if (pythonBridgeStartPromise) {
            await pythonBridgeStartPromise;
            if (pythonBridgeReady) return pythonBridge;
            if (pythonBridgeError) throw pythonBridgeError;
        }

        // Start the bridge
        if (!pythonBridge) {
            pythonBridge = getGlobalBridge();

            pythonBridge.on("stderr", (msg) => {
                // Log Python stderr for debugging
                if (msg && !msg.includes("FutureWarning") && !msg.includes("DeprecationWarning")) {
                    RED.log.debug("[PythonBridge] " + msg);
                }
            });

            pythonBridge.on("exit", (info) => {
                RED.log.warn("[PythonBridge] Exited: " + JSON.stringify(info));
                pythonBridgeReady = false;
                pythonBridgeStartPromise = null;
                // Will auto-restart on next request
            });

            // Create a promise that all callers can await
            pythonBridgeStartPromise = pythonBridge
                .start()
                .then(() => {
                    pythonBridgeReady = true;
                    RED.log.info("[PythonBridge] Started successfully");
                })
                .catch((err) => {
                    pythonBridgeError = err;
                    pythonBridge = null;
                    throw err;
                });

            await pythonBridgeStartPromise;
        }

        return pythonBridge;
    }

    // Initialize MAX Engine bridge
    async function ensureMaxBridge() {
        if (maxBridge && maxBridgeReady) {
            return maxBridge;
        }

        if (maxBridgeError) {
            throw maxBridgeError;
        }

        if (!maxBridge) {
            maxBridge = getMaxBridge({
                serverUrl: process.env.MAX_ENGINE_URL || "http://localhost:8765"
            });

            maxBridge.on("health", (info) => {
                RED.log.debug("[MaxBridge] Health: " + JSON.stringify(info));
            });

            maxBridge.on("unhealthy", (err) => {
                RED.log.warn("[MaxBridge] Unhealthy: " + err.message);
                maxBridgeReady = false;
            });

            maxBridge.on("modelLoaded", (info) => {
                RED.log.info("[MaxBridge] Model loaded: " + info.modelId + " (" + info.backend + ")");
            });

            try {
                await maxBridge.checkHealth();
                maxBridgeReady = true;
                maxBridge.startHealthCheck();
                RED.log.info("[MaxBridge] Connected to MAX Engine server");
            } catch (err) {
                maxBridgeError = err;
                maxBridge = null;
                RED.log.warn("[MaxBridge] Not available: " + err.message);
                throw err;
            }
        }

        return maxBridge;
    }

    // Shutdown bridge on Node-RED close
    // Use once() to prevent multiple registrations across test runs
    // Store handler reference for proper cleanup
    if (!RED._pythonBridgeShutdownHandler) {
        RED._pythonBridgeShutdownHandler = async function () {
            if (pythonBridge) {
                try {
                    await shutdownGlobalBridge();
                    RED.log.info("[PythonBridge] Shutdown complete");
                } catch (err) {
                    RED.log.warn("[PythonBridge] Shutdown error: " + err.message);
                }
                pythonBridge = null;
                pythonBridgeReady = false;
            }
            // Shutdown MAX bridge
            if (maxBridge) {
                try {
                    shutdownMaxBridge();
                    RED.log.info("[MaxBridge] Shutdown complete");
                } catch (err) {
                    RED.log.warn("[MaxBridge] Shutdown error: " + err.message);
                }
                maxBridge = null;
                maxBridgeReady = false;
            }
            // Reset handler reference after execution
            RED._pythonBridgeShutdownHandler = null;
        };
        RED.events.once("flows:stopped", RED._pythonBridgeShutdownHandler);
    }

    // Model Metadata Management
    function getModelMetadataPath(modelPath) {
        const dir = path.dirname(modelPath);
        const basename = path.basename(modelPath, path.extname(modelPath));
        return path.join(dir, basename + "_metadata.json");
    }

    function loadModelMetadata(modelPath) {
        try {
            const metadataPath = getModelMetadataPath(modelPath);
            if (fs.existsSync(metadataPath)) {
                const metadataContent = fs.readFileSync(metadataPath, "utf8");
                return JSON.parse(metadataContent);
            }
        } catch (err) {
            // Ignore errors, return null if metadata doesn't exist
        }
        return null;
    }

    function saveModelMetadata(modelPath, metadata) {
        try {
            const metadataPath = getModelMetadataPath(modelPath);
            const metadataContent = JSON.stringify(metadata, null, 2);
            fs.writeFileSync(metadataPath, metadataContent, "utf8");
            return true;
        } catch (err) {
            return false;
        }
    }

    // ----- Registry downloaders ---------------------------------------------------
    //
    // All four registry helpers accept an optional `expectedSha256` (lower-case
    // hex). When set, the downloaded artifact is verified against the digest
    // before any caller touches it; mismatches surface as ESHAMISMATCH errors.

    // Hugging Face Hub API
    async function downloadFromHuggingFace(modelId, revision, token, targetPath, expectedSha256) {
        const hfFilesUrl = `https://huggingface.co/${modelId}/resolve/${revision}/`;

        try {
            // Try to find model.json (TensorFlow.js) or .onnx file
            const possibleFiles = ["model.json", "model.onnx", "pytorch_model.bin"];

            for (const file of possibleFiles) {
                try {
                    const fileUrl = hfFilesUrl + file;
                    await downloadFile(fileUrl, token ? "bearer" : "none", token || "", targetPath, expectedSha256);
                    return targetPath;
                } catch (e) {
                    // ESHAMISMATCH means we *did* download a candidate but it's the wrong file:
                    // surface it instead of silently trying the next one (otherwise the user
                    // would see a generic "no model file found" message).
                    if (e && e.code === "ESHAMISMATCH") throw e;
                    // Try next file
                    continue;
                }
            }

            throw new Error(`Could not find model file for ${modelId}. Supported: model.json, model.onnx`);
        } catch (err) {
            throw new Error(`Failed to download from Hugging Face: ${err.message}`);
        }
    }

    // MLflow Registry API
    // Minimal MLflow REST request helper: picks http/https from the URL scheme
    // (registry URIs are commonly plain http, e.g. http://mlflow-server:5000)
    // and supports both GET (with query params) and POST (with a JSON body).
    // MLflow's registry API returns small JSON control-plane payloads; these
    // bounds keep a hostile or wedged endpoint from stalling/exhausting the runtime.
    const MAX_MLFLOW_RESPONSE_BYTES = 8 * 1024 * 1024;
    const MLFLOW_TIMEOUT_MS = 15000;

    function mlflowApiRequest(url, method, token, body) {
        return new Promise((resolve, reject) => {
            const isHttps = url.startsWith("https");
            const protocol = isHttps ? https : http;
            const urlObj = new URL(url);
            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port || (isHttps ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: method,
                headers: { "Content-Type": "application/json" }
            };
            if (token) options.headers["Authorization"] = "Bearer " + token;

            const req = protocol.request(options, (res) => {
                let data = "";
                let overflow = false;
                res.on("data", (chunk) => {
                    if (overflow) return;
                    data += chunk;
                    // JSON control-plane responses are small; refuse to buffer a
                    // hostile or misconfigured endpoint's unbounded stream.
                    if (data.length > MAX_MLFLOW_RESPONSE_BYTES) {
                        overflow = true;
                        res.destroy();
                        reject(new Error("MLflow response exceeds " + MAX_MLFLOW_RESPONSE_BYTES + " bytes"));
                    }
                });
                res.on("end", () => {
                    if (overflow) return;
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(data ? JSON.parse(data) : {});
                        } catch (e) {
                            reject(new Error("Invalid JSON response from MLflow"));
                        }
                    } else {
                        reject(new Error(`MLflow API error: ${res.statusCode} ${res.statusMessage}`));
                    }
                });
            });
            req.on("error", reject);
            req.setTimeout(MLFLOW_TIMEOUT_MS, () => {
                req.destroy(new Error("MLflow request timed out after " + MLFLOW_TIMEOUT_MS + "ms"));
            });
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }

    async function downloadFromMLflow(registryUri, modelName, version, stage, token, targetPath, expectedSha256) {
        try {
            const baseUrl = registryUri.replace(/\/$/, "");

            // Resolve the model version's artifact source.
            let modelInfo;
            if (version && version !== "latest") {
                // Specific version: GET model-versions/get
                const apiUrl = `${baseUrl}/api/2.0/mlflow/model-versions/get?name=${encodeURIComponent(
                    modelName
                )}&version=${encodeURIComponent(version)}`;
                modelInfo = await mlflowApiRequest(apiUrl, "GET", token);
            } else {
                // "latest" (optionally filtered by stage): POST get-latest-versions
                // (there is no `latest-versions/get` endpoint; the registry API is
                // registered-models/get-latest-versions and it is a POST).
                const apiUrl = `${baseUrl}/api/2.0/mlflow/registered-models/get-latest-versions`;
                const reqBody = { name: modelName };
                if (stage) reqBody.stages = [stage];
                modelInfo = await mlflowApiRequest(apiUrl, "POST", token, reqBody);
            }

            const modelUri = modelInfo.model_version?.source || modelInfo.model_versions?.[0]?.source;

            if (!modelUri) {
                throw new Error("Could not get model URI from MLflow");
            }

            // MLflow `source` is an artifact URI. Only http(s) sources are directly
            // downloadable here; object-store / proxy schemes (s3://, dbfs:/,
            // mlflow-artifacts:/, models:/, file:/) need their own client.
            if (!/^https?:\/\//i.test(modelUri)) {
                const scheme = String(modelUri).split(":")[0];
                throw new Error(
                    `MLflow model source uses '${scheme}:' which is not directly downloadable over HTTP. ` +
                        "Serve artifacts over http(s) (e.g. the mlflow-artifacts proxy) or use modelSource=url with a direct link."
                );
            }

            // Download model from MLflow storage
            await downloadFile(modelUri, token ? "bearer" : "none", token || "", targetPath, expectedSha256);
            return targetPath;
        } catch (err) {
            if (err && err.code === "ESHAMISMATCH") throw err;
            throw new Error(`Failed to download from MLflow: ${err.message}`);
        }
    }

    // Custom Registry API
    async function downloadFromCustomRegistry(registryUrl, modelId, apiKey, targetPath, expectedSha256) {
        try {
            const apiUrl = `${registryUrl.replace(/\/$/, "")}/models/${encodeURIComponent(modelId)}/download`;
            await downloadFile(apiUrl, apiKey ? "bearer" : "none", apiKey || "", targetPath, expectedSha256);
            return targetPath;
        } catch (err) {
            if (err && err.code === "ESHAMISMATCH") throw err;
            throw new Error(`Failed to download from custom registry: ${err.message}`);
        }
    }

    // ========================================
    // MLflow Tracking API - Performance Logging
    // ========================================

    /**
     * MLflow Tracking Manager - handles experiment/run lifecycle and metric logging
     */
    class MLflowTracker {
        constructor(trackingUri, experimentName, token) {
            this.trackingUri = trackingUri ? trackingUri.replace(/\/$/, "") : "";
            this.experimentName = experimentName || "node-red-ml-inference";
            this.token = token || "";
            this.experimentId = null;
            this.runId = null;
            this.metricsBuffer = [];
            this.bufferSize = 100; // Batch size for metric logging
            this.flushInterval = null;
            this.enabled = !!this.trackingUri;
            this.stepCounter = 0;
        }

        /**
         * Make HTTP request to MLflow API
         */
        async _request(method, endpoint, data = null) {
            if (!this.enabled) return null;

            return new Promise((resolve, reject) => {
                const url = `${this.trackingUri}${endpoint}`;
                const isHttps = url.startsWith("https");
                const protocol = isHttps ? https : http;

                const urlObj = new URL(url);
                const options = {
                    hostname: urlObj.hostname,
                    port: urlObj.port || (isHttps ? 443 : 80),
                    path: urlObj.pathname + urlObj.search,
                    method: method,
                    headers: {
                        "Content-Type": "application/json"
                    }
                };

                if (this.token) {
                    options.headers["Authorization"] = "Bearer " + this.token;
                }

                const req = protocol.request(options, (res) => {
                    let responseData = "";
                    res.on("data", (chunk) => (responseData += chunk));
                    res.on("end", () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                resolve(responseData ? JSON.parse(responseData) : {});
                            } catch (e) {
                                resolve({});
                            }
                        } else {
                            reject(new Error(`MLflow API error: ${res.statusCode} - ${responseData}`));
                        }
                    });
                });

                req.on("error", reject);

                if (data) {
                    req.write(JSON.stringify(data));
                }
                req.end();
            });
        }

        /**
         * Get or create experiment by name
         */
        async getOrCreateExperiment() {
            if (!this.enabled) return null;

            try {
                // Try to get existing experiment
                const searchResult = await this._request(
                    "GET",
                    `/api/2.0/mlflow/experiments/get-by-name?experiment_name=${encodeURIComponent(this.experimentName)}`
                );

                if (searchResult && searchResult.experiment) {
                    this.experimentId = searchResult.experiment.experiment_id;
                    return this.experimentId;
                }
            } catch (e) {
                // Experiment doesn't exist, create it
            }

            try {
                const createResult = await this._request("POST", "/api/2.0/mlflow/experiments/create", {
                    name: this.experimentName,
                    tags: [
                        { key: "source", value: "node-red-ml-inference" },
                        { key: "created_at", value: new Date().toISOString() }
                    ]
                });

                if (createResult && createResult.experiment_id) {
                    this.experimentId = createResult.experiment_id;
                    return this.experimentId;
                }
            } catch (e) {
                RED.log.warn("[MLflowTracker] Failed to create experiment: " + e.message);
            }

            return null;
        }

        /**
         * Start a new MLflow run for this node instance
         */
        async startRun(runName, tags = {}) {
            if (!this.enabled) return null;

            if (!this.experimentId) {
                await this.getOrCreateExperiment();
            }

            if (!this.experimentId) return null;

            try {
                const runTags = [
                    { key: "mlflow.runName", value: runName },
                    { key: "node_red.node_type", value: "ml-inference" },
                    { key: "node_red.start_time", value: new Date().toISOString() }
                ];

                // Add custom tags
                for (const [key, value] of Object.entries(tags)) {
                    runTags.push({ key: `node_red.${key}`, value: String(value) });
                }

                const result = await this._request("POST", "/api/2.0/mlflow/runs/create", {
                    experiment_id: this.experimentId,
                    start_time: Date.now(),
                    tags: runTags
                });

                if (result && result.run) {
                    this.runId = result.run.info.run_id;
                    this.stepCounter = 0;

                    // Start periodic flush
                    this._startFlushInterval();

                    return this.runId;
                }
            } catch (e) {
                RED.log.warn("[MLflowTracker] Failed to start run: " + e.message);
            }

            return null;
        }

        /**
         * Log a single metric (buffered)
         */
        logMetric(key, value, step = null) {
            if (!this.enabled || !this.runId) return;

            const metric = {
                key: key,
                value: typeof value === "number" ? value : parseFloat(value) || 0,
                timestamp: Date.now(),
                step: step !== null ? step : this.stepCounter++
            };

            this.metricsBuffer.push(metric);

            // Flush if buffer is full
            if (this.metricsBuffer.length >= this.bufferSize) {
                this.flush();
            }
        }

        /**
         * Log multiple metrics at once (buffered)
         */
        logMetrics(metrics, step = null) {
            if (!this.enabled || !this.runId) return;

            const currentStep = step !== null ? step : this.stepCounter++;

            for (const [key, value] of Object.entries(metrics)) {
                this.metricsBuffer.push({
                    key: key,
                    value: typeof value === "number" ? value : parseFloat(value) || 0,
                    timestamp: Date.now(),
                    step: currentStep
                });
            }

            if (this.metricsBuffer.length >= this.bufferSize) {
                this.flush();
            }
        }

        /**
         * Log parameters (not buffered - immediate)
         */
        async logParams(params) {
            if (!this.enabled || !this.runId) return;

            const paramList = [];
            for (const [key, value] of Object.entries(params)) {
                paramList.push({ key: key, value: String(value).substring(0, 500) }); // MLflow limit
            }

            try {
                await this._request("POST", "/api/2.0/mlflow/runs/log-batch", {
                    run_id: this.runId,
                    params: paramList
                });
            } catch (e) {
                RED.log.debug("[MLflowTracker] Failed to log params: " + e.message);
            }
        }

        /**
         * Flush metrics buffer to MLflow
         */
        async flush() {
            if (!this.enabled || !this.runId || this.metricsBuffer.length === 0) return;

            const metricsToSend = [...this.metricsBuffer];
            this.metricsBuffer = [];

            try {
                await this._request("POST", "/api/2.0/mlflow/runs/log-batch", {
                    run_id: this.runId,
                    metrics: metricsToSend
                });
            } catch (e) {
                RED.log.debug("[MLflowTracker] Failed to flush metrics: " + e.message);
                // Re-add metrics to buffer on failure (up to limit)
                this.metricsBuffer = [...metricsToSend.slice(-50), ...this.metricsBuffer].slice(0, this.bufferSize * 2);
            }
        }

        /**
         * Start periodic flush interval
         */
        _startFlushInterval() {
            if (this.flushInterval) return;

            // Flush every 10 seconds
            this.flushInterval = setInterval(() => {
                this.flush();
            }, 10000);
            if (this.flushInterval.unref) {
                this.flushInterval.unref();
            }
        }

        /**
         * End the current run
         */
        async endRun(status = "FINISHED") {
            if (!this.enabled || !this.runId) return;

            // Final flush
            await this.flush();

            // Stop flush interval
            if (this.flushInterval) {
                clearInterval(this.flushInterval);
                this.flushInterval = null;
            }

            try {
                await this._request("POST", "/api/2.0/mlflow/runs/update", {
                    run_id: this.runId,
                    status: status,
                    end_time: Date.now()
                });
            } catch (e) {
                RED.log.debug("[MLflowTracker] Failed to end run: " + e.message);
            }

            this.runId = null;
        }

        /**
         * Clean up resources
         */
        destroy() {
            if (this.flushInterval) {
                clearInterval(this.flushInterval);
                this.flushInterval = null;
            }
            this.endRun("KILLED");
        }
    }

    // Store active trackers by node ID
    const activeTrackers = new Map();

    /**
     * Compute the SHA-256 hash of a file, returning a lower-case hex digest.
     */
    function sha256OfFile(filePath) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash("sha256");
            const stream = fs.createReadStream(filePath);
            stream.on("data", (chunk) => hash.update(chunk));
            stream.on("end", () => resolve(hash.digest("hex")));
            stream.on("error", reject);
        });
    }

    // Download file with authentication.
    //
    // When `expectedSha256` is provided, the downloaded artifact is hashed and
    // compared against it after the stream completes. On mismatch the file is
    // unlinked and the promise rejects — no caller will ever see a poisoned
    // model. Hashes must be the lower-case hex SHA-256 digest.
    async function downloadFile(url, authType, authToken, targetPath, expectedSha256, redirectsLeft) {
        if (redirectsLeft === undefined) redirectsLeft = 5;
        await new Promise((resolve, reject) => {
            const protocol = url.startsWith("https") ? https : http;

            const options = {
                headers: {}
            };

            // Add authentication headers
            if (authType === "bearer" && authToken) {
                options.headers["Authorization"] = "Bearer " + authToken;
            } else if (authType === "basic" && authToken) {
                options.headers["Authorization"] = "Basic " + Buffer.from(authToken).toString("base64");
            }

            const file = fs.createWriteStream(targetPath);

            // A WriteStream error (disk full, EACCES, etc.) would otherwise be an
            // unhandled 'error' event and crash the process. Route it to reject.
            file.on("error", (err) => {
                try {
                    file.destroy();
                    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
                } catch (_) {
                    /* ignore cleanup errors */
                }
                reject(err);
            });

            protocol
                .get(url, options, (response) => {
                    if (
                        response.statusCode === 301 ||
                        response.statusCode === 302 ||
                        response.statusCode === 303 ||
                        response.statusCode === 307 ||
                        response.statusCode === 308
                    ) {
                        // Handle redirect — recurse but keep the same expectedSha256
                        file.destroy();
                        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
                        if (redirectsLeft <= 0 || !response.headers.location) {
                            reject(new Error("Too many redirects (or missing Location) while downloading " + url));
                            return;
                        }
                        const nextUrl = new URL(response.headers.location, url).toString();
                        // Drop credentials when the redirect crosses to another origin —
                        // presigned-CDN redirects (HF/S3) must not receive our auth token.
                        let nextAuthType = authType;
                        let nextAuthToken = authToken;
                        try {
                            if (new URL(nextUrl).origin !== new URL(url).origin) {
                                nextAuthType = null;
                                nextAuthToken = null;
                            }
                        } catch (e) {
                            // malformed URL — let the recursive call fail cleanly
                        }
                        return downloadFile(
                            nextUrl,
                            nextAuthType,
                            nextAuthToken,
                            targetPath,
                            expectedSha256,
                            redirectsLeft - 1
                        )
                            .then(resolve)
                            .catch(reject);
                    }

                    if (response.statusCode !== 200) {
                        file.close();
                        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
                        reject(new Error(`Failed to download: ${response.statusCode} ${response.statusMessage}`));
                        return;
                    }

                    response.pipe(file);

                    file.on("finish", () => {
                        file.close();
                        resolve();
                    });
                })
                .on("error", (err) => {
                    file.close();
                    if (fs.existsSync(targetPath)) {
                        fs.unlinkSync(targetPath);
                    }
                    reject(err);
                });
        });

        if (expectedSha256) {
            const want = String(expectedSha256).trim().toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(want)) {
                if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
                throw new Error("expectedSha256 must be a 64-char hex SHA-256 digest");
            }
            const got = await sha256OfFile(targetPath);
            if (got !== want) {
                if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
                const err = new Error(`SHA-256 mismatch for ${url}: expected ${want}, got ${got}`);
                err.code = "ESHAMISMATCH";
                throw err;
            }
        }

        return targetPath;
    }

    // Lazy-load ML runtimes
    let tf = null;
    let ort = null;

    function loadTensorFlowJS() {
        if (tf === null) {
            try {
                tf = require("@tensorflow/tfjs-node");
            } catch (err) {
                try {
                    // Fallback to CPU-only version
                    tf = require("@tensorflow/tfjs");
                } catch (err2) {
                    return null;
                }
            }
        }
        return tf;
    }

    function loadONNXRuntime() {
        if (ort === null) {
            try {
                ort = require("onnxruntime-node");
            } catch (err) {
                return null;
            }
        }
        return ort;
    }

    function MLInferenceNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Configuration
        this.modelSource = config.modelSource || "local"; // local, url, huggingface, mlflow, custom
        this.modelPath = config.modelPath || "";
        this.modelType = config.modelType || "auto"; // auto, tfjs, onnx, coral
        this.inputShape = config.inputShape || ""; // e.g., "1,10" for batch of 10 features
        this.outputProperty = config.outputProperty || "prediction";
        this.inputProperty = config.inputProperty || "payload";
        this.preprocessMode = config.preprocessMode || "array"; // array, object, flatten
        this.batchSize = clampInt(config.batchSize, 1, 100000, 1);
        this.warmup = config.warmup !== false;

        // URL Authentication (for Phase 1)
        this.urlAuthType = config.urlAuthType || ""; // bearer, basic, none
        this.urlAuthToken = config.urlAuthToken || ""; // Bearer token or Basic auth credentials

        // Optional integrity check: lower-case hex SHA-256 of the downloaded artifact.
        // When set, downloads with a different digest are rejected and unlinked.
        // The hash applies to URL-, HuggingFace-, MLflow- and custom-registry downloads.
        this.modelSha256 = (function () {
            const v = (config.modelSha256 || "").toString().trim().toLowerCase();
            return /^[0-9a-f]{64}$/.test(v) ? v : null;
        })();

        // Hugging Face Hub (Phase 2)
        this.hfModelId = config.hfModelId || ""; // e.g., "microsoft/DialoGPT-medium"
        this.hfRevision = config.hfRevision || "main"; // branch, tag, or commit hash
        this.hfToken = config.hfToken || ""; // Optional HF token

        // MLflow Registry (Phase 3)
        this.mlflowRegistryUri = config.mlflowRegistryUri || ""; // e.g., "http://mlflow-server:5000"
        this.mlflowModelName = config.mlflowModelName || "";
        this.mlflowVersion = config.mlflowVersion || "latest"; // version number or "latest"
        this.mlflowStage = config.mlflowStage || "production"; // staging, production, archived
        this.mlflowAuthToken = config.mlflowAuthToken || ""; // Optional MLflow token

        // Custom Registry (Phase 4)
        this.customRegistryUrl = config.customRegistryUrl || "";
        this.customModelId = config.customModelId || "";
        this.customApiKey = config.customApiKey || "";

        // Auto-Update & Lifecycle (Phase 5)
        this.autoUpdate = config.autoUpdate || false;
        this.updateCheckInterval = clampInt(config.updateCheckInterval, 1, 31536000, 3600); // seconds
        this.modelStage = config.modelStage || "production"; // development, staging, production, deprecated, archived

        // MLflow Tracking (Phase 6) - Performance Logging
        this.mlflowTrackingEnabled = config.mlflowTrackingEnabled || false;
        this.mlflowTrackingUri = config.mlflowTrackingUri || config.mlflowRegistryUri || ""; // Reuse registry URI if not specified
        this.mlflowExperimentName = config.mlflowExperimentName || "node-red-ml-inference";
        this.mlflowRunName = config.mlflowRunName || config.name || node.id;
        this.mlflowLogInferenceTime = config.mlflowLogInferenceTime !== false; // Default: true
        this.mlflowLogPredictions = config.mlflowLogPredictions || false; // Default: false (can be verbose)
        this.mlflowLogInputStats = config.mlflowLogInputStats || false; // Log input min/max/mean
        this.mlflowLogAnomalies = config.mlflowLogAnomalies || false; // Log anomaly detections
        this.mlflowBatchSize = clampInt(config.mlflowBatchSize, 1, 100000, 100); // Metrics batch size

        // MLflow Tracker instance
        this.mlflowTracker = null;

        // State
        this.model = null;
        this.modelLoaded = false;
        this.modelFormat = null; // 'tfjs' or 'onnx'
        this.inputNames = [];
        this.outputNames = [];
        this.loadError = null;

        // Status indicator
        node.status({ fill: "yellow", shape: "ring", text: "initializing..." });

        // Auto-update timer (Phase 5)
        let updateTimer = null;
        if (node.autoUpdate && node.updateCheckInterval > 0) {
            updateTimer = setInterval(async () => {
                if (
                    node.modelSource === "huggingface" ||
                    node.modelSource === "mlflow" ||
                    node.modelSource === "custom"
                ) {
                    try {
                        node.status({ fill: "yellow", shape: "dot", text: "checking for updates..." });
                        // Re-initialize model to check for updates
                        await initializeModel();
                    } catch (err) {
                        node.warn("Auto-update check failed: " + err.message);
                    }
                }
            }, node.updateCheckInterval * 1000);
            if (updateTimer.unref) {
                updateTimer.unref();
            }
        }

        // Parse input shape
        function parseShape(shapeStr) {
            if (!shapeStr || shapeStr.trim() === "") return null;

            // Remove brackets if present: "[1,8]" -> "1,8"
            let cleaned = shapeStr.trim();
            if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
                cleaned = cleaned.slice(1, -1);
            }

            if (cleaned === "") return null;

            const parts = cleaned.split(",").map((s) => {
                // Remove any remaining brackets or whitespace
                const trimmed = s.trim().replace(/[[\]]/g, "");
                const n = parseInt(trimmed);
                return isNaN(n) ? 1 : Math.max(1, n); // Default to 1 for invalid/dynamic dimensions
            });

            // Filter out invalid entries
            return parts.filter((n) => n > 0);
        }

        // Detect model type from path
        function detectModelType(modelPath) {
            if (!modelPath) return null;

            const ext = path.extname(modelPath).toLowerCase();
            const basename = path.basename(modelPath).toLowerCase();

            if (ext === ".onnx") return "onnx";
            if (ext === ".tflite") return "tflite";
            if (ext === ".keras") return "keras";
            if (ext === ".h5") return "keras";
            if (ext === ".pkl") return "sklearn";
            if (ext === ".joblib") return "sklearn";
            if (ext === ".json" && basename === "model.json") return "tfjs";
            if (basename === "model.json") return "tfjs";
            if (ext === ".json") return "tfjs";

            // Check if it's a directory (SavedModel or tfjs)
            try {
                if (fs.existsSync(modelPath) && fs.statSync(modelPath).isDirectory()) {
                    // Check for tfjs model.json
                    if (fs.existsSync(path.join(modelPath, "model.json"))) {
                        return "tfjs";
                    }
                    // Check for SavedModel
                    if (fs.existsSync(path.join(modelPath, "saved_model.pb"))) {
                        return "savedmodel";
                    }
                }
            } catch (e) {
                // Ignore errors
            }

            return null;
        }

        // Load TensorFlow.js model
        async function loadTFJSModel(modelPath, authType, authToken, expectedSha256) {
            // Validate the path BEFORE probing for the optional runtime. A path
            // the allowlist rejects must be reported as such whether or not the
            // runtime happens to be installed — otherwise the security check is
            // shadowed by an availability check, and which error you get depends
            // on the install. The other four loaders already validate first.
            if (!modelPath.startsWith("http://") && !modelPath.startsWith("https://")) {
                resolveLocalModelPath(modelPath);
            }

            const tensorflow = loadTensorFlowJS();
            if (!tensorflow) {
                throw new Error("TensorFlow.js not available. Install: npm install @tensorflow/tfjs-node");
            }

            let model;
            let actualPath = modelPath;

            // Determine how to load based on path
            if (modelPath.startsWith("http://") || modelPath.startsWith("https://")) {
                // URL-based loading - download first if authentication is needed
                if (authType && authToken) {
                    // Download to cache first
                    const urlObj = new URL(modelPath);
                    const filename = path.basename(urlObj.pathname) || "model_" + Date.now() + ".json";
                    const cachePath = path.join(MODELS_DIR, "cache", filename);

                    // Ensure cache directory exists
                    const cacheDir = path.dirname(cachePath);
                    if (!fs.existsSync(cacheDir)) {
                        fs.mkdirSync(cacheDir, { recursive: true });
                    }

                    // Download file (with optional SHA-256 integrity check)
                    await downloadFile(modelPath, authType, authToken, cachePath, expectedSha256);
                    actualPath = cachePath;
                } else if (expectedSha256) {
                    // We were asked to verify integrity but we'd otherwise hand the URL
                    // straight to TensorFlow.js — fetch+verify here so the contract is honoured.
                    const urlObj = new URL(modelPath);
                    const filename = path.basename(urlObj.pathname) || "model_" + Date.now() + ".json";
                    const cachePath = path.join(MODELS_DIR, "cache", filename);
                    const cacheDir = path.dirname(cachePath);
                    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
                    await downloadFile(modelPath, "none", "", cachePath, expectedSha256);
                    actualPath = cachePath;
                }

                // Load from URL (TF.js handles URLs natively, but we use cached file if auth was needed)
                try {
                    model = await tensorflow.loadGraphModel(actualPath);
                } catch (e) {
                    model = await tensorflow.loadLayersModel(actualPath);
                }
            } else {
                // Local file
                const fullPath = resolveLocalModelPath(modelPath);

                if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
                    // Directory - check for model.json or saved_model.pb
                    const modelJsonPath = path.join(fullPath, "model.json");
                    const savedModelPath = fullPath;

                    if (fs.existsSync(modelJsonPath)) {
                        try {
                            model = await tensorflow.loadGraphModel("file://" + modelJsonPath);
                        } catch (e) {
                            model = await tensorflow.loadLayersModel("file://" + modelJsonPath);
                        }
                    } else if (fs.existsSync(path.join(fullPath, "saved_model.pb"))) {
                        model = await tensorflow.node.loadSavedModel(savedModelPath);
                    } else {
                        throw new Error("No model.json or saved_model.pb found in directory");
                    }
                } else {
                    // Single file (model.json)
                    const fileUrl = "file://" + fullPath;
                    try {
                        model = await tensorflow.loadGraphModel(fileUrl);
                    } catch (e) {
                        model = await tensorflow.loadLayersModel(fileUrl);
                    }
                }
            }

            return model;
        }

        // Load ONNX model
        async function loadONNXModel(modelPath, authType, authToken, expectedSha256) {
            // Validate the path BEFORE probing for the optional runtime. A path
            // the allowlist rejects must be reported as such whether or not the
            // runtime happens to be installed — otherwise the security check is
            // shadowed by an availability check, and which error you get depends
            // on the install. The other four loaders already validate first.
            if (!modelPath.startsWith("http://") && !modelPath.startsWith("https://")) {
                resolveLocalModelPath(modelPath);
            }

            const onnxruntime = loadONNXRuntime();
            if (!onnxruntime) {
                throw new Error("ONNX Runtime not available. Install: npm install onnxruntime-node");
            }

            let actualPath = modelPath;

            // Handle URL-based loading
            if (modelPath.startsWith("http://") || modelPath.startsWith("https://")) {
                // Download to cache first (ONNX Runtime needs local files)
                const urlObj = new URL(modelPath);
                const filename = path.basename(urlObj.pathname) || "model_" + Date.now() + ".onnx";
                const cachePath = path.join(MODELS_DIR, "cache", filename);

                // Ensure cache directory exists
                const cacheDir = path.dirname(cachePath);
                if (!fs.existsSync(cacheDir)) {
                    fs.mkdirSync(cacheDir, { recursive: true });
                }

                // Download file (with optional SHA-256 integrity check)
                await downloadFile(modelPath, authType || "none", authToken || "", cachePath, expectedSha256);
                actualPath = cachePath;
            }

            const fullPath = resolveLocalModelPath(actualPath);

            if (!fs.existsSync(fullPath)) {
                throw new Error("ONNX model file not found: " + fullPath);
            }

            const session = await onnxruntime.InferenceSession.create(fullPath);
            return session;
        }

        // Load TFLite/Coral model using persistent Python bridge
        async function loadCoralModel(modelPath) {
            const fullPath = resolveLocalModelPath(modelPath);

            if (!fs.existsSync(fullPath)) {
                throw new Error("TFLite model file not found: " + fullPath);
            }

            // Get or start the persistent Python bridge
            const bridge = await ensurePythonBridge();

            // Generate a unique model ID for this node
            const modelId = "tflite_" + path.basename(fullPath) + "_" + node.id;

            // Load model into the persistent bridge
            await bridge.loadModel(fullPath, modelId);

            return {
                type: "tflite",
                modelPath: fullPath,
                modelId: modelId,
                usePersistentBridge: true,
                predict: async function (inputData) {
                    const bridge = await ensurePythonBridge();
                    return bridge.predict(modelId, inputData);
                },
                unload: async function () {
                    try {
                        const bridge = await ensurePythonBridge();
                        await bridge.unloadModel(modelId);
                    } catch (err) {
                        // Ignore unload errors
                    }
                }
            };
        }

        // Load Keras model (.keras, .h5) using persistent Python bridge
        async function loadKerasModel(modelPath) {
            const fullPath = resolveLocalModelPath(modelPath);

            if (!fs.existsSync(fullPath)) {
                throw new Error("Keras model file not found: " + fullPath);
            }

            // Get or start the persistent Python bridge
            const bridge = await ensurePythonBridge();

            // Generate a unique model ID for this node
            const modelId = "keras_" + path.basename(fullPath) + "_" + node.id;

            // Load model into the persistent bridge
            await bridge.loadModel(fullPath, modelId);

            return {
                type: "keras",
                modelPath: fullPath,
                modelId: modelId,
                usePersistentBridge: true,
                predict: async function (inputData) {
                    const bridge = await ensurePythonBridge();
                    return bridge.predict(modelId, inputData);
                },
                unload: async function () {
                    try {
                        const bridge = await ensurePythonBridge();
                        await bridge.unloadModel(modelId);
                    } catch (err) {
                        // Ignore unload errors
                    }
                }
            };
        }

        // Load ONNX model using MAX Engine bridge (high-performance)
        async function loadMaxModel(modelPath) {
            const fullPath = resolveLocalModelPath(modelPath);

            if (!fs.existsSync(fullPath)) {
                throw new Error("Model file not found: " + fullPath);
            }

            // Get or start the MAX bridge
            const bridge = await ensureMaxBridge();

            // Generate a unique model ID for this node
            const modelId = "max_" + path.basename(fullPath) + "_" + node.id;

            // Load model into the MAX server
            // Use container path for Docker: /models/...
            let containerPath = fullPath;
            if (fullPath.includes("/data/models/")) {
                containerPath = fullPath.replace(/.*\/data\/models\//, "/models/");
            } else if (fullPath.includes("/models/")) {
                // Already a container path
                containerPath = fullPath;
            }

            await bridge.loadModel(containerPath, modelId, "auto");

            return {
                type: "max",
                modelPath: fullPath,
                containerPath: containerPath,
                modelId: modelId,
                predict: async function (inputData) {
                    const bridge = await ensureMaxBridge();
                    const result = await bridge.predict(modelId, inputData);
                    return result.prediction;
                },
                batchPredict: async function (inputs) {
                    const bridge = await ensureMaxBridge();
                    const result = await bridge.batchPredict(modelId, inputs);
                    return result.predictions;
                },
                unload: async function () {
                    try {
                        const bridge = await ensureMaxBridge();
                        await bridge.unloadModel(modelId);
                    } catch (err) {
                        // Ignore unload errors
                    }
                }
            };
        }

        // Load scikit-learn model (.pkl, .joblib) using persistent Python bridge
        async function loadSklearnModel(modelPath) {
            const fullPath = resolveLocalModelPath(modelPath);

            if (!fs.existsSync(fullPath)) {
                throw new Error("scikit-learn model file not found: " + fullPath);
            }

            // Get or start the persistent Python bridge
            const bridge = await ensurePythonBridge();

            // Generate a unique model ID for this node
            const modelId = "sklearn_" + path.basename(fullPath) + "_" + node.id;

            // Load model into the persistent bridge
            await bridge.loadModel(fullPath, modelId);

            return {
                type: "sklearn",
                modelPath: fullPath,
                modelId: modelId,
                usePersistentBridge: true,
                predict: async function (inputData) {
                    const bridge = await ensurePythonBridge();
                    return bridge.predict(modelId, inputData);
                },
                unload: async function () {
                    try {
                        const bridge = await ensurePythonBridge();
                        await bridge.unloadModel(modelId);
                    } catch (err) {
                        // Ignore unload errors
                    }
                }
            };
        }

        // Initialize model
        // Dispose/unload the currently loaded model before loading a new one.
        // Prevents tensor / native-session / bridge-model leaks on auto-update
        // reloads and runtime msg.loadModel swaps.
        async function disposeCurrentModel() {
            if (!node.model) return;
            const old = node.model;
            node.model = null;
            node.modelLoaded = false;
            try {
                if (old.usePersistentBridge && old.unload) {
                    await old.unload();
                }
                if (node.modelFormat === "tfjs" && old.dispose) {
                    old.dispose();
                }
                // ONNX sessions don't need explicit disposal
            } catch (err) {
                node.warn("Error disposing previous model: " + err.message);
            }
        }

        async function initializeModel() {
            // Dispose any previously loaded model first (reload / auto-update / swap)
            await disposeCurrentModel();

            // Check if model source is configured
            if (node.modelSource === "huggingface" && !node.hfModelId) {
                node.status({ fill: "grey", shape: "ring", text: "no Hugging Face model ID" });
                return;
            }
            if (node.modelSource === "mlflow" && !node.mlflowModelName) {
                node.status({ fill: "grey", shape: "ring", text: "no MLflow model name" });
                return;
            }
            if (node.modelSource === "custom" && !node.customModelId) {
                node.status({ fill: "grey", shape: "ring", text: "no custom model ID" });
                return;
            }
            if ((node.modelSource === "local" || node.modelSource === "url") && !node.modelPath) {
                node.status({ fill: "grey", shape: "ring", text: "no model configured" });
                return;
            }

            try {
                node.status({ fill: "yellow", shape: "dot", text: "loading model..." });

                let actualModelPath = node.modelPath;
                let authType = null;
                let authToken = null;
                let metadata = null;

                // Handle different model sources
                if (node.modelSource === "huggingface") {
                    // Download from Hugging Face Hub
                    const cacheDir = path.join(MODELS_DIR, "cache", "hf");
                    if (!fs.existsSync(cacheDir)) {
                        fs.mkdirSync(cacheDir, { recursive: true });
                    }
                    const safeModelId = node.hfModelId.replace(/[^a-zA-Z0-9._-]/g, "_");
                    const cachePath = path.join(cacheDir, safeModelId + "_" + node.hfRevision + ".model");

                    await downloadFromHuggingFace(
                        node.hfModelId,
                        node.hfRevision,
                        node.hfToken,
                        cachePath,
                        node.modelSha256
                    );
                    actualModelPath = cachePath;
                    authType = node.hfToken ? "bearer" : null;
                    authToken = node.hfToken || null;

                    // Create metadata from HF model
                    metadata = {
                        name: node.hfModelId,
                        version: node.hfRevision,
                        type: "auto",
                        source: "huggingface",
                        downloaded: new Date().toISOString()
                    };
                } else if (node.modelSource === "mlflow") {
                    // Download from MLflow Registry
                    const cacheDir = path.join(MODELS_DIR, "cache", "mlflow");
                    if (!fs.existsSync(cacheDir)) {
                        fs.mkdirSync(cacheDir, { recursive: true });
                    }
                    const safeModelName = node.mlflowModelName.replace(/[^a-zA-Z0-9._-]/g, "_");
                    const versionStr = node.mlflowVersion === "latest" ? "latest" : node.mlflowVersion;
                    const cachePath = path.join(cacheDir, safeModelName + "_" + versionStr + ".model");

                    await downloadFromMLflow(
                        node.mlflowRegistryUri,
                        node.mlflowModelName,
                        node.mlflowVersion,
                        node.mlflowStage,
                        node.mlflowAuthToken,
                        cachePath,
                        node.modelSha256
                    );
                    actualModelPath = cachePath;
                    authType = node.mlflowAuthToken ? "bearer" : null;
                    authToken = node.mlflowAuthToken || null;

                    // Create metadata from MLflow
                    metadata = {
                        name: node.mlflowModelName,
                        version: node.mlflowVersion,
                        stage: node.mlflowStage,
                        type: "auto",
                        source: "mlflow",
                        downloaded: new Date().toISOString()
                    };
                } else if (node.modelSource === "custom") {
                    // Download from Custom Registry
                    const cacheDir = path.join(MODELS_DIR, "cache", "custom");
                    if (!fs.existsSync(cacheDir)) {
                        fs.mkdirSync(cacheDir, { recursive: true });
                    }
                    const safeModelId = node.customModelId.replace(/[^a-zA-Z0-9._-]/g, "_");
                    const cachePath = path.join(cacheDir, safeModelId + ".model");

                    await downloadFromCustomRegistry(
                        node.customRegistryUrl,
                        node.customModelId,
                        node.customApiKey,
                        cachePath,
                        node.modelSha256
                    );
                    actualModelPath = cachePath;
                    authType = node.customApiKey ? "bearer" : null;
                    authToken = node.customApiKey || null;

                    // Create metadata from custom registry
                    metadata = {
                        name: node.customModelId,
                        version: "1.0.0",
                        type: "auto",
                        source: "custom",
                        downloaded: new Date().toISOString()
                    };
                } else if (node.modelSource === "url") {
                    // URL-based loading (already handled in load functions)
                    authType = node.urlAuthType || null;
                    authToken = node.urlAuthToken || null;
                } else {
                    // Local file - load metadata if available
                    if (actualModelPath && !actualModelPath.startsWith("http")) {
                        metadata = loadModelMetadata(actualModelPath);
                    }
                }

                // Detect model type
                let modelType = node.modelType;
                if (modelType === "auto") {
                    modelType = detectModelType(actualModelPath);
                    if (!modelType) {
                        throw new Error("Could not detect model type. Please specify tfjs or onnx.");
                    }
                }

                node.modelFormat = modelType;

                if (modelType === "tfjs") {
                    node.model = await loadTFJSModel(node.modelPath, authType, authToken, node.modelSha256);
                    node.modelLoaded = true;

                    // Warmup run
                    if (node.warmup && node.model.predict) {
                        const shape = parseShape(node.inputShape) || [1, 1];
                        const tensorflow = loadTensorFlowJS();
                        const dummyInput = tensorflow.zeros(shape);
                        try {
                            const result = node.model.predict(dummyInput);
                            // Multi-output models return an array of tensors
                            if (Array.isArray(result)) {
                                result.forEach((t) => t && t.dispose && t.dispose());
                            } else if (result && result.dispose) {
                                result.dispose();
                            }
                        } catch (e) {
                            // Ignore warmup errors
                        }
                        dummyInput.dispose();
                    }

                    node.status({ fill: "green", shape: "dot", text: "tfjs ready" });
                } else if (modelType === "onnx") {
                    node.model = await loadONNXModel(actualModelPath, authType, authToken, node.modelSha256);
                    node.modelLoaded = true;

                    // Get input/output names
                    node.inputNames = node.model.inputNames || [];
                    node.outputNames = node.model.outputNames || [];

                    node.status({ fill: "green", shape: "dot", text: "onnx ready" });
                } else if (modelType === "coral") {
                    node.model = await loadCoralModel(actualModelPath);
                    node.modelLoaded = true;
                    node.status({ fill: "green", shape: "dot", text: "coral ready" });
                } else if (modelType === "tflite") {
                    // TFLite models use Coral/Python bridge for inference
                    node.model = await loadCoralModel(actualModelPath);
                    node.modelLoaded = true;
                    node.status({ fill: "green", shape: "dot", text: "tflite ready" });
                } else if (modelType === "savedmodel") {
                    // TensorFlow SavedModel uses TF.js loader
                    node.model = await loadTFJSModel(node.modelPath, authType, authToken, node.modelSha256);
                    node.modelLoaded = true;
                    node.status({ fill: "green", shape: "dot", text: "savedmodel ready" });
                } else if (modelType === "keras") {
                    // Keras models (.keras, .h5) use Python bridge
                    node.model = await loadKerasModel(actualModelPath);
                    node.modelLoaded = true;
                    node.status({ fill: "green", shape: "dot", text: "keras ready" });
                } else if (modelType === "sklearn") {
                    // scikit-learn models (.pkl, .joblib) use Python bridge
                    node.model = await loadSklearnModel(actualModelPath);
                    node.modelLoaded = true;
                    node.status({ fill: "green", shape: "dot", text: "sklearn ready" });
                } else if (modelType === "max") {
                    // ONNX models via MAX Engine (high-performance)
                    node.model = await loadMaxModel(actualModelPath);
                    node.modelLoaded = true;
                    node.status({ fill: "green", shape: "dot", text: "max ready" });
                } else {
                    throw new Error("Unknown model type: " + modelType);
                }

                // Save or update metadata
                if (metadata) {
                    const updatedMetadata = Object.assign({}, metadata, {
                        type: modelType,
                        format: modelType,
                        lastLoaded: new Date().toISOString(),
                        inputShape: node.inputShape || null,
                        stage: node.modelStage || metadata.stage || "production",
                        metadata: metadata.metadata || {}
                    });

                    // Save metadata to cache or local path
                    if (actualModelPath && !actualModelPath.startsWith("http")) {
                        saveModelMetadata(actualModelPath, updatedMetadata);
                    }
                } else if (actualModelPath && !actualModelPath.startsWith("http")) {
                    // Create metadata for local models
                    const currentMetadata = loadModelMetadata(actualModelPath) || {};
                    const updatedMetadata = {
                        name: currentMetadata.name || path.basename(actualModelPath),
                        version: currentMetadata.version || "1.0.0",
                        type: modelType,
                        path: actualModelPath,
                        source: node.modelSource || "local",
                        format: modelType,
                        lastLoaded: new Date().toISOString(),
                        stage: node.modelStage || "production",
                        inputShape: node.inputShape || null,
                        metadata: currentMetadata.metadata || {}
                    };
                    saveModelMetadata(actualModelPath, updatedMetadata);
                }

                node.log(
                    "Model loaded successfully: " + actualModelPath + " (" + modelType + ") from " + node.modelSource
                );

                // ========================================
                // Initialize MLflow Tracking if enabled
                // ========================================
                if (node.mlflowTrackingEnabled && node.mlflowTrackingUri) {
                    try {
                        // Clean up existing tracker if any
                        if (node.mlflowTracker) {
                            await node.mlflowTracker.endRun("FINISHED");
                        }

                        // Create new tracker
                        node.mlflowTracker = new MLflowTracker(
                            node.mlflowTrackingUri,
                            node.mlflowExperimentName,
                            node.mlflowAuthToken
                        );
                        node.mlflowTracker.bufferSize = node.mlflowBatchSize;

                        // Start a new run
                        const runTags = {
                            model_name: metadata ? metadata.name : path.basename(actualModelPath),
                            model_version: metadata ? metadata.version : "1.0.0",
                            model_source: node.modelSource,
                            model_format: modelType,
                            model_stage: node.modelStage,
                            node_id: node.id,
                            node_name: node.name || "ml-inference"
                        };

                        await node.mlflowTracker.startRun(node.mlflowRunName || node.name || node.id, runTags);

                        // Log initial parameters
                        await node.mlflowTracker.logParams({
                            model_path: actualModelPath,
                            model_type: modelType,
                            input_shape: node.inputShape || "auto",
                            preprocess_mode: node.preprocessMode,
                            batch_size: String(node.batchSize)
                        });

                        node.log("[MLflowTracker] Started tracking run: " + node.mlflowTracker.runId);

                        // Store tracker reference
                        activeTrackers.set(node.id, node.mlflowTracker);
                    } catch (trackingErr) {
                        node.warn("[MLflowTracker] Failed to initialize tracking: " + trackingErr.message);
                        node.mlflowTracker = null;
                    }
                }
            } catch (err) {
                node.loadError = err;
                node.modelLoaded = false;
                node.status({ fill: "red", shape: "ring", text: err.message.substring(0, 30) });
                node.error("Failed to load model: " + err.message);
            }
        }

        // Prepare input data
        function prepareInput(data, preprocessMode) {
            let inputArray;

            if (Array.isArray(data)) {
                inputArray = data.flat(Infinity).map((v) => parseFloat(v) || 0);
            } else if (typeof data === "object" && data !== null) {
                if (preprocessMode === "object") {
                    // Extract values from object
                    inputArray = Object.values(data).map((v) => parseFloat(v) || 0);
                } else {
                    // Try to get array from common properties
                    inputArray = data.features || data.values || data.input || Object.values(data);
                    inputArray = inputArray.flat(Infinity).map((v) => parseFloat(v) || 0);
                }
            } else if (typeof data === "number") {
                inputArray = [data];
            } else {
                throw new Error("Input data must be a number, array, or object");
            }

            return inputArray;
        }

        // Run TFJS inference
        async function runTFJSInference(inputData) {
            const tensorflow = loadTensorFlowJS();
            const shape = parseShape(node.inputShape);

            let inputTensor;
            if (shape) {
                inputTensor = tensorflow.tensor(inputData, shape);
            } else {
                inputTensor = tensorflow.tensor([inputData]);
            }

            try {
                const result = node.model.predict(inputTensor);
                let output;

                if (Array.isArray(result)) {
                    node._lastOutputShape = result.map((t) => t.shape);
                    output = await Promise.all(result.map((t) => t.array()));
                    result.forEach((t) => t.dispose());
                } else {
                    node._lastOutputShape = result.shape;
                    output = await result.array();
                    result.dispose();
                }

                return output;
            } finally {
                inputTensor.dispose();
            }
        }

        // Run ONNX inference
        async function runONNXInference(inputData) {
            const onnxruntime = loadONNXRuntime();

            // Ensure inputData is an array
            let dataArray = inputData;
            if (!Array.isArray(dataArray)) {
                dataArray = [dataArray];
            }

            // Flatten nested arrays
            const flatData = dataArray.flat(Infinity);

            // Determine shape
            let shape = parseShape(node.inputShape);

            if (!shape || shape.length === 0) {
                // Default: batch of 1 with input length
                shape = [1, flatData.length];
            } else if (shape.length === 1) {
                // Single dimension: add batch dimension
                shape = [1, shape[0]];
            }

            // Ensure shape matches data length
            const expectedLength = shape.reduce((a, b) => a * b, 1);
            if (flatData.length !== expectedLength) {
                // Adjust shape to match data
                if (shape.length === 2 && shape[0] === 1) {
                    shape = [1, flatData.length];
                } else {
                    node.warn(
                        `Shape mismatch: expected ${expectedLength} values, got ${flatData.length}. Adjusting shape.`
                    );
                    shape = [1, flatData.length];
                }
            }

            // Create input tensor
            const inputName = node.inputNames[0] || "input";
            const inputTensor = new onnxruntime.Tensor("float32", flatData, shape);

            const feeds = {};
            feeds[inputName] = inputTensor;

            const results = await node.model.run(feeds);

            // Extract output
            const outputName = node.outputNames[0] || Object.keys(results)[0];
            const outputTensor = results[outputName];

            // Remember the tensor shape so downstream nodes (e.g. vision-annotator)
            // can reshape the flat data back into [N,C,H,W] / [N,boxes,attrs].
            node._lastOutputShape = outputTensor.dims ? Array.from(outputTensor.dims) : null;

            // Convert to array
            return Array.from(outputTensor.data);
        }

        // Process messages
        node.on("input", async function (msg, send, done) {
            send =
                send ||
                function () {
                    node.send.apply(node, arguments);
                };
            done =
                done ||
                function (err) {
                    if (err) node.error(err, msg);
                };

            try {
                // Check if this is a model load/reload command
                if (msg.loadModel) {
                    node.modelPath = msg.loadModel;
                    // initializeModel() disposes the previous model before loading
                    await initializeModel();
                    done();
                    return;
                }

                // Check if model is loaded
                if (!node.modelLoaded) {
                    if (node.loadError) {
                        throw new Error("Model not loaded: " + node.loadError.message);
                    } else if (!node.modelPath) {
                        throw new Error("No model path configured");
                    } else {
                        throw new Error("Model not yet loaded");
                    }
                }

                // Get input data
                const inputProperty = msg.inputProperty || node.inputProperty;
                const inputData = inputProperty.split(".").reduce((obj, key) => obj && obj[key], msg);

                if (inputData === undefined || inputData === null) {
                    throw new Error("Input data not found at msg." + inputProperty);
                }

                // Prepare input
                const preparedInput = prepareInput(inputData, node.preprocessMode);

                // Run inference
                node.status({ fill: "blue", shape: "dot", text: "inferencing..." });
                let prediction;
                const startTime = Date.now();

                if (node.modelFormat === "tfjs" || node.modelFormat === "savedmodel") {
                    prediction = await runTFJSInference(preparedInput);
                } else if (node.modelFormat === "onnx") {
                    prediction = await runONNXInference(preparedInput);
                } else if (node.modelFormat === "tflite" || node.modelFormat === "coral") {
                    // TFLite/Coral uses Python bridge
                    if (node.model && node.model.predict) {
                        prediction = await node.model.predict(preparedInput);
                    } else {
                        throw new Error("TFLite model not properly loaded");
                    }
                } else if (node.modelFormat === "keras") {
                    // Keras uses Python bridge
                    if (node.model && node.model.predict) {
                        prediction = await node.model.predict(preparedInput);
                    } else {
                        throw new Error("Keras model not properly loaded");
                    }
                } else if (node.modelFormat === "sklearn") {
                    // scikit-learn uses Python bridge
                    if (node.model && node.model.predict) {
                        prediction = await node.model.predict(preparedInput);
                    } else {
                        throw new Error("scikit-learn model not properly loaded");
                    }
                } else if (node.modelFormat === "max") {
                    // MAX Engine for high-performance ONNX inference
                    if (node.model && node.model.predict) {
                        prediction = await node.model.predict(preparedInput);
                    } else {
                        throw new Error("MAX model not properly loaded");
                    }
                } else {
                    throw new Error("Unknown model format: " + node.modelFormat);
                }

                const inferenceTime = Date.now() - startTime;

                // ========================================
                // MLflow Tracking - Log Performance Metrics
                // ========================================
                if (node.mlflowTracker && node.mlflowTrackingEnabled) {
                    const metrics = {};

                    // Always log inference time if enabled
                    if (node.mlflowLogInferenceTime) {
                        metrics["inference_time_ms"] = inferenceTime;
                    }

                    // Log prediction statistics if enabled
                    if (node.mlflowLogPredictions && prediction !== null) {
                        if (typeof prediction === "number") {
                            metrics["prediction_value"] = prediction;
                        } else if (Array.isArray(prediction)) {
                            // For array predictions, log statistics
                            const flatPred = prediction.flat(Infinity).filter((v) => typeof v === "number");
                            if (flatPred.length > 0) {
                                metrics["prediction_mean"] = flatPred.reduce((a, b) => a + b, 0) / flatPred.length;
                                metrics["prediction_max"] = Math.max(...flatPred);
                                metrics["prediction_min"] = Math.min(...flatPred);
                            }
                        } else if (typeof prediction === "object" && prediction.score !== undefined) {
                            metrics["prediction_score"] = prediction.score;
                        }
                    }

                    // Log input statistics if enabled
                    if (node.mlflowLogInputStats && preparedInput) {
                        const flatInput = preparedInput.flat(Infinity).filter((v) => typeof v === "number");
                        if (flatInput.length > 0) {
                            metrics["input_mean"] = flatInput.reduce((a, b) => a + b, 0) / flatInput.length;
                            metrics["input_max"] = Math.max(...flatInput);
                            metrics["input_min"] = Math.min(...flatInput);
                            metrics["input_std"] = Math.sqrt(
                                flatInput.reduce((sum, val) => sum + Math.pow(val - metrics["input_mean"], 2), 0) /
                                    flatInput.length
                            );
                        }
                    }

                    // Log anomaly detection if enabled and prediction indicates anomaly
                    if (node.mlflowLogAnomalies) {
                        let isAnomaly = false;
                        let anomalyScore = 0;

                        if (typeof prediction === "number") {
                            // Threshold-based: assume > 0.5 is anomaly
                            isAnomaly = prediction > 0.5;
                            anomalyScore = prediction;
                        } else if (Array.isArray(prediction) && prediction.length >= 2) {
                            // Classification: [normal_prob, anomaly_prob]
                            const flatPred = prediction.flat(Infinity);
                            if (flatPred.length >= 2) {
                                isAnomaly = flatPred[1] > flatPred[0];
                                anomalyScore = flatPred[1];
                            }
                        } else if (typeof prediction === "object") {
                            isAnomaly = prediction.isAnomaly || prediction.anomaly || false;
                            anomalyScore = prediction.score || prediction.anomalyScore || 0;
                        }

                        metrics["is_anomaly"] = isAnomaly ? 1 : 0;
                        metrics["anomaly_score"] = anomalyScore;
                    }

                    // Log all collected metrics
                    if (Object.keys(metrics).length > 0) {
                        node.mlflowTracker.logMetrics(metrics);
                    }
                }

                // Build output message (deep clone: nested outputProperty writes must not mutate the original msg)
                const outputMsg = RED.util.cloneMessage(msg);

                // Set prediction at configured property
                const outputParts = node.outputProperty.split(".");
                let target = outputMsg;
                for (let i = 0; i < outputParts.length - 1; i++) {
                    if (!target[outputParts[i]]) target[outputParts[i]] = {};
                    target = target[outputParts[i]];
                }
                target[outputParts[outputParts.length - 1]] = prediction;

                // Add metadata
                outputMsg.mlInference = {
                    modelPath: node.modelPath,
                    modelFormat: node.modelFormat,
                    inferenceTime: inferenceTime,
                    inputShape: node.inputShape,
                    outputShape: node._lastOutputShape || null,
                    timestamp: Date.now(),
                    mlflowTracking:
                        node.mlflowTrackingEnabled && node.mlflowTracker
                            ? {
                                  experimentName: node.mlflowExperimentName,
                                  runId: node.mlflowTracker.runId
                              }
                            : null
                };

                send(outputMsg);
                done();

                // Update status with inference time
                node.inferenceCount = (node.inferenceCount || 0) + 1;
                node.status({ fill: "green", shape: "dot", text: inferenceTime + "ms | #" + node.inferenceCount });
            } catch (err) {
                node.status({ fill: "red", shape: "dot", text: err.message.substring(0, 30) });
                done(err);

                // Reset status after delay
                setTimeout(function () {
                    if (node.modelLoaded) {
                        node.status({ fill: "green", shape: "dot", text: node.modelFormat + " ready" });
                    }
                }, 3000);
            }
        });

        // Cleanup
        node.on("close", async function (done) {
            // Clear auto-update timer
            if (updateTimer) {
                clearInterval(updateTimer);
                updateTimer = null;
            }

            // ========================================
            // Cleanup MLflow Tracker
            // ========================================
            if (node.mlflowTracker) {
                try {
                    await node.mlflowTracker.endRun("FINISHED");
                    activeTrackers.delete(node.id);
                    node.log("[MLflowTracker] Run ended successfully");
                } catch (trackingErr) {
                    node.warn("[MLflowTracker] Error ending run: " + trackingErr.message);
                }
                node.mlflowTracker = null;
            }

            if (node.model) {
                // Unload from persistent Python bridge if applicable
                if (node.model.usePersistentBridge && node.model.unload) {
                    try {
                        await node.model.unload();
                    } catch (err) {
                        // Ignore unload errors during shutdown
                    }
                }

                if (node.modelFormat === "tfjs" && node.model.dispose) {
                    node.model.dispose();
                }
                // ONNX sessions don't need explicit disposal
                node.model = null;
            }
            node.modelLoaded = false;
            done();
        });

        // Initialize model on startup. local/url load from modelPath; the registry
        // sources (mlflow / huggingface / custom) load by their own identifiers and
        // have no modelPath — initializeModel() self-validates each source, so it is
        // safe to call whenever a remote source is selected.
        const remoteSource =
            node.modelSource === "mlflow" || node.modelSource === "huggingface" || node.modelSource === "custom";
        if (node.modelPath || remoteSource) {
            initializeModel();
        } else {
            node.status({ fill: "grey", shape: "ring", text: "no model configured" });
        }
    }

    RED.nodes.registerType("ml-inference", MLInferenceNode);

    // The editor-facing HTTP surface lives in its own module — see
    // ml-inference-admin.js. Runtime state it needs is injected; the Python
    // bridge is handed over as a getter because it is created lazily and
    // replaced whenever the sidecar exits.
    registerAdminRoutes(RED, {
        MODELS_DIR: MODELS_DIR,
        nodeDir: __dirname,
        loadModelMetadata: loadModelMetadata,
        saveModelMetadata: saveModelMetadata,
        mlflowApiRequest: mlflowApiRequest,
        loadTensorFlowJS: loadTensorFlowJS,
        loadONNXRuntime: loadONNXRuntime,
        getMaxBridge: getMaxBridge,
        getPythonBridgeState: function () {
            return { bridge: pythonBridge, ready: pythonBridgeReady, error: pythonBridgeError };
        }
    });
};
