/**
 * State Persistence Helper
 * ========================
 *
 * Utility functions to reduce boilerplate code for state persistence
 * across Node-RED condition monitoring nodes.
 *
 * @module utils/persistence-helper
 */

"use strict";

// Import state persistence module
let StatePersistence = null;
try {
    StatePersistence = require("../state-persistence");
} catch (err) {
    // State persistence not available
}

/**
 * Initialize state persistence for a node
 *
 * @param {Object} node - The Node-RED node instance
 * @param {Object} options - Configuration options
 * @param {string} options.stateKey - Unique key for storing state (e.g., 'anomalyDetectorState')
 * @param {number} [options.saveInterval=30000] - Interval in ms to auto-save state
 * @param {Function} [options.onStateLoaded] - Callback when state is loaded: (state) => void
 * @param {Function} [options.getStateToSave] - Function returning state object to save: () => Object
 * @param {boolean} [options.debug=false] - Enable debug logging
 * @returns {Object|null} State manager instance or null if persistence unavailable
 *
 * @example
 * // In your node constructor:
 * const persistence = initializeStatePersistence(node, {
 *     stateKey: 'myNodeState',
 *     saveInterval: 30000,
 *     onStateLoaded: (state) => {
 *         if (state.buffer) node.buffer = state.buffer;
 *     },
 *     getStateToSave: () => ({
 *         buffer: node.buffer,
 *         count: node.count
 *     }),
 *     debug: node.debug
 * });
 *
 * // To manually trigger save:
 * if (persistence) persistence.saveNow();
 */
function initializeStatePersistence(node, options) {
    if (!options || !options.stateKey) {
        throw new Error("stateKey is required for state persistence");
    }

    // Check if persistence is enabled for this node and available
    if (!node.persistState || !StatePersistence) {
        return null;
    }

    const stateKey = options.stateKey;
    const saveInterval = options.saveInterval || 30000;
    const onStateLoaded = options.onStateLoaded || function () {};
    const getStateToSave =
        options.getStateToSave ||
        function () {
            return {};
        };
    const debug = options.debug || false;

    // Debug logging helper
    const debugLog = function (message) {
        if (debug) {
            node.debug(message);
        }
    };

    // Create state manager
    const stateManager = new StatePersistence.NodeStateManager(node, {
        stateKey: stateKey,
        saveInterval: saveInterval
    });

    // Set node.stateManager for backward compatibility with tests
    node.stateManager = stateManager;

    // Load persisted state on startup
    stateManager
        .load()
        .then(function (state) {
            if (state && Object.keys(state).length > 0) {
                try {
                    onStateLoaded(state);
                    debugLog("Loaded persisted state for " + stateKey);
                } catch (err) {
                    debugLog("Error processing loaded state: " + err.message);
                }
            }
        })
        .catch(function (err) {
            debugLog("Failed to load persisted state: " + err.message);
        });

    // Return an enhanced state manager with helper methods
    return {
        /**
         * The underlying state manager instance
         */
        manager: stateManager,

        /**
         * Save current state immediately
         */
        saveNow: function () {
            try {
                const state = getStateToSave();
                if (state && typeof state === "object") {
                    stateManager.setMultiple(state);
                }
            } catch (err) {
                debugLog("Error saving state: " + err.message);
            }
        },

        /**
         * Save state conditionally (e.g., every N samples)
         * @param {number} counter - Current sample counter
         * @param {number} [interval=10] - Save every N samples
         */
        saveIfNeeded: function (counter, interval) {
            interval = interval || 10;
            if (counter % interval === 0) {
                this.saveNow();
            }
        },

        /**
         * Set a single state value
         * @param {string} key - State key
         * @param {*} value - State value
         */
        set: function (key, value) {
            stateManager.set(key, value);
        },

        /**
         * Set multiple state values
         * @param {Object} values - Object with key-value pairs
         */
        setMultiple: function (values) {
            stateManager.setMultiple(values);
        },

        /**
         * Close the state manager (call on node close)
         * @returns {Promise}
         */
        close: async function () {
            try {
                this.saveNow();
                await stateManager.close();
            } catch (err) {
                // Ignore persistence errors during shutdown
            }
        }
    };
}

/**
 * Check if state persistence is available
 * @returns {boolean} True if StatePersistence module is loaded
 */
function isPersistenceAvailable() {
    return StatePersistence !== null;
}

/**
 * Create a standard close handler that saves state
 *
 * @param {Object} node - The Node-RED node instance
 * @param {Object|null} persistence - Persistence helper from initializeStatePersistence
 * @param {Function} [cleanupFn] - Additional cleanup function to call
 * @returns {Function} Close handler function for node.on('close', ...)
 *
 * @example
 * node.on('close', createCloseHandler(node, persistence, () => {
 *     node.buffer = [];
 *     node.status({});
 * }));
 */
function createCloseHandler(node, persistence, cleanupFn) {
    return async function (done) {
        // Save state before closing if persistence enabled
        if (persistence) {
            await persistence.close();
        }

        // Run additional cleanup
        if (typeof cleanupFn === "function") {
            cleanupFn();
        }

        if (done) done();
    };
}

module.exports = {
    initializeStatePersistence: initializeStatePersistence,
    isPersistenceAvailable: isPersistenceAvailable,
    createCloseHandler: createCloseHandler
};
