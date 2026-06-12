/**
 * Config validation helpers
 * =========================
 *
 * Node config fields arrive as strings from the editor. The widespread
 * `parseInt(config.x) || fallback` pattern silently turns the valid value 0
 * (and any NaN edge) into the fallback. These helpers make the intent
 * explicit: parse, fall back when unparseable, clamp into the allowed range
 * otherwise. Semantics match the validators originally embedded in
 * llm-analyzer.js.
 */

"use strict";

/**
 * Parse an integer config value. Unparseable → fallback; out of range →
 * clamped to the nearest bound.
 */
function clampInt(raw, min, max, fallback) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
}

/**
 * Parse a float config value. Same semantics as clampInt.
 */
function clampFloat(raw, min, max, fallback) {
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
}

/**
 * Non-empty string or fallback.
 */
function stringOr(raw, fallback) {
    if (typeof raw === "string" && raw.trim().length > 0) return raw;
    return fallback;
}

module.exports = { clampInt, clampFloat, stringOr };
