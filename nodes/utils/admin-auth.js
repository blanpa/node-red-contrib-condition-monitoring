/**
 * Admin route authentication helper
 * =================================
 *
 * Node-RED does **not** apply `adminAuth` to routes a node registers on
 * `RED.httpAdmin` — the node has to opt in explicitly via
 * `RED.auth.needsPermission()`. Forgetting that leaves the route reachable by
 * anyone who can talk to the editor port, even on a runtime with adminAuth
 * configured.
 *
 * This wrapper makes the opt-in a one-liner and, when `RED.auth` is missing
 * (partial test doubles, stripped-down embeddings), fails **closed** instead of
 * quietly serving the route unauthenticated.
 *
 * @module utils/admin-auth
 */

"use strict";

/**
 * Build the permission middleware for an httpAdmin route.
 *
 * @param {Object} RED    The Node-RED runtime object handed to the node module.
 * @param {string} scope  Permission scope, e.g. "ml-inference.read" / ".write".
 * @returns {Function} Express middleware.
 *
 * @example
 * const { needsPermission } = require("./utils/admin-auth");
 * RED.httpAdmin.get("/my-node/status", needsPermission(RED, "my-node.read"), handler);
 */
function needsPermission(RED, scope) {
    if (RED && RED.auth && typeof RED.auth.needsPermission === "function") {
        return RED.auth.needsPermission(scope);
    }
    // Fail closed: an unguardable route is worse than an unavailable one.
    return function denyMissingAuth(req, res) {
        res.status(401).json({
            error: "Admin authentication is unavailable; refusing to serve " + scope
        });
    };
}

module.exports = { needsPermission };
