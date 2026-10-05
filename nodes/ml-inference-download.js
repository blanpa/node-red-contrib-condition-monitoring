/**
 * ml-inference model downloads
 * ============================
 *
 * Everything the ml-inference node needs to fetch a model artifact onto local
 * disk: the streaming downloader (temp file + atomic rename, redirects, idle
 * timeout, optional SHA-256 pinning), the TF.js mirror (model.json + weight
 * shards), the three registry downloaders (Hugging Face Hub, MLflow, custom)
 * and the helpers that give a downloaded artifact a loadable file extension.
 *
 * Split out of `ml-inference.js` as a pure move — no node state lives here.
 * Not a node: it is not registered in package.json.
 *
 * @module ml-inference-download
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const stream = require("stream");

const { assertPath } = require("./utils/path-validator");

/**
 * @param {Object}   deps
 * @param {string}   deps.MODELS_DIR        Model store; downloads are cached below it.
 * @param {Function} deps.mlflowApiRequest  JSON request helper from ml-inference-mlflow.
 */
module.exports = function createModelDownloader(deps) {
    const MODELS_DIR = deps.MODELS_DIR;
    const mlflowApiRequest = deps.mlflowApiRequest;

    // ----- Registry downloaders ---------------------------------------------------
    //
    // All four registry helpers accept an optional `expectedSha256` (lower-case
    // hex). When set, the downloaded artifact is verified against the digest
    // before any caller touches it; mismatches surface as ESHAMISMATCH errors.

    // Hugging Face Hub API
    //
    // `basePath` is the cache location WITHOUT extension. The extension is
    // chosen from the file that was actually found, so the loader can tell the
    // formats apart; a TF.js model gets its own directory with all weight
    // shards. Resolves with the path to load.
    async function downloadFromHuggingFace(modelId, revision, token, basePath, expectedSha256) {
        const hfFilesUrl = `https://huggingface.co/${modelId}/resolve/${revision}/`;
        const authType = token ? "bearer" : "none";

        try {
            // Try to find model.json (TensorFlow.js) or .onnx file
            const possibleFiles = ["model.json", "model.onnx", "pytorch_model.bin"];

            for (const file of possibleFiles) {
                try {
                    const fileUrl = hfFilesUrl + file;
                    if (file === "model.json") {
                        return await downloadTfjsModel(fileUrl, authType, token || "", expectedSha256, basePath);
                    }
                    const targetPath = basePath + path.extname(file);
                    await downloadFile(fileUrl, authType, token || "", targetPath, expectedSha256);
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
            if (err && err.code === "ESHAMISMATCH") throw err;
            throw new Error(`Failed to download from Hugging Face: ${err.message}`);
        }
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

    // A download that makes no progress for this long is abandoned. This is an
    // idle timeout on the socket, not a cap on the total transfer time, so a
    // large model on a slow link still completes.
    const DOWNLOAD_IDLE_TIMEOUT_MS = 60000;
    let downloadCounter = 0;

    function unlinkQuietly(filePath) {
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (_) {
            /* ignore cleanup errors */
        }
    }

    /**
     * Stream `url` into `filePath` (which is created/overwritten), following
     * redirects. Rejects — and removes the partial file — on a non-200 status,
     * a connection that drops mid-body, a stalled transfer or a write error.
     */
    function fetchToFile(url, authType, authToken, filePath, redirectsLeft) {
        return new Promise((resolve, reject) => {
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

            const req = protocol.get(url, options, (response) => {
                const status = response.statusCode;
                if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
                    response.resume();
                    if (redirectsLeft <= 0 || !response.headers.location) {
                        reject(new Error("Too many redirects (or missing Location) while downloading " + url));
                        return;
                    }
                    let nextUrl;
                    let sameOrigin = false;
                    try {
                        const next = new URL(response.headers.location, url);
                        const current = new URL(url);
                        nextUrl = next.toString();
                        sameOrigin = next.origin === current.origin;
                        if (current.protocol === "https:" && next.protocol !== "https:") {
                            reject(
                                new Error(
                                    "Refusing redirect from https to " + next.protocol + "// while downloading " + url
                                )
                            );
                            return;
                        }
                    } catch (e) {
                        reject(new Error("Invalid redirect Location while downloading " + url));
                        return;
                    }
                    // Drop credentials when the redirect crosses to another origin —
                    // presigned-CDN redirects (HF/S3) must not receive our auth token.
                    fetchToFile(
                        nextUrl,
                        sameOrigin ? authType : null,
                        sameOrigin ? authToken : null,
                        filePath,
                        redirectsLeft - 1
                    ).then(resolve, reject);
                    return;
                }

                if (status !== 200) {
                    response.resume();
                    reject(new Error(`Failed to download: ${status} ${response.statusMessage}`));
                    return;
                }

                // pipeline() — unlike pipe() — reports a response that ends
                // prematurely (connection reset mid-body) and write errors
                // (disk full, EACCES), and tears both streams down.
                stream.pipeline(response, fs.createWriteStream(filePath), (err) => {
                    if (err) {
                        unlinkQuietly(filePath);
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });

            req.on("error", reject);
            req.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
                req.destroy(new Error("Download stalled for " + DOWNLOAD_IDLE_TIMEOUT_MS + "ms: " + url));
            });
        });
    }

    // Download file with authentication.
    //
    // The artifact is streamed to a temporary file next to `targetPath` and
    // only renamed into place once it is complete (and, when `expectedSha256`
    // is provided, verified). A failed, stalled or tampered download therefore
    // never replaces — or deletes — a previously cached model, and two
    // overlapping downloads of the same artifact cannot interleave their bytes.
    // Hashes must be the lower-case hex SHA-256 digest.
    async function downloadFile(url, authType, authToken, targetPath, expectedSha256, redirectsLeft) {
        if (redirectsLeft === undefined) redirectsLeft = 5;

        let want = null;
        if (expectedSha256) {
            want = String(expectedSha256).trim().toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(want)) {
                throw new Error("expectedSha256 must be a 64-char hex SHA-256 digest");
            }
        }

        const tmpPath = targetPath + "." + process.pid + "-" + ++downloadCounter + ".part";
        try {
            await fetchToFile(url, authType, authToken, tmpPath, redirectsLeft);

            if (want) {
                const got = await sha256OfFile(tmpPath);
                if (got !== want) {
                    const err = new Error(`SHA-256 mismatch for ${url}: expected ${want}, got ${got}`);
                    err.code = "ESHAMISMATCH";
                    throw err;
                }
            }

            fs.renameSync(tmpPath, targetPath);
        } catch (err) {
            unlinkQuietly(tmpPath);
            throw err;
        }

        return targetPath;
    }

    /**
     * Download a TensorFlow.js model: `model.json` plus every weight shard its
     * manifest references, into a directory of its own. A model.json without
     * its shards cannot be loaded, and `tf.loadGraphModel(url)` cannot send
     * credentials — so authenticated / integrity-pinned / Hub models have to be
     * mirrored locally first.
     *
     * `expectedSha256` covers model.json (which names the shards).
     *
     * @returns {Promise<string>} local path of the downloaded model.json
     */
    async function downloadTfjsModel(modelJsonUrl, authType, authToken, expectedSha256, targetDir) {
        const dir =
            targetDir ||
            path.join(
                MODELS_DIR,
                "cache",
                "tfjs",
                crypto.createHash("sha256").update(modelJsonUrl).digest("hex").slice(0, 16)
            );
        fs.mkdirSync(dir, { recursive: true });

        const modelJsonPath = path.join(dir, "model.json");
        await downloadFile(modelJsonUrl, authType, authToken, modelJsonPath, expectedSha256);

        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(modelJsonPath, "utf8")).weightsManifest;
        } catch (e) {
            throw new Error("Downloaded model.json is not valid JSON: " + modelJsonUrl);
        }

        const origin = new URL(modelJsonUrl).origin;
        for (const group of Array.isArray(manifest) ? manifest : []) {
            for (const shard of Array.isArray(group && group.paths) ? group.paths : []) {
                const shardUrl = new URL(String(shard), modelJsonUrl);
                // The manifest is remote input: a shard name must not climb
                // out of the model's directory.
                const shardPath = assertPath(path.resolve(dir, String(shard)), { allowedBases: [dir] });
                fs.mkdirSync(path.dirname(shardPath), { recursive: true });
                const sameOrigin = shardUrl.origin === origin;
                await downloadFile(
                    shardUrl.toString(),
                    sameOrigin ? authType : null,
                    sameOrigin ? authToken : null,
                    shardPath
                );
            }
        }

        return modelJsonPath;
    }

    // Extension a downloaded registry artifact is cached under, per model type.
    // The loaders (and the Python bridge) pick the format from the extension.
    const EXT_BY_MODEL_TYPE = {
        onnx: ".onnx",
        max: ".onnx",
        tflite: ".tflite",
        coral: ".tflite",
        tfjs: ".json",
        savedmodel: ".json",
        sklearn: ".pkl"
    };

    /** Guess a model file's format from its first bytes. */
    function sniffModelExtension(filePath) {
        const buf = Buffer.alloc(16);
        const fd = fs.openSync(filePath, "r");
        let n;
        try {
            n = fs.readSync(fd, buf, 0, 16, 0);
        } finally {
            fs.closeSync(fd);
        }
        if (n >= 8 && buf.toString("latin1", 4, 8) === "TFL3") return ".tflite";
        if (n >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]))) {
            return ".h5"; // HDF5 (legacy Keras)
        }
        if (n >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
            return ".keras"; // zip container
        }
        if (n >= 2 && buf[0] === 0x80 && buf[1] >= 2 && buf[1] <= 5) return ".pkl"; // pickle protocol 2-5
        if (buf.toString("utf8", 0, n).trimStart().charAt(0) === "{") return ".json";
        // ONNX is a bare protobuf without a magic number.
        return ".onnx";
    }

    /**
     * Give a freshly downloaded registry artifact (cached as `<name>.model`) an
     * extension the loaders understand, and return the new path.
     *
     * With an explicit model type the extension follows the type; with "auto"
     * it is sniffed from the content. A pickle is never selected automatically:
     * unpickling runs code, so the operator has to opt in by choosing the
     * scikit-learn type.
     */
    function finalizeDownloadedModel(downloadedPath, configuredType) {
        const sniffed = sniffModelExtension(downloadedPath);
        let ext;
        if (configuredType === "keras") {
            ext = sniffed === ".h5" ? ".h5" : ".keras";
        } else if (configuredType && configuredType !== "auto") {
            ext = EXT_BY_MODEL_TYPE[configuredType] || sniffed;
        } else if (sniffed === ".pkl") {
            unlinkQuietly(downloadedPath);
            throw new Error(
                "Downloaded model looks like a Python pickle. Set the model type to scikit-learn explicitly to load it."
            );
        } else {
            ext = sniffed;
        }
        const base = downloadedPath.replace(/\.model$/, "");
        const finalPath = base + ext;
        fs.renameSync(downloadedPath, finalPath);
        return finalPath;
    }

    return {
        downloadFile: downloadFile,
        downloadTfjsModel: downloadTfjsModel,
        downloadFromHuggingFace: downloadFromHuggingFace,
        downloadFromMLflow: downloadFromMLflow,
        downloadFromCustomRegistry: downloadFromCustomRegistry,
        sniffModelExtension: sniffModelExtension,
        finalizeDownloadedModel: finalizeDownloadedModel,
        sha256OfFile: sha256OfFile
    };
};
