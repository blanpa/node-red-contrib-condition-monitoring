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
