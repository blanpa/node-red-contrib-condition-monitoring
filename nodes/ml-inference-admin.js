/**
 * ml-inference admin routes
 * =========================
 *
 * Every `RED.httpAdmin` route the ml-inference node exposes: runtime probing,
 * the model store (list / upload / delete), and the model-registry proxies.
 *
 * Split out of `ml-inference.js`, which had grown past 2600 lines with ~575 of
 * them being HTTP surface that has nothing to do with running inference. Keeping
 * the routes in one file makes the security posture reviewable at a glance —
 * every registration below must carry a `needsPermission()` guard, and every
 * request-supplied file name must go through `safeChildPath()`.
 *
 * The node module owns the runtime state (model dir, bridges, metadata I/O), so
 * it is injected rather than re-derived here.
 *
 * @module ml-inference-admin
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { needsPermission } = require("./utils/admin-auth");
const { assertPath } = require("./utils/path-validator");

/**
 * @param {Object} RED   The Node-RED runtime.
 * @param {Object} deps  Runtime state owned by ml-inference.js:
 *   @param {string}   deps.MODELS_DIR
 *   @param {Function} deps.loadModelMetadata
 *   @param {Function} deps.saveModelMetadata
 *   @param {Function} deps.mlflowApiRequest
 *   @param {Function} deps.loadTensorFlowJS
 *   @param {Function} deps.loadONNXRuntime
 *   @param {Function} deps.getMaxBridge
 *   @param {Function} deps.getPythonBridgeState  Returns { bridge, ready, error };
 *          a getter, not a value — the bridge is created lazily and replaced on exit.
 *   @param {string}   deps.nodeDir  Directory holding model-catalog.json.
 */
