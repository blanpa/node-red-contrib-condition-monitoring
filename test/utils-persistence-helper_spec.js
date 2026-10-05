"use strict";

const { NodeStateManager } = require("../nodes/state-persistence");
const { initializeStatePersistence, createCloseHandler } = require("../nodes/utils/persistence-helper");

/** Minimal node double whose context store answers asynchronously, like the file store. */
function makeNode(stored, delayMs = 20) {
    const store = { value: stored };
    const node = {
        persistState: true,
        warnings: [],
        store,
        debug() {},
        warn(m) {
            node.warnings.push(m);
        },
        context() {
            return {
                get(key, storeName, cb) {
                    setTimeout(() => cb(null, store.value), delayMs);
                    return undefined;
                },
                set(key, value, storeName, cb) {
                    store.value = value;
                    setTimeout(() => cb(null), 0);
                }
            };
        }
    };
    return node;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("state persistence helpers", () => {
    const managers = [];

    afterEach(async () => {
        for (const m of managers.splice(0)) await m.close();
    });

    it("load() keeps values that were set while the store was still loading", async () => {
        const node = makeNode({ buffer: [1, 2, 3], count: 3 });
        const manager = new NodeStateManager(node, { autoSave: false });
        managers.push(manager);

        const loading = manager.load();
        manager.set("count", 99); // arrives before the store answered
        const state = await loading;

        expect(state.buffer).toEqual([1, 2, 3]);
        expect(state.count).toBe(99);
        expect(manager.isLoaded).toBe(true);
    });

    it("saveNow() does not overwrite persisted history before it has been loaded", async () => {
        const node = makeNode({ buffer: [1, 2, 3] }, 30);
        let buffer = [];
        const loaded = [];
        const persistence = initializeStatePersistence(node, {
            stateKey: "testState",
            onStateLoaded: (state) => {
                loaded.push(state.buffer);
                buffer = state.buffer.slice();
            },
            getStateToSave: () => ({ buffer })
        });
        managers.push(persistence.manager);

        buffer = [42]; // first sample after startup, load still pending
        persistence.saveNow();
        await sleep(80);

        expect(loaded).toEqual([[1, 2, 3]]);
        expect(buffer).toEqual([1, 2, 3]);

        // Once loaded, saving works as before.
        buffer.push(4);
        persistence.saveNow();
        expect(persistence.manager.get("buffer")).toEqual([1, 2, 3, 4]);
    });

    it("createCloseHandler still calls done() when the cleanup function throws", async () => {
        const node = makeNode(null);
        const done = jest.fn();
        const handler = createCloseHandler(node, null, () => {
            throw new Error("cleanup exploded");
        });
        await handler(done);
        expect(done).toHaveBeenCalledTimes(1);
        expect(node.warnings.join(" ")).toMatch(/cleanup exploded/);
    });

    it("createCloseHandler saves through the persistence helper before cleanup", async () => {
        const node = makeNode(null, 0);
        const persistence = initializeStatePersistence(node, {
            stateKey: "testState",
            getStateToSave: () => ({ count: 7 })
        });
        await sleep(20);
        const order = [];
        const handler = createCloseHandler(node, persistence, () => order.push("cleanup"));
        await handler(() => order.push("done"));
        expect(order).toEqual(["cleanup", "done"]);
        expect(node.store.value).toEqual({ count: 7 });
    });
});
