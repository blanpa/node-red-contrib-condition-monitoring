module.exports = function (RED) {
    "use strict";

    const fs = require("fs");
    const path = require("path");
    const zlib = require("zlib");
    const { promisify } = require("util");

    const gzip = promisify(zlib.gzip);

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
        this.datasetName = config.datasetName || "dataset";
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
        this.rulStartValue = parseFloat(config.rulStartValue) || 100;
        this.rulUnit = config.rulUnit || "samples"; // samples, seconds, hours, days
        this.defaultLabel = config.defaultLabel || "normal";

        // Buffer settings
        this.bufferSize = parseInt(config.bufferSize) || 1000;
        this.windowSize = parseInt(config.windowSize) || 100; // For timeseries mode
        this.windowOverlap = parseInt(config.windowOverlap) || 50; // Percent
        this.flushOnDeploy = config.flushOnDeploy !== false;

        // Export settings
        this.exportFormat = config.exportFormat || "csv"; // csv, jsonl, json, npy
        this.compressionEnabled = config.compressionEnabled !== false;
        this.compressionThreshold = parseInt(config.compressionThreshold) || 10000; // Samples before compression
        this.splitRatio = config.splitRatio || { train: 0.8, val: 0.1, test: 0.1 };
        this.shuffleOnExport = config.shuffleOnExport !== false;
        this.includeMetadata = config.includeMetadata !== false;

        // S3 settings
        this.s3Enabled = config.s3Enabled === true;
        this.s3Bucket = config.s3Bucket || "";
        this.s3Prefix = config.s3Prefix || "training-data/";
        this.s3Region = config.s3Region || "eu-central-1";
        // SECURITY: Credentials from environment variables only - never from node config
        // This prevents accidental exposure of credentials in flow exports
        this.s3AccessKeyId = process.env.AWS_ACCESS_KEY_ID || "";
        this.s3SecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || "";

        // Warn if credentials were provided in config (deprecated)
        if (config.s3AccessKeyId || config.s3SecretAccessKey) {
            node.warn(
                "S3 credentials in node config are deprecated and ignored for security. Use AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables instead."
            );
        }

        // Data quality settings
        this.validateData = config.validateData !== false;
        this.removeOutliers = config.removeOutliers === true;
        this.outlierThreshold = parseFloat(config.outlierThreshold) || 5.0; // Z-score threshold

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
        if (this.s3Enabled && S3Client && this.s3AccessKeyId && this.s3SecretAccessKey) {
            try {
                this.s3Client = new S3Client({
                    region: this.s3Region,
                    credentials: {
                        accessKeyId: this.s3AccessKeyId,
                        secretAccessKey: this.s3SecretAccessKey
                    }
                });
                node.log("S3 client initialized for bucket: " + this.s3Bucket);
            } catch (err) {
                node.warn("Failed to initialize S3 client: " + err.message);
            }
        } else if (this.s3Enabled && !S3Client) {
            node.warn("S3 upload enabled but @aws-sdk/client-s3 not installed. Run: npm install @aws-sdk/client-s3");
        }

        // Initial status
        updateStatus();

        // ========================================
        // Helper Functions
        // ========================================

        function updateStatus() {
            if (node.isPaused) {
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
                    const fullPath = path.join(baseDir, sanitized);
                    // SECURITY: Ensure the resolved path is still within baseDir
                    const resolvedPath = path.resolve(fullPath);
                    const resolvedBase = path.resolve(baseDir);
                    if (!resolvedPath.startsWith(resolvedBase)) {
                        node.warn("Output path attempted directory traversal. Using base directory.");
                        return baseDir;
                    }
                    return fullPath;
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
            const parsed = parseFloat(v);
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
                } else if (typeof featData === "object") {
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
                        if (typeof val === "number" || (typeof val === "string" && !isNaN(parseFloat(val)))) {
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

        function getLabelDistribution() {
            const distribution = {};
            node.dataBuffer.forEach(function (sample) {
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

        async function exportToCSV(data, filename) {
            if (data.length === 0) return null;

            const outputDir = ensureOutputDir();
            let headers = node.includeTimestamp ? ["timestamp"] : [];
            headers = headers.concat(node.featureNames);
            if (node.labelMode !== "unlabeled") {
                headers.push("label");
                headers.push("severity");
            }

            const lines = [headers.join(",")];

            data.forEach(function (sample) {
                const row = [];
                if (node.includeTimestamp) {
                    row.push(sample.timestamp);
                }
                node.featureNames.forEach(function (name) {
                    row.push(sample.features[name] !== undefined ? sample.features[name] : "");
                });
                if (node.labelMode !== "unlabeled") {
                    row.push(sample.label !== null ? sample.label : "");
                    row.push(sample.severity !== undefined ? sample.severity : "");
                }
                lines.push(row.join(","));
            });

            const content = lines.join("\n");
            let filePath = path.join(outputDir, filename);

            // Compress if enabled and over threshold
            if (node.compressionEnabled && data.length >= node.compressionThreshold) {
                const compressed = await gzip(Buffer.from(content, "utf8"));
                filePath += ".gz";
                fs.writeFileSync(filePath, compressed);
            } else {
                fs.writeFileSync(filePath, content, "utf8");
            }

            return filePath;
        }

        async function exportToJSONL(data, filename) {
            if (data.length === 0) return null;

            const outputDir = ensureOutputDir();
            const lines = data.map(function (sample) {
                const obj = {
                    features: sample.values || Object.values(sample.features)
                };
                if (node.includeTimestamp) {
                    obj.timestamp = sample.timestamp;
                }
                if (node.labelMode !== "unlabeled" && sample.label !== null) {
                    obj.label = sample.label;
                }
                if (sample.severity !== undefined && sample.severity !== 0) {
                    obj.severity = sample.severity;
                }
                return JSON.stringify(obj);
            });

            const content = lines.join("\n");
            let filePath = path.join(outputDir, filename);

            if (node.compressionEnabled && data.length >= node.compressionThreshold) {
                const compressed = await gzip(Buffer.from(content, "utf8"));
                filePath += ".gz";
                fs.writeFileSync(filePath, compressed);
            } else {
                fs.writeFileSync(filePath, content, "utf8");
            }

            return filePath;
        }

        async function exportToJSON(data, filename) {
            if (data.length === 0) return null;

            const outputDir = ensureOutputDir();

            const output = {
                datasetInfo: {
                    name: node.datasetName,
                    created: new Date().toISOString(),
                    samples: data.length,
                    features: node.featureNames,
                    classes: Array.from(node.labelClasses),
                    featureDimension: node.featureNames.length,
                    statistics: getStatisticsSummary()
                },
                data: data.map(function (sample) {
                    const obj = {
                        x: sample.values || Object.values(sample.features)
                    };
                    if (node.labelMode !== "unlabeled" && sample.label !== null) {
                        obj.y = sample.label;
                    }
                    if (sample.severity !== undefined && sample.severity !== 0) {
                        obj.severity = sample.severity;
                    }
                    return obj;
                })
            };

            const content = JSON.stringify(output, null, 2);
            let filePath = path.join(outputDir, filename);

            if (node.compressionEnabled && data.length >= node.compressionThreshold) {
                const compressed = await gzip(Buffer.from(content, "utf8"));
                filePath += ".gz";
                fs.writeFileSync(filePath, compressed);
            } else {
                fs.writeFileSync(filePath, content, "utf8");
            }

            return filePath;
        }

        async function exportMetadata(filename) {
            const outputDir = ensureOutputDir();

            const metadata = {
                datasetInfo: {
                    name: node.datasetName,
                    created: new Date().toISOString(),
                    sessionStart: new Date(node.sessionStart).toISOString(),
                    totalSamples: node.sampleCount,
                    exportedSamples: node.dataBuffer.length
                },
                features: {
                    names: node.featureNames,
                    count: node.featureNames.length,
                    statistics: getStatisticsSummary()
                },
                labels: {
                    mode: node.labelMode,
                    classes: Array.from(node.labelClasses),
                    distribution: getLabelDistribution()
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
                    exported: node.dataBuffer.length,
                    validationEnabled: node.validateData
                }
            };

            const filePath = path.join(outputDir, filename);
            fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), "utf8");

            return filePath;
        }

        async function uploadToS3(filePath, s3Key) {
            if (!node.s3Client || !node.s3Bucket) {
                throw new Error("S3 client not configured");
            }

            const fileContent = fs.readFileSync(filePath);
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

        async function performExport(msg) {
            if (node.dataBuffer.length === 0) {
                return {
                    success: false,
                    error: "No data to export",
                    samples: 0
                };
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const baseFilename = node.datasetName + "_" + timestamp;
            const exportedFiles = [];
            const s3Urls = [];

            try {
                node.status({ fill: "yellow", shape: "dot", text: "exporting..." });

                // Split data if ratio is configured
                let splits = {};
                if (
                    node.splitRatio &&
                    (node.splitRatio.train < 1 || node.splitRatio.val > 0 || node.splitRatio.test > 0)
                ) {
                    splits = splitData(node.dataBuffer, node.splitRatio);
                } else {
                    splits.train = node.dataBuffer;
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
                                node.warn("S3 upload failed: " + s3Err.message);
                            }
                        }
                    }
                }

                // Export metadata
                if (node.includeMetadata) {
                    const metaPath = await exportMetadata(baseFilename + "_metadata.json");
                    exportedFiles.push(metaPath);

                    if (node.s3Enabled && node.s3Client) {
                        try {
                            const s3Url = await uploadToS3(metaPath, path.basename(metaPath));
                            s3Urls.push(s3Url);
                        } catch (s3Err) {
                            node.warn("S3 metadata upload failed: " + s3Err.message);
                        }
                    }
                }

                const result = {
                    success: true,
                    samples: node.dataBuffer.length,
                    files: exportedFiles,
                    splits: {
                        train: splits.train ? splits.train.length : 0,
                        val: splits.val ? splits.val.length : 0,
                        test: splits.test ? splits.test.length : 0
                    },
                    labelDistribution: getLabelDistribution(),
                    statistics: getStatisticsSummary(),
                    features: node.featureNames,
                    classes: Array.from(node.labelClasses)
                };

                if (s3Urls.length > 0) {
                    result.s3Urls = s3Urls;
                }

                // Clear buffer after successful export if autoSave
                if (msg && msg.clearAfterExport !== false) {
                    node.dataBuffer = [];
                }

                updateStatus();
                return result;
            } catch (err) {
                node.error("Export failed: " + err.message);
                updateStatus();
                return {
                    success: false,
                    error: err.message,
                    samples: node.dataBuffer.length
                };
            }
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
                            node.currentRul = msg.rulValue !== undefined ? msg.rulValue : node.rulStartValue;
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
                    // Streaming mode: immediately append to file (async)
                    const outputDir = ensureOutputDir();
                    const streamFile = path.join(outputDir, node.datasetName + "_stream.jsonl");

                    const line =
                        JSON.stringify({
                            timestamp: sample.timestamp,
                            features: values,
                            label: label,
                            severity: severity
                        }) + "\n";

                    // PERFORMANCE: Use async file I/O to avoid blocking the event loop
                    fs.promises.appendFile(streamFile, line, "utf8").catch(function (err) {
                        node.warn("Failed to append to stream file: " + err.message);
                    });
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
                        const slideAmount = Math.floor(node.windowSize * (1 - node.windowOverlap / 100));
                        node.windowBuffer = node.windowBuffer.slice(slideAmount);
                        node.windowLabels = node.windowLabels.slice(slideAmount);
                    }
                } else {
                    // Batch mode: collect in buffer
                    node.dataBuffer.push(sample);
                    enforceBufferCap();
                }

                // Auto-save when buffer is full
                if (node.autoSave && node.dataBuffer.length >= node.bufferSize) {
                    const exportResult = await performExport({ clearAfterExport: true });
                    if (exportResult.success) {
                        node.log(
                            "Auto-saved " +
                                exportResult.samples +
                                " samples to " +
                                (exportResult.files || []).join(", ")
                        );
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

    RED.nodes.registerType("training-data-collector", TrainingDataCollectorNode);

    // ========================================
    // HTTP Admin Endpoints
    // ========================================

    // Get available datasets
    RED.httpAdmin.get("/training-data-collector/datasets", function (req, res) {
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
                    const filePath = path.join(dataDir, f);
                    const stats = fs.statSync(filePath);
                    return {
                        name: f,
                        path: filePath,
                        size: stats.size,
                        modified: stats.mtime,
                        compressed: f.endsWith(".gz")
                    };
                });

            res.json({ datasets: datasets, path: dataDir });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Check S3 availability
    RED.httpAdmin.get("/training-data-collector/s3-status", function (req, res) {
        res.json({
            available: S3Client !== null,
            message: S3Client ? "AWS SDK available" : "Install @aws-sdk/client-s3 for S3 support"
        });
    });

    // Download dataset
    RED.httpAdmin.get("/training-data-collector/download/:filename", function (req, res) {
        try {
            const dataDir = getDataDir(RED);
            const filename = req.params.filename;
            const filePath = path.join(dataDir, filename);

            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: "File not found" });
            }

            res.download(filePath);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};
