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

/** True when something exists at `p` — including a dangling symlink. */
function lexists(p) {
    try {
        fs.lstatSync(p);
        return true;
    } catch (err) {
        return false;
    }
}

/**
 * Real path of `resolved`, also when the path itself does not exist yet.
 *
 * `realpathSync` only works on existing paths, but a file that is about to be
 * created can still sit behind a symlinked *parent*: `<base>/link/new.bin` with
 * `link -> /etc` is lexically inside `<base>` and physically outside it. So
 * resolve the nearest existing ancestor and re-attach the missing tail.
 *
 * @throws when an existing component cannot be resolved (e.g. dangling symlink)
 */
function realpathAllowingMissing(resolved) {
    const tail = [];
    let current = resolved;
    for (;;) {
        if (lexists(current)) {
            const real = fs.realpathSync(current);
            return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
        }
        const parent = path.dirname(current);
        if (parent === current) return resolved;
        tail.push(path.basename(current));
        current = parent;
    }
}

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
            // Not-yet-created files are resolved through their nearest existing
            // ancestor, so a symlinked parent directory cannot smuggle a new
            // file out of the allowlist.
            resolved = realpathAllowingMissing(resolved);
        } catch (err) {
            return { ok: false, resolved: null, reason: "cannot resolve real path: " + err.message };
        }
    }

    const normalised = path.normalize(resolved);

    for (const baseDir of options.allowedBases) {
        if (typeof baseDir !== "string" || baseDir.length === 0) continue;
        const candidates = [path.normalize(path.resolve(baseDir))];
        if (followSymlinks) {
            // The candidate was real-pathed above, so an allowlisted directory
            // that is itself a symlink (a mounted /data, say) has to be compared
            // by its real location too — the operator allowlisted the target.
            try {
                const realBase = path.normalize(realpathAllowingMissing(candidates[0]));
                if (realBase !== candidates[0]) candidates.push(realBase);
            } catch (err) {
                // Unresolvable base: the lexical form is still enforced.
            }
        }
        for (const allowed of candidates) {
            if (normalised === allowed) {
                return { ok: true, resolved: normalised, reason: null };
            }
            // Append separator to ensure /a/b is not considered inside /a/bc.
            const allowedWithSep = allowed.endsWith(path.sep) ? allowed : allowed + path.sep;
            if (normalised.startsWith(allowedWithSep)) {
                return { ok: true, resolved: normalised, reason: null };
            }
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
