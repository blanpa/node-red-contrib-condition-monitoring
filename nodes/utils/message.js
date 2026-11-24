/**
 * Message helpers
 * ===============
 *
 * Shared building blocks for assembling a node's outgoing message.
 *
 * @module utils/message
 */

"use strict";

/**
 * Copy the incoming message's properties onto an outgoing message without
 * clobbering anything the node already computed.
 *
 * This is the Node-RED passthrough convention every analysis node in this
 * package implements: the node owns `payload` (and whatever it explicitly set),
 * everything else — `topic`, `_msgid`, correlation ids, user-added fields —
 * rides along untouched. It was duplicated verbatim in six node files; a single
 * implementation keeps the semantics from drifting apart between them.
 *
 * @param {Object} outputMsg  The message being built. Mutated in place.
 * @param {Object} msg        The incoming message.
 * @param {Object} [options]
 * @param {boolean} [options.includePayload=false]
 *        Also copy `payload` when `outputMsg` has not set one. Off by default:
 *        an analysis node's payload is its result, not its input.
 * @param {boolean} [options.preserveTopic=false]
 *        Force the original `topic` through even if `outputMsg` already set one
 *        — used by nodes whose "output topic" config is empty.
 * @returns {Object} `outputMsg`, for chaining.
 */
function copyPassthrough(outputMsg, msg, options) {
    if (!outputMsg || !msg) return outputMsg;
    const opts = options || {};

    Object.keys(msg).forEach(function (key) {
        if (key === "payload" && !opts.includePayload) return;
        if (!Object.prototype.hasOwnProperty.call(outputMsg, key)) {
            outputMsg[key] = msg[key];
        }
    });

    if (opts.preserveTopic && Object.prototype.hasOwnProperty.call(msg, "topic")) {
        outputMsg.topic = msg.topic;
    }

    return outputMsg;
}

module.exports = { copyPassthrough };
