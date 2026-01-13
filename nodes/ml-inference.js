module.exports = function(RED) {
    "use strict";
    
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const https = require('https');
    const http = require('http');
    
    // Import persistent Python bridge
    const { getGlobalBridge, shutdownGlobalBridge } = require('./python-bridge-manager');
    
    // Model storage directory
    const MODELS_DIR = path.join(RED.settings.userDir || os.homedir(), 'ml-models');
    
    // Global Python bridge instance (shared across all ml-inference nodes)
    let pythonBridge = null;
    let pythonBridgeReady = false;
    let pythonBridgeError = null;
    
    // Initialize Python bridge on first node creation
    async function ensurePythonBridge() {
        if (pythonBridge && pythonBridgeReady) {
            return pythonBridge;
        }
        
        if (pythonBridgeError) {
            throw pythonBridgeError;
        }
        
        if (!pythonBridge) {
            pythonBridge = getGlobalBridge();
            
            pythonBridge.on('stderr', (msg) => {
                // Log Python stderr for debugging
                if (msg && !msg.includes('FutureWarning') && !msg.includes('DeprecationWarning')) {
                    RED.log.debug('[PythonBridge] ' + msg);
                }
            });
            
            pythonBridge.on('exit', (info) => {
                RED.log.warn('[PythonBridge] Exited: ' + JSON.stringify(info));
                pythonBridgeReady = false;
                // Will auto-restart on next request
            });
            
            try {
                await pythonBridge.start();
                pythonBridgeReady = true;
                RED.log.info('[PythonBridge] Started successfully');
            } catch (err) {
                pythonBridgeError = err;
                pythonBridge = null;
                throw err;
            }
        }
        
        return pythonBridge;
    }
    
    // Shutdown bridge on Node-RED close
    // Use once() to prevent multiple registrations across test runs
    // Store handler reference for proper cleanup
    if (!RED._pythonBridgeShutdownHandler) {
        RED._pythonBridgeShutdownHandler = async function() {
            if (pythonBridge) {
                try {
                    await shutdownGlobalBridge();
                    RED.log.info('[PythonBridge] Shutdown complete');
                } catch (err) {
                    RED.log.warn('[PythonBridge] Shutdown error: ' + err.message);
                }
                pythonBridge = null;
                pythonBridgeReady = false;
            }
            // Reset handler reference after execution
            RED._pythonBridgeShutdownHandler = null;
        };
        RED.events.once('flows:stopped', RED._pythonBridgeShutdownHandler);
    }
    
    // Model Metadata Management
    function getModelMetadataPath(modelPath) {
        const dir = path.dirname(modelPath);
        const basename = path.basename(modelPath, path.extname(modelPath));
        return path.join(dir, basename + '_metadata.json');
    }
    
    function loadModelMetadata(modelPath) {
        try {
            const metadataPath = getModelMetadataPath(modelPath);
            if (fs.existsSync(metadataPath)) {
                const metadataContent = fs.readFileSync(metadataPath, 'utf8');
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
            fs.writeFileSync(metadataPath, metadataContent, 'utf8');
            return true;
        } catch (err) {
            return false;
        }
    }
    
    // Hugging Face Hub API
    async function downloadFromHuggingFace(modelId, revision, token, targetPath) {
        const hfFilesUrl = `https://huggingface.co/${modelId}/resolve/${revision}/`;
        
        try {
            // Try to find model.json (TensorFlow.js) or .onnx file
            const possibleFiles = ['model.json', 'model.onnx', 'pytorch_model.bin'];
            
            for (const file of possibleFiles) {
                try {
                    const fileUrl = hfFilesUrl + file;
                    await downloadFile(fileUrl, token ? 'bearer' : 'none', token || '', targetPath);
                    return targetPath;
                } catch (e) {
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
    async function downloadFromMLflow(registryUri, modelName, version, stage, token, targetPath) {
        try {
            const baseUrl = registryUri.replace(/\/$/, '');
            let modelUri = null;
            
            const protocol = https;
            const options = {
                headers: {
                    'Content-Type': 'application/json'
                }
            };
            
            if (token) {
                options.headers['Authorization'] = 'Bearer ' + token;
            }
            
            // Get model version URI
            let apiUrl;
            if (version && version !== 'latest') {
                apiUrl = `${baseUrl}/api/2.0/mlflow/model-versions/get?name=${encodeURIComponent(modelName)}&version=${version}`;
            } else if (stage) {
                apiUrl = `${baseUrl}/api/2.0/mlflow/latest-versions/get?name=${encodeURIComponent(modelName)}&stages=${stage}`;
            } else {
                apiUrl = `${baseUrl}/api/2.0/mlflow/latest-versions/get?name=${encodeURIComponent(modelName)}`;
            }
            
            const modelInfo = await new Promise((resolve, reject) => {
                protocol.get(apiUrl, options, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            try {
                                resolve(JSON.parse(data));
                            } catch (e) {
                                reject(new Error('Invalid JSON response from MLflow'));
                            }
                        } else {
                            reject(new Error(`MLflow API error: ${res.statusCode} ${res.statusMessage}`));
                        }
                    });
                }).on('error', reject);
            });
            
            modelUri = modelInfo.model_version?.source || modelInfo.model_versions?.[0]?.source;
            
            if (!modelUri) {
                throw new Error('Could not get model URI from MLflow');
            }
            
            // Download model from MLflow storage
            await downloadFile(modelUri, token ? 'bearer' : 'none', token || '', targetPath);
            return targetPath;
        } catch (err) {
            throw new Error(`Failed to download from MLflow: ${err.message}`);
        }
    }
    
    // Custom Registry API
    async function downloadFromCustomRegistry(registryUrl, modelId, apiKey, targetPath) {
        try {
            const apiUrl = `${registryUrl.replace(/\/$/, '')}/models/${encodeURIComponent(modelId)}/download`;
            await downloadFile(apiUrl, apiKey ? 'bearer' : 'none', apiKey || '', targetPath);
            return targetPath;
        } catch (err) {
            throw new Error(`Failed to download from custom registry: ${err.message}`);
        }
    }
    
    // Download file with authentication
    async function downloadFile(url, authType, authToken, targetPath) {
        return new Promise((resolve, reject) => {
            const protocol = url.startsWith('https') ? https : http;
            
            const options = {
                headers: {}
            };
            
            // Add authentication headers
            if (authType === 'bearer' && authToken) {
                options.headers['Authorization'] = 'Bearer ' + authToken;
            } else if (authType === 'basic' && authToken) {
                options.headers['Authorization'] = 'Basic ' + Buffer.from(authToken).toString('base64');
            }
            
            const file = fs.createWriteStream(targetPath);
            
            protocol.get(url, options, (response) => {
                if (response.statusCode === 301 || response.statusCode === 302) {
                    // Handle redirect
                    return downloadFile(response.headers.location, authType, authToken, targetPath)
                        .then(resolve)
                        .catch(reject);
                }
                
                if (response.statusCode !== 200) {
                    file.close();
                    fs.unlinkSync(targetPath);
                    reject(new Error(`Failed to download: ${response.statusCode} ${response.statusMessage}`));
                    return;
                }
                
                response.pipe(file);
                
                file.on('finish', () => {
                    file.close();
                    resolve(targetPath);
                });
            }).on('error', (err) => {
                file.close();
                if (fs.existsSync(targetPath)) {
                    fs.unlinkSync(targetPath);
                }
                reject(err);
            });
        });
    }
    
    // Lazy-load ML runtimes
    let tf = null;
    let ort = null;
    
    function loadTensorFlowJS() {
        if (tf === null) {
            try {
                tf = require('@tensorflow/tfjs-node');
            } catch (err) {
                try {
                    // Fallback to CPU-only version
                    tf = require('@tensorflow/tfjs');
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
                ort = require('onnxruntime-node');
            } catch (err) {
                return null;
            }
        }
        return ort;
    }
    
    function MLInferenceNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        // Configuration
        this.modelSource = config.modelSource || "local"; // local, url, huggingface, mlflow, custom
        this.modelPath = config.modelPath || "";
        this.modelType = config.modelType || "auto"; // auto, tfjs, onnx, coral
        this.inputShape = config.inputShape || ""; // e.g., "1,10" for batch of 10 features
        this.outputProperty = config.outputProperty || "prediction";
        this.inputProperty = config.inputProperty || "payload";
        this.preprocessMode = config.preprocessMode || "array"; // array, object, flatten
        this.batchSize = parseInt(config.batchSize) || 1;
        this.warmup = config.warmup !== false;
        
        // URL Authentication (for Phase 1)
        this.urlAuthType = config.urlAuthType || ""; // bearer, basic, none
        this.urlAuthToken = config.urlAuthToken || ""; // Bearer token or Basic auth credentials
        
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
        this.updateCheckInterval = parseInt(config.updateCheckInterval) || 3600; // seconds
        this.modelStage = config.modelStage || "production"; // development, staging, production, deprecated, archived
        
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
                if (node.modelSource === 'huggingface' || node.modelSource === 'mlflow' || node.modelSource === 'custom') {
                    try {
                        node.status({ fill: "yellow", shape: "dot", text: "checking for updates..." });
                        // Re-initialize model to check for updates
                        await initializeModel();
                    } catch (err) {
                        node.warn("Auto-update check failed: " + err.message);
                    }
                }
            }, node.updateCheckInterval * 1000);
        }
        
        // Parse input shape
        function parseShape(shapeStr) {
            if (!shapeStr || shapeStr.trim() === "") return null;
            
            // Remove brackets if present: "[1,8]" -> "1,8"
            let cleaned = shapeStr.trim();
            if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
                cleaned = cleaned.slice(1, -1);
            }
            
            if (cleaned === "") return null;
            
            const parts = cleaned.split(',').map(s => {
                // Remove any remaining brackets or whitespace
                const trimmed = s.trim().replace(/[\[\]]/g, '');
                const n = parseInt(trimmed);
                return isNaN(n) ? 1 : Math.max(1, n); // Default to 1 for invalid/dynamic dimensions
            });
            
            // Filter out invalid entries
            return parts.filter(n => n > 0);
        }
        
        // Detect model type from path
        function detectModelType(modelPath) {
            if (!modelPath) return null;
            
            const ext = path.extname(modelPath).toLowerCase();
            const basename = path.basename(modelPath).toLowerCase();
            
            if (ext === '.onnx') return 'onnx';
            if (ext === '.tflite') return 'tflite';
            if (ext === '.keras') return 'keras';
            if (ext === '.h5') return 'keras';
            if (ext === '.pkl') return 'sklearn';
            if (ext === '.joblib') return 'sklearn';
            if (ext === '.json' && basename === 'model.json') return 'tfjs';
            if (basename === 'model.json') return 'tfjs';
            if (ext === '.json') return 'tfjs';
            
            // Check if it's a directory (SavedModel or tfjs)
            try {
                if (fs.existsSync(modelPath) && fs.statSync(modelPath).isDirectory()) {
                    // Check for tfjs model.json
                    if (fs.existsSync(path.join(modelPath, 'model.json'))) {
                        return 'tfjs';
                    }
                    // Check for SavedModel
                    if (fs.existsSync(path.join(modelPath, 'saved_model.pb'))) {
                        return 'savedmodel';
                    }
                }
            } catch (e) {
                // Ignore errors
            }
            
            return null;
        }
        
        // Load TensorFlow.js model
        async function loadTFJSModel(modelPath, authType, authToken) {
            const tensorflow = loadTensorFlowJS();
            if (!tensorflow) {
                throw new Error("TensorFlow.js not available. Install: npm install @tensorflow/tfjs-node");
            }
            
            let model;
            let actualPath = modelPath;
            
            // Determine how to load based on path
            if (modelPath.startsWith('http://') || modelPath.startsWith('https://')) {
                // URL-based loading - download first if authentication is needed
                if (authType && authToken) {
                    // Download to cache first
                    const urlObj = new URL(modelPath);
                    const filename = path.basename(urlObj.pathname) || 'model_' + Date.now() + '.json';
                    const cachePath = path.join(MODELS_DIR, 'cache', filename);
                    
                    // Ensure cache directory exists
                    const cacheDir = path.dirname(cachePath);
                    if (!fs.existsSync(cacheDir)) {
                        fs.mkdirSync(cacheDir, { recursive: true });
                    }
                    
                    // Download file
                    await downloadFile(modelPath, authType, authToken, cachePath);
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
                const fullPath = path.isAbsolute(modelPath) ? modelPath : path.join(process.cwd(), modelPath);
                
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
                    // Directory - check for model.json or saved_model.pb
                    const modelJsonPath = path.join(fullPath, 'model.json');
                    const savedModelPath = fullPath;
                    
                    if (fs.existsSync(modelJsonPath)) {
                        try {
                            model = await tensorflow.loadGraphModel('file://' + modelJsonPath);
                        } catch (e) {
                            model = await tensorflow.loadLayersModel('file://' + modelJsonPath);
                        }
                    } else if (fs.existsSync(path.join(fullPath, 'saved_model.pb'))) {
                        model = await tensorflow.node.loadSavedModel(savedModelPath);
                    } else {
                        throw new Error("No model.json or saved_model.pb found in directory");
                    }
                } else {
                    // Single file (model.json)
                    const fileUrl = 'file://' + fullPath;
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
        async function loadONNXModel(modelPath, authType, authToken) {
            const onnxruntime = loadONNXRuntime();
            if (!onnxruntime) {
                throw new Error("ONNX Runtime not available. Install: npm install onnxruntime-node");
            }
            
            let actualPath = modelPath;
            
            // Handle URL-based loading
            if (modelPath.startsWith('http://') || modelPath.startsWith('https://')) {
                // Download to cache first (ONNX Runtime needs local files)
                const urlObj = new URL(modelPath);
                const filename = path.basename(urlObj.pathname) || 'model_' + Date.now() + '.onnx';
                const cachePath = path.join(MODELS_DIR, 'cache', filename);
                
                // Ensure cache directory exists
                const cacheDir = path.dirname(cachePath);
                if (!fs.existsSync(cacheDir)) {
                    fs.mkdirSync(cacheDir, { recursive: true });
                }
                
                // Download file
                await downloadFile(modelPath, authType || 'none', authToken || '', cachePath);
                actualPath = cachePath;
            }
            
            const fullPath = path.isAbsolute(actualPath) ? actualPath : path.join(process.cwd(), actualPath);
            
            if (!fs.existsSync(fullPath)) {
                throw new Error("ONNX model file not found: " + fullPath);
            }
            
            const session = await onnxruntime.InferenceSession.create(fullPath);
            return session;
        }
        
        // Load TFLite/Coral model using persistent Python bridge
        async function loadCoralModel(modelPath) {
            const fullPath = path.isAbsolute(modelPath) ? modelPath : path.join(process.cwd(), modelPath);
            
            if (!fs.existsSync(fullPath)) {
                throw new Error("TFLite model file not found: " + fullPath);
            }
            
            // Get or start the persistent Python bridge
            const bridge = await ensurePythonBridge();
            
            // Generate a unique model ID for this node
            const modelId = 'tflite_' + path.basename(fullPath) + '_' + node.id;
            
            // Load model into the persistent bridge
            await bridge.loadModel(fullPath, modelId);
            
            return {
                type: 'tflite',
                modelPath: fullPath,
                modelId: modelId,
                usePersistentBridge: true,
                predict: async function(inputData) {
                    const bridge = await ensurePythonBridge();
                    return bridge.predict(modelId, inputData);
                },
                unload: async function() {
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
            const fullPath = path.isAbsolute(modelPath) ? modelPath : path.join(process.cwd(), modelPath);
            
            if (!fs.existsSync(fullPath)) {
                throw new Error("Keras model file not found: " + fullPath);
            }
            
            // Get or start the persistent Python bridge
            const bridge = await ensurePythonBridge();
            
            // Generate a unique model ID for this node
            const modelId = 'keras_' + path.basename(fullPath) + '_' + node.id;
            
            // Load model into the persistent bridge
            await bridge.loadModel(fullPath, modelId);
            
            return {
                type: 'keras',
                modelPath: fullPath,
                modelId: modelId,
                usePersistentBridge: true,
                predict: async function(inputData) {
                    const bridge = await ensurePythonBridge();
                    return bridge.predict(modelId, inputData);
                },
                unload: async function() {
                    try {
                        const bridge = await ensurePythonBridge();
                        await bridge.unloadModel(modelId);
                    } catch (err) {
                        // Ignore unload errors
                    }
                }
            };
        }
        
        // Load scikit-learn model (.pkl, .joblib) using persistent Python bridge
        async function loadSklearnModel(modelPath) {
            const fullPath = path.isAbsolute(modelPath) ? modelPath : path.join(process.cwd(), modelPath);
            
            if (!fs.existsSync(fullPath)) {
                throw new Error("scikit-learn model file not found: " + fullPath);
            }
            
            // Get or start the persistent Python bridge
            const bridge = await ensurePythonBridge();
            
            // Generate a unique model ID for this node
            const modelId = 'sklearn_' + path.basename(fullPath) + '_' + node.id;
            
            // Load model into the persistent bridge
            await bridge.loadModel(fullPath, modelId);
            
            return {
                type: 'sklearn',
                modelPath: fullPath,
                modelId: modelId,
                usePersistentBridge: true,
                predict: async function(inputData) {
                    const bridge = await ensurePythonBridge();
                    return bridge.predict(modelId, inputData);
                },
                unload: async function() {
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
        async function initializeModel() {
            // Check if model source is configured
            if (node.modelSource === 'huggingface' && !node.hfModelId) {
                node.status({ fill: "grey", shape: "ring", text: "no Hugging Face model ID" });
                return;
            }
            if (node.modelSource === 'mlflow' && !node.mlflowModelName) {
                node.status({ fill: "grey", shape: "ring", text: "no MLflow model name" });
                return;
            }
            if (node.modelSource === 'custom' && !node.customModelId) {
                node.status({ fill: "grey", shape: "ring", text: "no custom model ID" });
                return;
            }
            if ((node.modelSource === 'local' || node.modelSource === 'url') && !node.modelPath) {
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
                if (node.modelSource === 'huggingface') {
                    // Download from Hugging Face Hub
                    const cacheDir = path.join(MODELS_DIR, 'cache', 'hf');
                    if (!fs.existsSync(cacheDir)) {
                        fs.mkdirSync(cacheDir, { recursive: true });
                    }
                    const safeModelId = node.hfModelId.replace(/[^a-zA-Z0-9._-]/g, '_');
                    const cachePath = path.join(cacheDir, safeModelId + '_' + node.hfRevision + '.model');
                    
                    await downloadFromHuggingFace(node.hfModelId, node.hfRevision, node.hfToken, cachePath);
                    actualModelPath = cachePath;
                    authType = node.hfToken ? 'bearer' : null;
                    authToken = node.hfToken || null;
                    
                    // Create metadata from HF model
                    metadata = {
                        name: node.hfModelId,
                        version: node.hfRevision,
                        type: 'auto',
                        source: 'huggingface',
                        downloaded: new Date().toISOString()
                    };
                    
                } else if (node.modelSource === 'mlflow') {
                    // Download from MLflow Registry
                    const cacheDir = path.join(MODELS_DIR, 'cache', 'mlflow');
                    if (!fs.existsSync(cacheDir)) {
                        fs.mkdirSync(cacheDir, { recursive: true });
                    }
                    const safeModelName = node.mlflowModelName.replace(/[^a-zA-Z0-9._-]/g, '_');
                    const versionStr = node.mlflowVersion === 'latest' ? 'latest' : node.mlflowVersion;
                    const cachePath = path.join(cacheDir, safeModelName + '_' + versionStr + '.model');
                    
                    await downloadFromMLflow(node.mlflowRegistryUri, node.mlflowModelName, node.mlflowVersion, node.mlflowStage, node.mlflowAuthToken, cachePath);
                    actualModelPath = cachePath;
                    authType = node.mlflowAuthToken ? 'bearer' : null;
                    authToken = node.mlflowAuthToken || null;
                    
                    // Create metadata from MLflow
                    metadata = {
                        name: node.mlflowModelName,
                        version: node.mlflowVersion,
                        stage: node.mlflowStage,
                        type: 'auto',
                        source: 'mlflow',
                        downloaded: new Date().toISOString()
                    };
                    
                } else if (node.modelSource === 'custom') {
                    // Download from Custom Registry
                    const cacheDir = path.join(MODELS_DIR, 'cache', 'custom');
                    if (!fs.existsSync(cacheDir)) {
                        fs.mkdirSync(cacheDir, { recursive: true });
                    }
                    const safeModelId = node.customModelId.replace(/[^a-zA-Z0-9._-]/g, '_');
                    const cachePath = path.join(cacheDir, safeModelId + '.model');
                    
                    await downloadFromCustomRegistry(node.customRegistryUrl, node.customModelId, node.customApiKey, cachePath);
                    actualModelPath = cachePath;
                    authType = node.customApiKey ? 'bearer' : null;
                    authToken = node.customApiKey || null;
                    
                    // Create metadata from custom registry
                    metadata = {
                        name: node.customModelId,
                        version: "1.0.0",
                        type: 'auto',
                        source: 'custom',
                        downloaded: new Date().toISOString()
                    };
                    
                } else if (node.modelSource === 'url') {
                    // URL-based loading (already handled in load functions)
                    authType = node.urlAuthType || null;
                    authToken = node.urlAuthToken || null;
                } else {
                    // Local file - load metadata if available
                    if (actualModelPath && !actualModelPath.startsWith('http')) {
                        metadata = loadModelMetadata(actualModelPath);
                    }
                }
                
                // Detect model type
                let modelType = node.modelType;
                if (modelType === 'auto') {
                    modelType = detectModelType(actualModelPath);
                    if (!modelType) {
                        throw new Error("Could not detect model type. Please specify tfjs or onnx.");
                    }
                }
                
                node.modelFormat = modelType;
                
                if (modelType === 'tfjs') {
                    node.model = await loadTFJSModel(node.modelPath, authType, authToken);
                    node.modelLoaded = true;
                    
                    // Warmup run
                    if (node.warmup && node.model.predict) {
                        const shape = parseShape(node.inputShape) || [1, 1];
                        const tensorflow = loadTensorFlowJS();
                        const dummyInput = tensorflow.zeros(shape);
                        try {
                            const result = node.model.predict(dummyInput);
                            if (result.dispose) result.dispose();
                        } catch (e) {
                            // Ignore warmup errors
                        }
                        dummyInput.dispose();
                    }
                    
                    node.status({ fill: "green", shape: "dot", text: "tfjs ready" });
                    
                } else if (modelType === 'onnx') {
                    node.model = await loadONNXModel(actualModelPath, authType, authToken);
                    node.modelLoaded = true;
                    
                    // Get input/output names
                    node.inputNames = node.model.inputNames || [];
                    node.outputNames = node.model.outputNames || [];
                    
                    node.status({ fill: "green", shape: "dot", text: "onnx ready" });
                    
                } else if (modelType === 'coral') {
                    node.model = await loadCoralModel(actualModelPath);
                    node.modelLoaded = true;
                    node.status({ fill: "green", shape: "dot", text: "coral ready" });
                } else if (modelType === 'tflite') {
                    // TFLite models use Coral/Python bridge for inference
                    node.model = await loadCoralModel(actualModelPath);
                    node.modelLoaded = true;
                    node.status({ fill: "green", shape: "dot", text: "tflite ready" });
                } else if (modelType === 'savedmodel') {
                    // TensorFlow SavedModel uses TF.js loader
                    node.model = await loadTFJSModel(node.modelPath, authType, authToken);
                    node.modelLoaded = true;
                    node.status({ fill: "green", shape: "dot", text: "savedmodel ready" });
                } else if (modelType === 'keras') {
                    // Keras models (.keras, .h5) use Python bridge
                    node.model = await loadKerasModel(actualModelPath);
                    node.modelLoaded = true;
                    node.status({ fill: "green", shape: "dot", text: "keras ready" });
                } else if (modelType === 'sklearn') {
                    // scikit-learn models (.pkl, .joblib) use Python bridge
                    node.model = await loadSklearnModel(actualModelPath);
                    node.modelLoaded = true;
                    node.status({ fill: "green", shape: "dot", text: "sklearn ready" });
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
                    if (actualModelPath && !actualModelPath.startsWith('http')) {
                        saveModelMetadata(actualModelPath, updatedMetadata);
                    }
                } else if (actualModelPath && !actualModelPath.startsWith('http')) {
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
                
                node.log("Model loaded successfully: " + actualModelPath + " (" + modelType + ") from " + node.modelSource);
                
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
                inputArray = data.flat(Infinity).map(v => parseFloat(v) || 0);
            } else if (typeof data === 'object' && data !== null) {
                if (preprocessMode === 'object') {
                    // Extract values from object
                    inputArray = Object.values(data).map(v => parseFloat(v) || 0);
                } else {
                    // Try to get array from common properties
                    inputArray = data.features || data.values || data.input || Object.values(data);
                    inputArray = inputArray.flat(Infinity).map(v => parseFloat(v) || 0);
                }
            } else if (typeof data === 'number') {
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
                    output = await Promise.all(result.map(t => t.array()));
                    result.forEach(t => t.dispose());
                } else {
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
                    node.warn(`Shape mismatch: expected ${expectedLength} values, got ${flatData.length}. Adjusting shape.`);
                    shape = [1, flatData.length];
                }
            }
            
            // Create input tensor
            const inputName = node.inputNames[0] || 'input';
            const inputTensor = new onnxruntime.Tensor('float32', Float32Array.from(flatData), shape);
            
            const feeds = {};
            feeds[inputName] = inputTensor;
            
            const results = await node.model.run(feeds);
            
            // Extract output
            const outputName = node.outputNames[0] || Object.keys(results)[0];
            const outputTensor = results[outputName];
            
            // Convert to array
            return Array.from(outputTensor.data);
        }
        
        // Process messages
        node.on('input', async function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };
            
            try {
                // Check if this is a model load/reload command
                if (msg.loadModel) {
                    node.modelPath = msg.loadModel;
                    node.modelLoaded = false;
                    node.model = null;
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
                let inputData = inputProperty.split('.').reduce((obj, key) => obj && obj[key], msg);
                
                if (inputData === undefined || inputData === null) {
                    throw new Error("Input data not found at msg." + inputProperty);
                }
                
                // Prepare input
                const preparedInput = prepareInput(inputData, node.preprocessMode);
                
                // Run inference
                let prediction;
                const startTime = Date.now();
                
                if (node.modelFormat === 'tfjs' || node.modelFormat === 'savedmodel') {
                    prediction = await runTFJSInference(preparedInput);
                } else if (node.modelFormat === 'onnx') {
                    prediction = await runONNXInference(preparedInput);
                } else if (node.modelFormat === 'tflite' || node.modelFormat === 'coral') {
                    // TFLite/Coral uses Python bridge
                    if (node.model && node.model.predict) {
                        prediction = await node.model.predict(preparedInput);
                    } else {
                        throw new Error("TFLite model not properly loaded");
                    }
                } else if (node.modelFormat === 'keras') {
                    // Keras uses Python bridge
                    if (node.model && node.model.predict) {
                        prediction = await node.model.predict(preparedInput);
                    } else {
                        throw new Error("Keras model not properly loaded");
                    }
                } else if (node.modelFormat === 'sklearn') {
                    // scikit-learn uses Python bridge
                    if (node.model && node.model.predict) {
                        prediction = await node.model.predict(preparedInput);
                    } else {
                        throw new Error("scikit-learn model not properly loaded");
                    }
                } else {
                    throw new Error("Unknown model format: " + node.modelFormat);
                }
                
                const inferenceTime = Date.now() - startTime;
                
                // Build output message
                const outputMsg = Object.assign({}, msg);
                
                // Set prediction at configured property
                const outputParts = node.outputProperty.split('.');
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
                    timestamp: Date.now()
                };
                
                send(outputMsg);
                done();
                
            } catch (err) {
                node.status({ fill: "red", shape: "dot", text: err.message.substring(0, 30) });
                done(err);
                
                // Reset status after delay
                setTimeout(function() {
                    if (node.modelLoaded) {
                        node.status({ fill: "green", shape: "dot", text: node.modelFormat + " ready" });
                    }
                }, 3000);
            }
        });
        
        // Cleanup
        node.on('close', async function(done) {
            // Clear auto-update timer
            if (updateTimer) {
                clearInterval(updateTimer);
                updateTimer = null;
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
                
                if (node.modelFormat === 'tfjs' && node.model.dispose) {
                    node.model.dispose();
                }
                // ONNX sessions don't need explicit disposal
                node.model = null;
            }
            node.modelLoaded = false;
            done();
        });
        
        // Initialize model on startup
        if (node.modelPath) {
            initializeModel();
        } else {
            node.status({ fill: "grey", shape: "ring", text: "no model configured" });
        }
    }
    
    RED.nodes.registerType("ml-inference", MLInferenceNode);
    
    // API endpoint for model info
    RED.httpAdmin.get("/ml-inference/runtimes", function(req, res) {
        const runtimes = {
            tfjs: loadTensorFlowJS() !== null,
            onnx: loadONNXRuntime() !== null
        };
        res.json(runtimes);
    });
    
    // API endpoint to check Python bridge status
    RED.httpAdmin.get("/ml-inference/python-bridge", async function(req, res) {
        try {
            if (pythonBridge && pythonBridgeReady) {
                const status = await pythonBridge.getStatus();
                const stats = pythonBridge.getStats();
                res.json({
                    available: true,
                    mode: 'persistent',
                    ...status,
                    stats: stats
                });
            } else {
                res.json({
                    available: false,
                    mode: 'none',
                    reason: pythonBridgeError ? pythonBridgeError.message : 'Not started'
                });
            }
        } catch (err) {
            res.json({
                available: false,
                mode: 'none',
                error: err.message
            });
        }
    });
    
    // API endpoint to check Python availability
    RED.httpAdmin.get("/ml-inference/python-status", function(req, res) {
        const { spawn } = require('child_process');
        const pythonCandidates = ['python3', 'python'];
        
        function checkPython(candidates, index) {
            if (index >= candidates.length) {
                res.json({ available: false, version: null, packages: [] });
                return;
            }
            
            const proc = spawn(candidates[index], ['-c', 'import sys; print(sys.version.split()[0])'], { 
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: 5000
            });
            
            let stdout = '';
            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            
            proc.on('close', (code) => {
                if (code === 0 && stdout.trim()) {
                    // Check for ML packages
                    const checkPackages = spawn(candidates[index], ['-c', `
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
`], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
                    
                    let pkgOut = '';
                    checkPackages.stdout.on('data', (data) => { pkgOut += data.toString(); });
                    
                    checkPackages.on('close', () => {
                        let packages = [];
                        try { packages = JSON.parse(pkgOut.trim()); } catch(e) {}
                        res.json({ 
                            available: true, 
                            version: stdout.trim(),
                            python: candidates[index],
                            packages: packages
                        });
                    });
                    
                    checkPackages.on('error', () => {
                        res.json({ available: true, version: stdout.trim(), python: candidates[index], packages: [] });
                    });
                } else {
                    checkPython(candidates, index + 1);
                }
            });
            
            proc.on('error', () => {
                checkPython(candidates, index + 1);
            });
        }
        
        checkPython(pythonCandidates, 0);
    });
    
    // API endpoint to check Coral TPU availability
    RED.httpAdmin.get("/ml-inference/coral-status", function(req, res) {
        const { spawn } = require('child_process');
        const proc = spawn('python3', ['-c', 'from pycoral.utils.edgetpu import list_edge_tpus; print(len(list_edge_tpus()))'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5000
        });
        
        let stdout = '';
        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        
        proc.on('close', (code) => {
            const count = parseInt(stdout.trim()) || 0;
            res.json({ available: count > 0, count: count });
        });
        
        proc.on('error', () => {
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
    
    // API endpoint to list uploaded models
    RED.httpAdmin.get("/ml-inference/models", function(req, res) {
        try {
            ensureModelsDir();
            const files = fs.readdirSync(MODELS_DIR);
            const fileModels = files.filter(f => {
                const filePath = path.join(MODELS_DIR, f);
                if (!fs.existsSync(filePath)) return false;
                const stats = fs.statSync(filePath);
                if (stats.isDirectory()) return false;
                const ext = path.extname(f).toLowerCase();
                return ext === '.onnx' || ext === '.json' || ext === '.tflite';
            }).map(f => {
                const filePath = path.join(MODELS_DIR, f);
                const stats = fs.statSync(filePath);
                const metadata = loadModelMetadata(filePath);
                const ext = path.extname(f).toLowerCase();
                return {
                    name: f,
                    path: filePath,
                    size: stats.size,
                    modified: stats.mtime,
                    type: ext === '.onnx' ? 'onnx' : (ext === '.tflite' ? 'tflite' : 'tfjs'),
                    version: metadata?.version || "1.0.0",
                    metadata: metadata || null
                };
            });
            
            // Also include directories (for TFJS models)
            const dirModels = files.filter(f => {
                const dirPath = path.join(MODELS_DIR, f);
                if (!fs.existsSync(dirPath)) return false;
                return fs.statSync(dirPath).isDirectory();
            }).map(d => {
                const dirPath = path.join(MODELS_DIR, d);
                const modelJsonPath = path.join(dirPath, 'model.json');
                const metadata = fs.existsSync(modelJsonPath) ? loadModelMetadata(modelJsonPath) : null;
                return {
                    name: d,
                    path: dirPath,
                    type: 'tfjs',
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
    RED.httpAdmin.post("/ml-inference/upload", function(req, res) {
        try {
            ensureModelsDir();
            
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                try {
                    const buffer = Buffer.concat(chunks);
                    const filename = req.headers['x-filename'] || 'model_' + Date.now() + '.onnx';
                    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
                    const filePath = path.join(MODELS_DIR, safeName);
                    
                    fs.writeFileSync(filePath, buffer);
                    
                    // Create initial metadata
                    const metadata = {
                        name: safeName,
                        version: "1.0.0",
                        type: path.extname(safeName).toLowerCase() === '.onnx' ? 'onnx' : 'tflite',
                        path: filePath,
                        source: "local",
                        format: path.extname(safeName).toLowerCase() === '.onnx' ? 'onnx' : 'tflite',
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
                    res.status(500).json({ error: err.message });
                }
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    
    // API endpoint to upload TensorFlow.js model (multiple files)
    RED.httpAdmin.post("/ml-inference/upload-tfjs", function(req, res) {
        try {
            ensureModelsDir();
            
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                try {
                    const buffer = Buffer.concat(chunks);
                    const data = JSON.parse(buffer.toString());
                    
                    // Create a subdirectory for the TFJS model
                    const modelName = data.name || 'tfjs_model_' + Date.now();
                    const safeName = modelName.replace(/[^a-zA-Z0-9._-]/g, '_');
                    const modelDir = path.join(MODELS_DIR, safeName);
                    
                    if (!fs.existsSync(modelDir)) {
                        fs.mkdirSync(modelDir, { recursive: true });
                    }
                    
                    // Save model.json
                    const modelJsonPath = path.join(modelDir, 'model.json');
                    fs.writeFileSync(modelJsonPath, data.modelJson);
                    
                    // Save weight files
                    if (data.weights && Array.isArray(data.weights)) {
                        data.weights.forEach(w => {
                            const weightPath = path.join(modelDir, w.name);
                            const weightBuffer = Buffer.from(w.data, 'base64');
                            fs.writeFileSync(weightPath, weightBuffer);
                        });
                    }
                    
                    // Create initial metadata
                    const metadata = {
                        name: safeName,
                        version: "1.0.0",
                        type: 'tfjs',
                        path: modelDir,
                        source: "local",
                        format: 'tfjs',
                        uploaded: new Date().toISOString(),
                        metadata: {}
                    };
                    saveModelMetadata(path.join(modelDir, 'model.json'), metadata);
                    
                    res.json({ 
                        success: true, 
                        path: modelDir,
                        name: safeName,
                        metadata: metadata
                    });
                } catch (err) {
                    res.status(500).json({ error: err.message });
                }
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    
    // API endpoint to delete a model
    RED.httpAdmin.delete("/ml-inference/models/:name", function(req, res) {
        try {
            const modelName = req.params.name;
            const safeName = modelName.replace(/[^a-zA-Z0-9._-]/g, '_');
            const modelPath = path.join(MODELS_DIR, safeName);
            
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
            res.status(500).json({ error: err.message });
        }
    });
    
    // Registry API Endpoints (Phase 2-4)
    
    // List available registries
    RED.httpAdmin.get("/ml-inference/registries", function(req, res) {
        res.json({
            registries: [
                { id: "huggingface", name: "Hugging Face Hub", enabled: true },
                { id: "mlflow", name: "MLflow Registry", enabled: true },
                { id: "custom", name: "Custom Registry", enabled: true }
            ]
        });
    });
    
    // Get models from MLflow Registry
    RED.httpAdmin.get("/ml-inference/registries/mlflow/models", function(req, res) {
        const registryUri = req.query.registryUri;
        const token = req.query.token || "";
        
        if (!registryUri) {
            return res.status(400).json({ error: "registryUri parameter required" });
        }
        
        const baseUrl = registryUri.replace(/\/$/, '');
        const apiUrl = `${baseUrl}/api/2.0/mlflow/registered-models/search`;
        
        const protocol = https;
        const options = {
            headers: {
                'Content-Type': 'application/json'
            }
        };
        
        if (token) {
            options.headers['Authorization'] = 'Bearer ' + token;
        }
        
        protocol.get(apiUrl, options, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                if (response.statusCode === 200) {
                    try {
                        const result = JSON.parse(data);
                        res.json({ models: result.registered_models || [] });
                    } catch (e) {
                        res.status(500).json({ error: 'Invalid JSON response from MLflow' });
                    }
                } else {
                    res.status(response.statusCode).json({ error: `MLflow API error: ${response.statusMessage}` });
                }
            });
        }).on('error', (err) => {
            res.status(500).json({ error: err.message });
        });
    });
    
    // Get model versions
    RED.httpAdmin.get("/ml-inference/models/:name/versions", function(req, res) {
        try {
            const modelName = req.params.name;
            const safeName = modelName.replace(/[^a-zA-Z0-9._-]/g, '_');
            const modelPath = path.join(MODELS_DIR, safeName);
            
            // For now, return single version from metadata
            const metadata = loadModelMetadata(modelPath);
            if (metadata) {
                res.json({ versions: [{ version: metadata.version, metadata: metadata }] });
            } else {
                res.json({ versions: [] });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};

