/**
 * Sensor value parsing
 * ====================
 *
 * One strict reading of "a sensor value" for every detection node. The nodes
 * used to differ: anomaly-detector rejected "123abc" and `[7]`, while
 * isolation-forest's `parseFloat` read them as 123 and 7, and the object paths
 * of pca-anomaly / multi-value-processor read an ISO timestamp
 * ("2024-05-01T12:00:00Z") as the sensor value 2024 — and then monitored it.
 *
 * @module utils/sensor-value
 */

"use strict";

const { isIsoDateLike } = require("./config-validator");

// Purely numeric text: optional sign, digits with an optional fraction, an
// optional exponent. Same expression as anomaly-detector's payload check, so
// a string is a number for every node or for none.
const NUMERIC_RE = /^-?\d*\.?\d+(?:[eE][-+]?\d+)?$/;

/**
 * Read one sensor value.
 *
 * Accepts finite numbers and strings that are nothing but a number ("7",
 * " -1.5e3 "). Everything else is `null`: NaN / Infinity, booleans, arrays,
 * objects, `null`, empty strings, text with a numeric prefix ("123abc",
 * "65 °C") and date-like strings.
 *
 * @param {*} raw
 * @returns {number|null}
 */
function parseSensorValue(raw) {
    if (typeof raw === "number") {
        return Number.isFinite(raw) ? raw : null;
    }
    if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed === "" || isIsoDateLike(trimmed) || !NUMERIC_RE.test(trimmed)) {
            return null;
        }
        const parsed = parseFloat(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/**
 * True for a string the old lenient parsers would have turned into a number:
 * `parseFloat` reads "2024-05-01" as 2024 and "123abc" as 123. Nodes use it to
 * warn once about a field that was monitored before and is skipped now.
 *
 * @param {*} raw
 * @returns {boolean}
 */
function isLenientNumeric(raw) {
    return typeof raw === "string" && Number.isFinite(parseFloat(raw)) && parseSensorValue(raw) === null;
}

/**
 * Read the sensor values of an object payload, in key order.
 *
 * @param {Object} obj
 * @param {Object} [options]
 * @param {string[]} [options.skipKeys] Keys that are never sensor values (and
 *        are not reported as skipped either), e.g. a device id the node reads
 *        for grouping.
 * @returns {{names: string[], values: number[], skipped: string[]}}
 *          `skipped` lists the keys whose value was not a sensor value.
 */
function parseSensorObject(obj, options) {
    const names = [];
    const values = [];
    const skipped = [];
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        return { names: names, values: values, skipped: skipped };
    }

    const skipKeys = options && Array.isArray(options.skipKeys) ? new Set(options.skipKeys) : null;
    Object.keys(obj).forEach(function (key) {
        if (skipKeys && skipKeys.has(key)) return;
        const value = parseSensorValue(obj[key]);
        if (value === null) {
            skipped.push(key);
        } else {
            names.push(key);
            values.push(value);
        }
    });

    return { names: names, values: values, skipped: skipped };
}

/**
 * A `warn(payload, skipped)` function for a node: warns ONCE per field name
 * about skipped fields that earlier releases did read as numbers (a date
 * string became 2024, "123abc" became 123), so the change in what is monitored
 * does not go unnoticed. Fields that were never numeric (text metadata, null)
 * stay silent — nothing changed for them.
 *
 * @param {Object} node - The node (its `warn` is called)
 * @returns {function(Object, string[]): void}
 */
function createSkippedFieldWarner(node) {
    const warned = new Set();
    return function (payload, skipped) {
        const fresh = skipped.filter(function (key) {
            return !warned.has(key) && isLenientNumeric(payload[key]);
        });
        if (fresh.length === 0) return;
        fresh.forEach(function (key) {
            warned.add(key);
        });
        node.warn(
            "Ignoring non-numeric field(s) " +
                fresh
                    .map(function (key) {
                        return '"' + key + '"';
                    })
                    .join(", ") +
                " (text or timestamp, not a sensor value)"
        );
    };
}

module.exports = { parseSensorValue, parseSensorObject, isLenientNumeric, createSkippedFieldWarner, NUMERIC_RE };
