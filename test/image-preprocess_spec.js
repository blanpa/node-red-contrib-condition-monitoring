const helper = require("node-red-node-test-helper");
const ipNode = require("../nodes/image-preprocess.js");
const { PNG } = require("pngjs");

helper.init(require.resolve("node-red"));

// 2x2 PNG: (0,0) red, (1,0) green, (0,1) blue, (1,1) white
function png2x2() {
    const p = new PNG({ width: 2, height: 2 });
    const set = (i, r, g, b) => {
        p.data[i] = r;
        p.data[i + 1] = g;
        p.data[i + 2] = b;
        p.data[i + 3] = 255;
    };
    set(0, 255, 0, 0);
    set(4, 0, 255, 0);
    set(8, 0, 0, 255);
    set(12, 255, 255, 255);
    return PNG.sync.write(p);
}

// A real 1x1 PNG whose IHDR is patched to claim w x h. The CRC no longer
// matches, which never matters: the size guard must refuse it before pngjs
// gets to read a chunk.
function pngClaiming(w, h) {
    const buf = PNG.sync.write(new PNG({ width: 1, height: 1 }));
    buf.writeUInt32BE(w, 16);
    buf.writeUInt32BE(h, 20);
    return buf;
}

describe("image-preprocess Node", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });
    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("should be loaded", function (done) {
        const flow = [{ id: "n1", type: "image-preprocess", name: "ip" }];
        helper.load(ipNode, flow, function () {
            try {
                expect(helper.getNode("n1").name).toBe("ip");
                done();
            } catch (e) {
                done(e);
            }
        });
    });

    it("decodes a PNG into a normalized NCHW tensor with exact values", function (done) {
        const flow = [
            {
                id: "n1",
                type: "image-preprocess",
                targetWidth: 2,
                targetHeight: 2,
                normalize: "0-1",
                layout: "nchw",
                channelOrder: "rgb",
                keepImage: false,
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        helper.load(ipNode, flow, function () {
            const n2 = helper.getNode("n2"),
                n1 = helper.getNode("n1");
            n2.on("input", function (msg) {
                try {
                    expect(msg.tensorShape).toEqual([1, 3, 2, 2]);
                    // R channel of the 4 pixels: red,green,blue,white -> [1,0,0,1]
                    expect(msg.payload[0]).toBeCloseTo(1, 5);
                    expect(msg.payload[3]).toBeCloseTo(1, 5);
                    // G channel starts at index 4: [0,1,0,1]
                    expect(msg.payload[5]).toBeCloseTo(1, 5);
                    // B channel starts at index 8: [0,0,1,1]
                    expect(msg.payload[10]).toBeCloseTo(1, 5);
                    done();
                } catch (e) {
                    done(e);
                }
            });
            n1.receive({ payload: png2x2() });
        });
    });

    it("keeps the resized image on msg.image when keepImage is on", function (done) {
        const flow = [
            {
                id: "n1",
                type: "image-preprocess",
                targetWidth: 2,
                targetHeight: 2,
                normalize: "0-1",
                keepImage: true,
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        helper.load(ipNode, flow, function () {
            const n2 = helper.getNode("n2"),
                n1 = helper.getNode("n1");
            n2.on("input", function (msg) {
                try {
                    expect(Buffer.isBuffer(msg.image)).toBe(true);
                    expect(msg.preprocess.width).toBe(2);
                    done();
                } catch (e) {
                    done(e);
                }
            });
            n1.receive({ payload: png2x2() });
        });
    });

    it("errors on a non-image payload", function (done) {
        const flow = [
            { id: "n1", type: "image-preprocess", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(ipNode, flow, function () {
            const n1 = helper.getNode("n1");
            n1.on("call:error", function () {
                done();
            });
            n1.receive({ payload: "not an image" });
        });
    });
});

describe("image-preprocess hardening", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });
    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("clamps a negative / absurd target size instead of failing every message", function (done) {
        const flow = [
            { id: "n1", type: "image-preprocess", targetWidth: -5, targetHeight: 99999999, wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(ipNode, flow, function () {
            const n1 = helper.getNode("n1");
            try {
                expect(n1.targetWidth).toBe(1);
                expect(n1.targetHeight).toBe(4096);
                done();
            } catch (e) {
                done(e);
            }
        });
    });

    it("refuses a PNG whose header claims 20000x20000 before decoding it (no 1.6 GB allocation)", function (done) {
        const flow = [
            { id: "n1", type: "image-preprocess", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(ipNode, flow, function () {
            const n1 = helper.getNode("n1");
            const statuses = [];
            n1.status = (s) => statuses.push(s);
            const before = process.memoryUsage().arrayBuffers;
            const started = Date.now();
            n1.error = function (err) {
                try {
                    expect(String(err.message || err)).toMatch(/image too large: 20000x20000 \(400\.0 MP\)/);
                    expect(Date.now() - started).toBeLessThan(500);
                    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024);
                    // Short class in the status line, the full text goes to node.error.
                    expect(statuses[statuses.length - 1]).toMatchObject({ fill: "red", text: "image too large" });
                    done();
                } catch (e) {
                    done(e);
                }
            };
            n1.receive({ payload: pngClaiming(20000, 20000) });
        });
    });

    it("keeps the status text short for any failure", function (done) {
        const flow = [{ id: "n1", type: "image-preprocess", wires: [[]] }];
        helper.load(ipNode, flow, function () {
            const n1 = helper.getNode("n1");
            const statuses = [];
            n1.status = (s) => statuses.push(s);
            n1.error = function (err) {
                try {
                    expect(String(err.message || err)).toBe("input is not a Buffer (expected a PNG/JPEG image)");
                    expect(statuses[statuses.length - 1].text).toBe("not an image");
                    expect(statuses[statuses.length - 1].text.length).toBeLessThanOrEqual(25);
                    done();
                } catch (e) {
                    done(e);
                }
            };
            n1.receive({ payload: { not: "an image" } });
        });
    });
});
