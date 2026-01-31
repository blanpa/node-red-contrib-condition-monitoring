/**
 * MAX Engine Bridge Manager
 * ==========================
 * 
 * Manages communication with the MAX Engine inference server.
 * The server runs as a separate container and provides HTTP API for ONNX model inference.
 * 
 * Benefits over direct ONNX Runtime:
 * - High-performance inference with MAX Engine (when available)
 * - GPU acceleration (NVIDIA/AMD)
 * - Model caching and warm-up
 * - Batch inference support
 * - Separate process for better resource management
 * 
 * Usage:
 *   const { getMaxBridge } = require('./max-bridge-manager');
 *   const bridge = getMaxBridge();
 *   await bridge.loadModel('/models/anomaly.onnx', 'anomaly-detector');
 *   const result = await bridge.predict('anomaly-detector', [0.5, 1.2, 0.8]);
 */

const http = require('http');
const https = require('https');
const EventEmitter = require('events');

class MaxBridgeManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        // Server configuration
        this.serverUrl = options.serverUrl || process.env.MAX_ENGINE_URL || 'http://localhost:8765';
        this.requestTimeout = options.requestTimeout || 60000;
        this.healthCheckInterval = options.healthCheckInterval || 30000;
        this.retryAttempts = options.retryAttempts || 3;
        this.retryDelay = options.retryDelay || 1000;
        
        // Parse URL
        const url = new URL(this.serverUrl);
        this.protocol = url.protocol === 'https:' ? https : http;
        this.hostname = url.hostname;
        this.port = url.port || (url.protocol === 'https:' ? 443 : 80);
        
        // State
        this.isConnected = false;
        this.serverInfo = null;
        this.healthCheckTimer = null;
        
        // Statistics
        this.stats = {
            requestsTotal: 0,
            successfulRequests: 0,
            failedRequests: 0,
            avgResponseTime: 0,
            lastResponseTime: null
        };
    }
    
    /**
     * Make HTTP request to MAX bridge server
     */
    async _request(method, path, data = null) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            
            const options = {
                hostname: this.hostname,
                port: this.port,
                path: path,
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: this.requestTimeout
            };
            
            const req = this.protocol.request(options, (res) => {
                let responseData = '';
                
                res.on('data', (chunk) => {
                    responseData += chunk;
                });
                
                res.on('end', () => {
                    const responseTime = Date.now() - startTime;
                    this._updateStats(responseTime, res.statusCode < 400);
                    
                    try {
                        const parsed = JSON.parse(responseData);
                        
                        if (res.statusCode >= 400) {
                            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
                        } else {
                            resolve(parsed);
                        }
                    } catch (e) {
                        reject(new Error(`Invalid JSON response: ${responseData.substring(0, 100)}`));
                    }
                });
            });
            
            req.on('error', (err) => {
                this._updateStats(Date.now() - startTime, false);
                reject(err);
            });
            
            req.on('timeout', () => {
                req.destroy();
                this._updateStats(Date.now() - startTime, false);
                reject(new Error('Request timeout'));
            });
            
            if (data) {
                req.write(JSON.stringify(data));
            }
            
            req.end();
        });
    }
    
    /**
     * Update request statistics
     */
    _updateStats(responseTime, success) {
        this.stats.requestsTotal++;
        this.stats.lastResponseTime = responseTime;
        
        if (success) {
            this.stats.successfulRequests++;
            this.stats.avgResponseTime = (
                (this.stats.avgResponseTime * (this.stats.successfulRequests - 1) + responseTime) /
                this.stats.successfulRequests
            );
        } else {
            this.stats.failedRequests++;
        }
    }
    
    /**
     * Make request with retry
     */
    async _requestWithRetry(method, path, data = null) {
        let lastError;
        
        for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
            try {
                return await this._request(method, path, data);
            } catch (err) {
                lastError = err;
                
                // Don't retry on client errors (4xx)
                if (err.message && err.message.includes('HTTP 4')) {
                    throw err;
                }
                
                if (attempt < this.retryAttempts - 1) {
                    await new Promise(resolve => setTimeout(resolve, this.retryDelay * (attempt + 1)));
                }
            }
        }
        
        throw lastError;
    }
    
    /**
     * Check if server is healthy
     */
    async checkHealth() {
        try {
            const response = await this._request('GET', '/health');
            this.isConnected = response.status === 'healthy';
            this.serverInfo = response;
            this.emit('health', response);
            return response;
        } catch (err) {
            this.isConnected = false;
            this.serverInfo = null;
            this.emit('unhealthy', err);
            throw err;
        }
    }
    
    /**
     * Get server status and loaded models
     */
    async getStatus() {
        return this._requestWithRetry('GET', '/status');
    }
    
    /**
     * Start periodic health checks
     */
    startHealthCheck() {
        if (this.healthCheckTimer) {
            return;
        }
        
        this.healthCheckTimer = setInterval(async () => {
            try {
                await this.checkHealth();
            } catch (err) {
                // Error already emitted via 'unhealthy' event
            }
        }, this.healthCheckInterval);
        
        // Initial check
        this.checkHealth().catch(() => {});
    }
    
    /**
     * Stop periodic health checks
     */
    stopHealthCheck() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }
    
    /**
     * Load a model into the MAX server
     * @param {string} modelPath - Path to the model file (inside container)
     * @param {string} modelId - Unique identifier for the model
     * @param {string} backend - Preferred backend: 'auto', 'max', or 'onnx'
     */
    async loadModel(modelPath, modelId = null, backend = 'auto') {
        const response = await this._requestWithRetry('POST', '/load', {
            model_path: modelPath,
            model_id: modelId || modelPath,
            backend: backend
        });
        
        if (!response.success) {
            throw new Error(response.error || 'Failed to load model');
        }
        
        this.emit('modelLoaded', {
            modelId: response.model_id,
            backend: response.backend,
            loadTime: response.load_time_ms
        });
        
        return response;
    }
    
    /**
     * Run inference on a loaded model
     * @param {string} modelId - Model identifier
     * @param {Array|Array[]} inputData - Input data (single sample or batch)
     */
    async predict(modelId, inputData) {
        const response = await this._requestWithRetry('POST', '/predict', {
            model_id: modelId,
            input_data: inputData
        });
        
        if (!response.success) {
            throw new Error(response.error || 'Prediction failed');
        }
        
        return {
            prediction: response.prediction,
            inferenceTime: response.inference_time_ms,
            backend: response.backend
        };
    }
    
    /**
     * Run batch inference on multiple inputs
     * @param {string} modelId - Model identifier
     * @param {Array[]} inputs - Array of input arrays
     */
    async batchPredict(modelId, inputs) {
        const response = await this._requestWithRetry('POST', '/batch_predict', {
            model_id: modelId,
            inputs: inputs
        });
        
        if (!response.success) {
            throw new Error(response.error || 'Batch prediction failed');
        }
        
        return {
            predictions: response.predictions,
            batchSize: response.batch_size,
            inferenceTime: response.inference_time_ms,
            perSampleTime: response.per_sample_ms,
            backend: response.backend
        };
    }
    
    /**
     * Unload a model from memory
     * @param {string} modelId - Model identifier
     */
    async unloadModel(modelId) {
        const response = await this._requestWithRetry('POST', '/unload', {
            model_id: modelId
        });
        
        if (!response.success) {
            throw new Error(response.error || 'Failed to unload model');
        }
        
        this.emit('modelUnloaded', { modelId });
        
        return response;
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            isConnected: this.isConnected,
            serverInfo: this.serverInfo
        };
    }
    
    /**
     * Clean up resources
     */
    destroy() {
        this.stopHealthCheck();
        this.removeAllListeners();
    }
}

// Singleton instance for shared use across nodes
let globalMaxBridge = null;

/**
 * Get or create the global MAX bridge instance
 * @param {object} options - Bridge options
 */
function getMaxBridge(options = {}) {
    if (!globalMaxBridge) {
        globalMaxBridge = new MaxBridgeManager(options);
    }
    return globalMaxBridge;
}

/**
 * Check if MAX bridge server is available
 */
async function isMaxBridgeAvailable() {
    const bridge = getMaxBridge();
    try {
        await bridge.checkHealth();
        return true;
    } catch (err) {
        return false;
    }
}

/**
 * Shutdown the global MAX bridge
 */
function shutdownMaxBridge() {
    if (globalMaxBridge) {
        globalMaxBridge.destroy();
        globalMaxBridge = null;
    }
}

module.exports = {
    MaxBridgeManager,
    getMaxBridge,
    isMaxBridgeAvailable,
    shutdownMaxBridge
};
