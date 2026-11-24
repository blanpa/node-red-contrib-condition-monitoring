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

// YYYY-MM-DD, alone or followed by a time part ("T…" / " …").
const ISO_DATE_RE = /^\s*\d{4}-\d{2}-\d{2}(?:\s*$|[T\s])/;

/**
 * True for strings shaped like an ISO date or timestamp ("2024-05-01",
 * "2024-05-01T12:00:00Z"). `parseFloat` happily reads those as the number
 * 2024, so lenient numeric parsers ("65 °C" → 65) check this first to keep a
 * timestamp column from being ingested as a sensor value.
 */
function isIsoDateLike(raw) {
    return typeof raw === "string" && ISO_DATE_RE.test(raw);
}

module.exports = { clampInt, clampFloat, stringOr, isIsoDateLike };
