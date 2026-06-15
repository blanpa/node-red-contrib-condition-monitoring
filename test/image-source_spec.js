const helper = require("node-red-node-test-helper");
const isNode = require("../nodes/image-source.js");
const { PNG } = require("pngjs");

helper.init(require.resolve("node-red"));

describe("image-source Node", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });
    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("should be loaded", function (done) {
        helper.load(isNode, [{ id: "n1", type: "image-source", name: "is" }], function () {
            try {
                expect(helper.getNode("n1").name).toBe("is");
                done();
            } catch (e) {
                done(e);
            }
        });
    });

    it("emits a valid PNG with a defect + ground-truth mask", function (done) {
        const flow = [
            {
                id: "n1",
                type: "image-source",
                width: 64,
                height: 64,
                defect: "spot",
                severity: 0.8,
                seed: 1,
                emitMask: true,
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        helper.load(isNode, flow, function () {
            const n2 = helper.getNode("n2"),
                n1 = helper.getNode("n1");
            n2.on("input", function (msg) {
                try {
                    expect(Buffer.isBuffer(msg.payload)).toBe(true);
                    const img = PNG.sync.read(msg.payload); // valid PNG
                    expect(img.width).toBe(64);
                    expect(msg.defectCount).toBeGreaterThan(0);
                    expect(msg.defects[0].type).toBe("spot");
                    // ground-truth mask has some defect pixels
                    const mask = PNG.sync.read(msg.mask);
                    let white = 0;
                    for (let i = 0; i < mask.width * mask.height; i++) if (mask.data[i * 4] > 127) white++;
                    expect(white).toBeGreaterThan(5);
                    done();
                } catch (e) {
                    done(e);
                }
            });
            n1.receive({ payload: "tick" });
        });
    });

    it("emits a clean image (no defect) when defect=none", function (done) {
        const flow = [
            { id: "n1", type: "image-source", width: 32, height: 32, defect: "none", seed: 1, wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(isNode, flow, function () {
            const n2 = helper.getNode("n2"),
                n1 = helper.getNode("n1");
            n2.on("input", function (msg) {
                try {
                    expect(msg.defectCount).toBe(0);
                    done();
                } catch (e) {
                    done(e);
                }
            });
            n1.receive({ payload: "tick" });
        });
    });
});
