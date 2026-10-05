/**
 * utils/group-state: group key resolution, the LRU-bounded group map and the
 * field swapper used by nodes that keep their state on the node itself.
 */
const groupState = require("../nodes/utils/group-state");

const RED = {
    util: {
        getMessageProperty: function (msg, path) {
            if (path === "boom") throw new Error("bad path");
            return path.split(".").reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), msg);
        }
    }
};

describe("group-state", function () {
    describe("resolveGroupKey", function () {
        it("returns the default group when grouping is disabled", function () {
            expect(groupState.resolveGroupKey(RED, { topic: "a" }, "")).toBe(groupState.DEFAULT_GROUP);
        });

        it("accepts non-empty strings and finite numbers, nested paths included", function () {
            expect(groupState.resolveGroupKey(RED, { topic: "pump-1" }, "topic")).toBe("pump-1");
            expect(groupState.resolveGroupKey(RED, { payload: { id: 7 } }, "payload.id")).toBe("7");
        });

        it.each([[undefined], [null], [""], [{}], [NaN], [Infinity], [true]])(
            "maps %p to the default group",
            function (value) {
                expect(groupState.resolveGroupKey(RED, { topic: value }, "topic")).toBe(groupState.DEFAULT_GROUP);
            }
        );

        it("maps a throwing property path to the default group", function () {
            expect(groupState.resolveGroupKey(RED, {}, "boom")).toBe(groupState.DEFAULT_GROUP);
        });
    });

    describe("getOrCreateGroup", function () {
        const options = function (extra) {
            return Object.assign({ max: 2, create: (key) => ({ key: key, n: 0 }) }, extra);
        };

        it("creates a state once and returns the same object afterwards", function () {
            const groups = new Map();
            const a = groupState.getOrCreateGroup(groups, "a", options());
            a.n = 5;
            expect(groupState.getOrCreateGroup(groups, "a", options())).toBe(a);
            expect(groups.size).toBe(1);
        });

        it("evicts the least recently used group beyond max and reports it", function () {
            const groups = new Map();
            const evicted = [];
            const opts = options({ onEvict: (key, state) => evicted.push([key, state.key]) });
            groupState.getOrCreateGroup(groups, "a", opts);
            groupState.getOrCreateGroup(groups, "b", opts);
            groupState.getOrCreateGroup(groups, "a", opts); // a is now the most recent
            groupState.getOrCreateGroup(groups, "c", opts);
            expect(Array.from(groups.keys())).toEqual(["a", "c"]);
            expect(evicted).toEqual([["b", "b"]]);
        });

        it("does not reorder on access when lru is false", function () {
            const groups = new Map();
            const opts = options({ lru: false, max: 5 });
            groupState.getOrCreateGroup(groups, "a", opts);
            groupState.getOrCreateGroup(groups, "b", opts);
            groupState.getOrCreateGroup(groups, "a", opts);
            expect(Array.from(groups.keys())).toEqual(["a", "b"]);
        });
    });

    describe("createStateSwapper", function () {
        function build(max) {
            const target = { items: [], count: 0, untouched: "kept" };
            const parked = new Map();
            const swapper = groupState.createStateSwapper(target, {
                fields: ["items", "count"],
                fresh: () => ({ items: [], count: 0 }),
                parked: parked,
                isEmpty: (t) => t.items.length === 0,
                max: () => max
            });
            return { target, parked, swapper };
        }

        it("swaps the listed fields per key and leaves other fields alone", function () {
            const { target, swapper } = build(5);
            swapper.switchTo("a");
            target.items.push(1);
            target.count = 1;
            swapper.switchTo("b");
            expect(target.items).toEqual([]);
            target.items.push(2, 3);
            swapper.switchTo("a");
            expect(target.items).toEqual([1]);
            expect(target.count).toBe(1);
            expect(target.untouched).toBe("kept");
            expect(swapper.activeKey()).toBe("a");
        });

        it("does not park an untouched state", function () {
            const { parked, swapper } = build(5);
            expect(swapper.switchTo("a")).toBe(true);
            expect(parked.size).toBe(0);
            expect(swapper.switchTo("a")).toBe(false);
        });

        it("bounds the total number of states and evicts the least recently used", function () {
            const { target, parked, swapper } = build(2);
            ["a", "b", "c"].forEach(function (key, i) {
                swapper.switchTo(key);
                target.items.push(i);
            });
            // live: c, parked: b (a was evicted)
            expect(Array.from(parked.keys())).toEqual(["b"]);
            swapper.switchTo("a");
            expect(target.items).toEqual([]);
        });

        it("resetAll drops every state and returns to the initial key", function () {
            const { target, parked, swapper } = build(5);
            swapper.switchTo("a");
            target.items.push(1);
            swapper.switchTo("b");
            swapper.resetAll();
            expect(parked.size).toBe(0);
            expect(target.items).toEqual([]);
            expect(swapper.activeKey()).toBe(groupState.DEFAULT_GROUP);
        });

        it("setActiveKey relabels the live state without swapping it", function () {
            const { target, parked, swapper } = build(5);
            target.items.push(9);
            swapper.setActiveKey("restored");
            expect(swapper.activeKey()).toBe("restored");
            expect(target.items).toEqual([9]);
            swapper.switchTo("other");
            expect(Array.from(parked.keys())).toEqual(["restored"]);
        });
    });
});
