/**
 * Error Handling Utility
 * ======================
 *
 * Standardized error handling functions for Node-RED condition monitoring nodes.
 * Provides consistent error messaging, status updates, and logging across all nodes.
 *
 * @module utils/error-handler
 */

"use strict";

/**
 * Error severity levels
 * @enum {string}
 */
const ErrorLevel = {
    ERROR: 'error',
    WARN: 'warn',
    INFO: 'info'
};

/**
 * Handle an error on a Node-RED node with consistent status and logging
 *
 * @param {Object} node - The Node-RED node instance
 * @param {string} errorMsg - Error message to display/log
 * @param {Object} [msg=null] - The message that caused the error (for error routing)
 * @param {string} [level='error'] - Error level: 'error', 'warn', or 'info'
 * @param {Object} [options={}] - Additional options
 * @param {string} [options.statusText] - Custom status text (defaults to truncated errorMsg)
 * @param {string} [options.statusColor] - Status color: 'red', 'yellow', 'grey' (default based on level)
 * @param {string} [options.statusShape] - Status shape: 'ring' or 'dot' (default: 'ring')
 *
 * @example
 * // Simple error
 * handleNodeError(node, "Invalid payload: not a number", msg);
 *
 * // Warning level
 * handleNodeError(node, "Missing optional field", msg, 'warn');
 *
 * // Custom status
 * handleNodeError(node, "Connection timeout after 30s", msg, 'error', {
 *     statusText: "timeout"
 * });
 */
function handleNodeError(node, errorMsg, msg, level, options) {
    level = level || ErrorLevel.ERROR;
    options = options || {};

    // Determine status color based on level
    var statusColor = options.statusColor;
    if (!statusColor) {
        switch (level) {
            case ErrorLevel.ERROR:
                statusColor = 'red';
                break;
            case ErrorLevel.WARN:
                statusColor = 'yellow';
                break;
            case ErrorLevel.INFO:
                statusColor = 'grey';
                break;
            default:
                statusColor = 'red';
        }
    }

    // Truncate status text to fit in Node-RED UI
    var statusText = options.statusText || errorMsg;
    if (statusText.length > 25) {
        statusText = statusText.substring(0, 22) + '...';
    }

    // Update node status
    node.status({
        fill: statusColor,
        shape: options.statusShape || 'ring',
        text: statusText
    });

    // Log based on level
    switch (level) {
        case ErrorLevel.ERROR:
            node.error(errorMsg, msg);
            break;
        case ErrorLevel.WARN:
            node.warn(errorMsg);
            break;
        case ErrorLevel.INFO:
            // Info level just logs to debug
            if (node.debug) {
                node.warn("[INFO] " + errorMsg);
            }
            break;
    }
}

/**
 * Create a validation error object with consistent structure
 *
 * @param {string} fieldName - Name of the field that failed validation
 * @param {string} expectedType - Expected type or format description
 * @param {*} actualValue - The actual value received
 * @returns {Object} Structured error object
 *
 * @example
 * if (typeof value !== 'number') {
 *     const err = createValidationError('payload', 'number', typeof value);
 *     handleNodeError(node, err.message, msg);
 *     return;
 * }
 */
function createValidationError(fieldName, expectedType, actualValue) {
    var actualType = actualValue === null ? 'null' :
                     actualValue === undefined ? 'undefined' :
                     Array.isArray(actualValue) ? 'array' :
                     typeof actualValue;

    var actualStr = actualType;
    if (actualType === 'string' && actualValue.length > 20) {
        actualStr = 'string("' + actualValue.substring(0, 17) + '...")';
    } else if (actualType === 'string') {
        actualStr = 'string("' + actualValue + '")';
    } else if (actualType === 'number') {
        actualStr = 'number(' + actualValue + ')';
    }

    return {
        field: fieldName,
        expected: expectedType,
        actual: actualType,
        message: "Invalid " + fieldName + ": expected " + expectedType + ", got " + actualStr,
        shortMessage: "invalid " + fieldName
    };
}

/**
 * Validate that a value is a finite number
 *
 * @param {*} value - Value to validate
 * @param {string} [fieldName='value'] - Name of the field for error messages
 * @returns {{valid: boolean, error: Object|null, value: number|null}} Validation result
 *
 * @example
 * const result = validateFiniteNumber(msg.payload, 'payload');
 * if (!result.valid) {
 *     handleNodeError(node, result.error.message, msg);
 *     return;
 * }
 * const value = result.value;
 */
function validateFiniteNumber(value, fieldName) {
    fieldName = fieldName || 'value';

    if (typeof value === 'number') {
        if (Number.isFinite(value)) {
            return { valid: true, error: null, value: value };
        } else {
            return {
                valid: false,
                error: createValidationError(fieldName, 'finite number', value + ' (NaN or Infinity)'),
                value: null
            };
        }
    }

    if (typeof value === 'string') {
        var trimmed = value.trim();
        // Strict numeric format check
        if (trimmed === '' || !/^-?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(trimmed)) {
            return {
                valid: false,
                error: createValidationError(fieldName, 'numeric string', value),
                value: null
            };
        }
        var parsed = parseFloat(trimmed);
        if (Number.isFinite(parsed)) {
            return { valid: true, error: null, value: parsed };
        }
    }

    return {
        valid: false,
        error: createValidationError(fieldName, 'number', value),
        value: null
    };
}

