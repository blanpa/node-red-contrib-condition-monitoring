/**
 * State Persistence Manager
 * =========================
 * 
 * Provides persistent state storage for condition monitoring nodes.
 * Uses Node-RED's context storage API which supports:
 * - Memory (default)
 * - File-based persistence (if configured in settings.js)
 * 
 * This allows nodes to survive Node-RED restarts and maintain
 * their training state, buffers, and calculated statistics.
 */

/**
 * State Manager for a single node
 */
class NodeStateManager {
    /**
     * @param {Object} node - Node-RED node instance
     * @param {Object} options - Configuration options
     * @param {string} options.storeName - Context store name (default: 'file' or 'default')
     * @param {string} options.stateKey - Key for storing state (default: 'persistedState')
     * @param {number} options.saveInterval - Auto-save interval in ms (default: 30000)
     * @param {boolean} options.autoSave - Enable periodic auto-save (default: true)
     * @param {boolean} options.saveOnChange - Save immediately on changes (default: false)
     */
    constructor(node, options = {}) {
        this.node = node;
        this.storeName = options.storeName || this._detectStoreName();
        this.stateKey = options.stateKey || 'persistedState';
        this.saveInterval = options.saveInterval || 30000; // 30 seconds
        this.autoSave = options.autoSave !== false;
        this.saveOnChange = options.saveOnChange === true;
        
        this.state = {};
        this.isDirty = false;
        this.saveTimer = null;
        this.isLoaded = false;
        
        // Start auto-save timer if enabled
        if (this.autoSave) {
            this._startAutoSave();
        }
    }
    
    /**
     * Detect the best available context store
     */
    _detectStoreName() {
        try {
            // Try to use 'file' store if available (for persistence)
            const context = this.node.context();
            if (context.flow && typeof context.flow.keys === 'function') {
                // Check if file store is configured
                // Return 'default' which will use whatever is configured
                return 'default';
            }
        } catch (err) {
            // Ignore
        }
        return 'default';
    }
    
    /**
     * Start periodic auto-save
     */
    _startAutoSave() {
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
        }
        
        this.saveTimer = setInterval(() => {
            if (this.isDirty) {
                this.save();
            }
        }, this.saveInterval);
        
