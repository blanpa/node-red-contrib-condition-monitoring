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

    it("markDirty() lets the manager's auto-save pull a snapshot — one writer, no node-side timer", async () => {
        const node = makeNode(null, 0);
        const buffer = [1];
        const persistence = initializeStatePersistence(node, {
            stateKey: "s",
            saveInterval: 15,
            getStateToSave: () => ({ buffer: buffer.slice() })
        });
        managers.push(persistence.manager);
        await sleep(10); // loaded

        buffer.push(2);
        persistence.markDirty();
        await sleep(60);
        expect(node.store.value).toEqual({ __v: 1, buffer: [1, 2] });

        // Nothing marked dirty → nothing rewritten.
        node.store.value = "untouched";
        buffer.push(3);
        await sleep(60);
        expect(node.store.value).toBe("untouched");
    });

    it("flush() snapshots and writes at once; nothing is written before the state was loaded", async () => {
        const node = makeNode(null, 30);
        let count = 1;
        const persistence = initializeStatePersistence(node, {
            stateKey: "s",
            getStateToSave: () => ({ count })
        });
        managers.push(persistence.manager);

        await expect(persistence.flush()).resolves.toBe(false); // load still pending
        expect(node.store.value).toBeNull();
        await sleep(50);
        count = 2;
        await expect(persistence.flush()).resolves.toBe(true);
        expect(node.store.value).toEqual({ __v: 1, count: 2 });
    });

    it("passes migrate and maxPersistedItems through to the manager", async () => {
        const node = makeNode({ __v: 3, buffer: [1, 2, 3, 4] }, 0); // a future schema version
        const loaded = [];
        const persistence = initializeStatePersistence(node, {
            stateKey: "s",
            maxPersistedItems: 2,
            migrate: (state, fromVersion) => (fromVersion === 3 ? state : null),
            onStateLoaded: (state) => loaded.push(state.buffer),
            getStateToSave: () => ({ buffer: [1, 2, 3, 4] })
        });
        managers.push(persistence.manager);
        await sleep(20);
        expect(loaded).toEqual([[1, 2, 3, 4]]);
        await persistence.flush();
        expect(node.store.value).toEqual({ __v: 1, buffer: [3, 4] });
        expect(node.warnings).toEqual([expect.stringMatching(/only the newest 2 are persisted/)]);
    });

    it("an unversioned (0.4.0) blob loads unchanged, without a warning; arrays are not capped by default", async () => {
        const node = makeNode({ buffer: [1, 2, 3], dataBuffer: [{ t: 1 }], mean: 2 }, 0);
        const loaded = [];
        const persistence = initializeStatePersistence(node, {
            stateKey: "s",
            onStateLoaded: (state) => loaded.push(state),
            getStateToSave: () => ({ buffer: Array.from({ length: 5000 }, (_, i) => i) })
        });
        managers.push(persistence.manager);
        await sleep(20);
        expect(loaded).toEqual([{ buffer: [1, 2, 3], dataBuffer: [{ t: 1 }], mean: 2 }]);
        expect(node.warnings).toEqual([]);
        expect(persistence.manager.maxPersistedItems).toBeNull();
        await persistence.flush();
        expect(node.store.value.__v).toBe(1);
        expect(node.store.value.buffer).toHaveLength(5000);
    });

    it("a blob of a different version is discarded with a warning when no migrate hook exists", async () => {
        const node = makeNode({ __v: 2, buffer: [1, 2, 3] }, 0);
        const loaded = [];
        const persistence = initializeStatePersistence(node, {
            stateKey: "s",
            onStateLoaded: (state) => loaded.push(state)
        });
        managers.push(persistence.manager);
        await sleep(20);
        expect(loaded).toEqual([]);
        expect(node.warnings).toEqual([expect.stringMatching(/version 2.*expects version 1.*starting fresh/)]);
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
        expect(node.store.value).toEqual({ __v: 1, count: 7 });
    });
});
