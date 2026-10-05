const helper = require("node-red-node-test-helper");
const vaNode = require("../nodes/vision-annotator.js");

helper.init(require.resolve("node-red"));

function run(config, msg, check, done) {
    const flow = [
        Object.assign({ id: "n1", type: "vision-annotator", wires: [["n2"]] }, config),
        { id: "n2", type: "helper" }
    ];
    helper.load(vaNode, flow, function () {
        const n2 = helper.getNode("n2"),
            n1 = helper.getNode("n1");
        n2.on("input", function (m) {
            try {
                check(m);
                done();
            } catch (e) {
                done(e);
            }
        });
        n1.receive(msg);
    });
}

describe("vision-annotator Node", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });
    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("should be loaded", function (done) {
        helper.load(vaNode, [{ id: "n1", type: "vision-annotator", name: "va" }], function () {
            try {
                expect(helper.getNode("n1").name).toBe("va");
                done();
            } catch (e) {
                done(e);
            }
        });
    });

    it("boxes (xyxy) -> PNG + box annotations", function (done) {
        run(
            { mode: "boxes", boxFormat: "xyxy", canvasWidth: 100, canvasHeight: 100, scoreThreshold: 0.3 },
            { prediction: [10, 10, 40, 40, 0.9, 0, 50, 20, 90, 70, 0.8, 1], mlInference: { outputShape: [1, 2, 6] } },
            function (m) {
                expect(Buffer.isBuffer(m.payload)).toBe(true);
                expect(m.contentType).toBe("image/png");
                expect(m.annotations.mode).toBe("boxes");
                expect(m.annotations.count).toBe(2);
                expect(m.annotations.boxes[0].x1).toBe(10);
                expect(m.annotations.classesPresent).toEqual([0, 1]);
            },
            done
        );
    });

    it("classification applies softmax to logits", function (done) {
        run(
            { mode: "classification", canvasWidth: 80, canvasHeight: 30 },
            { prediction: [0.1, 0.7, 0.15, 0.05], mlInference: { outputShape: [1, 4] } },
            function (m) {
                expect(m.annotations.mode).toBe("classification");
                expect(m.annotations.topClass).toBe(1);
                expect(m.annotations.topScore).toBeCloseTo(0.3777, 3); // softmax of the logits
            },
            done
        );
    });

    it("segmentation argmax -> classesPresent", function (done) {
        // [1,3,2,2] logits: pixel0 class1 wins, others class2 wins
        const ch0 = [0, 0, 0, 0];
        const ch1 = [5, 0, 0, 0];
        const ch2 = [0, 5, 5, 5];
        run(
            { mode: "segmentation", canvasWidth: 16, canvasHeight: 16 },
            { prediction: ch0.concat(ch1, ch2), mlInference: { outputShape: [1, 3, 2, 2] } },
            function (m) {
                expect(m.annotations.mode).toBe("segmentation");
                expect(m.annotations.classesPresent).toEqual([1, 2]);
                expect(m.annotations.maskClassCounts["1"]).toBe(1);
                expect(m.annotations.maskClassCounts["2"]).toBe(3);
            },
            done
        );
    });

    it("anomaly -> thresholded region metrics", function (done) {
        // 4x4 field, a 2x2 block of 1.0 at rows1-2/cols1-2 (4 px), rest 0
        const f = [];
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) f.push(y >= 1 && y <= 2 && x >= 1 && x <= 2 ? 1 : 0);
        run(
            { mode: "anomaly", canvasWidth: 32, canvasHeight: 32, threshold: 0.5 },
            { prediction: f, mlInference: { outputShape: [1, 1, 4, 4] } },
            function (m) {
                expect(m.annotations.mode).toBe("anomaly");
                expect(m.annotations.regionCount).toBe(1);
                expect(m.annotations.maxScore).toBeCloseTo(1, 5);
                expect(m.annotations.anomalyFraction).toBeCloseTo(4 / 16, 5);
            },
            done
        );
    });
});

