module.exports = function (RED) {
    "use strict";

    const fs = require("fs");
    const path = require("path");
    const os = require("os");

    // Import persistent Python bridge
    const { getGlobalBridge, shutdownGlobalBridge } = require("./python-bridge-manager");

    // Import MAX Engine bridge
    const { getMaxBridge, shutdownMaxBridge } = require("./max-bridge-manager");
    const registerAdminRoutes = require("./ml-inference-admin");
    const createMlflowClient = require("./ml-inference-mlflow");
    const createModelDownloader = require("./ml-inference-download");

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
    let pythonBridgeErrorAt = 0;
    let pythonBridgeStartPromise = null; // Track pending startup

    // Global MAX Engine bridge instance
    let maxBridge = null;
    let maxBridgeError = null;
    let maxBridgeErrorAt = 0;

    // A bridge that failed to start is not retried on every single message
    // (a local start can take up to 30 s), but it IS retried: after this
    // back-off, and on every deploy. Caching the error for the lifetime of the
    // runtime meant "Python was not installed yet at first deploy" could only
    // be cured by restarting Node-RED.
    const BRIDGE_RETRY_BACKOFF_MS = 30000;

    // Model handles currently loaded into each bridge. A deploy only shuts a
    // bridge down when nothing uses it any more — a partial deploy must not
    // pull the sidecar out from under the nodes it did not touch.
    const pythonBridgeUsers = new Set();
    const maxBridgeUsers = new Set();

    /** Forget a bridge that died or failed to start, so the next request starts a fresh one. */
    function forgetPythonBridge(bridge) {
        if (pythonBridge !== bridge) return;
        pythonBridge = null;
        pythonBridgeReady = false;
        pythonBridgeStartPromise = null;
        // Drops the singleton in python-bridge-manager synchronously.
        shutdownGlobalBridge().catch(function () {});
    }

    /** The running Python bridge, or null — never starts one (used for unload/cleanup). */
    function currentPythonBridge() {
        return pythonBridge && pythonBridgeReady ? pythonBridge : null;
    }

    // Initialize Python bridge on first use; restart it after a crash.
    function ensurePythonBridge() {
        // Already ready - return immediately
        if (pythonBridge && pythonBridgeReady) {
            return Promise.resolve(pythonBridge);
        }

        // Startup in progress - every caller waits for the same attempt
        if (pythonBridgeStartPromise) {
            return pythonBridgeStartPromise;
        }

        // A recent startup failed - don't hammer it
        if (pythonBridgeError && Date.now() - pythonBridgeErrorAt < BRIDGE_RETRY_BACKOFF_MS) {
            return Promise.reject(pythonBridgeError);
        }
        pythonBridgeError = null;

        let bridge;
        try {
            bridge = getGlobalBridge();
        } catch (err) {
            pythonBridgeError = err;
            pythonBridgeErrorAt = Date.now();
            return Promise.reject(err);
        }
        pythonBridge = bridge;
        pythonBridgeReady = false;

        bridge.on("stderr", (msg) => {
            // Log Python stderr for debugging
            if (msg && !msg.includes("FutureWarning") && !msg.includes("DeprecationWarning")) {
                RED.log.debug("[PythonBridge] " + msg);
            }
        });

        // Stray stdout output of a library is noise, not a failure.
        bridge.on("protocolError", (err) => {
            RED.log.debug("[PythonBridge] " + err.message);
        });

        bridge.on("exit", (info) => {
            RED.log.warn("[PythonBridge] Exited: " + JSON.stringify(info));
            // Drop the dead instance: the next request starts a new sidecar,
            // and each model handle reloads itself into it on first use.
            forgetPythonBridge(bridge);
        });

        // One promise that all callers await
        const startPromise = bridge.start().then(
            () => {
                if (pythonBridge === bridge) {
                    pythonBridgeReady = true;
                    RED.log.info("[PythonBridge] Started successfully");
                }
                return bridge;
            },
            (err) => {
                if (pythonBridge === bridge) {
                    pythonBridgeError = err;
                    pythonBridgeErrorAt = Date.now();
                    forgetPythonBridge(bridge);
                }
                throw err;
            }
        );
        pythonBridgeStartPromise = startPromise;
        return startPromise;
    }

    // Initialize MAX Engine bridge
    async function ensureMaxBridge() {
        // Connected (possibly flagged unhealthy by the periodic probe, or with
        // its first health check still under way): let the request decide.
        if (maxBridge) {
            return maxBridge;
        }

        if (maxBridgeError && Date.now() - maxBridgeErrorAt < BRIDGE_RETRY_BACKOFF_MS) {
            throw maxBridgeError;
        }
        maxBridgeError = null;

        const bridge = getMaxBridge({
            serverUrl: process.env.MAX_ENGINE_URL || "http://localhost:8765"
        });
        maxBridge = bridge;

        bridge.on("health", (info) => {
            RED.log.debug("[MaxBridge] Health: " + JSON.stringify(info));
        });

        bridge.on("unhealthy", (err) => {
            RED.log.warn("[MaxBridge] Unhealthy: " + err.message);
        });

        bridge.on("modelLoaded", (info) => {
            RED.log.info("[MaxBridge] Model loaded: " + info.modelId + " (" + info.backend + ")");
        });

        try {
            await bridge.checkHealth();
            bridge.startHealthCheck();
            RED.log.info("[MaxBridge] Connected to MAX Engine server");
        } catch (err) {
            maxBridgeError = err;
            maxBridgeErrorAt = Date.now();
            if (maxBridge === bridge) {
                maxBridge = null;
                // Also detaches the listeners registered above.
                shutdownMaxBridge();
            }
            RED.log.warn("[MaxBridge] Not available: " + err.message);
            throw err;
        }

        return bridge;
    }

    // Bridge housekeeping on every flow stop (deploy or runtime shutdown).
    //
    // Node-RED emits "flows:stopped" for full AND partial deploys, after the
    // affected nodes have closed (and unloaded their models). So:
    //   - a bridge nobody uses any more is shut down — synchronously forgotten
    //     first, so nodes created right after this event start a fresh one
    //     instead of loading into the instance that is on its way out;
    //   - a bridge that still serves nodes untouched by a partial deploy is
    //     left alone;
    //   - cached start errors expire, so a deploy retries a bridge that was
    //     unavailable earlier.
    // The handler stays registered for the lifetime of the runtime. The
    // previous registration is tracked on the event bus itself (each load of
    // this module gets its own RED object, the bus is shared), so re-loading
    // the module — as the test helper does — replaces it instead of stacking.
    const SHUTDOWN_HANDLER_KEY = Symbol.for("node-red-contrib-condition-monitoring.bridgeShutdownHandler");
    if (RED.events[SHUTDOWN_HANDLER_KEY]) {
        RED.events.removeListener("flows:stopped", RED.events[SHUTDOWN_HANDLER_KEY]);
    }
    RED._pythonBridgeShutdownHandler = function () {
        pythonBridgeError = null;
        maxBridgeError = null;

        if (pythonBridge && pythonBridgeUsers.size === 0) {
            pythonBridge = null;
            pythonBridgeReady = false;
            pythonBridgeStartPromise = null;
            shutdownGlobalBridge().then(
                function () {
                    RED.log.info("[PythonBridge] Shutdown complete");
                },
                function (err) {
                    RED.log.warn("[PythonBridge] Shutdown error: " + err.message);
                }
            );
        }

        if (maxBridge && maxBridgeUsers.size === 0) {
            try {
                shutdownMaxBridge();
                RED.log.info("[MaxBridge] Shutdown complete");
            } catch (err) {
                RED.log.warn("[MaxBridge] Shutdown error: " + err.message);
            }
            maxBridge = null;
        }
    };
    RED.events[SHUTDOWN_HANDLER_KEY] = RED._pythonBridgeShutdownHandler;
    RED.events.on("flows:stopped", RED._pythonBridgeShutdownHandler);

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

    // Models shipped inside this package. They are read-only assets: writing a
    // metadata sidecar next to them dirties the install (and the git checkout).
    const BUNDLED_MODELS_DIR = path.join(__dirname, "models");

    function saveModelMetadata(modelPath, metadata) {
        try {
            const metadataPath = getModelMetadataPath(modelPath);
            if (path.resolve(path.dirname(metadataPath)) === BUNDLED_MODELS_DIR) {
                return false;
            }
            const metadataContent = JSON.stringify(metadata, null, 2);
            fs.writeFileSync(metadataPath, metadataContent, "utf8");
            return true;
        } catch (err) {
            return false;
        }
    }

    // MLflow REST helper + metric tracker, and the model download helpers,
    // live in their own modules (ml-inference-mlflow.js, ml-inference-download.js).
    const { mlflowApiRequest, MLflowTracker } = createMlflowClient(RED);
    const {
        downloadFile,
        downloadTfjsModel,
        downloadFromHuggingFace,
        downloadFromMLflow,
        downloadFromCustomRegistry,
        finalizeDownloadedModel
    } = createModelDownloader({ MODELS_DIR: MODELS_DIR, mlflowApiRequest: mlflowApiRequest });

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

        // Lifecycle bookkeeping.
        //  - closed:        set by the close handler; a load that finishes after
        //                   it must release what it loaded instead of installing it.
        //  - loadChain:     model loads run strictly one after another (startup,
        //                   auto-update timer and msg.loadModel can overlap).
        //  - loadsPending:  loads queued or running.
        //  - inflight:      inferences currently running against node.model.
        let closed = false;
        let loadChain = Promise.resolve();
        let loadsPending = 0;
        let inflight = 0;
        let idleWaiters = [];
        let statusResetTimer = null;
        let lastInvalidInputWarning = 0;

        // Auto-update timer (Phase 5)
        let updateTimer = null;
        if (node.autoUpdate && node.updateCheckInterval > 0) {
            updateTimer = setInterval(() => {
                if (
                    node.modelSource === "huggingface" ||
                    node.modelSource === "mlflow" ||
                    node.modelSource === "custom"
                ) {
                    // The previous load/check is still running (slow download,
                    // short interval): don't pile another one on top of it.
                    if (loadsPending > 0) return;
                    if (!node.modelLoaded) {
                        node.status({ fill: "yellow", shape: "dot", text: "checking for updates..." });
                    }
                    // Re-fetch and swap. The model that is serving right now
                    // stays in place until the new one has loaded, and stays
                    // for good if the registry is unreachable.
                    initializeModel({ keepOnFailure: true });
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
                // TF.js can load a public URL natively. With credentials or an
                // integrity pin we have to fetch it ourselves — model.json AND
                // the weight shards it references — and load the local mirror.
                if ((authType && authType !== "none" && authToken) || expectedSha256) {
                    const localModelJson = await downloadTfjsModel(
                        modelPath,
                        authType || "none",
                        authToken || "",
                        expectedSha256
                    );
                    actualPath = "file://" + localModelJson;
                }

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

        /**
         * Load a model into the persistent Python bridge (TFLite/Coral, Keras,
         * scikit-learn — the bridge picks the loader from the file extension).
         *
         * The returned handle heals itself: when the sidecar was restarted (crash,
         * OOM kill, deploy) or lost the model, the next predict() loads it again
         * instead of failing forever with "not loaded".
         */
        async function loadBridgeModel(kind, label, modelPath) {
            const fullPath = resolveLocalModelPath(modelPath);

            if (!fs.existsSync(fullPath)) {
                throw new Error(label + " model file not found: " + fullPath);
            }

            // Get or start the persistent Python bridge
            const bridge = await ensurePythonBridge();

            // Generate a unique model ID for this node
            const modelId = kind + "_" + path.basename(fullPath) + "_" + node.id;

            // The bridge caches by model id. When this node already holds that
            // id (reload / auto-update of the same file name), unload first so
            // the file is actually read again.
            const current = node.model;
            if (current && current.usePersistentBridge && current.modelId === modelId) {
                try {
                    await bridge.unloadModel(modelId);
                } catch (err) {
                    // Not loaded there (any more) — nothing to replace
                }
            }

            // Load model into the persistent bridge
            await bridge.loadModel(fullPath, modelId);
            let loadedInto = bridge;

            const handle = {
                type: kind,
                modelPath: fullPath,
                modelId: modelId,
                usePersistentBridge: true,
                predict: async function (inputData) {
                    const active = await ensurePythonBridge();
                    if (active !== loadedInto) {
                        // New sidecar process: it has never seen this model.
                        await active.loadModel(fullPath, modelId);
                        loadedInto = active;
                    }
                    try {
                        return await active.predict(modelId, inputData);
                    } catch (err) {
                        if (!/not loaded/i.test(String(err && err.message))) throw err;
                        // The bridge dropped the model (cache eviction, remote
                        // replica restart): load once more and retry.
                        await active.loadModel(fullPath, modelId);
                        return active.predict(modelId, inputData);
                    }
                },
                unload: async function () {
                    pythonBridgeUsers.delete(handle);
                    try {
                        // Never start a sidecar just to unload from it.
                        const active = currentPythonBridge();
                        if (active && active === loadedInto) {
                            await active.unloadModel(modelId);
                        }
                    } catch (err) {
                        // Ignore unload errors
                    }
                }
            };
            pythonBridgeUsers.add(handle);
            return handle;
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

            // Same id already held by this node: unload so the server re-reads the file.
            const current = node.model;
            if (current && current.type === "max" && current.modelId === modelId) {
                try {
                    await bridge.unloadModel(modelId);
                } catch (err) {
                    // Not loaded there (any more)
                }
            }

            await bridge.loadModel(containerPath, modelId, "auto");

            const handle = {
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
                    maxBridgeUsers.delete(handle);
                    try {
                        // Only talk to a bridge that exists; don't connect just to unload.
                        if (maxBridge) {
                            await maxBridge.unloadModel(modelId);
                        }
                    } catch (err) {
                        // Ignore unload errors
                    }
                }
            };
            maxBridgeUsers.add(handle);
            return handle;
        }

        /** Resolves once no inference is running against the current model (or after `timeoutMs`). */
        function waitForIdle(timeoutMs) {
            if (inflight === 0) return Promise.resolve();
            return new Promise((resolve) => {
                let timer = null;
                const finish = function () {
                    if (timer) clearTimeout(timer);
                    idleWaiters = idleWaiters.filter((w) => w !== finish);
                    resolve();
                };
                timer = setTimeout(finish, timeoutMs);
                idleWaiters.push(finish);
            });
        }

        /**
         * Free everything a loaded model holds, whatever its format:
         *   - bridge-backed handles (Python bridge AND MAX Engine) are unloaded
         *     from their server, unless `replacedBy` took over the same model id;
         *   - TF.js graph/layers models and SavedModels are disposed;
         *   - ONNX Runtime sessions are released (native memory, not GC-managed).
         * Native handles are only freed once in-flight inferences have drained.
         */
        async function releaseModel(model, format, replacedBy) {
            if (!model) return;
            try {
                if (typeof model.unload === "function") {
                    const sameSlot =
                        replacedBy && replacedBy.modelId === model.modelId && replacedBy.type === model.type;
                    if (sameSlot) {
                        // The new handle already replaced it on the server.
                        pythonBridgeUsers.delete(model);
                        maxBridgeUsers.delete(model);
                    } else {
                        await model.unload();
                    }
                } else if (format === "tfjs" || format === "savedmodel") {
                    await waitForIdle(5000);
                    if (typeof model.dispose === "function") model.dispose();
                } else if (format === "onnx") {
                    await waitForIdle(5000);
                    if (typeof model.release === "function") await model.release();
                }
            } catch (err) {
                node.warn("Error disposing previous model: " + err.message);
            }
        }

        // Dispose/unload the currently loaded model.
        async function disposeCurrentModel() {
            if (!node.model) return;
            const old = node.model;
            const oldFormat = node.modelFormat;
            node.model = null;
            node.modelLoaded = false;
            await releaseModel(old, oldFormat);
        }

        /** Load `actualModelPath` as `modelType`. Touches no node state. */
        async function loadByType(modelType, actualModelPath, authType, authToken) {
            if (modelType === "tfjs" || modelType === "savedmodel") {
                // (SavedModels go through the TF.js loader as well.)
                const model = await loadTFJSModel(actualModelPath, authType, authToken, node.modelSha256);

                // Warmup run
                if (modelType === "tfjs" && node.warmup && model.predict) {
                    const shape = parseShape(node.inputShape) || [1, 1];
                    const tensorflow = loadTensorFlowJS();
                    const dummyInput = tensorflow.zeros(shape);
                    try {
                        const result = model.predict(dummyInput);
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
                return { model: model, inputNames: [], outputNames: [] };
            }
            if (modelType === "onnx") {
                const session = await loadONNXModel(actualModelPath, authType, authToken, node.modelSha256);
                return {
                    model: session,
                    inputNames: session.inputNames || [],
                    outputNames: session.outputNames || []
                };
            }
            if (modelType === "coral" || modelType === "tflite") {
                // TFLite models use Coral/Python bridge for inference
                return { model: await loadBridgeModel("tflite", "TFLite", actualModelPath) };
            }
            if (modelType === "keras") {
                // Keras models (.keras, .h5) use Python bridge
                return { model: await loadBridgeModel("keras", "Keras", actualModelPath) };
            }
            if (modelType === "sklearn") {
                // scikit-learn models (.pkl, .joblib) use Python bridge
                return { model: await loadBridgeModel("sklearn", "scikit-learn", actualModelPath) };
            }
            if (modelType === "max") {
                // ONNX models via MAX Engine (high-performance)
                return { model: await loadMaxModel(actualModelPath) };
            }
            throw new Error("Unknown model type: " + modelType);
        }

        /** Characters that are safe in a cache file name. */
        function cacheSafe(value) {
            return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
        }

        /**
         * (Re)load the configured model.
         *
         * Loads are serialised per node, and the new model is loaded BEFORE the
         * current one is released, then swapped in atomically — inference keeps
         * running on the old model in the meantime.
         *
         * @param {Object}  [options]
         * @param {boolean} [options.keepOnFailure=false]  When the load fails, keep
         *        serving the model that is loaded now (auto-update). Otherwise a
         *        failed load leaves the node without a model and in error state
         *        (startup, explicit msg.loadModel).
         * @returns {Promise<void>} never rejects
         */
        function initializeModel(options) {
            loadsPending++;
            const run = function () {
                return doInitializeModel(options || {})
                    .catch(function (err) {
                        // doInitializeModel reports its own failures; this is a last resort.
                        node.error("Failed to load model: " + (err && err.message));
                    })
                    .then(function () {
                        loadsPending--;
                    });
            };
            loadChain = loadChain.then(run, run);
            return loadChain;
        }

        async function doInitializeModel(options) {
            if (closed) return;

            // Check if model source is configured
            let notConfigured = null;
            if (node.modelSource === "huggingface" && !node.hfModelId) {
                notConfigured = "no Hugging Face model ID";
            } else if (node.modelSource === "mlflow" && !node.mlflowModelName) {
                notConfigured = "no MLflow model name";
            } else if (node.modelSource === "custom" && !node.customModelId) {
                notConfigured = "no custom model ID";
            } else if ((node.modelSource === "local" || node.modelSource === "url") && !node.modelPath) {
                notConfigured = "no model configured";
            }
            if (notConfigured) {
                await disposeCurrentModel();
                node.status({ fill: "grey", shape: "ring", text: notConfigured });
                return;
            }

            const keepOnFailure = options.keepOnFailure === true && node.modelLoaded && !!node.model;
            let loaded = null;
            let loadedType = null;
            let installed = false;

            try {
                if (!keepOnFailure) {
                    node.status({ fill: "yellow", shape: "dot", text: "loading model..." });
                }

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
                    const cacheBase = path.join(cacheDir, cacheSafe(node.hfModelId) + "_" + cacheSafe(node.hfRevision));

                    actualModelPath = await downloadFromHuggingFace(
                        node.hfModelId,
                        node.hfRevision,
                        node.hfToken,
                        cacheBase,
                        node.modelSha256
                    );

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
                    const cachePath = path.join(
                        cacheDir,
                        cacheSafe(node.mlflowModelName) + "_" + cacheSafe(node.mlflowVersion) + ".model"
                    );

                    await downloadFromMLflow(
                        node.mlflowRegistryUri,
                        node.mlflowModelName,
                        node.mlflowVersion,
                        node.mlflowStage,
                        node.mlflowAuthToken,
                        cachePath,
                        node.modelSha256
                    );
                    actualModelPath = finalizeDownloadedModel(cachePath, node.modelType);

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
                    const cachePath = path.join(cacheDir, cacheSafe(node.customModelId) + ".model");

                    await downloadFromCustomRegistry(
                        node.customRegistryUrl,
                        node.customModelId,
                        node.customApiKey,
                        cachePath,
                        node.modelSha256
                    );
                    actualModelPath = finalizeDownloadedModel(cachePath, node.modelType);

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

                // Registry artifacts were fetched (and verified) above; from here
                // on they are local files and are loaded from the cache path.
                loadedType = modelType;
                loaded = await loadByType(modelType, actualModelPath, authType, authToken);

                if (closed) {
                    // The node was closed (redeploy) while the model was loading.
                    await releaseModel(loaded.model, modelType);
                    return;
                }

                // Swap: from this statement on, new messages use the new model.
                const previous = node.model;
                const previousFormat = node.modelFormat;
                node.model = loaded.model;
                node.modelFormat = modelType;
                node.inputNames = loaded.inputNames || [];
                node.outputNames = loaded.outputNames || [];
                node.modelLoaded = true;
                node.loadError = null;
                installed = true;
                node.status({ fill: "green", shape: "dot", text: modelType + " ready" });

                if (previous && previous !== loaded.model) {
                    await releaseModel(previous, previousFormat, loaded.model);
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
                if (node.mlflowTrackingEnabled && node.mlflowTrackingUri && !closed) {
                    try {
                        // Clean up existing tracker if any
                        if (node.mlflowTracker) {
                            await node.mlflowTracker.endRun("FINISHED");
                        }

                        // Create new tracker
                        const tracker = new MLflowTracker(
                            node.mlflowTrackingUri,
                            node.mlflowExperimentName,
                            node.mlflowAuthToken
                        );
                        tracker.bufferSize = node.mlflowBatchSize;
                        node.mlflowTracker = tracker;

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

                        await tracker.startRun(node.mlflowRunName || node.name || node.id, runTags);

                        // Log initial parameters
                        await tracker.logParams({
                            model_path: actualModelPath,
                            model_type: modelType,
                            input_shape: node.inputShape || "auto",
                            preprocess_mode: node.preprocessMode
                        });

                        if (closed) {
                            // Closed while the run was being created: the close
                            // handler has already run, so end it here.
                            await tracker.endRun("FINISHED");
                            if (node.mlflowTracker === tracker) node.mlflowTracker = null;
                        } else {
                            node.log("[MLflowTracker] Started tracking run: " + tracker.runId);
                        }
                    } catch (trackingErr) {
                        node.warn("[MLflowTracker] Failed to initialize tracking: " + trackingErr.message);
                        node.mlflowTracker = null;
                    }
                }
            } catch (err) {
                if (installed) {
                    // The model itself is in place; only bookkeeping failed.
                    node.warn("Model loaded, but post-load bookkeeping failed: " + err.message);
                    return;
                }
                if (loaded && loaded.model) {
                    await releaseModel(loaded.model, loadedType);
                }
                if (closed) return;

                if (keepOnFailure && node.model) {
                    // Auto-update: the registry is unreachable or served a bad
                    // artifact. The current model keeps serving.
                    node.warn("Model update failed, keeping the loaded model: " + err.message);
                    node.status({ fill: "green", shape: "dot", text: node.modelFormat + " ready" });
                    return;
                }

                await disposeCurrentModel();
                node.loadError = err;
                node.modelLoaded = false;
                node.status({ fill: "red", shape: "ring", text: err.message.substring(0, 30) });
                node.error("Failed to load model: " + err.message);
            }
        }

        // Prepare input data.
        //
        // Values that are not numbers (null, NaN, "n/a" — a sensor dropout) are
        // still fed to the model as 0, as they always were, but they are counted
        // in `stats.invalid` so the caller can flag the prediction instead of
        // presenting fabricated zeros as a clean measurement.
        function prepareInput(data, preprocessMode, stats) {
            const toNumber = function (v) {
                const n = typeof v === "number" ? v : parseFloat(v);
                if (Number.isNaN(n)) {
                    if (stats) stats.invalid++;
                    return 0;
                }
                return n;
            };
            let inputArray;

            if (Array.isArray(data)) {
                inputArray = data.flat(Infinity).map(toNumber);
            } else if (typeof data === "object" && data !== null) {
                if (preprocessMode === "object") {
                    // Extract values from object
                    inputArray = Object.values(data).map(toNumber);
                } else {
                    // Try to get array from common properties
                    inputArray = data.features || data.values || data.input || Object.values(data);
                    inputArray = inputArray.flat(Infinity).map(toNumber);
                }
            } else if (typeof data === "number") {
                inputArray = [toNumber(data)];
            } else {
                throw new Error("Input data must be a number, array, or object");
            }

            return inputArray;
        }

        // Run TFJS inference
        async function runTFJSInference(inputData, model) {
            const tensorflow = loadTensorFlowJS();
            const shape = parseShape(node.inputShape);

            let inputTensor;
            if (shape) {
                inputTensor = tensorflow.tensor(inputData, shape);
            } else {
                inputTensor = tensorflow.tensor([inputData]);
            }

            try {
                const result = model.predict(inputTensor);
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
        async function runONNXInference(inputData, model, inputNames, outputNames) {
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
            const inputName = inputNames[0] || "input";
            const inputTensor = new onnxruntime.Tensor("float32", flatData, shape);

            const feeds = {};
            feeds[inputName] = inputTensor;

            const results = await model.run(feeds);

            // Extract output
            const outputName = outputNames[0] || Object.keys(results)[0];
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

            let counted = false;
            try {
                // Check if this is a model load/reload command
                if (msg.loadModel) {
                    if (typeof msg.loadModel !== "string") {
                        throw new Error("msg.loadModel must be a model path (string)");
                    }
                    node.modelPath = msg.loadModel;
                    // Loads are serialised; the previous model is released once
                    // the new one is in place (or the load has failed).
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
                const inputStats = { invalid: 0 };
                const preparedInput = prepareInput(inputData, node.preprocessMode, inputStats);
                if (inputStats.invalid > 0 && Date.now() - lastInvalidInputWarning > 60000) {
                    // Throttled: a dead sensor would otherwise warn on every sample.
                    lastInvalidInputWarning = Date.now();
                    node.warn(
                        inputStats.invalid +
                            " non-numeric input value(s) were replaced by 0 — see msg.mlInference.invalidInputs"
                    );
                }

                // Pin the model for this inference: a reload may swap node.model
                // while we await, and format, model and tensor names must match.
                const model = node.model;
                const modelFormat = node.modelFormat;
                const inputNames = node.inputNames;
                const outputNames = node.outputNames;
                inflight++;
                counted = true;

                // Run inference
                node.status({ fill: "blue", shape: "dot", text: "inferencing..." });
                let prediction;
                const startTime = Date.now();

                if (modelFormat === "tfjs" || modelFormat === "savedmodel") {
                    prediction = await runTFJSInference(preparedInput, model);
                } else if (modelFormat === "onnx") {
                    prediction = await runONNXInference(preparedInput, model, inputNames, outputNames);
                } else if (modelFormat === "tflite" || modelFormat === "coral") {
                    // TFLite/Coral uses Python bridge
                    if (model && model.predict) {
                        prediction = await model.predict(preparedInput);
                    } else {
                        throw new Error("TFLite model not properly loaded");
                    }
                } else if (modelFormat === "keras") {
                    // Keras uses Python bridge
                    if (model && model.predict) {
                        prediction = await model.predict(preparedInput);
                    } else {
                        throw new Error("Keras model not properly loaded");
                    }
                } else if (modelFormat === "sklearn") {
                    // scikit-learn uses Python bridge
                    if (model && model.predict) {
                        prediction = await model.predict(preparedInput);
                    } else {
                        throw new Error("scikit-learn model not properly loaded");
                    }
                } else if (modelFormat === "max") {
                    // MAX Engine for high-performance ONNX inference
                    if (model && model.predict) {
                        prediction = await model.predict(preparedInput);
                    } else {
                        throw new Error("MAX model not properly loaded");
                    }
                } else {
                    throw new Error("Unknown model format: " + modelFormat);
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
                    modelFormat: modelFormat,
                    inferenceTime: inferenceTime,
                    // Input values that were not numbers and went in as 0.
                    invalidInputs: inputStats.invalid,
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
                node.status({ fill: "red", shape: "dot", text: String(err.message).substring(0, 30) });
                done(err);

                // Reset status after delay (one pending reset at a time, and
                // none that outlives the node)
                if (statusResetTimer) clearTimeout(statusResetTimer);
                statusResetTimer = setTimeout(function () {
                    statusResetTimer = null;
                    if (!closed && node.modelLoaded) {
                        node.status({ fill: "green", shape: "dot", text: node.modelFormat + " ready" });
                    }
                }, 3000);
            } finally {
                if (counted) {
                    inflight--;
                    if (inflight === 0 && idleWaiters.length > 0) {
                        idleWaiters.slice().forEach((wake) => wake());
                    }
                }
            }
        });

        // Cleanup
        node.on("close", async function (done) {
            // From here on a load that is still in flight releases whatever
            // it loaded instead of installing it on a closed node.
            closed = true;

            // Clear timers
            if (updateTimer) {
                clearInterval(updateTimer);
                updateTimer = null;
            }
            if (statusResetTimer) {
                clearTimeout(statusResetTimer);
                statusResetTimer = null;
            }

            // ========================================
            // Cleanup MLflow Tracker
            // ========================================
            if (node.mlflowTracker) {
                const tracker = node.mlflowTracker;
                node.mlflowTracker = null;
                try {
                    // Best effort and bounded: an unreachable tracking server
                    // must not run every deploy into Node-RED's close timeout.
                    let giveUp = null;
                    const ended = await Promise.race([
                        tracker.endRun("FINISHED").then(() => true),
                        new Promise((resolve) => {
                            giveUp = setTimeout(() => resolve(false), 5000);
                        })
                    ]);
                    clearTimeout(giveUp);
                    if (ended) {
                        node.log("[MLflowTracker] Run ended successfully");
                    } else {
                        node.warn("[MLflowTracker] Tracking server did not answer in time; run left open");
                    }
                } catch (trackingErr) {
                    node.warn("[MLflowTracker] Error ending run: " + trackingErr.message);
                }
            }

            // Release the model: bridge handles (Python and MAX) are unloaded,
            // TF.js models/SavedModels disposed, ONNX sessions released.
            const model = node.model;
            const modelFormat = node.modelFormat;
            node.model = null;
            node.modelLoaded = false;
            try {
                await releaseModel(model, modelFormat);
            } catch (err) {
                // Ignore release errors during shutdown
            }
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
