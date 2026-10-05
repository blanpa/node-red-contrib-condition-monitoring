"use strict";

/**
 * Pins the seeded output of the three simulator nodes. They share one PRNG
 * (nodes/utils/seeded-random.js); a seeded flow must keep producing exactly
 * the same stream across refactors, so the first samples are fixed here.
 */

const EventEmitter = require("events");
const crypto = require("crypto");
const { PNG } = require("pngjs");

function build(nodeModule, config) {
    let Ctor = null;
    const RED = {
        util: {
            setMessageProperty(msg, prop, value) {
                msg[prop] = value;
            }
        },
        nodes: {
            createNode(node) {
                const emitter = new EventEmitter();
                node.id = "pin";
                node.on = emitter.on.bind(emitter);
                node.emit = emitter.emit.bind(emitter);
                node.status = () => {};
                node.error = () => {};
                node.warn = () => {};
                node.log = () => {};
                node.send = () => {};
            },
            registerType(name, ctor) {
                Ctor = ctor;
            }
        }
    };
    nodeModule(RED);
    return new Ctor(config);
}

function emitN(node, count) {
    const sent = [];
    for (let i = 0; i < count; i++) {
        node.emit(
            "input",
            {},
            (m) => sent.push(m),
            () => {}
        );
    }
    return sent;
}

describe("seeded simulator output is pinned", () => {
    it("json-source (seed 7, anomalyChance 0.5)", () => {
        const sent = emitN(build(require("../nodes/json-source.js"), { seed: 7, anomalyChance: 0.5 }), 3);
        expect(sent.map((m) => [m.payload, m.anomalyInjected || null])).toEqual([
            [{ temperature: 57.3286, pressure: 4.4225, vibration: 1.7249, asset: "pump-01" }, null],
            [{ temperature: 62.2354, pressure: 4.6291, vibration: 0.1496, asset: "pump-01" }, "vibration"],
            [{ temperature: 50.1895, pressure: 4.5414, vibration: 1.7044, asset: "pump-01" }, "temperature"]
        ]);
    });

    it("image-source (seed 11, 16x16, multi)", () => {
        const sent = emitN(
            build(require("../nodes/image-source.js"), { seed: 11, width: 16, height: 16, defect: "multi" }),
            2
        );
        expect(sent.map((m) => m.defects)).toEqual([
            [
                { type: "spot", x: 7, y: 11, r: 3, severity: 0.7 },
                { type: "spot", x: 7, y: 5, r: 3, severity: 0.7 },
                { type: "scratch", x: 2, y: 14, len: 10, severity: 0.7 }
            ],
            [
                { type: "spot", x: 11, y: 3, r: 3, severity: 0.7 },
                { type: "spot", x: 9, y: 11, r: 3, severity: 0.7 },
                { type: "scratch", x: 4, y: 15, len: 10, severity: 0.7 }
            ]
        ]);
        // Hash the decoded pixels, not the PNG bytes (those depend on zlib).
        const pixelHash = (m) =>
            crypto.createHash("sha256").update(PNG.sync.read(m.payload).data).digest("hex").slice(0, 16);
        expect(sent.map(pixelHash)).toEqual(["4583d9404e06f772", "2c7a84845179304a"]);
    });

    it("condition-monitoring-source (seed 42 and a negative seed)", () => {
        const cm = require("../nodes/condition-monitoring-source.js");
        expect(emitN(build(cm, { seed: 42, noise: 1 }), 3).map((m) => m.payload.sensors)).toEqual([
            { vibrationRMS: 1.869, temperature: 57.43, current: 11.913, pressure: 4.649 },
            { vibrationRMS: 1.364, temperature: 57.78, current: 11.568, pressure: 4.634 },
            { vibrationRMS: 2.2, temperature: 57.6, current: 11.555, pressure: 4.709 }
        ]);
        expect(emitN(build(cm, { seed: -3, noise: 1 }), 1).map((m) => m.payload.sensors)).toEqual([
            { vibrationRMS: 1.763, temperature: 57.5, current: 11.462, pressure: 4.58 }
        ]);
    });
});
