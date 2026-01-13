/**
 * Python Bridge Manager
 * =====================
 * 
 * Manages a persistent Python subprocess for ML inference.
 * Instead of spawning a new Python process for each inference,
 * this maintains a single long-running process and communicates via JSON over stdin/stdout.
 * 
 * Performance improvement: ~10-100x faster inference for repeated calls.
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const EventEmitter = require('events');

class PythonBridgeManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.pythonPath = options.pythonPath || 'python3';
        this.bridgeScript = options.bridgeScript || path.join(__dirname, 'python_bridge.py');
        this.startupTimeout = options.startupTimeout || 30000;
        this.requestTimeout = options.requestTimeout || 60000;
        
        this.process = null;
        this.isReady = false;
        this.isShuttingDown = false;
        this.pendingRequests = new Map(); // id -> { resolve, reject, timeout }
        this.requestCounter = 0;
        this.readline = null;
        
        // Stats
        this.stats = {
            requestsProcessed: 0,
            errors: 0,
            avgResponseTime: 0,
            lastResponseTime: null
        };
    }
    
    /**
     * Start the Python bridge subprocess
     */
    async start() {
        if (this.process) {
            return; // Already started
        }
        
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            
            // Try python3 first, then python
            this._tryStart(['python3', 'python'], 0, (err, pythonPath) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                this.pythonPath = pythonPath;
                
                // Wait for ready signal
                const readyTimeout = setTimeout(() => {
                    reject(new Error('Python bridge startup timeout'));
                    this.stop();
                }, this.startupTimeout);
                
                const checkReady = (response) => {
                    if (response.id === 'ready' && response.success) {
                        clearTimeout(readyTimeout);
                        this.isReady = true;
                        this.emit('ready', response.result);
                        resolve(response.result);
                    }
                };
                
                this.once('response', checkReady);
            });
        });
    }
    
    /**
     * Try starting Python with different commands
     */
    _tryStart(pythonCandidates, index, callback) {
        if (index >= pythonCandidates.length) {
            callback(new Error('Python not found. Install Python 3 with ML packages.'));
            return;
        }
        
        const pythonPath = pythonCandidates[index];
        
        try {
            this.process = spawn(pythonPath, [this.bridgeScript], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, PYTHONUNBUFFERED: '1' }
            });
            
            // Set up readline for stdout
            this.readline = readline.createInterface({
                input: this.process.stdout,
                crlfDelay: Infinity
            });
            
            this.readline.on('line', (line) => {
                this._handleResponse(line);
            });
            
            // Handle stderr (for debugging)
            this.process.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) {
                    this.emit('stderr', msg);
                }
            });
            
            // Handle process exit
            this.process.on('exit', (code, signal) => {
                this.isReady = false;
                this.process = null;
                
                // Reject all pending requests
                for (const [id, pending] of this.pendingRequests) {
                    clearTimeout(pending.timeout);
                    pending.reject(new Error(`Python bridge exited with code ${code}`));
                }
                this.pendingRequests.clear();
                
                if (!this.isShuttingDown) {
                    this.emit('exit', { code, signal });
                }
            });
            
            this.process.on('error', (err) => {
                // Process failed to start, try next python candidate
                this.process = null;
                this._tryStart(pythonCandidates, index + 1, callback);
            });
            
            // If we get here without error, the process started
            // Wait a moment to ensure it's running
            setTimeout(() => {
                if (this.process && !this.process.killed) {
                    callback(null, pythonPath);
                }
            }, 100);
            
        } catch (err) {
            this._tryStart(pythonCandidates, index + 1, callback);
        }
    }
    
    /**
     * Handle a response line from Python
     */
    _handleResponse(line) {
        try {
            const response = JSON.parse(line);
            const id = response.id;
            
            // Emit for general listeners
            this.emit('response', response);
            
            // Resolve pending request
            if (this.pendingRequests.has(id)) {
                const pending = this.pendingRequests.get(id);
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(id);
                
                // Update stats
                this.stats.requestsProcessed++;
                this.stats.lastResponseTime = Date.now() - pending.startTime;
                this.stats.avgResponseTime = (
                    (this.stats.avgResponseTime * (this.stats.requestsProcessed - 1) + 
                     this.stats.lastResponseTime) / this.stats.requestsProcessed
                );
                
                if (response.success) {
                    pending.resolve(response.result);
                } else {
                    this.stats.errors++;
                    pending.reject(new Error(response.error || 'Unknown error'));
                }
            }
        } catch (err) {
            this.emit('error', new Error(`Failed to parse response: ${line}`));
        }
    }
    
    /**
     * Send a command to Python and wait for response
     */
    async sendCommand(command, params = {}) {
        if (!this.isReady) {
            throw new Error('Python bridge not ready');
        }
        
        const id = `req_${++this.requestCounter}`;
        const message = JSON.stringify({ id, command, ...params }) + '\n';
        
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Request timeout: ${command}`));
            }, this.requestTimeout);
            
            this.pendingRequests.set(id, { resolve, reject, timeout, startTime });
            
            try {
                this.process.stdin.write(message);
            } catch (err) {
                clearTimeout(timeout);
                this.pendingRequests.delete(id);
                reject(err);
            }
        });
    }
    
    /**
     * Load a model
     */
    async loadModel(modelPath, modelId = null) {
        return this.sendCommand('load_model', { model_path: modelPath, model_id: modelId });
    }
    
    /**
     * Run inference
     */
    async predict(modelId, inputData) {
        return this.sendCommand('predict', { model_id: modelId, input_data: inputData });
    }
    
    /**
     * Unload a model
     */
    async unloadModel(modelId) {
        return this.sendCommand('unload_model', { model_id: modelId });
    }
    
    /**
     * Get status
     */
    async getStatus() {
        return this.sendCommand('status');
    }
    
    /**
     * Ping to check if bridge is alive
     */
    async ping() {
        return this.sendCommand('ping');
    }
    
    /**
     * Stop the Python bridge
     */
    async stop() {
        if (!this.process) {
            return;
        }
        
        this.isShuttingDown = true;
        
        try {
            await this.sendCommand('shutdown');
        } catch (err) {
            // Ignore errors during shutdown
        }
        
        // Give it a moment to shutdown gracefully
        await new Promise(resolve => setTimeout(resolve, 500));
        
        if (this.process) {
            this.process.kill('SIGTERM');
            
            // Force kill after 2 seconds
            setTimeout(() => {
                if (this.process) {
                    this.process.kill('SIGKILL');
                }
            }, 2000);
        }
        
        if (this.readline) {
            this.readline.close();
            this.readline = null;
        }
        
        this.process = null;
        this.isReady = false;
        this.isShuttingDown = false;
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            isReady: this.isReady,
            pendingRequests: this.pendingRequests.size
        };
    }
}

// Singleton instance for shared use across nodes
let globalBridge = null;

/**
 * Get or create the global Python bridge instance
 */
function getGlobalBridge() {
    if (!globalBridge) {
        globalBridge = new PythonBridgeManager();
    }
    return globalBridge;
}

/**
 * Shutdown the global bridge (call on Node-RED shutdown)
 */
async function shutdownGlobalBridge() {
    if (globalBridge) {
        await globalBridge.stop();
        globalBridge = null;
    }
}

module.exports = {
    PythonBridgeManager,
    getGlobalBridge,
    shutdownGlobalBridge
};