/**
 * Validate array of sensor readings
 *
 * @param {Array} items - Array of sensor readings to validate
 * @param {Object} [options={}] - Validation options
 * @param {string} [options.valueField='value'] - Field name containing the numeric value
 * @param {string} [options.nameField='name'] - Field name containing the sensor name
 * @param {boolean} [options.logInvalid=false] - Whether to log skipped invalid entries
 * @param {Object} [options.node=null] - Node instance for logging (required if logInvalid is true)
 * @returns {{valid: Array, invalid: Array, count: {total: number, valid: number, invalid: number}}}
 *
 * @example
 * const result = validateSensorArray(msg.payload, {
 *     valueField: 'value',
 *     nameField: 'name',
 *     logInvalid: true,
 *     node: node
 * });
 *
 * if (result.count.valid === 0) {
 *     handleNodeError(node, "No valid sensor readings", msg);
 *     return;
 * }
 */
function validateSensorArray(items, options) {
    options = options || {};
    var valueField = options.valueField || 'value';
    var nameField = options.nameField || 'name';
    var logInvalid = options.logInvalid || false;
    var node = options.node;

    var valid = [];
    var invalid = [];

    if (!Array.isArray(items)) {
        return {
            valid: [],
            invalid: [{ item: items, reason: 'not an array' }],
            count: { total: 0, valid: 0, invalid: 1 }
        };
    }

    items.forEach(function(item, index) {
        if (typeof item === 'object' && item !== null) {
            var value = item[valueField];
            var name = item[nameField] || ('sensor' + index);

            if (value === undefined || value === null) {
                invalid.push({ item: item, reason: 'missing ' + valueField, index: index });
                if (logInvalid && node) {
                    node.warn("Skipping sensor " + name + ": missing " + valueField);
                }
            } else {
                var validation = validateFiniteNumber(value, valueField);
                if (validation.valid) {
                    valid.push({
                        name: name,
                        value: validation.value,
                        originalItem: item
                    });
                } else {
                    invalid.push({ item: item, reason: validation.error.message, index: index });
                    if (logInvalid && node) {
                        node.warn("Skipping sensor " + name + ": " + validation.error.shortMessage);
                    }
                }
            }
        } else if (typeof item === 'number') {
            if (Number.isFinite(item)) {
                valid.push({
                    name: 'sensor' + index,
                    value: item,
                    originalItem: item
                });
            } else {
                invalid.push({ item: item, reason: 'not a finite number', index: index });
            }
        } else {
            invalid.push({ item: item, reason: 'invalid type: ' + typeof item, index: index });
        }
    });

    return {
        valid: valid,
        invalid: invalid,
        count: {
            total: items.length,
            valid: valid.length,
            invalid: invalid.length
        }
    };
}

/**
 * Sanitize an object to prevent prototype pollution
 * Call this after JSON.parse() on user-provided data
 *
 * @param {Object} obj - Object to sanitize
 * @returns {Object} The same object with dangerous properties removed
 *
 * @example
 * let config = JSON.parse(userInput);
 * sanitizeObject(config);
 */
function sanitizeObject(obj) {
    if (obj && typeof obj === 'object') {
        delete obj.__proto__;
        delete obj.constructor;
        delete obj.prototype;
    }
    return obj;
}

/**
 * Wrap a function with error handling that updates node status
 *
 * @param {Object} node - The Node-RED node instance
 * @param {Function} fn - Function to wrap
 * @param {string} [errorPrefix='Error'] - Prefix for error messages
 * @returns {Function} Wrapped function that catches and handles errors
 *
 * @example
 * const safeProcess = wrapWithErrorHandler(node, processData, 'Processing');
 * safeProcess(msg); // Errors are caught and node status updated
 */
function wrapWithErrorHandler(node, fn, errorPrefix) {
    errorPrefix = errorPrefix || 'Error';
    return function() {
        try {
            return fn.apply(this, arguments);
        } catch (err) {
            handleNodeError(node, errorPrefix + ": " + err.message, arguments[0]);
            return null;
        }
    };
}

module.exports = {
    // Error levels
    ErrorLevel: ErrorLevel,

    // Main error handler
    handleNodeError: handleNodeError,

    // Validation helpers
    createValidationError: createValidationError,
    validateFiniteNumber: validateFiniteNumber,
    validateSensorArray: validateSensorArray,

    // Security
    sanitizeObject: sanitizeObject,

    // Utility
    wrapWithErrorHandler: wrapWithErrorHandler
};