// ---------------------------------------------------------------------------
// Hardening: hostile / malformed tensors must not hang or mis-render
// ---------------------------------------------------------------------------
describe("vision-annotator hardening", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });
    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    function runErr(config, msg, check, done) {
        const flow = [Object.assign({ id: "n1", type: "vision-annotator", wires: [[]] }, config)];
        helper.load(vaNode, flow, function () {
            const n1 = helper.getNode("n1");
            n1.error = function (err) {
                try {
                    check(err);
                    done();
                } catch (e) {
                    done(e);
                }
            };
            n1.receive(msg);
        });
    }

    it("drops boxes with non-finite coordinates instead of looping forever", function (done) {
        run(
            { mode: "boxes", scoreThreshold: 0.3 },
            {
                prediction: [
                    [0, 0, Infinity, 10, 0.9, 0],
                    [NaN, 0, 10, 10, 0.9, 0],
                    [10, 10, 50, 50, NaN, 0],
                    [10, 10, 50, 50, 0.9, 1]
                ]
            },
            function (m) {
                expect(m.annotations.count).toBe(1);
                expect(m.annotations.boxes[0]).toMatchObject({ x1: 10, y1: 10, x2: 50, y2: 50, class: 1 });
            },
            done
        );
    });

    it("renders a huge-but-finite box quickly (drawing is clipped to the canvas)", function (done) {
        const started = Date.now();
        run(
            { mode: "boxes", scoreThreshold: 0.3 },
            { prediction: [[-1e15, -1e15, 1e15, 1e15, 0.9, 0]] },
            function (m) {
                expect(m.annotations.count).toBe(1);
                expect(Date.now() - started).toBeLessThan(1500);
            },
            done
        );
    });

    it("clips polygon / obb edges that leave the canvas (no multi-second line walk)", function (done) {
        const started = Date.now();
        run(
            { mode: "polygons" },
            { prediction: [0, 0, 2e12, 1e12, 5, 5] },
            function (m) {
                expect(m.annotations.count).toBe(1);
                expect(Date.now() - started).toBeLessThan(1500);
            },
            done
        );
    });

    it("an off-canvas coordinate beyond 32 bits is not wrapped back onto the canvas", function (done) {
        // 2**32 + 5 used to be painted in column 5 via `x | 0`.
        run(
            { mode: "keypoints", canvasWidth: 16, canvasHeight: 16, pointRadius: 1, kpThreshold: 0.5 },
            { prediction: [4294967301, 8, 0.9] },
            function (m) {
                const png = require("pngjs").PNG.sync.read(m.payload);
                // Pixel (5,8) must still be the blank background colour.
                const i = (8 * 16 + 5) * 4;
                expect([png.data[i], png.data[i + 1], png.data[i + 2]]).toEqual([32, 36, 44]);
            },
            done
        );
    });

    it("accepts a typed-array prediction (Float32Array)", function (done) {
        run(
            { mode: "boxes", scoreThreshold: 0.3 },
            { prediction: new Float32Array([10, 10, 50, 50, 0.9, 1]) },
            function (m) {
                expect(m.annotations.count).toBe(1);
                expect(m.annotations.boxes[0].class).toBe(1);
            },
            done
        );
    });

    it("rejects a declared shape that claims more elements than the data holds", function (done) {
        runErr(
            { mode: "boxes" },
            { prediction: [[10, 10, 50, 50, 0.9, 1]], mlInference: { outputShape: [1, 1000000000, 6] } },
            function (err) {
                expect(String(err.message || err)).toMatch(/shape needs 6000000000 values/);
            },
            done
        );
    });

    it("clamps nonsensical config instead of failing every message", function (done) {
        run(
            { mode: "boxes", canvasWidth: -5, canvasHeight: 0, boxThickness: -3, alpha: 7 },
            { prediction: [[0, 0, 1, 1, 0.9, 0]] },
            function (m) {
                expect(m.annotations.width).toBe(1);
                expect(m.annotations.height).toBe(1);
            },
            done
        );
    });

    it("throttles editor previews to the latest frame of a burst", function () {
        // The test helper's RED has no `comms`, so drive the node through a
        // minimal stand-in runtime that records what would reach the editor.
        const EventEmitter = require("events");
        const published = [];
        let Ctor = null;
        const RED = {
            util: {
                getMessageProperty: (m, p) =>
                    p.split(".").reduce((a, k) => (a === null || a === undefined ? undefined : a[k]), m)
            },
            comms: {
                publish: (topic, data) => {
                    if (data && data.data) published.push(topic);
                }
            },
            nodes: {
                createNode(n, cfg) {
                    const emitter = new EventEmitter();
                    n.id = cfg.id;
                    n.on = emitter.on.bind(emitter);
                    n.emit = emitter.emit.bind(emitter);
                    n.status = () => {};
                    n.error = () => {};
                    n.send = () => {};
                },
                registerType(name, ctor) {
                    Ctor = ctor;
                }
            }
        };
        vaNode(RED);
        const node = new Ctor({ id: "p1", mode: "boxes" });
        // The clock is frozen for the burst: on a slow or busy machine 25
        // rendered frames take longer than the throttle interval in real time,
        // and the test would then count extra (legitimate) frames.
        jest.useFakeTimers();
        try {
            for (let i = 0; i < 25; i++) {
                node.emit(
                    "input",
                    { prediction: [[0, 0, 10, 10, 0.9, 0]] },
                    () => {},
                    () => {}
                );
            }
            jest.advanceTimersByTime(1000);
            // One leading frame + one trailing frame for the whole burst.
            expect(published).toEqual(["vision-annotator-preview/p1", "vision-annotator-preview/p1"]);
            node.emit("close");
        } finally {
            jest.useRealTimers();
        }
    });
});
