const helper = require("node-red-node-test-helper");
const jsNode = require("../nodes/json-source.js");

helper.init(require.resolve("node-red"));

describe("json-source Node", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });
    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("should be loaded", function (done) {
        helper.load(jsNode, [{ id: "n1", type: "json-source", name: "js" }], function () {
            try {
                expect(helper.getNode("n1").name).toBe("js");
                done();
            } catch (e) {
                done(e);
            }
        });
    });

    it("emits a JSON record with simulated numeric + constant fields", function (done) {
        const flow = [
            {
                id: "n1",
                type: "json-source",
                seed: 7,
                fields: '{"temperature":{"mean":60,"noise":2},"pressure":{"mean":4.5,"noise":0.15},"asset":"pump-01"}',
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        helper.load(jsNode, flow, function () {
            const n2 = helper.getNode("n2"),
                n1 = helper.getNode("n1");
            n2.on("input", function (msg) {
                try {
                    expect(typeof msg.payload).toBe("object");
                    expect(typeof msg.payload.temperature).toBe("number");
                    expect(msg.payload.temperature).toBeGreaterThan(45); // mean 60 ± noise
                    expect(msg.payload.temperature).toBeLessThan(75);
                    expect(typeof msg.payload.pressure).toBe("number");
                    expect(msg.payload.asset).toBe("pump-01"); // constant passes through
                    done();
                } catch (e) {
                    done(e);
                }
            });
            n1.receive({ payload: "tick" });
        });
    });

    it("is deterministic for a given seed", function (done) {
        const mk = (id) => ({
            id: id,
            type: "json-source",
            seed: 42,
            fields: '{"x":{"mean":10,"noise":3}}',
            wires: [["c"]]
        });
        const flow = [mk("a"), mk("b"), { id: "c", type: "helper" }];
        helper.load(jsNode, flow, function () {
            const c = helper.getNode("c");
            const vals = [];
            c.on("input", function (msg) {
                vals.push(msg.payload.x);
                if (vals.length === 2) {
                    try {
                        expect(vals[0]).toBe(vals[1]);
                        done();
                    } catch (e) {
                        done(e);
                    }
                }
            });
            helper.getNode("a").receive({ payload: "tick" });
            helper.getNode("b").receive({ payload: "tick" });
        });
    });

    it("injects an anomaly when anomalyChance is 1", function (done) {
        const flow = [
            {
                id: "n1",
                type: "json-source",
                seed: 3,
                anomalyChance: 1,
                anomalyMag: 8,
                fields: '{"v":{"mean":2,"noise":0.3}}',
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        helper.load(jsNode, flow, function () {
            const n2 = helper.getNode("n2"),
                n1 = helper.getNode("n1");
            n2.on("input", function (msg) {
                try {
                    expect(msg.anomalyInjected).toBe("v");
                    done();
                } catch (e) {
                    done(e);
                }
            });
            n1.receive({ payload: "tick" });
        });
    });
});
