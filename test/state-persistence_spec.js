const helper = require("node-red-node-test-helper");
const anomalyDetectorNode = require("../nodes/anomaly-detector.js");
const pcaAnomalyNode = require("../nodes/pca-anomaly.js");
const signalAnalyzerNode = require("../nodes/signal-analyzer.js");
const isolationForestNode = require("../nodes/isolation-forest-anomaly.js");
const trendPredictorNode = require("../nodes/trend-predictor.js");
const healthIndexNode = require("../nodes/health-index.js");
const { NodeStateManager } = require("../nodes/state-persistence.js");

helper.init(require.resolve("node-red"));

describe("State Persistence", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    // ============================================
    // Anomaly Detector State Persistence
    // ============================================

    describe("anomaly-detector persistence", function () {
        it("should have persistState config option", function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1).toHaveProperty("persistState", true);
                done();
            });
        });

        it("should initialize state manager when persistState is enabled", function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                // State manager should be initialized
                expect(n1.stateManager).toBeInstanceOf(NodeStateManager);
                expect(n1.stateManager.storeName).toBe("default");
                expect(n1.stateManager.autoSave).toBe(true);
                done();
            });
        });

        it("should not initialize state manager when persistState is disabled", function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", persistState: false, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1.stateManager).toBeFalsy();
                done();
            });
        });

        it("should maintain buffer in dataBuffer property", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "anomaly-detector",
                    name: "test",
                    method: "zscore",
                    windowSize: 10,
                    persistState: true,
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");

                // Send some values
                for (let i = 0; i < 5; i++) {
                    n1.receive({ payload: 50 + i });
                }

                setTimeout(function () {
                    // Buffer should have data
                    expect(n1.dataBuffer.length).toBe(5);
                    done();
                }, 50);
            });
        });
    });

    // ============================================
    // PCA Anomaly State Persistence
    // ============================================

    describe("pca-anomaly persistence", function () {
        it("should have persistState config option", function (done) {
            const flow = [
                { id: "n1", type: "pca-anomaly", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(pcaAnomalyNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1).toHaveProperty("persistState", true);
                done();
            });
        });

        it("should store trained model state", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "pca-anomaly",
                    name: "test",
                    windowSize: 20,
                    persistState: true,
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(pcaAnomalyNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                const n3 = helper.getNode("n3");

                const handler = function (msg) {
                    if (msg.pca) {
                        // After training, model should be stored
                        expect(n1.isTrained).toBe(true);
                        expect(n1.pcaModel).toBeTruthy();
                        expect(n1.mean).toBeTruthy();
                        expect(n1.stdDev).toBeTruthy();
                        done();
                    }
                };
                n2.on("input", handler);
                n3.on("input", handler);

                // Train the model
                for (let i = 0; i < 15; i++) {
                    n1.receive({
                        payload: {
                            sensor1: 10 + Math.random(),
                            sensor2: 20 + Math.random(),
                            sensor3: 30 + Math.random()
                        }
                    });
                }

                n1.receive({ payload: { sensor1: 10.5, sensor2: 20.5, sensor3: 30.5 } });
            });
        });

        it("should be able to serialize pcaModel to JSON", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "pca-anomaly",
                    name: "test",
                    windowSize: 20,
                    persistState: true,
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(pcaAnomalyNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                const n3 = helper.getNode("n3");

                const handler = function (msg) {
                    if (msg.pca && n1.pcaModel) {
                        // Check that model can be serialized
                        expect(typeof n1.pcaModel.toJSON).toBe("function");
                        const json = n1.pcaModel.toJSON();
                        expect(json).toBeTruthy();
                        expect(typeof json).toBe("object");
                        done();
                    }
                };
                n2.on("input", handler);
                n3.on("input", handler);

                // Train the model
                for (let i = 0; i < 15; i++) {
                    n1.receive({
                        payload: {
                            sensor1: 10 + Math.random(),
                            sensor2: 20 + Math.random(),
                            sensor3: 30 + Math.random()
                        }
                    });
                }

                n1.receive({ payload: { sensor1: 10.5, sensor2: 20.5, sensor3: 30.5 } });
            });
        });
    });

    // ============================================
    // Signal Analyzer State Persistence
    // ============================================

    describe("signal-analyzer persistence", function () {
        it("should have persistState config option", function (done) {
            const flow = [
                { id: "n1", type: "signal-analyzer", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1).toHaveProperty("persistState", true);
                done();
            });
        });

        it("should maintain buffer state", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "signal-analyzer",
                    name: "test",
                    mode: "vibration",
                    windowSize: 50,
                    persistState: true,
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");

                // Send some values (less than windowSize to not trigger processing)
                for (let i = 0; i < 30; i++) {
                    n1.receive({ payload: Math.sin(i * 0.1) });
                }

                setTimeout(function () {
                    expect(n1.buffer.length).toBe(30);
                    done();
                }, 50);
            });
        });
    });

    // ============================================
    // Isolation Forest State Persistence
    // ============================================

    describe("isolation-forest-anomaly persistence", function () {
        it("should have persistState config option", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "isolation-forest-anomaly",
                    name: "test",
                    persistState: true,
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(isolationForestNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1).toHaveProperty("persistState", true);
                done();
            });
        });

        it("should maintain data buffer state", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "isolation-forest-anomaly",
                    name: "test",
                    windowSize: 50,
                    persistState: true,
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(isolationForestNode, flow, function () {
                const n1 = helper.getNode("n1");

                // Send some values (less than needed for training)
                for (let i = 0; i < 5; i++) {
                    n1.receive({ payload: 50 + Math.random() * 10 });
                }

                setTimeout(function () {
                    expect(n1.dataBuffer.length).toBe(5);
                    done();
                }, 50);
            });
        });

        it("should track sample count", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "isolation-forest-anomaly",
                    name: "test",
                    windowSize: 50,
                    persistState: true,
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(isolationForestNode, flow, function () {
                const n1 = helper.getNode("n1");

                // Send some values
                for (let i = 0; i < 8; i++) {
                    n1.receive({ payload: 50 + Math.random() * 10 });
                }

                setTimeout(function () {
                    expect(n1.sampleCount).toBe(8);
                    done();
                }, 50);
            });
        });
    });

    // ============================================
    // Trend Predictor State Persistence
    // ============================================

    describe("trend-predictor persistence", function () {
        it("should have persistState config option", function (done) {
            const flow = [
                { id: "n1", type: "trend-predictor", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(trendPredictorNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1).toHaveProperty("persistState", true);
                done();
            });
        });

        it("should initialize state manager when persistState is enabled", function (done) {
            const flow = [
                { id: "n1", type: "trend-predictor", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(trendPredictorNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1.stateManager).toBeInstanceOf(NodeStateManager);
                expect(n1.stateManager.storeName).toBe("default");
                expect(n1.stateManager.autoSave).toBe(true);
                done();
            });
        });

        it("should not initialize state manager when persistState is disabled", function (done) {
            const flow = [
                { id: "n1", type: "trend-predictor", name: "test", persistState: false, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(trendPredictorNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1.stateManager).toBeFalsy();
                done();
            });
        });

        it("should maintain buffer state", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "trend-predictor",
                    name: "test",
                    mode: "prediction",
                    windowSize: 50,
                    persistState: true,
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(trendPredictorNode, flow, function () {
                const n1 = helper.getNode("n1");

                // Send some values
                for (let i = 0; i < 10; i++) {
                    n1.receive({ payload: 50 + i, timestamp: Date.now() + i * 1000 });
                }

                setTimeout(function () {
                    expect(n1.buffer.length).toBe(10);
                    expect(n1.timestamps.length).toBe(10);
                    done();
                }, 50);
            });
        });

        it("should maintain rate of change state", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "trend-predictor",
                    name: "test",
                    mode: "rate-of-change",
                    persistState: true,
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(trendPredictorNode, flow, function () {
                const n1 = helper.getNode("n1");

                n1.receive({ payload: 50, timestamp: Date.now() });
                n1.receive({ payload: 55, timestamp: Date.now() + 1000 });

                setTimeout(function () {
                    expect(n1.previousValue).toBe(55);
                    expect(n1.previousTimestamp).toBeTruthy();
                    done();
                }, 50);
            });
        });
    });

    // ============================================
    // Health Index State Persistence
    // ============================================

    describe("health-index persistence", function () {
        it("should have persistState config option", function (done) {
            const flow = [
                { id: "n1", type: "health-index", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(healthIndexNode, flow, function () {
                const n1 = helper.getNode("n1");
                // The node should load without error
                expect(n1).toBeTruthy();
                done();
            });
        });

        it("should initialize state manager when persistState is enabled", function (done) {
            const flow = [
                { id: "n1", type: "health-index", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(healthIndexNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1.stateManager).toBeInstanceOf(NodeStateManager);
                expect(n1.stateManager.storeName).toBe("default");
                expect(n1.stateManager.autoSave).toBe(true);
                done();
            });
        });

        it("should maintain health history", function (done) {
            const flow = [
                { id: "n1", type: "health-index", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(healthIndexNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");

                let msgCount = 0;
                n2.on("input", function (_msg) {
                    msgCount++;
                    if (msgCount >= 3) {
                        expect(n1.healthHistory.length).toBe(3);
                        expect(n1.lastHealthIndex).toBeTruthy();
                        done();
                    }
                });

                // Send some healthy sensor readings
                n1.receive({ payload: { temp: { value: 50 }, pressure: { value: 100 } } });
                n1.receive({ payload: { temp: { value: 51 }, pressure: { value: 101 } } });
                n1.receive({ payload: { temp: { value: 52 }, pressure: { value: 102 } } });
            });
        });

        it("should include health trend in output", function (done) {
            const flow = [
                { id: "n1", type: "health-index", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(healthIndexNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");

                let msgCount = 0;
                n2.on("input", function (msg) {
                    msgCount++;
                    if (msgCount >= 5) {
                        expect(msg).toHaveProperty("healthTrend");
                        expect(msg.healthTrend).toHaveProperty("trend");
                        expect(msg.healthTrend).toHaveProperty("samples");
                        done();
                    }
                });

                // Send several healthy sensor readings
                for (let i = 0; i < 5; i++) {
                    n1.receive({ payload: { temp: { value: 50 + i }, pressure: { value: 100 } } });
                }
            });
        });
    });

    // ============================================
    // State Persistence Manager Tests
    // ============================================

    describe("NodeStateManager", function () {
        const StatePersistence = require("../nodes/state-persistence.js");
        const managers = [];

        /** Node double with a synchronous in-memory context store. */
        function makeNode() {
            const store = {};
            return {
                store,
                warnings: [],
                debug() {},
                warn(m) {
                    this.warnings.push(m);
                },
                context() {
                    return {
                        get: (key, storeName, cb) => cb(null, store[storeName + ":" + key]),
                        set: (key, value, storeName, cb) => {
                            // Stores persist JSON: typed arrays would not survive as such.
                            store[storeName + ":" + key] = JSON.parse(JSON.stringify(value));
                            cb(null);
                        }
                    };
                }
            };
        }

        function track(manager) {
            managers.push(manager);
            return manager;
        }

        afterEach(async function () {
            for (const m of managers.splice(0)) await m.close();
        });

        it("exports the manager class and its factories with their own keys and intervals", function () {
            expect(Object.keys(StatePersistence).sort()).toEqual([
                "NodeStateManager",
                "createAnomalyStateManager",
                "createMLStateManager",
                "createSignalStateManager"
            ]);

            const node = makeNode();
            const anomaly = track(StatePersistence.createAnomalyStateManager(node));
            const ml = track(StatePersistence.createMLStateManager(node));
            const signal = track(StatePersistence.createSignalStateManager(node, { saveInterval: 5000 }));

            expect(anomaly).toBeInstanceOf(NodeStateManager);
            expect([anomaly.stateKey, anomaly.saveInterval]).toEqual(["anomalyState", 60000]);
            expect([ml.stateKey, ml.saveInterval]).toEqual(["mlState", 120000]);
            expect([signal.stateKey, signal.saveInterval]).toEqual(["signalState", 5000]);
        });

        it("tracks values and the dirty flag through set/get/delete/clear", function () {
            const manager = track(new NodeStateManager(makeNode(), { autoSave: false }));
            expect(manager.isDirty).toBe(false);
            expect(manager.get("missing", "fallback")).toBe("fallback");

            manager.set("count", 3);
            manager.setMultiple({ mean: 1.5, label: "a" });
            expect(manager.isDirty).toBe(true);
            expect(manager.get("count")).toBe(3);
            expect(manager.has("mean")).toBe(true);
            expect(manager.keys().sort()).toEqual(["count", "label", "mean"]);
            expect(manager.getAll()).toEqual({ count: 3, mean: 1.5, label: "a" });

            manager.delete("label");
            expect(manager.has("label")).toBe(false);
            manager.clear();
            expect(manager.keys()).toEqual([]);
        });

        it("round-trips typed arrays and object arrays through the context store", async function () {
            const node = makeNode();
            const writer = track(new NodeStateManager(node, { stateKey: "s", autoSave: false }));
            writer.setMultiple({
                weights: new Float32Array([0.5, 1.5]),
                precise: new Float64Array([Math.PI]),
                samples: [{ t: 1, v: 2 }],
                plain: [1, 2, 3],
                count: 7
            });
            await expect(writer.save()).resolves.toBe(true);
            expect(writer.isDirty).toBe(false);
            expect(node.store["default:s"].weights).toEqual({ __type: "Float32Array", data: [0.5, 1.5] });

            const reader = track(new NodeStateManager(node, { stateKey: "s", autoSave: false }));
            const state = await reader.load();
            expect(reader.isLoaded).toBe(true);
            expect(state.weights).toBeInstanceOf(Float32Array);
            expect(Array.from(state.weights)).toEqual([0.5, 1.5]);
            expect(state.precise).toBeInstanceOf(Float64Array);
            expect(state.precise[0]).toBe(Math.PI);
            expect(state.samples).toEqual([{ t: 1, v: 2 }]);
            expect(state.plain).toEqual([1, 2, 3]);
            expect(state.count).toBe(7);
        });

        it("saves pending changes on close and starts empty when nothing was stored", async function () {
            const node = makeNode();
            const fresh = new NodeStateManager(node, { stateKey: "k", autoSave: false });
            await expect(fresh.load()).resolves.toEqual({});

            fresh.set("n", 1);
            await fresh.close();
            expect(node.store["default:k"]).toEqual({ n: 1 });
            expect(fresh.saveTimer).toBeNull();
        });

        it("reports a failing store instead of throwing", async function () {
            const node = makeNode();
            node.context = () => ({
                get: (key, storeName, cb) => cb(new Error("store offline")),
                set: (key, value, storeName, cb) => cb(new Error("store offline"))
            });
            const manager = track(new NodeStateManager(node, { autoSave: false }));
            await expect(manager.load()).resolves.toEqual({});
            manager.set("x", 1);
            await expect(manager.save()).resolves.toBe(false);
            expect(manager.isDirty).toBe(true);
            expect(node.warnings).toEqual([
                "[Persistence] Failed to load state: store offline",
                "[Persistence] Failed to save state: store offline"
            ]);
            // Keep afterEach's close() from warning again into a dead store.
            manager.isDirty = false;
        });
    });
});
