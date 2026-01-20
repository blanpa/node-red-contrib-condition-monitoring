module.exports = function(RED) {
    "use strict";
    
    const fs = require('fs');
    const path = require('path');
    const zlib = require('zlib');
    const { promisify } = require('util');
    
    const gzip = promisify(zlib.gzip);
    const gunzip = promisify(zlib.gunzip);
    
    // Optional S3 support
    let S3Client = null;
    let PutObjectCommand = null;
    try {
        const awsSdk = require('@aws-sdk/client-s3');
        S3Client = awsSdk.S3Client;
        PutObjectCommand = awsSdk.PutObjectCommand;
    } catch (err) {
        // S3 not available - optional dependency
    }
    
    // Data directory relative to Node-RED userDir
    function getDataDir(RED) {
        return path.join(RED.settings.userDir || process.cwd(), 'training-data');
    }
    
    /**
     * Training Data Collector Node
     * Collects sensor data in formats suitable for ML training
     */
    function TrainingDataCollectorNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        // ========================================
        // Configuration
        // ========================================
        
        // Dataset settings
        this.datasetName = config.datasetName || "dataset";
        this.outputPath = config.outputPath || "";  // Relative to userDir/training-data
        this.mode = config.mode || "batch";  // streaming, batch, timeseries
        this.autoSave = config.autoSave !== false;
        
        // Feature configuration
        this.featureSource = config.featureSource || "payload";  // payload, payload.features, custom
        this.featureFields = config.featureFields ? 
            (Array.isArray(config.featureFields) ? config.featureFields : config.featureFields.split(',').map(s => s.trim()).filter(s => s)) : 
            [];
        this.includeTimestamp = config.includeTimestamp !== false;
        this.timestampFormat = config.timestampFormat || "iso";  // iso, unix, unix_ms
        
        // Label configuration
        this.labelMode = config.labelMode || "manual";  // manual, fromMessage, rul, unlabeled
        this.labelField = config.labelField || "label";
        this.severityField = config.severityField || "severity";
        this.rulStartValue = parseFloat(config.rulStartValue) || 100;
        this.rulUnit = config.rulUnit || "samples";  // samples, seconds, hours, days
        this.defaultLabel = config.defaultLabel || "normal";
        
        // Buffer settings
        this.bufferSize = parseInt(config.bufferSize) || 1000;
        this.windowSize = parseInt(config.windowSize) || 100;  // For timeseries mode
        this.windowOverlap = parseInt(config.windowOverlap) || 50;  // Percent
        this.flushOnDeploy = config.flushOnDeploy !== false;
        
        // Export settings
        this.exportFormat = config.exportFormat || "csv";  // csv, jsonl, json, npy
        this.compressionEnabled = config.compressionEnabled !== false;
        this.compressionThreshold = parseInt(config.compressionThreshold) || 10000;  // Samples before compression
        this.splitRatio = config.splitRatio || { train: 0.8, val: 0.1, test: 0.1 };
        this.shuffleOnExport = config.shuffleOnExport !== false;
        this.includeMetadata = config.includeMetadata !== false;
        
        // S3 settings
        this.s3Enabled = config.s3Enabled === true;
        this.s3Bucket = config.s3Bucket || "";
        this.s3Prefix = config.s3Prefix || "training-data/";
        this.s3Region = config.s3Region || "eu-central-1";
        // Credentials from node config or environment
        this.s3AccessKeyId = config.s3AccessKeyId || process.env.AWS_ACCESS_KEY_ID || "";
        this.s3SecretAccessKey = config.s3SecretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || "";
        
        // Data quality settings
        this.validateData = config.validateData !== false;
        this.removeOutliers = config.removeOutliers === true;
        this.outlierThreshold = parseFloat(config.outlierThreshold) || 5.0;  // Z-score threshold
        
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
                var classInfo = node.labelClasses.size > 0 ? " | " + node.labelClasses.size + " classes" : "";
                node.status({ fill: "green", shape: "dot", text: node.dataBuffer.length + "/" + node.bufferSize + classInfo });
            }
        }
        
        function getOutputDir() {
            var baseDir = getDataDir(RED);
            if (node.outputPath) {
                return path.join(baseDir, node.outputPath);
            }
            return baseDir;
        }
        
        function ensureOutputDir() {
            var dir = getOutputDir();
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
        
        function extractFeatures(msg) {
            var features = {};
            var values = [];
            
            if (node.featureSource === "custom" && node.featureFields.length > 0) {
                // Extract specific fields
                node.featureFields.forEach(function(field) {
                    var value = getNestedValue(msg, field);
                    if (value !== undefined && value !== null) {
                        features[field] = parseFloat(value) || 0;
                        values.push(features[field]);
                    }
                });
            } else if (node.featureSource === "payload.features") {
                // Features are in msg.payload.features
                var featData = msg.payload && msg.payload.features;
                if (Array.isArray(featData)) {
                    values = featData.map(function(v) { return parseFloat(v) || 0; });
                    featData.forEach(function(v, i) {
                        features["feature_" + i] = parseFloat(v) || 0;
                    });
                } else if (typeof featData === 'object') {
                    Object.keys(featData).forEach(function(key) {
                        features[key] = parseFloat(featData[key]) || 0;
                        values.push(features[key]);
                    });
                }
            } else {
                // Features are directly in payload
                if (Array.isArray(msg.payload)) {
                    values = msg.payload.map(function(v) { return parseFloat(v) || 0; });
                    msg.payload.forEach(function(v, i) {
                        features["feature_" + i] = parseFloat(v) || 0;
                    });
                } else if (typeof msg.payload === 'object' && msg.payload !== null) {
                    Object.keys(msg.payload).forEach(function(key) {
                        var val = msg.payload[key];
                        if (typeof val === 'number' || (typeof val === 'string' && !isNaN(parseFloat(val)))) {
                            features[key] = parseFloat(val) || 0;
                            values.push(features[key]);
                        }
                    });
                } else if (typeof msg.payload === 'number') {
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
            var parts = path.split('.');
            var current = obj;
            for (var i = 0; i < parts.length; i++) {
                if (current === undefined || current === null) return undefined;
                current = current[parts[i]];
            }
            return current;
        }
        
        function extractLabel(msg) {
            switch (node.labelMode) {
                case "fromMessage":
                    // Get label from message field
                    var label = getNestedValue(msg, node.labelField);
                    if (label === undefined || label === null) {
                        // Try common fields
                        label = msg.label || msg.class || msg.category || 
                                (msg.isAnomaly ? "anomaly" : null) ||
                                (msg.anomaly && msg.anomaly.isAnomaly ? "anomaly" : null);
                    }
                    return label !== undefined && label !== null ? String(label) : node.defaultLabel;
                    
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
            var severity = getNestedValue(msg, node.severityField);
            if (severity === undefined || severity === null) {
                severity = msg.severity || msg.score || 
                           (msg.anomaly && msg.anomaly.severity) || 0;
            }
            return parseFloat(severity) || 0;
        }
        
        function updateRul(msg) {
            if (node.labelMode !== "rul") return;
            
            switch (node.rulUnit) {
                case "samples":
                    node.currentRul = Math.max(0, node.currentRul - 1);
                    break;
                case "seconds":
                    if (node.lastTimestamp) {
                        var elapsed = (Date.now() - node.lastTimestamp) / 1000;
                        node.currentRul = Math.max(0, node.currentRul - elapsed);
                    }
                    break;
                case "hours":
                    if (node.lastTimestamp) {
                        var elapsed = (Date.now() - node.lastTimestamp) / 3600000;
                        node.currentRul = Math.max(0, node.currentRul - elapsed);
                    }
                    break;
                case "days":
                    if (node.lastTimestamp) {
                        var elapsed = (Date.now() - node.lastTimestamp) / 86400000;
                        node.currentRul = Math.max(0, node.currentRul - elapsed);
                    }
                    break;
            }
            node.lastTimestamp = Date.now();
        }
        
        function validateSample(features, values) {
            if (!node.validateData) return { valid: true };
            
            var issues = [];
            
            // Check for NaN/Infinity
            for (var i = 0; i < values.length; i++) {
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
            Object.keys(features).forEach(function(key) {
                var value = features[key];
                
                if (!node.statistics[key]) {
                    node.statistics[key] = {
                        count: 0,
                        sum: 0,
                        sumSquares: 0,
                        min: Infinity,
                        max: -Infinity
                    };
                }
                
                var stats = node.statistics[key];
                stats.count++;
                stats.sum += value;
                stats.sumSquares += value * value;
                stats.min = Math.min(stats.min, value);
                stats.max = Math.max(stats.max, value);
            });
        }
        
        function getStatisticsSummary() {
            var summary = {};
            
            Object.keys(node.statistics).forEach(function(key) {
                var stats = node.statistics[key];
                var mean = stats.sum / stats.count;
                var variance = (stats.sumSquares / stats.count) - (mean * mean);
                var std = Math.sqrt(Math.max(0, variance));
                
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
            var distribution = {};
            node.dataBuffer.forEach(function(sample) {
                var label = sample.label;
                if (label !== null && label !== undefined) {
                    distribution[label] = (distribution[label] || 0) + 1;
                }
            });
            return distribution;
        }
        
        function shuffleArray(array) {
            var result = array.slice();
            for (var i = result.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1));
                var temp = result[i];
                result[i] = result[j];
                result[j] = temp;
            }
            return result;
        }
        
        function splitData(data, ratio) {
            var shuffled = node.shuffleOnExport ? shuffleArray(data) : data;
            var total = shuffled.length;
            
            var trainSize = Math.floor(total * ratio.train);
            var valSize = Math.floor(total * ratio.val);
            
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
            
            var outputDir = ensureOutputDir();
            var headers = node.includeTimestamp ? ["timestamp"] : [];
            headers = headers.concat(node.featureNames);
            if (node.labelMode !== "unlabeled") {
                headers.push("label");
                headers.push("severity");
            }
            
            var lines = [headers.join(",")];
            
            data.forEach(function(sample) {
                var row = [];
                if (node.includeTimestamp) {
                    row.push(sample.timestamp);
                }
                node.featureNames.forEach(function(name) {
                    row.push(sample.features[name] !== undefined ? sample.features[name] : "");
                });
                if (node.labelMode !== "unlabeled") {
                    row.push(sample.label !== null ? sample.label : "");
                    row.push(sample.severity !== undefined ? sample.severity : "");
                }
                lines.push(row.join(","));
            });
            
            var content = lines.join("\n");
            var filePath = path.join(outputDir, filename);
            
            // Compress if enabled and over threshold
            if (node.compressionEnabled && data.length >= node.compressionThreshold) {
                var compressed = await gzip(Buffer.from(content, 'utf8'));
                filePath += '.gz';
                fs.writeFileSync(filePath, compressed);
            } else {
                fs.writeFileSync(filePath, content, 'utf8');
            }
            
            return filePath;
        }
        
        async function exportToJSONL(data, filename) {
            if (data.length === 0) return null;
            
            var outputDir = ensureOutputDir();
            var lines = data.map(function(sample) {
                var obj = {
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
            
            var content = lines.join("\n");
            var filePath = path.join(outputDir, filename);
            
            if (node.compressionEnabled && data.length >= node.compressionThreshold) {
                var compressed = await gzip(Buffer.from(content, 'utf8'));
                filePath += '.gz';
                fs.writeFileSync(filePath, compressed);
            } else {
                fs.writeFileSync(filePath, content, 'utf8');
            }
            
            return filePath;
        }
        
        async function exportToJSON(data, filename) {
            if (data.length === 0) return null;
            
            var outputDir = ensureOutputDir();
            
            var output = {
                datasetInfo: {
                    name: node.datasetName,
                    created: new Date().toISOString(),
                    samples: data.length,
                    features: node.featureNames,
                    classes: Array.from(node.labelClasses),
                    featureDimension: node.featureNames.length,
                    statistics: getStatisticsSummary()
                },
                data: data.map(function(sample) {
                    var obj = {
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
            
            var content = JSON.stringify(output, null, 2);
            var filePath = path.join(outputDir, filename);
            
            if (node.compressionEnabled && data.length >= node.compressionThreshold) {
                var compressed = await gzip(Buffer.from(content, 'utf8'));
                filePath += '.gz';
                fs.writeFileSync(filePath, compressed);
            } else {
                fs.writeFileSync(filePath, content, 'utf8');
            }
            
            return filePath;
        }
        
        async function exportMetadata(filename) {
            var outputDir = ensureOutputDir();
            
            var metadata = {
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
            
            var filePath = path.join(outputDir, filename);
            fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), 'utf8');
            
            return filePath;
        }
        
        async function uploadToS3(filePath, s3Key) {
            if (!node.s3Client || !node.s3Bucket) {
                throw new Error("S3 client not configured");
            }
            
            var fileContent = fs.readFileSync(filePath);
            var contentType = 'application/octet-stream';
            
            if (filePath.endsWith('.csv')) contentType = 'text/csv';
            else if (filePath.endsWith('.json')) contentType = 'application/json';
            else if (filePath.endsWith('.jsonl')) contentType = 'application/x-ndjson';
            else if (filePath.endsWith('.gz')) contentType = 'application/gzip';
            
            var command = new PutObjectCommand({
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
            
            var timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            var baseFilename = node.datasetName + "_" + timestamp;
            var exportedFiles = [];
            var s3Urls = [];
            
            try {
                node.status({ fill: "yellow", shape: "dot", text: "exporting..." });
                
                // Split data if ratio is configured
                var splits = {};
                if (node.splitRatio && (node.splitRatio.train < 1 || node.splitRatio.val > 0 || node.splitRatio.test > 0)) {
                    splits = splitData(node.dataBuffer, node.splitRatio);
                } else {
                    splits.train = node.dataBuffer;
                }
                
                // Export each split
                for (var splitName in splits) {
                    if (splits[splitName].length === 0) continue;
                    
                    var filename = baseFilename + (Object.keys(splits).length > 1 ? "_" + splitName : "");
                    var filePath = null;
                    
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
                                var s3Key = path.basename(filePath);
                                var s3Url = await uploadToS3(filePath, s3Key);
                                s3Urls.push(s3Url);
                            } catch (s3Err) {
                                node.warn("S3 upload failed: " + s3Err.message);
                            }
                        }
                    }
                }
                
                // Export metadata
                if (node.includeMetadata) {
                    var metaPath = await exportMetadata(baseFilename + "_metadata.json");
                    exportedFiles.push(metaPath);
                    
                    if (node.s3Enabled && node.s3Client) {
                        try {
                            var s3Url = await uploadToS3(metaPath, path.basename(metaPath));
                            s3Urls.push(s3Url);
                        } catch (s3Err) {
                            node.warn("S3 metadata upload failed: " + s3Err.message);
                        }
                    }
                }
                
                var result = {
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
        
        node.on('input', async function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };
            
            try {
                // Handle control actions
                if (msg.action) {
                    var result = null;
                    
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
                                bufferUsage: (node.dataBuffer.length / node.bufferSize * 100).toFixed(1) + "%",
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
                            send({ payload: { success: true, action: "resetRul", rul: node.currentRul }, topic: "control" });
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
                var extracted = extractFeatures(msg);
                var features = extracted.features;
                var values = extracted.values;
                
                if (Object.keys(features).length === 0) {
                    node.warn("No features extracted from message");
                    done();
                    return;
                }
                
                // Validate data
                var validation = validateSample(features, values);
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
                var label = extractLabel(msg);
                var severity = extractSeverity(msg);
                
                // Track label classes
                if (label !== null && label !== undefined) {
                    node.labelClasses.add(String(label));
                }
                
                // Create sample
                var sample = {
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
                    // Streaming mode: immediately append to file
                    var outputDir = ensureOutputDir();
                    var streamFile = path.join(outputDir, node.datasetName + "_stream.jsonl");
                    
                    var line = JSON.stringify({
                        timestamp: sample.timestamp,
                        features: values,
                        label: label,
                        severity: severity
                    }) + "\n";
                    
                    fs.appendFileSync(streamFile, line, 'utf8');
                    node.dataBuffer.push(sample);  // Also keep in buffer for stats
                    
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
                        var windowSample = {
                            timestamp: formatTimestamp(new Date()),
                            features: node.windowBuffer.slice(),
                            label: node.windowLabels[node.windowLabels.length - 1],  // Use last label
                            severity: severity
                        };
                        
                        node.dataBuffer.push(windowSample);
                        
                        // Slide window with overlap
                        var slideAmount = Math.floor(node.windowSize * (1 - node.windowOverlap / 100));
                        node.windowBuffer = node.windowBuffer.slice(slideAmount);
                        node.windowLabels = node.windowLabels.slice(slideAmount);
                    }
                    
                } else {
                    // Batch mode: collect in buffer
                    node.dataBuffer.push(sample);
                }
                
                // Auto-save when buffer is full
                if (node.autoSave && node.dataBuffer.length >= node.bufferSize) {
                    var exportResult = await performExport({ clearAfterExport: true });
                    if (exportResult.success) {
                        node.log("Auto-saved " + exportResult.samples + " samples to " + (exportResult.files || []).join(", "));
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
        node.on('close', async function(removed, done) {
            // Save remaining data if configured
            if (node.flushOnDeploy && node.dataBuffer.length > 0) {
                try {
                    var result = await performExport({ clearAfterExport: false });
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
    RED.httpAdmin.get("/training-data-collector/datasets", function(req, res) {
        try {
            var dataDir = getDataDir(RED);
            if (!fs.existsSync(dataDir)) {
                return res.json({ datasets: [], path: dataDir });
            }
            
            var files = fs.readdirSync(dataDir);
            var datasets = files.filter(function(f) {
                return f.endsWith('.csv') || f.endsWith('.json') || f.endsWith('.jsonl') || 
                       f.endsWith('.csv.gz') || f.endsWith('.json.gz') || f.endsWith('.jsonl.gz');
            }).map(function(f) {
                var filePath = path.join(dataDir, f);
                var stats = fs.statSync(filePath);
                return {
                    name: f,
                    path: filePath,
                    size: stats.size,
                    modified: stats.mtime,
                    compressed: f.endsWith('.gz')
                };
            });
            
            res.json({ datasets: datasets, path: dataDir });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    
    // Check S3 availability
    RED.httpAdmin.get("/training-data-collector/s3-status", function(req, res) {
        res.json({
            available: S3Client !== null,
            message: S3Client ? "AWS SDK available" : "Install @aws-sdk/client-s3 for S3 support"
        });
    });
    
    // Download dataset
    RED.httpAdmin.get("/training-data-collector/download/:filename", function(req, res) {
        try {
            var dataDir = getDataDir(RED);
            var filename = req.params.filename;
            var filePath = path.join(dataDir, filename);
            
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: "File not found" });
            }
            
            res.download(filePath);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};
