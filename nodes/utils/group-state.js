/**
 * Per-group node state, shared by every node that can keep one independent
 * state per value of a message property ("Group By": one buffer / baseline /
 * model per device on an interleaved multi-device stream).
 *
 * Two shapes of node use it:
 *
 *  - nodes whose state is one object per group and that look it up on every
 *    message (`getOrCreateGroup` on a Map kept in least-recently-used order);
 *  - nodes whose hot path reads its state as plain fields on the node itself
 *    (`createStateSwapper`: the fields of the outgoing group are parked in a
 *    Map and those of the incoming one assigned back).
 *
 * Both bound the number of groups, so an unbounded key space (a topic per
 * message) evicts the least recently used state instead of growing forever.
 */
"use strict";

/** Key of the state that messages without a usable group value share. */
const DEFAULT_GROUP = "";

/**
 * Resolve the group key of a message.
 *
 * A non-empty string or a finite number selects a group; anything else
 * (missing property, object, null, a property path that throws) is the default
 * group, so ungrouped traffic still has a home.
 *
 * @param {object} RED - the Node-RED runtime (for RED.util.getMessageProperty)
 * @param {object} msg
 * @param {string} property - message property path, "" = grouping disabled
 * @returns {string}
 */
function resolveGroupKey(RED, msg, property) {
    if (!property) {
        return DEFAULT_GROUP;
    }
    let value;
    try {
        value = RED.util.getMessageProperty(msg, property);
    } catch (e) {
        return DEFAULT_GROUP;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }
    return typeof value === "string" && value !== "" ? value : DEFAULT_GROUP;
}

/**
 * Fetch (or create) the state for a key in a Map kept in LRU order.
 *
 * @param {Map<string, object>} groups
 * @param {string} key
 * @param {object} options
 * @param {function(string): object} options.create - builds a fresh state
 * @param {number} options.max - maximum number of groups
 * @param {boolean} [options.lru=true] - move the key to the most recent end on
 *   access; pass false when grouping is disabled (a single key never moves)
 * @param {function(string, object): void} [options.onEvict]
 * @returns {object}
 */
function getOrCreateGroup(groups, key, options) {
    let state = groups.get(key);
    if (state) {
        if (options.lru !== false) {
            groups.delete(key);
            groups.set(key, state);
        }
        return state;
    }

    state = options.create(key);
    groups.set(key, state);

    const max = options.max > 0 ? options.max : 1;
    while (groups.size > max) {
        const oldest = groups.keys().next().value;
        const evicted = groups.get(oldest);
        groups.delete(oldest);
        if (typeof options.onEvict === "function") {
            options.onEvict(oldest, evicted);
        }
    }
    return state;
}

/**
 * Keep a node's state as plain fields on `target`, one set per key.
 *
 * Switching away parks the listed fields of the active key in `parked`;
 * switching to a key assigns its parked fields (or a fresh set) back. The
 * active key is never in `parked`, so the total number of states is
 * `parked.size + 1`.
 *
 * @param {object} target - the object carrying the live fields (the node)
 * @param {object} options
 * @param {string[]} options.fields - names of the fields that make up one state
 * @param {function(): object} options.fresh - builds a fresh set of those fields
 * @param {Map<string, object>} options.parked - storage for inactive states
 * @param {function(): number} options.max - maximum number of states in total
 * @param {function(object): boolean} [options.isEmpty] - true when the live
 *   fields hold no data yet; such a state is not parked on a switch-away
 * @param {string} [options.initialKey=DEFAULT_GROUP]
 * @returns {{activeKey: function(): string, switchTo: function(string): boolean,
 *            resetAll: function(): void, setActiveKey: function(string): void}}
 */
function createStateSwapper(target, options) {
    const fields = options.fields;
    const parked = options.parked;
    let active = options.initialKey !== undefined ? options.initialKey : DEFAULT_GROUP;

    function snapshot() {
        const bundle = {};
        fields.forEach(function (f) {
            bundle[f] = target[f];
        });
        return bundle;
    }

    return {
        activeKey: function () {
            return active;
        },

        /** Declare which key the live fields belong to (after restoring state). */
        setActiveKey: function (key) {
            parked.delete(key);
            active = key;
        },

        /** @returns {boolean} true when the live fields were swapped */
        switchTo: function (key) {
            if (key === active) return false;
            // An untouched state (typically the default key before the first
            // keyed message) is dropped rather than parked: it holds nothing
            // and would only occupy a slot.
            if (typeof options.isEmpty === "function" && options.isEmpty(target)) {
                parked.delete(active);
            } else {
                parked.set(active, snapshot());
            }
            let bundle = parked.get(key);
            if (bundle) {
                parked.delete(key); // re-inserted on the next switch-away → LRU order
            } else {
                const max = Math.max(1, options.max());
                while (parked.size >= max) {
                    parked.delete(parked.keys().next().value);
                }
                bundle = options.fresh();
            }
            Object.assign(target, bundle);
            active = key;
            return true;
        },

        resetAll: function () {
            parked.clear();
            Object.assign(target, options.fresh());
            active = options.initialKey !== undefined ? options.initialKey : DEFAULT_GROUP;
        }
    };
}

module.exports = {
    DEFAULT_GROUP,
    resolveGroupKey,
    getOrCreateGroup,
    createStateSwapper
};
