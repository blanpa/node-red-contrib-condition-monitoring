module.exports = function (RED) {
    "use strict";

    // Upper bound for the sliding window. Every sample touches the live window,
    // so the ceiling is a usability guard, not a formality — the old 1_000_000
    // let a single message cost a million-element pass.
    const MAX_WINDOW_SIZE = 100000;

    // Admin-route auth guard (Node-RED does not apply adminAuth to httpAdmin routes)
    const { needsPermission } = require("./utils/admin-auth");

    const fs = require("fs");
    const path = require("path");
    const zlib = require("zlib");
    const { Readable } = require("stream");
    const { pipeline } = require("stream/promises");

    const { clampInt, clampFloat, isIsoDateLike } = require("./utils/config-validator");
    const { validatePath, assertPath } = require("./utils/path-validator");

    // Rows per chunk when streaming an export to disk. Exports are written
    // through a stream so a large buffer never has to exist as one string.
    const EXPORT_CHUNK_ROWS = 2000;
    // Backoff after a failed auto-save: base * 2^(failures-1), capped.
    const AUTOSAVE_RETRY_BASE_MS = 5000;
    const AUTOSAVE_RETRY_MAX_MS = 5 * 60 * 1000;

    // Optional S3 support
    let S3Client = null;
    let PutObjectCommand = null;
    try {
        const awsSdk = require("@aws-sdk/client-s3");
        S3Client = awsSdk.S3Client;
        PutObjectCommand = awsSdk.PutObjectCommand;
    } catch (err) {
        // S3 not available - optional dependency
    }

    // Data directory relative to Node-RED userDir
    function getDataDir(RED) {
        return path.join(RED.settings.userDir || process.cwd(), "training-data");
    }

    // Directories a training-data path may resolve into: the data dir itself
    // and, when userDir is reached through a symlink, its real location (the
    // path validator compares real paths for files that already exist).
    function getAllowedBases(RED) {
        const dataDir = getDataDir(RED);
        const bases = [dataDir];
        try {
            if (fs.existsSync(dataDir)) {
                const real = fs.realpathSync(dataDir);
                if (real !== dataDir) bases.push(real);
            }
        } catch (err) {
            // fall back to the lexical base only
        }
        return bases;
    }

    // SECURITY: every path this node hands to `fs` goes through here. Throws
    // (EPATHFORBIDDEN) if it would resolve outside the training-data directory.
    function safeDataPath(RED, candidate) {
        return assertPath(candidate, { allowedBases: getAllowedBases(RED), base: getDataDir(RED) });
    }

    // RFC 4180 quoting: a label or feature name containing a comma, quote or
    // newline must not shift the columns of every row after it.
    function csvCell(value) {
        if (value === null || value === undefined) return "";
        const text = String(value);
        return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }

    // The editor stores the split as three percentages (splitTrain / splitVal
    // / splitTest); a `splitRatio` object ({train,val,test} as 0..1 fractions)
    // is accepted too and wins when present. Previously only `splitRatio` was
    // read — which the editor never saves — so every flow silently got 80/10/10.
    function normalizeSplitRatio(config) {
        const fallback = { train: 0.8, val: 0.1, test: 0.1 };
        const raw = config.splitRatio;
        if (raw && typeof raw === "object") {
            return {
                train: clampFloat(raw.train, 0, 1, fallback.train),
                val: clampFloat(raw.val, 0, 1, fallback.val),
                test: clampFloat(raw.test, 0, 1, fallback.test)
            };
        }
        return {
            train: clampFloat(config.splitTrain, 0, 100, fallback.train * 100) / 100,
            val: clampFloat(config.splitVal, 0, 100, fallback.val * 100) / 100,
            test: clampFloat(config.splitTest, 0, 100, fallback.test * 100) / 100
        };
    }

    /**
     * Training Data Collector Node
     * Collects sensor data in formats suitable for ML training
     */
    function TrainingDataCollectorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // ========================================
        // Configuration
        // ========================================

        // Dataset settings
        // SECURITY: datasetName is used to build filenames; strip any path
        // components and traversal sequences so it can never escape the output dir.
        this.datasetName =
            path
                .basename(config.datasetName || "dataset")
                .replace(/[^a-zA-Z0-9._-]/g, "_")
                .replace(/^\.+/, "") || "dataset";
        this.outputPath = config.outputPath || ""; // Relative to userDir/training-data
        this.mode = config.mode || "batch"; // streaming, batch, timeseries
        this.autoSave = config.autoSave !== false;

        // Feature configuration
        this.featureSource = config.featureSource || "payload"; // payload, payload.features, custom
        this.featureFields = config.featureFields
            ? Array.isArray(config.featureFields)
                ? config.featureFields
                : config.featureFields
                      .split(",")
                      .map((s) => s.trim())
                      .filter((s) => s)
            : [];
        this.includeTimestamp = config.includeTimestamp !== false;
        this.timestampFormat = config.timestampFormat || "iso"; // iso, unix, unix_ms

        // Label configuration
        this.labelMode = config.labelMode || "manual"; // manual, fromMessage, rul, unlabeled
        this.labelField = config.labelField || "label";
        this.severityField = config.severityField || "severity";
        this.rulStartValue = clampFloat(config.rulStartValue, 0, 1e12, 100);
        this.rulUnit = config.rulUnit || "samples"; // samples, seconds, hours, days
        this.defaultLabel = config.defaultLabel || "normal";

        // Buffer settings
        this.bufferSize = clampInt(config.bufferSize, 1, 10000000, 1000);
        this.windowSize = clampInt(config.windowSize, 2, MAX_WINDOW_SIZE, 100); // For timeseries mode
        this.windowOverlap = clampInt(config.windowOverlap, 0, 99, 50); // Percent
        this.flushOnDeploy = config.flushOnDeploy !== false;

        // Export settings
        this.exportFormat = config.exportFormat || "csv"; // csv, jsonl, json
        this.compressionEnabled = config.compressionEnabled !== false;
        this.compressionThreshold = clampInt(config.compressionThreshold, 1, 100000000, 10000); // Samples before compression
        this.splitRatio = normalizeSplitRatio(config);
        this.shuffleOnExport = config.shuffleOnExport !== false;
        this.includeMetadata = config.includeMetadata !== false;

        // Disk-usage limits. Both default to 0 (= unlimited) when the key is
        // absent, so flows saved before these options existed behave as before.
        // maxStreamFileMB: rotate <dataset>_stream.jsonl once it reaches this size.
        // maxFiles: keep at most this many exported/rotated files of this dataset.
        this.maxStreamFileMB = clampFloat(config.maxStreamFileMB, 0, 1000000, 0);
        this.maxFiles = clampInt(config.maxFiles, 0, 1000000, 0);

        // S3 settings
        this.s3Enabled = config.s3Enabled === true;
        this.s3Bucket = config.s3Bucket || "";
        this.s3Prefix = config.s3Prefix || "training-data/";
        this.s3Region = config.s3Region || "eu-central-1";
        // SECURITY: S3 keys live in Node-RED credentials (encrypted, never part
        // of a flow export). Resolution order: node credentials → the
        // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY environment variables →
        // the AWS SDK default chain (shared config, IAM role, IRSA, …).
        const credentials = node.credentials || {};
        const credAccessKeyId = typeof credentials.s3AccessKeyId === "string" ? credentials.s3AccessKeyId.trim() : "";
        const credSecretAccessKey =
            typeof credentials.s3SecretAccessKey === "string" ? credentials.s3SecretAccessKey.trim() : "";
        const useNodeCredentials = credAccessKeyId.length > 0 && credSecretAccessKey.length > 0;
        const s3AccessKeyId = useNodeCredentials ? credAccessKeyId : process.env.AWS_ACCESS_KEY_ID || "";
        const s3SecretAccessKey = useNodeCredentials ? credSecretAccessKey : process.env.AWS_SECRET_ACCESS_KEY || "";

        // Keys saved by an older version of the editor sit in the flow file in
        // plain text. They were never used and still are not.
        if (config.s3AccessKeyId || config.s3SecretAccessKey) {
            node.warn(
                "S3 credentials stored in the node config (plain text in flows.json) are ignored. Open the node, " +
                    "re-enter them in the credential fields and deploy — or use the AWS_ACCESS_KEY_ID / " +
                    "AWS_SECRET_ACCESS_KEY environment variables."
            );
        }

        // Data quality settings
        this.validateData = config.validateData !== false;

        // ========================================
        // State
        // ========================================

        this.dataBuffer = [];
        this.featureNames = [];
        this.labelClasses = new Set();
        this.statistics = {};
        this.sampleCount = 0;
        this.sessionStart = Date.now();
        this.isPaused = false;
        this.currentRul = this.rulStartValue;
        this.lastTimestamp = null;

        // Time-series window state
        this.windowBuffer = [];
        this.windowLabels = [];

        // S3 client
        this.s3Client = null;
        if (this.s3Enabled && !S3Client) {
            node.warn("S3 upload enabled but @aws-sdk/client-s3 not installed. Run: npm install @aws-sdk/client-s3");
        } else if (this.s3Enabled && !this.s3Bucket) {
            node.warn("S3 upload enabled but no bucket configured — nothing will be uploaded.");
        } else if (this.s3Enabled) {
            try {
                const clientConfig = { region: this.s3Region };
                if (s3AccessKeyId && s3SecretAccessKey) {
                    clientConfig.credentials = { accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey };
                    node.log(
                        "S3 client initialized for bucket: " +
                            this.s3Bucket +
                            " (" +
                            (useNodeCredentials ? "node credentials" : "environment credentials") +
                            ")"
                    );
                } else {
                    // No explicit keys: let the SDK resolve them (IAM role,
                    // shared config, …). A failure surfaces on the first upload.
                    node.log("S3 client initialized for bucket: " + this.s3Bucket + " (AWS default credential chain)");
                }
                this.s3Client = new S3Client(clientConfig);
            } catch (err) {
                node.warn("Failed to initialize S3 client: " + err.message);
            }
        }

        // Export / auto-save bookkeeping.
        // exportChain serialises exports so two never write at the same time.
        let exportChain = Promise.resolve();
        let lastExportStamp = "";
        let exportSeq = 0;
        let autoSaveFailures = 0;
        let autoSaveNotBefore = 0;
        // Streaming mode: appends are chained so lines land in arrival order,
        // and the file size is tracked for rotation (null = not measured yet).
        let streamChain = Promise.resolve();
        let streamBytes = null;
        let streamWarned = false;

        // Initial status
        updateStatus();

        // ========================================
        // Helper Functions
        // ========================================

        function updateStatus() {
            if (Date.now() < autoSaveNotBefore) {
                node.status({
                    fill: "red",
                    shape: "ring",
                    text:
                        "export failed - retry in " +
                        Math.ceil((autoSaveNotBefore - Date.now()) / 1000) +
                        "s - " +
                        node.dataBuffer.length +
                        " buffered"
                });
            } else if (node.isPaused) {
                node.status({ fill: "yellow", shape: "ring", text: "paused - " + node.dataBuffer.length + " samples" });
            } else if (node.dataBuffer.length >= node.bufferSize) {
                node.status({ fill: "yellow", shape: "dot", text: "buffer full - " + node.dataBuffer.length });
            } else {
                const classInfo = node.labelClasses.size > 0 ? " | " + node.labelClasses.size + " classes" : "";
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: node.dataBuffer.length + "/" + node.bufferSize + classInfo
                });
            }
        }

        // Without autoSave, batch/timeseries collection would grow without
        // bound and eventually OOM a long-running flow. Allow headroom up to
        // 2x bufferSize, then drop the oldest samples — loudly, so the
        // operator knows data is being lost and can export or enable autoSave.
        let bufferCapWarned = false;
        function enforceBufferCap() {
            const hardCap = node.bufferSize * 2;
            if (node.dataBuffer.length <= hardCap) return;
            while (node.dataBuffer.length > hardCap) {
                node.dataBuffer.shift();
            }
            if (!bufferCapWarned) {
                bufferCapWarned = true;
                node.warn(
                    "training-data-collector: buffer exceeded 2x bufferSize (" +
                        hardCap +
                        "); dropping oldest samples. Export the data or enable autoSave."
                );
            }
        }

        function sanitizePath(inputPath) {
            // SECURITY: Prevent path traversal attacks
            // Remove any parent directory references and normalize the path
            if (!inputPath) return "";

            // Replace backslashes with forward slashes
            let normalized = inputPath.replace(/\\/g, "/");

            // Remove any parent directory references (..)
            normalized = normalized.replace(/\.\./g, "");

            // Remove leading slashes (prevent absolute paths)
            normalized = normalized.replace(/^\/+/, "");

            // Remove any remaining dangerous characters
            normalized = normalized.replace(/[<>:"|?*]/g, "");

            // Split, filter empty parts and rejoin
            const parts = normalized.split("/").filter(function (part) {
                return part && part !== "." && part !== "..";
            });

            return parts.join(path.sep);
        }

        function getOutputDir() {
            const baseDir = getDataDir(RED);
            if (node.outputPath) {
                const sanitized = sanitizePath(node.outputPath);
                if (sanitized) {
                    // SECURITY: the resolved path must stay inside baseDir
                    // (path-validator also rejects symlinks pointing out of it).
                    const checked = validatePath(path.join(baseDir, sanitized), {
                        allowedBases: getAllowedBases(RED),
                        base: baseDir
                    });
                    if (!checked.ok) {
                        node.warn("Output path rejected (" + checked.reason + "). Using base directory.");
                        return baseDir;
                    }
                    return checked.resolved;
                }
            }
            return baseDir;
        }

        function ensureOutputDir() {
            const dir = getOutputDir();
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            return dir;
        }

        function formatTimestamp(date) {
            switch (node.timestampFormat) {
                case "unix":
                    return Math.floor(date.getTime() / 1000);
                case "unix_ms":
                    return date.getTime();
                case "iso":
                default:
                    return date.toISOString();
            }
        }

        let parseWarned = false;
        function safeParseFloat(v, fieldName) {
            // A date-shaped string is not a number, even though parseFloat
            // would read "2024-05-01" as 2024.
            const parsed = isIsoDateLike(v) ? NaN : parseFloat(v);
            if (isNaN(parsed)) {
                if (!parseWarned) {
                    node.warn(
                        "Non-numeric value in training data" +
                            (fieldName ? " (field: " + fieldName + ")" : "") +
                            ": " +
                            JSON.stringify(v).substring(0, 50) +
                            " — replaced with 0"
                    );
                    parseWarned = true;
                }
                return 0;
            }
            return parsed;
        }

        function extractFeatures(msg) {
            const features = {};
            let values = [];

            if (node.featureSource === "custom" && node.featureFields.length > 0) {
                // Extract specific fields
                node.featureFields.forEach(function (field) {
                    const value = getNestedValue(msg, field);
                    if (value !== undefined && value !== null) {
                        features[field] = safeParseFloat(value, field);
                        values.push(features[field]);
                    }
                });
            } else if (node.featureSource === "payload.features") {
                // Features are in msg.payload.features
                const featData = msg.payload && msg.payload.features;
                if (Array.isArray(featData)) {
                    values = featData.map(function (v, i) {
                        return safeParseFloat(v, "feature_" + i);
                    });
                    featData.forEach(function (v, i) {
                        features["feature_" + i] = safeParseFloat(v, "feature_" + i);
                    });
                } else if (featData && typeof featData === "object") {
                    Object.keys(featData).forEach(function (key) {
                        features[key] = safeParseFloat(featData[key], key);
                        values.push(features[key]);
                    });
                }
            } else {
                // Features are directly in payload
                if (Array.isArray(msg.payload)) {
                    values = msg.payload.map(function (v, i) {
                        return safeParseFloat(v, "feature_" + i);
                    });
                    msg.payload.forEach(function (v, i) {
                        features["feature_" + i] = safeParseFloat(v, "feature_" + i);
                    });
                } else if (typeof msg.payload === "object" && msg.payload !== null) {
                    Object.keys(msg.payload).forEach(function (key) {
                        const val = msg.payload[key];
                        if (
                            typeof val === "number" ||
                            (typeof val === "string" && !isIsoDateLike(val) && !isNaN(parseFloat(val)))
                        ) {
                            features[key] = safeParseFloat(val, key);
                            values.push(features[key]);
                        }
                    });
                } else if (typeof msg.payload === "number") {
                    features["value"] = msg.payload;
                    values.push(msg.payload);
                }
            }

            // Update feature names if not set
            if (node.featureNames.length === 0 && Object.keys(features).length > 0) {
                node.featureNames = Object.keys(features);
            }

            return { features: features, values: values };
        }

        function getNestedValue(obj, path) {
            const parts = path.split(".");
            let current = obj;
            for (let i = 0; i < parts.length; i++) {
                if (current === undefined || current === null) return undefined;
                current = current[parts[i]];
            }
            return current;
        }

        function extractLabel(msg) {
            switch (node.labelMode) {
                case "fromMessage": {
                    // Get label from message field
                    let label = getNestedValue(msg, node.labelField);
                    if (label === undefined || label === null) {
                        // Try common fields
                        label =
                            msg.label ||
                            msg.class ||
                            msg.category ||
                            (msg.isAnomaly ? "anomaly" : null) ||
                            (msg.anomaly && msg.anomaly.isAnomaly ? "anomaly" : null);
                    }
                    return label !== undefined && label !== null ? String(label) : node.defaultLabel;
                }

                case "rul":
                    // Return current RUL value
                    return node.currentRul;

                case "unlabeled":
                    return null;

                case "manual":
                default:
                    // Use default label or msg.label if provided
                    return msg.label !== undefined ? String(msg.label) : node.defaultLabel;
            }
        }

        function extractSeverity(msg) {
            let severity = getNestedValue(msg, node.severityField);
            if (severity === undefined || severity === null) {
                severity = msg.severity || msg.score || (msg.anomaly && msg.anomaly.severity) || 0;
            }
            return parseFloat(severity) || 0;
        }

        function updateRul(_msg) {
            if (node.labelMode !== "rul") return;

            switch (node.rulUnit) {
                case "samples":
                    node.currentRul = Math.max(0, node.currentRul - 1);
                    break;
                case "seconds":
                    if (node.lastTimestamp) {
                        const elapsed = (Date.now() - node.lastTimestamp) / 1000;
                        node.currentRul = Math.max(0, node.currentRul - elapsed);
                    }
                    break;
                case "hours":
                    if (node.lastTimestamp) {
                        const elapsed = (Date.now() - node.lastTimestamp) / 3600000;
                        node.currentRul = Math.max(0, node.currentRul - elapsed);
                    }
                    break;
                case "days":
                    if (node.lastTimestamp) {
                        const elapsed = (Date.now() - node.lastTimestamp) / 86400000;
                        node.currentRul = Math.max(0, node.currentRul - elapsed);
                    }
                    break;
            }
            node.lastTimestamp = Date.now();
        }

        function validateSample(features, values) {
            if (!node.validateData) return { valid: true };

            const issues = [];

            // Check for NaN/Infinity
            for (let i = 0; i < values.length; i++) {
                if (isNaN(values[i]) || !isFinite(values[i])) {
                    issues.push("Invalid value at index " + i);
                }
            }

            // Check feature count consistency
            if (node.featureNames.length > 0 && values.length !== node.featureNames.length) {
                issues.push("Feature count mismatch: expected " + node.featureNames.length + ", got " + values.length);
            }

            return {
                valid: issues.length === 0,
                issues: issues
            };
        }

        function updateStatistics(features) {
            Object.keys(features).forEach(function (key) {
                const value = features[key];

                if (!node.statistics[key]) {
                    node.statistics[key] = {
                        count: 0,
                        sum: 0,
                        sumSquares: 0,
                        min: Infinity,
                        max: -Infinity
                    };
                }

                const stats = node.statistics[key];
                stats.count++;
                stats.sum += value;
                stats.sumSquares += value * value;
                stats.min = Math.min(stats.min, value);
                stats.max = Math.max(stats.max, value);
            });
        }

        function getStatisticsSummary() {
            const summary = {};

            Object.keys(node.statistics).forEach(function (key) {
                const stats = node.statistics[key];
                const mean = stats.sum / stats.count;
                const variance = stats.sumSquares / stats.count - mean * mean;
                const std = Math.sqrt(Math.max(0, variance));

                summary[key] = {
                    count: stats.count,
                    mean: mean,
                    std: std,
                    min: stats.min,
                    max: stats.max
                };
            });

            return summary;
        }

        function getLabelDistribution(data) {
            const distribution = {};
            (data || node.dataBuffer).forEach(function (sample) {
                const label = sample.label;
                if (label !== null && label !== undefined) {
                    distribution[label] = (distribution[label] || 0) + 1;
                }
            });
            return distribution;
        }

        function shuffleArray(array) {
            const result = array.slice();
            for (let i = result.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                const temp = result[i];
                result[i] = result[j];
                result[j] = temp;
            }
            return result;
        }

        function splitData(data, ratio) {
            const shuffled = node.shuffleOnExport ? shuffleArray(data) : data;
            const total = shuffled.length;

            const trainSize = Math.floor(total * ratio.train);
            const valSize = Math.floor(total * ratio.val);

            return {
                train: shuffled.slice(0, trainSize),
                val: shuffled.slice(trainSize, trainSize + valSize),
                test: shuffled.slice(trainSize + valSize)
            };
        }

        // ========================================
        // Export Functions
        // ========================================

        // Unique per-export file stem. Millisecond resolution plus a sequence
        // number for exports landing in the same millisecond — a second-
        // resolution name let fast auto-saves overwrite one another.
        function nextExportStem() {
            const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
            if (stamp === lastExportStamp) {
                exportSeq++;
            } else {
                lastExportStamp = stamp;
                exportSeq = 0;
            }
            return node.datasetName + "_" + stamp + (exportSeq > 0 ? "_" + exportSeq : "");
        }

        // Stream `chunks` (an iterable of strings) to `filePath`, gzipped when
        // asked. Written to a .part file first and renamed, so a failed export
        // never leaves a truncated dataset behind. Returns the final path.
        async function writeChunks(filePath, chunks, compress) {
            const target = safeDataPath(RED, compress ? filePath + ".gz" : filePath);
            const partial = safeDataPath(RED, target + ".part");
            const stages = [Readable.from(chunks, { objectMode: false })];
            if (compress) stages.push(zlib.createGzip());
            stages.push(fs.createWriteStream(partial));
            try {
                await pipeline(stages);
                await fs.promises.rename(partial, target);
            } catch (err) {
                fs.promises.unlink(partial).catch(function () {});
                throw err;
            }
            return target;
        }

        function shouldCompress(data) {
            return node.compressionEnabled && data.length >= node.compressionThreshold;
        }

        // Time-series samples carry a window: an array of per-step value arrays.
        function isWindowSample(sample) {
            return !!sample && Array.isArray(sample.features);
        }

        function* csvChunks(data) {
            const windowed = isWindowSample(data[0]);
            let headers = node.includeTimestamp ? ["timestamp"] : [];
            let steps = 0;
            let width = 0;
            if (windowed) {
                // One row per window, flattened step by step: t0_a, t0_b, t1_a, …
                steps = data.reduce(function (m, s) {
                    return Math.max(m, isWindowSample(s) ? s.features.length : 0);
                }, 0);
                width = node.featureNames.length || (data[0].features[0] ? data[0].features[0].length : 0);
                for (let t = 0; t < steps; t++) {
                    for (let j = 0; j < width; j++) {
                        headers.push("t" + t + "_" + (node.featureNames[j] || "feature_" + j));
                    }
                }
            } else {
                headers = headers.concat(node.featureNames);
            }
            if (node.labelMode !== "unlabeled") {
                headers.push("label");
                headers.push("severity");
            }
            yield headers.map(csvCell).join(",") + "\n";

            let lines = [];
            for (const sample of data) {
                const row = [];
                if (node.includeTimestamp) {
                    row.push(sample.timestamp);
                }
                if (windowed) {
                    const win = isWindowSample(sample) ? sample.features : [];
                    for (let t = 0; t < steps; t++) {
                        const step = Array.isArray(win[t]) ? win[t] : [];
                        for (let j = 0; j < width; j++) row.push(step[j]);
                    }
                } else {
                    node.featureNames.forEach(function (name) {
                        row.push(sample.features[name]);
                    });
                }
                if (node.labelMode !== "unlabeled") {
                    row.push(sample.label);
                    row.push(sample.severity);
                }
                lines.push(row.map(csvCell).join(","));
                if (lines.length >= EXPORT_CHUNK_ROWS) {
                    yield lines.join("\n") + "\n";
                    lines = [];
                }
            }
            if (lines.length > 0) yield lines.join("\n");
        }

        function sampleVector(sample) {
            return sample.values || (isWindowSample(sample) ? sample.features : Object.values(sample.features));
        }

        function* jsonlChunks(data) {
            let lines = [];
            for (let i = 0; i < data.length; i++) {
                const sample = data[i];
                const obj = { features: sampleVector(sample) };
                if (node.includeTimestamp) {
                    obj.timestamp = sample.timestamp;
                }
                if (node.labelMode !== "unlabeled" && sample.label !== null) {
                    obj.label = sample.label;
                }
                if (sample.severity !== undefined && sample.severity !== 0) {
                    obj.severity = sample.severity;
                }
                lines.push(JSON.stringify(obj));
                if (lines.length >= EXPORT_CHUNK_ROWS && i < data.length - 1) {
                    yield lines.join("\n") + "\n";
                    lines = [];
                }
            }
            if (lines.length > 0) yield lines.join("\n");
        }

        function* jsonChunks(data) {
            const info = {
                name: node.datasetName,
                created: new Date().toISOString(),
                samples: data.length,
                features: node.featureNames,
                classes: Array.from(node.labelClasses),
                featureDimension: node.featureNames.length,
                statistics: getStatisticsSummary()
            };
            yield '{\n  "datasetInfo": ' + JSON.stringify(info, null, 2).replace(/\n/g, "\n  ") + ',\n  "data": [\n';
            let lines = [];
            for (let i = 0; i < data.length; i++) {
                const sample = data[i];
                const obj = { x: sampleVector(sample) };
                if (node.labelMode !== "unlabeled" && sample.label !== null) {
                    obj.y = sample.label;
                }
                if (sample.severity !== undefined && sample.severity !== 0) {
                    obj.severity = sample.severity;
                }
                lines.push("    " + JSON.stringify(obj) + (i < data.length - 1 ? "," : ""));
                if (lines.length >= EXPORT_CHUNK_ROWS) {
                    yield lines.join("\n") + "\n";
                    lines = [];
                }
            }
            yield (lines.length > 0 ? lines.join("\n") + "\n" : "") + "  ]\n}";
        }

        async function exportToCSV(data, filename) {
            if (data.length === 0) return null;
            return writeChunks(path.join(ensureOutputDir(), filename), csvChunks(data), shouldCompress(data));
        }

        async function exportToJSONL(data, filename) {
            if (data.length === 0) return null;
            return writeChunks(path.join(ensureOutputDir(), filename), jsonlChunks(data), shouldCompress(data));
        }

        async function exportToJSON(data, filename) {
            if (data.length === 0) return null;
            return writeChunks(path.join(ensureOutputDir(), filename), jsonChunks(data), shouldCompress(data));
        }

        async function exportMetadata(filename, data) {
            const outputDir = ensureOutputDir();

            const metadata = {
                datasetInfo: {
                    name: node.datasetName,
                    created: new Date().toISOString(),
                    sessionStart: new Date(node.sessionStart).toISOString(),
                    totalSamples: node.sampleCount,
                    exportedSamples: data.length
                },
                features: {
                    names: node.featureNames,
                    count: node.featureNames.length,
                    statistics: getStatisticsSummary()
                },
                labels: {
                    mode: node.labelMode,
                    classes: Array.from(node.labelClasses),
                    distribution: getLabelDistribution(data)
                },
                config: {
                    mode: node.mode,
                    exportFormat: node.exportFormat,
                    windowSize: node.windowSize,
                    windowOverlap: node.windowOverlap,
                    compressionEnabled: node.compressionEnabled
                },
                dataQuality: {
                    totalCollected: node.sampleCount,
                    exported: data.length,
                    validationEnabled: node.validateData
                }
            };

            const filePath = safeDataPath(RED, path.join(outputDir, filename));
            await fs.promises.writeFile(filePath, JSON.stringify(metadata, null, 2), "utf8");

            return filePath;
        }

        async function uploadToS3(filePath, s3Key) {
            if (!node.s3Client || !node.s3Bucket) {
                throw new Error("S3 client not configured");
            }

            const fileContent = await fs.promises.readFile(safeDataPath(RED, filePath));
            let contentType = "application/octet-stream";

            if (filePath.endsWith(".csv")) contentType = "text/csv";
            else if (filePath.endsWith(".json")) contentType = "application/json";
            else if (filePath.endsWith(".jsonl")) contentType = "application/x-ndjson";
            else if (filePath.endsWith(".gz")) contentType = "application/gzip";

            const command = new PutObjectCommand({
                Bucket: node.s3Bucket,
                Key: node.s3Prefix + s3Key,
                Body: fileContent,
                ContentType: contentType
            });

            await node.s3Client.send(command);
            return "s3://" + node.s3Bucket + "/" + node.s3Prefix + s3Key;
        }

        // Files this node produced for this dataset: timestamped exports
        // (incl. split / metadata / .gz variants) and rotated stream files —
        // never the live <dataset>_stream.jsonl, never another dataset's files.
        function isOwnDatasetFile(name) {
            const prefix = node.datasetName + "_";
            if (!name.startsWith(prefix)) return false;
            const rest = name.slice(prefix.length);
            return /^(stream_)?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d{3})?(_\d+)?(_train|_val|_test|_metadata)?\.(csv|jsonl|json)(\.gz)?$/.test(
                rest
            );
        }

        // Retention: with maxFiles > 0, delete this dataset's oldest files so
        // at most maxFiles remain. Best effort — never fails an export.
        async function pruneOldFiles() {
            if (!(node.maxFiles > 0)) return;
            try {
                const dir = getOutputDir();
                const names = (await fs.promises.readdir(dir)).filter(isOwnDatasetFile);
                if (names.length <= node.maxFiles) return;
                const entries = [];
                for (const name of names) {
                    const filePath = safeDataPath(RED, path.join(dir, name));
                    const stat = await fs.promises.stat(filePath);
                    if (stat.isFile()) entries.push({ filePath: filePath, name: name, mtime: stat.mtimeMs });
                }
                entries.sort(function (a, b) {
                    return a.mtime - b.mtime || (a.name < b.name ? -1 : 1);
                });
                const excess = entries.slice(0, Math.max(0, entries.length - node.maxFiles));
                for (const entry of excess) {
                    await fs.promises.unlink(entry.filePath);
                }
                if (excess.length > 0) {
                    node.log("Retention: removed " + excess.length + " old file(s) (maxFiles=" + node.maxFiles + ")");
                }
            } catch (err) {
                node.warn("Retention cleanup failed: " + err.message);
            }
        }

        // Streaming mode: append one line, in arrival order, rotating the file
        // once it would exceed maxStreamFileMB.
        function appendToStream(line) {
            streamChain = streamChain
                .then(async function () {
                    const outputDir = ensureOutputDir();
                    const streamFile = safeDataPath(RED, path.join(outputDir, node.datasetName + "_stream.jsonl"));
                    const bytes = Buffer.byteLength(line, "utf8");
                    if (streamBytes === null) {
                        try {
                            streamBytes = (await fs.promises.stat(streamFile)).size;
                        } catch (err) {
                            streamBytes = 0;
                        }
                    }
                    const limit = node.maxStreamFileMB * 1024 * 1024;
                    if (limit > 0 && streamBytes > 0 && streamBytes + bytes > limit) {
                        const rotated = safeDataPath(
                            RED,
                            path.join(
                                outputDir,
                                nextExportStem().replace(node.datasetName + "_", node.datasetName + "_stream_") +
                                    ".jsonl"
                            )
                        );
                        await fs.promises.rename(streamFile, rotated);
                        streamBytes = 0;
                        await pruneOldFiles();
                    }
                    await fs.promises.appendFile(streamFile, line, "utf8");
                    streamBytes += bytes;
                    streamWarned = false;
                })
                .catch(function (err) {
                    // The size is unknown after a failure; re-measure next time.
                    streamBytes = null;
                    if (!streamWarned) {
                        streamWarned = true;
                        node.warn("Failed to append to stream file: " + err.message);
                    }
                });
        }

        // Write one batch to disk (and S3). Never throws: failures come back
        // as { success: false }.
        async function writeBatch(batch) {
            const baseFilename = nextExportStem();
            const exportedFiles = [];
            const s3Urls = [];
            const s3Errors = [];

            try {
                node.status({ fill: "yellow", shape: "dot", text: "exporting..." });

                // Split data if ratio is configured
                let splits = {};
                if (
                    node.splitRatio &&
                    (node.splitRatio.train < 1 || node.splitRatio.val > 0 || node.splitRatio.test > 0)
                ) {
                    splits = splitData(batch, node.splitRatio);
                } else {
                    splits.train = batch;
                }

                // Export each split
                for (const splitName in splits) {
                    if (splits[splitName].length === 0) continue;

                    const filename = baseFilename + (Object.keys(splits).length > 1 ? "_" + splitName : "");
                    let filePath = null;

                    switch (node.exportFormat) {
                        case "csv":
                            filePath = await exportToCSV(splits[splitName], filename + ".csv");
                            break;
                        case "jsonl":
                            filePath = await exportToJSONL(splits[splitName], filename + ".jsonl");
                            break;
                        case "json":
                            filePath = await exportToJSON(splits[splitName], filename + ".json");
                            break;
                        default:
                            filePath = await exportToCSV(splits[splitName], filename + ".csv");
                    }

                    if (filePath) {
                        exportedFiles.push(filePath);

                        // Upload to S3 if enabled
                        if (node.s3Enabled && node.s3Client) {
                            try {
                                const s3Key = path.basename(filePath);
                                const s3Url = await uploadToS3(filePath, s3Key);
                                s3Urls.push(s3Url);
                            } catch (s3Err) {
                                s3Errors.push(s3Err.message);
                                node.warn("S3 upload failed: " + s3Err.message);
                            }
                        }
                    }
                }

                // Export metadata
                if (node.includeMetadata) {
                    const metaPath = await exportMetadata(baseFilename + "_metadata.json", batch);
                    exportedFiles.push(metaPath);

                    if (node.s3Enabled && node.s3Client) {
                        try {
                            const s3Url = await uploadToS3(metaPath, path.basename(metaPath));
                            s3Urls.push(s3Url);
                        } catch (s3Err) {
                            s3Errors.push(s3Err.message);
                            node.warn("S3 metadata upload failed: " + s3Err.message);
                        }
                    }
                }

                await pruneOldFiles();

                const result = {
                    success: true,
                    samples: batch.length,
                    files: exportedFiles,
                    splits: {
                        train: splits.train ? splits.train.length : 0,
                        val: splits.val ? splits.val.length : 0,
                        test: splits.test ? splits.test.length : 0
                    },
                    labelDistribution: getLabelDistribution(batch),
                    statistics: getStatisticsSummary(),
                    features: node.featureNames,
                    classes: Array.from(node.labelClasses)
                };

                if (s3Urls.length > 0) {
                    result.s3Urls = s3Urls;
                }
                if (s3Errors.length > 0) {
                    result.s3Errors = s3Errors;
                }
                return result;
            } catch (err) {
                node.error("Export failed: " + err.message);
                return {
                    success: false,
                    error: err.message,
                    samples: batch.length
                };
            }
        }

        // Export the current buffer. The batch is taken out of the buffer
        // SYNCHRONOUSLY (before the first await), so samples arriving while the
        // files are being written start a fresh buffer instead of being wiped
        // by the export that finishes — and cannot trigger a second export of
        // the same data. If the write fails the batch is put back.
        function performExport(msg) {
            if (node.dataBuffer.length === 0) {
                return Promise.resolve({
                    success: false,
                    error: "No data to export",
                    samples: 0
                });
            }

            const clear = !!(msg && msg.clearAfterExport !== false);
            const batch = clear ? node.dataBuffer : node.dataBuffer.slice();
            if (clear) {
                node.dataBuffer = [];
            }

            const run = exportChain.then(function () {
                return writeBatch(batch);
            });
            exportChain = run.then(
                function () {},
                function () {}
            );
            return run.then(function (result) {
                if (!result.success && clear) {
                    node.dataBuffer = batch.concat(node.dataBuffer);
                    enforceBufferCap();
                }
                updateStatus();
                return result;
            });
        }

        // ========================================
        // Message Processing
        // ========================================

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
                // Handle control actions
                if (msg.action) {
                    let result = null;

                    switch (msg.action) {
                        case "save":
                        case "export":
                            result = await performExport(msg);
                            send({ payload: result, topic: "export" });
                            done();
                            return;

                        case "clear":
                            node.dataBuffer = [];
                            node.windowBuffer = [];
                            node.windowLabels = [];
                            node.statistics = {};
                            node.labelClasses.clear();
                            node.sampleCount = 0;
                            node.currentRul = node.rulStartValue;
                            // Forget the locked feature schema too, otherwise a
                            // cleared collector rejects any differently shaped data.
                            node.featureNames = [];
                            bufferCapWarned = false;
                            autoSaveFailures = 0;
                            autoSaveNotBefore = 0;
                            updateStatus();
                            send({ payload: { success: true, action: "clear" }, topic: "control" });
                            done();
                            return;

                        case "stats":
                            result = {
                                samples: node.dataBuffer.length,
                                totalCollected: node.sampleCount,
                                features: node.featureNames,
                                classes: Array.from(node.labelClasses),
                                labelDistribution: getLabelDistribution(),
                                statistics: getStatisticsSummary(),
                                bufferUsage: ((node.dataBuffer.length / node.bufferSize) * 100).toFixed(1) + "%",
                                sessionDuration: Date.now() - node.sessionStart
                            };
                            send({ payload: result, topic: "stats" });
                            done();
                            return;

                        case "pause":
                            node.isPaused = true;
                            updateStatus();
                            send({ payload: { success: true, action: "pause" }, topic: "control" });
                            done();
                            return;

                        case "resume":
                            node.isPaused = false;
                            updateStatus();
                            send({ payload: { success: true, action: "resume" }, topic: "control" });
                            done();
                            return;

                        case "resetRul":
                            node.currentRul = clampFloat(msg.rulValue, 0, 1e12, node.rulStartValue);
                            send({
                                payload: { success: true, action: "resetRul", rul: node.currentRul },
                                topic: "control"
                            });
                            done();
                            return;
                    }
                }

                // Skip if paused
                if (node.isPaused) {
                    done();
                    return;
                }

                // Extract features and label
                const extracted = extractFeatures(msg);
                const features = extracted.features;
                const values = extracted.values;

                if (Object.keys(features).length === 0) {
                    node.warn("No features extracted from message");
                    done();
                    return;
                }

                // Validate data
                const validation = validateSample(features, values);
                if (!validation.valid) {
                    if (node.validateData) {
                        node.warn("Invalid sample: " + validation.issues.join(", "));
                        done();
                        return;
                    }
                }

                // Update RUL if in RUL mode
                updateRul(msg);

                // Extract label
                const label = extractLabel(msg);
                const severity = extractSeverity(msg);

                // Track label classes
                if (label !== null && label !== undefined) {
                    node.labelClasses.add(String(label));
                }

                // Create sample
                const sample = {
                    timestamp: formatTimestamp(new Date()),
                    features: features,
                    values: values,
                    label: label,
                    severity: severity
                };

                // Update statistics
                updateStatistics(features);
                node.sampleCount++;

                // Handle based on mode
                if (node.mode === "streaming") {
                    // Streaming mode: immediately append to file (async, ordered)
                    appendToStream(
                        JSON.stringify({
                            timestamp: sample.timestamp,
                            features: values,
                            label: label,
                            severity: severity
                        }) + "\n"
                    );
                    node.dataBuffer.push(sample); // Also keep in buffer for stats

                    // Trim buffer to avoid memory issues
                    if (node.dataBuffer.length > node.bufferSize) {
                        node.dataBuffer.shift();
                    }
                } else if (node.mode === "timeseries") {
                    // Time-series mode: collect windows
                    node.windowBuffer.push(values);
                    node.windowLabels.push(label);

                    if (node.windowBuffer.length >= node.windowSize) {
                        // Create window sample
                        const windowSample = {
                            timestamp: formatTimestamp(new Date()),
                            features: node.windowBuffer.slice(),
                            label: node.windowLabels[node.windowLabels.length - 1], // Use last label
                            severity: severity
                        };

                        node.dataBuffer.push(windowSample);
                        enforceBufferCap();

                        // Slide window with overlap
                        // Always advance by at least one step: a small window
                        // with a high overlap rounds to 0, which would never
                        // slide and grow the window without bound.
                        const slideAmount = Math.max(1, Math.floor(node.windowSize * (1 - node.windowOverlap / 100)));
                        node.windowBuffer = node.windowBuffer.slice(slideAmount);
                        node.windowLabels = node.windowLabels.slice(slideAmount);
                    }
                } else {
                    // Batch mode: collect in buffer
                    node.dataBuffer.push(sample);
                    enforceBufferCap();
                }

                // Auto-save when buffer is full. After a failed export, wait out
                // a backoff instead of re-running the whole export (and logging
                // an error) on every single incoming message.
                if (node.autoSave && node.dataBuffer.length >= node.bufferSize && Date.now() >= autoSaveNotBefore) {
                    const exportResult = await performExport({ clearAfterExport: true });
                    if (exportResult.success) {
                        autoSaveFailures = 0;
                        autoSaveNotBefore = 0;
                        node.log(
                            "Auto-saved " +
                                exportResult.samples +
                                " samples to " +
                                (exportResult.files || []).join(", ")
                        );
                    } else {
                        autoSaveFailures++;
                        autoSaveNotBefore =
                            Date.now() +
                            Math.min(AUTOSAVE_RETRY_MAX_MS, AUTOSAVE_RETRY_BASE_MS * Math.pow(2, autoSaveFailures - 1));
                    }
                }

                updateStatus();
                done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "error" });
                done(err);
            }
        });

        // Cleanup on close
        node.on("close", async function (removed, done) {
            // Let queued stream appends and any running export finish first.
            await streamChain;
            await exportChain;

            // Save remaining data if configured
            if (node.flushOnDeploy && node.dataBuffer.length > 0) {
                try {
                    const result = await performExport({ clearAfterExport: false });
                    if (result.success) {
                        node.log("Saved " + result.samples + " samples on close");
                    }
                } catch (err) {
                    node.warn("Failed to save on close: " + err.message);
                }
            }

            node.dataBuffer = [];
            node.windowBuffer = [];
            node.windowLabels = [];
            node.status({});

            if (done) done();
        });
    }

    RED.nodes.registerType("training-data-collector", TrainingDataCollectorNode, {
        credentials: {
            s3AccessKeyId: { type: "text" },
            s3SecretAccessKey: { type: "password" }
        }
    });

    // ========================================
    // HTTP Admin Endpoints
    // ========================================

    // Get available datasets
    RED.httpAdmin.get(
        "/training-data-collector/datasets",
        needsPermission(RED, "training-data-collector.read"),
        function (req, res) {
            try {
                const dataDir = getDataDir(RED);
                if (!fs.existsSync(dataDir)) {
                    return res.json({ datasets: [], path: dataDir });
                }

                const files = fs.readdirSync(dataDir);
                const datasets = files
                    .filter(function (f) {
                        return (
                            f.endsWith(".csv") ||
                            f.endsWith(".json") ||
                            f.endsWith(".jsonl") ||
                            f.endsWith(".csv.gz") ||
                            f.endsWith(".json.gz") ||
                            f.endsWith(".jsonl.gz")
                        );
                    })
                    .map(function (f) {
                        // Skip anything that does not resolve inside dataDir
                        // (e.g. a symlink pointing elsewhere).
                        const checked = validatePath(path.join(dataDir, f), {
                            allowedBases: getAllowedBases(RED),
                            base: dataDir
                        });
                        if (!checked.ok) return null;
                        const stats = fs.statSync(checked.resolved);
                        return {
                            name: f,
                            path: path.join(dataDir, f),
                            size: stats.size,
                            modified: stats.mtime,
                            compressed: f.endsWith(".gz")
                        };
                    })
                    .filter(Boolean);

                res.json({ datasets: datasets, path: dataDir });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // Check S3 availability
    RED.httpAdmin.get(
        "/training-data-collector/s3-status",
        needsPermission(RED, "training-data-collector.read"),
        function (req, res) {
            res.json({
                available: S3Client !== null,
                message: S3Client ? "AWS SDK available" : "Install @aws-sdk/client-s3 for S3 support"
            });
        }
    );

    // Download dataset
    RED.httpAdmin.get(
        "/training-data-collector/download/:filename",
        needsPermission(RED, "training-data-collector.read"),
        function (req, res) {
            try {
                const dataDir = getDataDir(RED);
                // SECURITY: strip directory components to prevent path traversal
                // (e.g. ../../etc/passwd) via the :filename route parameter.
                const filename = path.basename(req.params.filename || "");
                const filePath = path.join(dataDir, filename);

                // Defence in depth: the resolved path (symlinks included) must
                // stay within dataDir.
                const checked = validatePath(filePath, { allowedBases: getAllowedBases(RED), base: dataDir });
                if (!filename || !checked.ok) {
                    return res.status(400).json({ error: "Invalid filename" });
                }

                if (!fs.existsSync(checked.resolved)) {
                    return res.status(404).json({ error: "File not found" });
                }

                res.download(checked.resolved, filename);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );
};