        // Unref the timer so it doesn't keep the process alive during shutdown
        if (this.saveTimer.unref) {
            this.saveTimer.unref();
        }
    }
    
    /**
     * Load state from context storage
     * @returns {Promise<Object>} Loaded state or empty object
     */
    async load() {
        return new Promise((resolve) => {
            try {
                const context = this.node.context();
                const stored = context.get(this.stateKey, this.storeName);
                
                if (stored && typeof stored === 'object') {
                    this.state = this._deserializeState(stored);
                    this.isLoaded = true;
                    this.node.debug(`[Persistence] Loaded state: ${Object.keys(this.state).length} keys`);
                } else {
                    this.state = {};
                    this.isLoaded = true;
                }
                
                resolve(this.state);
            } catch (err) {
                this.node.warn(`[Persistence] Failed to load state: ${err.message}`);
                this.state = {};
                this.isLoaded = true;
                resolve(this.state);
            }
        });
    }
    
    /**
     * Save state to context storage
     * @returns {Promise<boolean>} Success
     */
    async save() {
        return new Promise((resolve) => {
            try {
                const context = this.node.context();
                const serialized = this._serializeState(this.state);
                
                context.set(this.stateKey, serialized, this.storeName, (err) => {
                    if (err) {
                        this.node.warn(`[Persistence] Failed to save state: ${err.message}`);
                        resolve(false);
                    } else {
                        this.isDirty = false;
                        this.node.debug(`[Persistence] Saved state: ${Object.keys(this.state).length} keys`);
                        resolve(true);
                    }
                });
            } catch (err) {
                this.node.warn(`[Persistence] Failed to save state: ${err.message}`);
                resolve(false);
            }
        });
    }
    
    /**
     * Get a value from state
     * @param {string} key - State key
     * @param {*} defaultValue - Default value if not found
     * @returns {*} Value
     */
    get(key, defaultValue = undefined) {
        return key in this.state ? this.state[key] : defaultValue;
    }
    
    /**
     * Set a value in state
     * @param {string} key - State key
     * @param {*} value - Value to store
     */
    set(key, value) {
        this.state[key] = value;
        this.isDirty = true;
        
        if (this.saveOnChange) {
            this.save();
        }
    }
    
    /**
     * Set multiple values
     * @param {Object} values - Key-value pairs
     */
    setMultiple(values) {
        Object.assign(this.state, values);
        this.isDirty = true;
        
        if (this.saveOnChange) {
            this.save();
        }
    }
    
    /**
     * Delete a key from state
     * @param {string} key - State key
     */
    delete(key) {
        if (key in this.state) {
            delete this.state[key];
            this.isDirty = true;
            
            if (this.saveOnChange) {
                this.save();
            }
        }
    }
    
    /**
     * Clear all state
     */
    clear() {
        this.state = {};
        this.isDirty = true;
        
        if (this.saveOnChange) {
            this.save();
        }
    }
    
    /**
     * Check if a key exists
     * @param {string} key - State key
     * @returns {boolean}
     */
    has(key) {
        return key in this.state;
    }
    
    /**
     * Get all keys
     * @returns {string[]}
     */
    keys() {
        return Object.keys(this.state);
    }
    
    /**
     * Get the entire state object
     * @returns {Object}
     */
    getAll() {
        return { ...this.state };
    }
    
    /**
     * Serialize state for storage (handle special types)
     */
    _serializeState(state) {
        const serialized = {};
        
        for (const [key, value] of Object.entries(state)) {
            if (value instanceof Float32Array || value instanceof Float64Array) {
                serialized[key] = {
                    __type: value.constructor.name,
                    data: Array.from(value)
                };
            } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
                // Handle arrays of objects (like buffers with timestamps)
                serialized[key] = {
                    __type: 'ObjectArray',
                    data: value
                };
            } else {
                serialized[key] = value;
            }
        }
        
        return serialized;
    }
    
    /**
     * Deserialize state from storage
     */
    _deserializeState(stored) {
        const state = {};
        
        for (const [key, value] of Object.entries(stored)) {
            if (value && typeof value === 'object' && value.__type) {
                if (value.__type === 'Float32Array') {
                    state[key] = new Float32Array(value.data);
                } else if (value.__type === 'Float64Array') {
                    state[key] = new Float64Array(value.data);
                } else if (value.__type === 'ObjectArray') {
                    state[key] = value.data;
                } else {
                    state[key] = value;
                }
            } else {
                state[key] = value;
            }
        }
        
        return state;
    }
    
    /**
     * Clean up resources
     */
    async close() {
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
        }
        
        // Final save on close
        if (this.isDirty) {
            await this.save();
        }
    }
}

/**
 * Create state manager for anomaly detection nodes
 * Stores: buffer, statistics, thresholds
 */
function createAnomalyStateManager(node, config = {}) {
    const manager = new NodeStateManager(node, {
        stateKey: 'anomalyState',
        saveInterval: config.saveInterval || 60000,
        ...config
    });
    
    return manager;
}

/**
 * Create state manager for ML nodes
 * Stores: model metadata, inference stats
 */
function createMLStateManager(node, config = {}) {
    const manager = new NodeStateManager(node, {
        stateKey: 'mlState',
        saveInterval: config.saveInterval || 120000, // 2 minutes
        ...config
    });
    
    return manager;
}

/**
 * Create state manager for signal analysis nodes
 * Stores: FFT cache, calibration data
 */
function createSignalStateManager(node, config = {}) {
    const manager = new NodeStateManager(node, {
        stateKey: 'signalState',
        saveInterval: config.saveInterval || 60000,
        ...config
    });
    
    return manager;
}

module.exports = {
    NodeStateManager,
    createAnomalyStateManager,
    createMLStateManager,
    createSignalStateManager
};