module.exports = function registerAdminRoutes(RED, deps) {
    const MODELS_DIR = deps.MODELS_DIR;
    const loadModelMetadata = deps.loadModelMetadata;
    const saveModelMetadata = deps.saveModelMetadata;
    const mlflowApiRequest = deps.mlflowApiRequest;
    const loadTensorFlowJS = deps.loadTensorFlowJS;
    const loadONNXRuntime = deps.loadONNXRuntime;
    const getMaxBridge = deps.getMaxBridge;
    const getPythonBridgeState = deps.getPythonBridgeState;
    const nodeDir = deps.nodeDir;

    // Curated pretrained-model catalog (common use cases). Bundled entries are
    // exposed with a RELATIVE "models/<file>" path — the loader's allowlist already
    // includes path.join(__dirname, "models"), so the absolute server path never
    // needs to leave the server (avoids disclosing the install path to editor clients).
    RED.httpAdmin.get("/ml-inference/model-catalog", needsPermission(RED, "ml-inference.read"), function (req, res) {
        try {
            const cat = JSON.parse(fs.readFileSync(path.join(nodeDir, "model-catalog.json"), "utf8"));
            (cat.models || []).forEach(function (m) {
                if (m.source === "bundled" && m.file) m.resolvedPath = "models/" + m.file;
            });
            res.json(cat);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // API endpoint for model info
    RED.httpAdmin.get("/ml-inference/runtimes", needsPermission(RED, "ml-inference.read"), function (req, res) {
        const runtimes = {
            tfjs: loadTensorFlowJS() !== null,
            onnx: loadONNXRuntime() !== null
        };
        res.json(runtimes);
    });

    // API endpoint to check Python bridge status
    RED.httpAdmin.get(
        "/ml-inference/python-bridge",
        needsPermission(RED, "ml-inference.read"),
        async function (req, res) {
            try {
                const {
                    bridge: pythonBridge,
                    ready: pythonBridgeReady,
                    error: pythonBridgeError
                } = getPythonBridgeState();
                if (pythonBridge && pythonBridgeReady) {
                    const status = await pythonBridge.getStatus();
                    const stats = pythonBridge.getStats();
                    res.json({
                        available: true,
                        mode: "persistent",
                        ...status,
                        stats: stats
                    });
                } else {
                    res.json({
                        available: false,
                        mode: "none",
                        reason: pythonBridgeError ? pythonBridgeError.message : "Not started"
                    });
                }
            } catch (err) {
                res.json({
                    available: false,
                    mode: "none",
                    error: err.message
                });
            }
        }
    );

    // API endpoint to check Python availability
    RED.httpAdmin.get("/ml-inference/python-status", needsPermission(RED, "ml-inference.read"), function (req, res) {
        const { spawn } = require("child_process");
        const pythonCandidates = ["python3", "python"];

        function checkPython(candidates, index) {
            if (index >= candidates.length) {
                res.json({ available: false, version: null, packages: [] });
                return;
            }

            const proc = spawn(candidates[index], ["-c", "import sys; print(sys.version.split()[0])"], {
                stdio: ["pipe", "pipe", "pipe"],
                timeout: 5000
            });

            let stdout = "";
            proc.stdout.on("data", (data) => {
                stdout += data.toString();
            });

            proc.on("close", (code) => {
                if (code === 0 && stdout.trim()) {
                    // Check for ML packages
                    const checkPackages = spawn(
                        candidates[index],
                        [
                            "-c",
                            `
    import json
    packages = []
    try:
    import sklearn; packages.append('sklearn')
    except: pass
    try:
    import tensorflow; packages.append('tensorflow')
    except: pass
    try:
    import tflite_runtime; packages.append('tflite')
    except: pass
    print(json.dumps(packages))
    `
                        ],
                        { stdio: ["pipe", "pipe", "pipe"], timeout: 10000 }
                    );

                    let pkgOut = "";
                    checkPackages.stdout.on("data", (data) => {
                        pkgOut += data.toString();
                    });

                    // Safety kill if process hangs beyond timeout
                    const pkgKillTimer = setTimeout(() => {
                        if (!checkPackages.killed) checkPackages.kill();
                    }, 12000);

                    checkPackages.on("close", () => {
                        clearTimeout(pkgKillTimer);
                        let packages = [];
                        try {
                            packages = JSON.parse(pkgOut.trim());
                        } catch (e) {}
                        res.json({
                            available: true,
                            version: stdout.trim(),
                            python: candidates[index],
                            packages: packages
                        });
                    });

                    checkPackages.on("error", () => {
                        clearTimeout(pkgKillTimer);
                        res.json({ available: true, version: stdout.trim(), python: candidates[index], packages: [] });
                    });
                } else {
                    checkPython(candidates, index + 1);
                }
            });

            proc.on("error", () => {
                checkPython(candidates, index + 1);
            });
        }

        checkPython(pythonCandidates, 0);
    });

    // API endpoint to check MAX Engine availability
    RED.httpAdmin.get("/ml-inference/max-status", needsPermission(RED, "ml-inference.read"), async function (req, res) {
        try {
            const bridge = getMaxBridge({
                serverUrl: process.env.MAX_ENGINE_URL || "http://localhost:8765"
            });

            const status = await bridge.getStatus();
            res.json({
                available: true,
                backend: status.backend,
                max_available: status.max_available,
                onnx_available: status.onnx_available,
                models_loaded: status.models,
                stats: status.stats
            });
        } catch (err) {
            res.json({
                available: false,
                error: err.message
            });
        }
    });

    // API endpoint to check Coral TPU availability
    RED.httpAdmin.get("/ml-inference/coral-status", needsPermission(RED, "ml-inference.read"), function (req, res) {
        const { spawn } = require("child_process");
        const proc = spawn(
            "python3",
            ["-c", "from pycoral.utils.edgetpu import list_edge_tpus; print(len(list_edge_tpus()))"],
            {
                stdio: ["pipe", "pipe", "pipe"],
                timeout: 5000
            }
        );

        let stdout = "";
        proc.stdout.on("data", (data) => {
            stdout += data.toString();
        });

        proc.on("close", () => {
            const count = parseInt(stdout.trim()) || 0;
            res.json({ available: count > 0, count: count });
        });

        proc.on("error", () => {
            res.json({ available: false, count: 0 });
        });
    });

    // Ensure models directory exists
    function ensureModelsDir() {
        if (!fs.existsSync(MODELS_DIR)) {
            fs.mkdirSync(MODELS_DIR, { recursive: true });
        }
        return MODELS_DIR;
    }

    // Upload ceiling for the model-upload endpoints. Both handlers buffer the
    // whole request body in memory, so an unbounded request is a trivial OOM.
    // Override via `mlInferenceMaxUploadBytes` in settings.js.
    const MAX_UPLOAD_BYTES = (function () {
        const n = parseInt(RED.settings && RED.settings.mlInferenceMaxUploadBytes, 10);
        return Number.isFinite(n) && n > 0 ? n : 128 * 1024 * 1024;
    })();

    /**
     * Hand `onBody(buffer)` the request body, capped at MAX_UPLOAD_BYTES.
     *
     * Node-RED mounts body parsers on the admin router, so by the time a route
     * handler runs the stream may already be drained — waiting on `data`/`end`
     * would then hang the request forever (that is exactly what the JSON
     * upload-tfjs route used to do). Prefer whatever the parser produced and
     * only fall back to streaming when nothing did.
     *
     * Over-sized and errored requests are answered here and never reach the
     * caller.
     */
    function readLimitedBody(req, res, onBody) {
        const tooBig = function (size) {
            if (size <= MAX_UPLOAD_BYTES) return false;
            res.status(413).json({ error: "Upload exceeds the " + MAX_UPLOAD_BYTES + " byte limit" });
            return true;
        };

        const parsed = req.body;
        if (Buffer.isBuffer(parsed)) {
            if (!tooBig(parsed.length)) onBody(parsed);
            return;
        }
        if (typeof parsed === "string" && parsed.length > 0) {
            const buf = Buffer.from(parsed);
            if (!tooBig(buf.length)) onBody(buf);
            return;
        }
        if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
            const buf = Buffer.from(JSON.stringify(parsed));
            if (!tooBig(buf.length)) onBody(buf);
            return;
        }
        if (req.complete || req.readableEnded) {
            // Stream already drained and the parser produced nothing usable.
            onBody(Buffer.alloc(0));
            return;
        }

        const chunks = [];
        let received = 0;
        let settled = false;

        req.on("data", function (chunk) {
            if (settled) return;
            received += chunk.length;
            if (received > MAX_UPLOAD_BYTES) {
                settled = true;
                chunks.length = 0;
                tooBig(received);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", function () {
            if (settled) return;
            settled = true;
            onBody(Buffer.concat(chunks));
        });
        req.on("error", function (err) {
            if (settled) return;
            settled = true;
            res.status(400).json({ error: err.message });
        });
    }

    /** 400 for a rejected path/parameter, 500 for anything genuinely unexpected. */
    function respondError(res, err) {
        const status = err && err.code === "EPATHFORBIDDEN" ? 400 : 500;
        res.status(status).json({ error: err.message });
    }

    /** Allowlist bases for `dir`, including its realpath when it is a symlink. */
    function allowedBasesFor(dir) {
        const bases = [dir];
        try {
            if (fs.existsSync(dir)) {
                const real = fs.realpathSync(dir);
                if (real !== dir) bases.push(real);
            }
        } catch (e) {
            // Non-fatal: the lexical base below is still enforced.
        }
        return bases;
    }

    /**
     * Turn an untrusted file name into a path inside `dir`.
     *
     * SECURITY: the name can come straight from a request body (the TF.js
     * weight-shard names do) or a route parameter, so this is a boundary, not
     * cosmetics — a bare `path.join(dir, name)` lets `../../` escape. Strip
     * every directory component, restrict the charset, then re-validate the
     * join through the shared path validator.
     *
     * @throws {Error} code EPATHFORBIDDEN when the name cannot be made safe.
     */
    function safeChildPath(dir, name) {
        const raw = String(name === null || name === undefined ? "" : name).trim();
        const safeName = path.basename(raw).replace(/[^a-zA-Z0-9._-]/g, "_");
        if (!safeName || /^\.+$/.test(safeName)) {
            const err = new Error("unsafe file name: " + raw);
            err.code = "EPATHFORBIDDEN";
            throw err;
        }
        return {
            safeName: safeName,
            filePath: assertPath(path.join(dir, safeName), { allowedBases: allowedBasesFor(dir) })
        };
    }

    // API endpoint to list uploaded models
    RED.httpAdmin.get("/ml-inference/models", needsPermission(RED, "ml-inference.read"), function (req, res) {
        try {
            ensureModelsDir();
            const files = fs.readdirSync(MODELS_DIR);
            const fileModels = files
                .filter((f) => {
                    const filePath = path.join(MODELS_DIR, f);
                    if (!fs.existsSync(filePath)) return false;
                    const stats = fs.statSync(filePath);
                    if (stats.isDirectory()) return false;
                    const ext = path.extname(f).toLowerCase();
                    return ext === ".onnx" || ext === ".json" || ext === ".tflite";
                })
                .map((f) => {
                    const filePath = path.join(MODELS_DIR, f);
                    const stats = fs.statSync(filePath);
                    const metadata = loadModelMetadata(filePath);
                    const ext = path.extname(f).toLowerCase();
                    return {
                        name: f,
                        path: filePath,
                        size: stats.size,
                        modified: stats.mtime,
                        type: ext === ".onnx" ? "onnx" : ext === ".tflite" ? "tflite" : "tfjs",
                        version: metadata?.version || "1.0.0",
                        metadata: metadata || null
                    };
                });

            // Also include directories (for TFJS models)
            const dirModels = files
                .filter((f) => {
                    const dirPath = path.join(MODELS_DIR, f);
                    if (!fs.existsSync(dirPath)) return false;
                    return fs.statSync(dirPath).isDirectory();
                })
                .map((d) => {
                    const dirPath = path.join(MODELS_DIR, d);
                    const modelJsonPath = path.join(dirPath, "model.json");
                    const metadata = fs.existsSync(modelJsonPath) ? loadModelMetadata(modelJsonPath) : null;
                    return {
                        name: d,
                        path: dirPath,
                        type: "tfjs",
                        version: metadata?.version || "1.0.0",
                        metadata: metadata || null
                    };
                });

            res.json({ models: [...fileModels, ...dirModels], modelsDir: MODELS_DIR });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // API endpoint to upload a model
    RED.httpAdmin.post("/ml-inference/upload", needsPermission(RED, "ml-inference.write"), function (req, res) {
        try {
            ensureModelsDir();

            readLimitedBody(req, res, function (buffer) {
                try {
                    const filename = req.headers["x-filename"] || "model_" + Date.now() + ".onnx";
                    const resolved = safeChildPath(MODELS_DIR, filename);
                    const safeName = resolved.safeName;
                    const filePath = resolved.filePath;

                    fs.writeFileSync(filePath, buffer);

                    // Create initial metadata
                    const metadata = {
                        name: safeName,
                        version: "1.0.0",
                        type: path.extname(safeName).toLowerCase() === ".onnx" ? "onnx" : "tflite",
                        path: filePath,
                        source: "local",
                        format: path.extname(safeName).toLowerCase() === ".onnx" ? "onnx" : "tflite",
                        uploaded: new Date().toISOString(),
                        size: buffer.length,
                        metadata: {}
                    };
                    saveModelMetadata(filePath, metadata);

                    res.json({
                        success: true,
                        path: filePath,
                        name: safeName,
                        size: buffer.length,
                        metadata: metadata
                    });
                } catch (err) {
                    respondError(res, err);
                }
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // API endpoint to upload TensorFlow.js model (multiple files)
    RED.httpAdmin.post("/ml-inference/upload-tfjs", needsPermission(RED, "ml-inference.write"), function (req, res) {
        try {
            ensureModelsDir();

            readLimitedBody(req, res, function (buffer) {
                try {
                    const data = JSON.parse(buffer.toString());

                    // Create a subdirectory for the TFJS model
                    const modelName = data.name || "tfjs_model_" + Date.now();
                    const dirResolved = safeChildPath(MODELS_DIR, modelName);
                    const safeName = dirResolved.safeName;
                    const modelDir = dirResolved.filePath;

                    if (!fs.existsSync(modelDir)) {
                        fs.mkdirSync(modelDir, { recursive: true });
                    }

                    // Save model.json
                    const modelJsonPath = path.join(modelDir, "model.json");
                    fs.writeFileSync(modelJsonPath, data.modelJson);

                    // Save weight files. `w.name` is attacker-controlled JSON —
                    // it must go through safeChildPath, never a bare path.join.
                    if (data.weights && Array.isArray(data.weights)) {
                        data.weights.forEach((w) => {
                            const weightPath = safeChildPath(modelDir, w && w.name).filePath;
                            const weightBuffer = Buffer.from((w && w.data) || "", "base64");
                            fs.writeFileSync(weightPath, weightBuffer);
                        });
                    }

                    // Create initial metadata
                    const metadata = {
                        name: safeName,
                        version: "1.0.0",
                        type: "tfjs",
                        path: modelDir,
                        source: "local",
                        format: "tfjs",
                        uploaded: new Date().toISOString(),
                        metadata: {}
                    };
                    saveModelMetadata(path.join(modelDir, "model.json"), metadata);

                    res.json({
                        success: true,
                        path: modelDir,
                        name: safeName,
                        metadata: metadata
                    });
                } catch (err) {
                    respondError(res, err);
                }
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // API endpoint to delete a model
    RED.httpAdmin.delete("/ml-inference/models/:name", needsPermission(RED, "ml-inference.write"), function (req, res) {
        try {
            const modelPath = safeChildPath(MODELS_DIR, req.params.name).filePath;

            if (!fs.existsSync(modelPath)) {
                return res.status(404).json({ error: "Model not found" });
            }

            const stats = fs.statSync(modelPath);
            if (stats.isDirectory()) {
                // Delete directory recursively
                fs.rmSync(modelPath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(modelPath);
            }

            res.json({ success: true });
        } catch (err) {
            respondError(res, err);
        }
    });

    // Registry API Endpoints (Phase 2-4)

    // List available registries
    RED.httpAdmin.get("/ml-inference/registries", needsPermission(RED, "ml-inference.read"), function (req, res) {
        res.json({
            registries: [
                { id: "huggingface", name: "Hugging Face Hub", enabled: true },
                { id: "mlflow", name: "MLflow Registry", enabled: true },
                { id: "custom", name: "Custom Registry", enabled: true }
            ]
        });
    });

    // Get models from MLflow Registry
    /**
     * Validate an operator-supplied registry base URL before the server fetches it.
     *
     * SECURITY: the admin route below hands this URL to the runtime's own HTTP
     * client, which turns the editor port into a request proxy if the input is
     * unchecked. The route is admin-authenticated, so this is defence in depth —
     * but it still blocks non-HTTP schemes and URL-embedded credentials, and it
     * honours an optional host allowlist (`mlInferenceAllowedRegistryHosts` in
     * settings.js) for deployments that want to pin the registry.
     *
     * @throws {Error} code EPATHFORBIDDEN
     */
    function assertRegistryUrl(rawUri) {
        const reject = (message) => {
            const err = new Error(message);
            err.code = "EPATHFORBIDDEN";
            return err;
        };

        let url;
        try {
            url = new URL(String(rawUri));
        } catch (e) {
            throw reject("registryUri is not a valid URL");
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw reject("registryUri must use http or https, got " + url.protocol);
        }
        if (url.username || url.password) {
            throw reject("registryUri must not embed credentials");
        }

        const allowlist = RED.settings && RED.settings.mlInferenceAllowedRegistryHosts;
        if (Array.isArray(allowlist) && allowlist.length > 0) {
            const host = url.hostname.toLowerCase();
            const permitted = allowlist.some(function (h) {
                return typeof h === "string" && h.trim().toLowerCase() === host;
            });
            if (!permitted) {
                throw reject("registry host is not in mlInferenceAllowedRegistryHosts: " + host);
            }
        }
        return url;
    }

    RED.httpAdmin.get(
        "/ml-inference/registries/mlflow/models",
        needsPermission(RED, "ml-inference.read"),
        async function (req, res) {
            const registryUri = req.query.registryUri;
            if (!registryUri) {
                return res.status(400).json({ error: "registryUri parameter required" });
            }
            // The token comes in as a header, never a query parameter: query
            // strings end up in proxy logs, Referer headers and browser history.
            const token = req.headers["x-mlflow-token"] || "";

            try {
                const url = assertRegistryUrl(registryUri);
                // Reuse the runtime's own MLflow client so this route honours the
                // URL's scheme (it used to force https, breaking http registries)
                // and inherits its timeout and response-size bounds.
                const baseUrl = url.href.replace(/\/$/, "");
                const result = await mlflowApiRequest(
                    baseUrl + "/api/2.0/mlflow/registered-models/search",
                    "GET",
                    token,
                    null
                );
                res.json({ models: result.registered_models || [] });
            } catch (err) {
                respondError(res, err);
            }
        }
    );

    // Get model versions
    RED.httpAdmin.get(
        "/ml-inference/models/:name/versions",
        needsPermission(RED, "ml-inference.read"),
        function (req, res) {
            try {
                const modelPath = safeChildPath(MODELS_DIR, req.params.name).filePath;

                // For now, return single version from metadata
                const metadata = loadModelMetadata(modelPath);
                if (metadata) {
                    res.json({ versions: [{ version: metadata.version, metadata: metadata }] });
                } else {
                    res.json({ versions: [] });
                }
            } catch (err) {
                respondError(res, err);
            }
        }
    );
};
