/**
 * Minimal RED stub for driving a node synchronously, without a Node-RED
 * runtime.
 *
 * node-red-node-test-helper unloads a flow before a node's asynchronous state
 * load can be observed, and delivers messages on later ticks. These helpers
 * construct the node directly against a controlled context store, so a spec
 * can seed persisted state, feed hundreds of samples in a tight loop and read
 * every output in order.
 *
 * Not a spec file (no `_spec` suffix), so jest does not collect it.
 */

"use strict";

const EventEmitter = require("events");

/**
 * @param {Function} nodeModule     the node's `module.exports = function (RED)`
 * @param {Object}   config         node config, as the editor would store it
 * @param {Object}   [seededContext] context store contents present at startup
 * @returns {{node, store, sent, errors, warnings, debugLines, statuses}}
 */
function buildStubbedNode(nodeModule, config, seededContext) {
    const store = Object.assign({}, seededContext);
    const context = {
        get: function (key, storeName, cb) {
            if (typeof cb === "function") {
                cb(null, store[key]);
                return undefined;
            }
            return store[key];
        },
        set: function (key, value, storeName, cb) {
            store[key] = value;
            if (typeof cb === "function") cb(null);
        }
    };

    const sent = [];
    const errors = [];
    const warnings = [];
    const debugLines = [];
    const statuses = [];

    let Constructor = null;
    nodeModule({
        nodes: {
            createNode: function (node) {
                node.status = function (s) {
                    statuses.push(s);
                };
                // A real method, like Node-RED's own logger: a node that
                // overwrites it with a boolean breaks here exactly as it would
                // in the runtime.
                node.debug = function (line) {
                    debugLines.push(String(line));
                };
                node.warn = function (w) {
                    warnings.push(String(w));
                };
                node.error = function (e) {
                    errors.push(String(e && e.message ? e.message : e));
                };
                node.log = function () {};
                node.send = function (m) {
                    sent.push(m);
                };
                node.context = function () {
                    return context;
                };
            },
            registerType: function (name, ctor) {
                Constructor = ctor;
            }
        },
        util: {
            getMessageProperty: function (msg, path) {
                return path.split(".").reduce(function (obj, key) {
                    return obj === null || obj === undefined ? undefined : obj[key];
                }, msg);
            },
            cloneMessage: function (msg) {
                return JSON.parse(JSON.stringify(msg));
            }
        },
        auth: {
            needsPermission: function () {
                return function (req, res, next) {
                    next();
                };
            }
        },
        httpAdmin: { get: function () {}, post: function () {} }
    });

    const node = new EventEmitter();
    Constructor.call(node, config);
    return {
        node: node,
        store: store,
        sent: sent,
        errors: errors,
        warnings: warnings,
        debugLines: debugLines,
        statuses: statuses
    };
}

/**
 * Deliver one message and return what the node sent for it, synchronously:
 * `{ out1, out2, error }` (each undefined when nothing went that way). When a
 * node sends several messages for one input, `all` lists every send() call.
 */
function feed(stub, msg) {
    const calls = [];
    let error;
    stub.node.emit(
        "input",
        msg,
        function (m) {
            calls.push(m);
            stub.sent.push(m);
        },
        function (err) {
            if (err) {
                error = String(err && err.message ? err.message : err);
                stub.errors.push(error);
            }
        }
    );
    const first = calls[0];
    return {
        out1: Array.isArray(first) ? first[0] || undefined : first,
        out2: Array.isArray(first) ? first[1] || undefined : undefined,
        error: error,
        all: calls
    };
}

/** The message a feed() produced on either output. */
function output(result) {
    return result.out1 || result.out2;
}

function closeNode(node) {
    return new Promise(function (resolve) {
        node.emit("close", resolve);
    });
}

/** Let the asynchronous context load settle. */
function settle() {
    return new Promise(function (resolve) {
        setTimeout(resolve, 20);
    });
}

/**
 * Deterministic pseudo-random source (mulberry32). Tests must not use
 * Math.random(): a borderline sample would make them flaky.
 *
 * @returns {{next: function(): number, gauss: function(): number}}
 */
function seededRandom(seed) {
    let a = seed >>> 0;
    const next = function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        next: next,
        // Standard normal (Box–Muller)
        gauss: function () {
            return Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next());
        }
    };
}

module.exports = { buildStubbedNode, feed, output, closeNode, settle, seededRandom };
