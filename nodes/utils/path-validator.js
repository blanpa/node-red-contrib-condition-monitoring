/**
 * Path validation helpers
 * =======================
 *
 * Defends against path traversal when nodes accept user-supplied model paths
 * (e.g. via the editor or `msg.modelPath`). The contract is simple:
 *
 *   - Absolute paths must resolve to a real path inside one of the allowlisted
 *     base directories (or an explicitly allowed list of file extensions).
 *   - Relative paths are resolved against `cwd` (or another supplied base) and
 *     must stay inside the allowlist after resolution.
 *   - Symlinks are not silently followed outside the allowlist.
 *
 * The validator is intentionally side-effect free except for one optional
 * `realpathSync` call to detect symlink escapes.
 *
 * @module utils/path-validator
 */

"use strict";

const fs = require("fs");
const path = require("path");

/**
 * @typedef {Object} ValidatePathOptions
 * @property {string[]} allowedBases  Absolute directories the path is allowed to resolve into.
 * @property {string} [base]          Base directory used to resolve relative inputs (defaults to cwd).
 * @property {boolean} [followSymlinks=true]
 *           When true, the resolved path is run through `fs.realpathSync` (if it exists)
 *           so a symlink pointing outside the allowlist is detected and rejected.
 */

/**
 * @typedef {Object} ValidatePathResult
 * @property {boolean} ok           Whether the path is allowed.
 * @property {string|null} resolved Absolute, normalised path (or null on rejection).
 * @property {string|null} reason   Human-readable rejection reason.
 */

/**
 * Validate that `inputPath` resolves inside one of `allowedBases`.
 *
 * @param {string} inputPath
 * @param {ValidatePathOptions} options
 * @returns {ValidatePathResult}
 */
function validatePath(inputPath, options) {
    if (typeof inputPath !== "string" || inputPath.length === 0) {
        return { ok: false, resolved: null, reason: "path must be a non-empty string" };
    }
    if (!options || !Array.isArray(options.allowedBases) || options.allowedBases.length === 0) {
        return { ok: false, resolved: null, reason: "allowedBases must be a non-empty array" };
    }

    // Reject NUL bytes outright — these can be used to truncate paths in some
    // C-bindings underneath Node-RED (native add-ons, libuv variants).
    if (inputPath.indexOf(String.fromCharCode(0)) !== -1) {
        return { ok: false, resolved: null, reason: "path contains a NUL byte" };
    }

    const base = typeof options.base === "string" && options.base.length > 0 ? options.base : process.cwd();
    const followSymlinks = options.followSymlinks !== false;

    let resolved;
    try {
        resolved = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(base, inputPath);
    } catch (err) {
        return { ok: false, resolved: null, reason: "cannot resolve path: " + err.message };
    }

    if (followSymlinks) {
        try {
            // realpathSync only succeeds for existing paths; for not-yet-created files
            // we still validate the lexical resolution against the allowlist below.
            if (fs.existsSync(resolved)) {
                resolved = fs.realpathSync(resolved);
            }
        } catch (err) {
            return { ok: false, resolved: null, reason: "cannot resolve real path: " + err.message };
        }
    }

    const normalised = path.normalize(resolved);

    for (const baseDir of options.allowedBases) {
        if (typeof baseDir !== "string" || baseDir.length === 0) continue;
        const allowed = path.normalize(path.resolve(baseDir));
        if (normalised === allowed) {
            return { ok: true, resolved: normalised, reason: null };
        }
        // Append separator to ensure /a/b is not considered inside /a/bc.
        const allowedWithSep = allowed.endsWith(path.sep) ? allowed : allowed + path.sep;
        if (normalised.startsWith(allowedWithSep)) {
            return { ok: true, resolved: normalised, reason: null };
        }
    }

    return {
        ok: false,
        resolved: null,
        reason: "path is outside the allowed directories: " + normalised
    };
}

/**
 * Convenience wrapper that throws a typed error on rejection — useful inside
 * async load functions that already propagate errors via try/catch.
 *
 * @param {string} inputPath
 * @param {ValidatePathOptions} options
 * @returns {string} the resolved absolute path
 */
function assertPath(inputPath, options) {
    const r = validatePath(inputPath, options);
    if (!r.ok) {
        const err = new Error("Refusing to use path: " + r.reason);
        err.code = "EPATHFORBIDDEN";
        throw err;
    }
    return r.resolved;
}

module.exports = {
    validatePath,
    assertPath
};
