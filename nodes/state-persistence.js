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
 *
 * Every blob written carries a schema version (`__v`). Blobs written before
 * versioning existed (0.4.0) carry none; their shape IS the version-1 shape,
 * so they load unchanged. A blob with a different `__v` is handed to the
 * node's `migrate(state, fromVersion)` hook when it has one, and otherwise
 * discarded with a warning so a shape change between package versions can
 * never feed stale fields into a node.
 */

// Schema version written into every persisted blob.
const STATE_VERSION = 1;
// Version assumed for a blob without `__v` (written by 0.4.0): the schema
// did not change when the marker was introduced.
const UNVERSIONED_BLOB_VERSION = 1;

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
     * @param {number} options.stateVersion - Schema version written as `__v` (default: STATE_VERSION)
     * @param {Function} options.migrate - `(state, fromVersion) => state|null` called when a
     *   stored blob has another version (a blob without `__v` counts as version 1); return
     *   the converted state to keep it, anything else to start fresh
     * @param {number} options.maxPersistedItems - Cap on the length of any persisted array
     *   (the newest items are kept); default: unlimited
     * @param {Function} options.onAutoSave - Called on every auto-save tick before the
     *   dirty check, so a node can hand over a fresh snapshot
     */
    constructor(node, options = {}) {
        this.node = node;
        this.storeName = options.storeName || this._detectStoreName();
        this.stateKey = options.stateKey || "persistedState";
        this.saveInterval = options.saveInterval || 30000; // 30 seconds
        this.autoSave = options.autoSave !== false;
        this.saveOnChange = options.saveOnChange === true;
        this.stateVersion = Number.isInteger(options.stateVersion) ? options.stateVersion : STATE_VERSION;
        this.migrate = typeof options.migrate === "function" ? options.migrate : null;
        this.maxPersistedItems =
            Number.isFinite(options.maxPersistedItems) && options.maxPersistedItems > 0
                ? Math.floor(options.maxPersistedItems)
                : null;
        this.onAutoSave = typeof options.onAutoSave === "function" ? options.onAutoSave : null;
        this._capWarned = false;

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
     * Default Node-RED context store.
     *
     * Returns the 'default' store, which uses whatever store the user wired up in
     * `settings.js` (`contextStorage.default`). For state to actually survive a
     * restart, the user must register a file-backed store, e.g.:
     *
     *     contextStorage: {
     *         default: { module: 'localfilesystem' }
     *     }
     *
     * Callers that want to target a specific store can pass `options.storeName`
     * to the constructor.
     *
     * @returns {string} Store name to use with context.get/set
     */
    _detectStoreName() {
        return "default";
    }

    /**
     * Start periodic auto-save
     */
    _startAutoSave() {
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
        }

        this.saveTimer = setInterval(() => {
            if (this.onAutoSave) {
                try {
                    this.onAutoSave();
                } catch (err) {
                    this.node.warn(`[Persistence] Auto-save snapshot failed: ${err.message}`);
                }
            }
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
            let settled = false;
            const finish = (stored) => {
                if (settled) return;
                settled = true;
                try {
                    if (stored && typeof stored === "object") {
                        // Loading is asynchronous: anything set() while the store
                        // was still answering is newer than what was persisted
                        // and must survive the load instead of being replaced.
                        this.state = Object.assign(this._adoptStoredState(stored), this.state);
                        this.node.debug(`[Persistence] Loaded state: ${Object.keys(this.state).length} keys`);
                    } else if (stored !== undefined && stored !== null) {
                        this.node.warn(
                            `[Persistence] Persisted state is not an object (${typeof stored}) — starting fresh`
                        );
                        this.isDirty = true;
                    }
                } catch (err) {
                    // Corrupt blob: say so and start fresh. Marking the state
                    // dirty replaces the blob at the next save, so the warning
                    // does not repeat on every start.
                    this.node.warn(`[Persistence] Failed to deserialize state (starting fresh): ${err.message}`);
                    this.state = Object.assign({}, this.state);
                    this.isDirty = true;
                }
                this.isLoaded = true;
                resolve(this.state);
            };

            try {
                const context = this.node.context();
                // Use the async callback form so async context stores (e.g. the
                // file store — the whole point of persistence) actually load.
                // Stores that only support sync get return the value directly.
                const maybeValue = context.get(this.stateKey, this.storeName, (err, value) => {
                    if (err) {
                        this.node.warn(`[Persistence] Failed to load state: ${err.message}`);
                        finish(null);
                        return;
                    }
                    finish(value);
                });
                // Synchronous stores ignore the callback and return the value.
                if (maybeValue !== undefined) {
                    finish(maybeValue);
                }
            } catch (err) {
                this.node.warn(`[Persistence] Failed to load state: ${err.message}`);
                finish(null);
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
     * Turn a stored blob into live state, honouring its schema version.
     * Same version (or no `__v`, which means version 1): deserialize. Other
     * version: the node's migrate hook decides; without one, or when it
     * declines, start fresh.
     */
    _adoptStoredState(stored) {
        const fromVersion = Number.isInteger(stored.__v) ? stored.__v : UNVERSIONED_BLOB_VERSION;
        const state = this._deserializeState(stored);
        if (fromVersion === this.stateVersion) return state;

        const label = "version " + fromVersion;
        if (this.migrate) {
            let migrated = null;
            try {
                migrated = this.migrate(state, fromVersion);
            } catch (err) {
                this.node.warn(`[Persistence] migrate() failed for ${label} state: ${err.message}`);
            }
            if (migrated && typeof migrated === "object") {
                this.node.debug(`[Persistence] Migrated ${label} state to version ${this.stateVersion}`);
                this.isDirty = true;
                return migrated;
            }
        }
        this.node.warn(
            `[Persistence] Persisted state is ${label}, this node expects version ${this.stateVersion} — starting fresh`
        );
        this.isDirty = true;
        return {};
    }

    /**
     * Serialize state for storage (handle special types)
     */
    _serializeState(state) {
        const serialized = { __v: this.stateVersion };

        for (const [key, value] of Object.entries(state)) {
            if (key === "__v") continue;
            if (value instanceof Float32Array || value instanceof Float64Array) {
                serialized[key] = {
                    __type: value.constructor.name,
                    data: Array.from(value)
                };
            } else if (Array.isArray(value)) {
                const bounded = this._boundArray(key, value);
                if (bounded.length > 0 && typeof bounded[0] === "object") {
                    // Handle arrays of objects (like buffers with timestamps)
                    serialized[key] = {
                        __type: "ObjectArray",
                        data: bounded
                    };
                } else {
                    serialized[key] = bounded;
                }
            } else {
                serialized[key] = value;
            }
        }

        return serialized;
    }

    /**
     * Apply maxPersistedItems to one array: the newest (last) items survive.
     * Warns once per manager — the cap is a size guard for the context file,
     * not a silent data policy.
     */
    _boundArray(key, value) {
        if (this.maxPersistedItems === null || value.length <= this.maxPersistedItems) return value;
        if (!this._capWarned) {
            this._capWarned = true;
            this.node.warn(
                `[Persistence] '${key}' holds ${value.length} items; only the newest ${this.maxPersistedItems} are persisted (maxPersistedItems)`
            );
        }
        return value.slice(value.length - this.maxPersistedItems);
    }

    /**
     * Deserialize state from storage. The `__v` marker is metadata, not state.
     */
    _deserializeState(stored) {
        const state = {};

        for (const [key, value] of Object.entries(stored)) {
            if (key === "__v") continue;
            if (value && typeof value === "object" && value.__type) {
                if (value.__type === "Float32Array") {
                    state[key] = new Float32Array(value.data);
                } else if (value.__type === "Float64Array") {
                    state[key] = new Float64Array(value.data);
                } else if (value.__type === "ObjectArray") {
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
        stateKey: "anomalyState",
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
        stateKey: "mlState",
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
        stateKey: "signalState",
        saveInterval: config.saveInterval || 60000,
        ...config
    });

    return manager;
}

module.exports = {
    NodeStateManager,
    STATE_VERSION,
    UNVERSIONED_BLOB_VERSION,
    createAnomalyStateManager,
    createMLStateManager,
    createSignalStateManager
};
