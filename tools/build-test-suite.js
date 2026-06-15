#!/usr/bin/env node
/* eslint-disable no-console */
/*
 * Generator for examples/test-suite.json — a multi-tab Node-RED flow that
 * exercises every node in this package with deterministic, simulated data and
 * validates the results against analytically-derived expectations.
 *
 * Design:
 *   inject ─┐
 *   linkIn ─┴─> generator(fn) ─> node-under-test ─(both ports)─> validator(fn) ─┬─> debug
 *                                                                                └─> linkOut(results)
 *
 *   - The generator sends a deterministic sequence of messages synchronously.
 *     Only the LAST message carries `msg.test` + `msg.expect`, so the generic
 *     validator fires exactly once per run (on the final result).
 *   - Nodes that copy unknown msg fields onto their output (verified in source)
 *     use the GENERIC validator. Nodes that build a fresh output object use a
 *     dedicated CUSTOM validator instead.
 *   - A Test Runner tab exposes GET /test: it broadcasts a trigger to every
 *     generator (via link nodes), collects each validator's verdict, and after
 *     a settle delay returns a JSON pass/fail summary.
 */

const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const jpeg = require("jpeg-js");

// --- test image fixtures (embedded as base64 in the generated flow) ----------
function pngB64(width, height, fill) {
    const p = new PNG({ width, height });
    fill(p.data, width, height);
    return PNG.sync.write(p).toString("base64");
}
// 2x2: (0,0) red, (1,0) green, (0,1) blue, (1,1) white
const PNG_2x2 = pngB64(2, 2, (d) => {
    const set = (i, r, g, b) => {
        d[i] = r;
        d[i + 1] = g;
        d[i + 2] = b;
        d[i + 3] = 255;
    };
    set(0, 255, 0, 0);
    set(4, 0, 255, 0);
    set(8, 0, 0, 255);
    set(12, 255, 255, 255);
});
// 100x100 gradient (so box overlays land on a real picture)
const PNG_100 = pngB64(100, 100, (d, w, h) => {
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            d[i] = Math.round((x / w) * 255);
            d[i + 1] = Math.round((y / h) * 255);
            d[i + 2] = 128;
            d[i + 3] = 255;
        }
});
// 8x8 solid red JPEG (lossy but a flat colour survives well)
const JPEG_RED = (function () {
    const w = 8,
        h = 8,
        data = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        data[i * 4] = 255;
        data[i * 4 + 3] = 255;
    }
    return jpeg.encode({ data, width: w, height: h }, 90).data.toString("base64");
})();
// PNG from a flat 0..255 RGB array
function pngFromRGB(width, height, rgb) {
    return pngB64(width, height, (d) => {
        for (let i = 0; i < width * height; i++) {
            d[i * 4] = rgb[i * 3];
            d[i * 4 + 1] = rgb[i * 3 + 1];
            d[i * 4 + 2] = rgb[i * 3 + 2];
            d[i * 4 + 3] = 255;
        }
    });
}
// Trained-model samples (produced by tools/train-defect-seg.py), if present
let SAMPLES = null;
try {
    SAMPLES = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "test-models", "samples.json"), "utf8"));
} catch (e) {
    SAMPLES = null;
}

// bilinear resize over RGBA (for embedding downscaled real photos)
function resizeRGBA(src, sw, sh, dw, dh) {
    const out = new Uint8Array(dw * dh * 4),
        sx = sw / dw,
        sy = sh / dh;
    for (let dy = 0; dy < dh; dy++)
        for (let dx = 0; dx < dw; dx++) {
            const fx = (dx + 0.5) * sx - 0.5,
                fy = (dy + 0.5) * sy - 0.5;
            const x0 = Math.floor(fx),
                y0 = Math.floor(fy),
                x1 = Math.min(sw - 1, x0 + 1),
                y1 = Math.min(sh - 1, y0 + 1);
            const cx0 = Math.min(sw - 1, Math.max(0, x0)),
                cy0 = Math.min(sh - 1, Math.max(0, y0)),
                wx = fx - x0,
                wy = fy - y0,
                o = (dy * dw + dx) * 4;
            for (let c = 0; c < 4; c++) {
                const p00 = src[(cy0 * sw + cx0) * 4 + c],
                    p10 = src[(cy0 * sw + x1) * 4 + c],
                    p01 = src[(y1 * sw + cx0) * 4 + c],
                    p11 = src[(y1 * sw + x1) * 4 + c];
                const top = p00 + (p10 - p00) * wx,
                    bot = p01 + (p11 - p01) * wx;
                out[o + c] = Math.round(top + (bot - top) * wy);
            }
        }
    return out;
}
// Pretrained SqueezeNet demo (real photo embedded downscaled to 224), if present
let PRETRAINED = null;
try {
    const dec = jpeg.decode(fs.readFileSync(path.join(__dirname, "..", "test-models", "dog.jpg")), {
        useTArray: true,
        formatAsRGBA: true
    });
    const r = resizeRGBA(dec.data, dec.width, dec.height, 224, 224);
    const dogJpg = jpeg
        .encode({ data: Buffer.from(r.buffer, r.byteOffset, r.byteLength), width: 224, height: 224 }, 85)
        .data.toString("base64");
    const labels = fs
        .readFileSync(path.join(__dirname, "..", "test-models", "imagenet_classes.txt"), "utf8")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    const r640 = resizeRGBA(dec.data, dec.width, dec.height, 640, 640);
    const dog640 = jpeg
        .encode({ data: Buffer.from(r640.buffer, r640.byteOffset, r640.byteLength), width: 640, height: 640 }, 85)
        .data.toString("base64");
    const r252 = resizeRGBA(dec.data, dec.width, dec.height, 252, 252);
    const dog252 = jpeg
        .encode({ data: Buffer.from(r252.buffer, r252.byteOffset, r252.byteLength), width: 252, height: 252 }, 85)
        .data.toString("base64");
    let person640 = null;
    try {
        const pd = jpeg.decode(fs.readFileSync(path.join(__dirname, "..", "test-models", "person.jpg")), {
            useTArray: true,
            formatAsRGBA: true
        });
        const pr = resizeRGBA(pd.data, pd.width, pd.height, 640, 640);
        person640 = jpeg
            .encode({ data: Buffer.from(pr.buffer, pr.byteOffset, pr.byteLength), width: 640, height: 640 }, 85)
            .data.toString("base64");
    } catch (e) {
        person640 = null;
    }
    PRETRAINED = { dogJpg, dog640, dog252, person640, labels };
} catch (e) {
    PRETRAINED = null;
}
const has = (f) => {
    try {
        fs.accessSync(path.join(__dirname, "..", "test-models", f));
        return true;
    } catch (e) {
        return false;
    }
};
const DEPTH_OK = has("depth.onnx"),
    POSE_OK = has("yolov8n-pose.onnx"),
    DEFECT_OK = has("defect_seg.onnx");
// COCO 17-keypoint skeleton edges
const COCO_SKELETON =
    "[[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16],[0,5],[0,6],[0,1],[0,2],[1,3],[2,4]]";

const COCO80 =
    "person,bicycle,car,motorcycle,airplane,bus,train,truck,boat,traffic light,fire hydrant,stop sign,parking meter,bench,bird,cat,dog,horse,sheep,cow,elephant,bear,zebra,giraffe,backpack,umbrella,handbag,tie,suitcase,frisbee,skis,snowboard,sports ball,kite,baseball bat,baseball glove,skateboard,surfboard,tennis racket,bottle,wine glass,cup,fork,knife,spoon,bowl,banana,apple,sandwich,orange,broccoli,carrot,hot dog,pizza,donut,cake,chair,couch,potted plant,bed,dining table,toilet,tv,laptop,mouse,remote,keyboard,cell phone,microwave,oven,toaster,sink,refrigerator,book,clock,vase,scissors,teddy bear,hair drier,toothbrush";
let YOLO_OK = false;
try {
    fs.accessSync(path.join(__dirname, "..", "test-models", "yolov10n.onnx"));
    YOLO_OK = true;
} catch (e) {
    YOLO_OK = false;
}

let _id = 0;
const nid = (p) => `${p || "n"}_${(++_id).toString(36)}`;

const nodes = [];
const add = (n) => {
    nodes.push(n);
    return n.id;
};

// ---- shared function bodies -------------------------------------------------

const GENERATOR_FN = (seq, expect, test) => `
const SEQ = ${JSON.stringify(seq)};
const EXPECT = ${JSON.stringify(expect)};
const TEST = ${JSON.stringify(test)};
for (let i = 0; i < SEQ.length; i++) {
    const el = SEQ[i];
    let m;
    if (el && typeof el === 'object' && !Array.isArray(el) && el.__b64) {
        m = { payload: Buffer.from(el.__b64, 'base64') };
    } else if (el && typeof el === 'object' && !Array.isArray(el) && el.__msg) {
        m = Object.assign({}, el); delete m.__msg;
    } else {
        m = { payload: el };
    }
    if (i === SEQ.length - 1 && EXPECT) { m.test = TEST; m.expect = EXPECT; }
    node.send(m);
}
return null;
`;

const GENERIC_VALIDATOR_FN = `
if (msg.expect === undefined) { return null; }
const exp = msg.expect;
function get(o, p) { return String(p).split('.').reduce((a, k) => (a == null ? undefined : a[k]), o); }
function approx(a, e, tol) { return (typeof a === 'number' && !isNaN(a)) && Math.abs(a - e) <= tol; }
const fails = [];
for (const key of Object.keys(exp)) {
    const e = exp[key];
    const a = get(msg, key);
    let ok = false;
    if (e && typeof e === 'object') {
        if ('min' in e || 'max' in e) {
            const lo = ('min' in e) ? e.min : -Infinity, hi = ('max' in e) ? e.max : Infinity;
            ok = (typeof a === 'number' && a >= lo && a <= hi);
        } else if ('approx' in e) {
            ok = approx(a, e.approx, e.tol != null ? e.tol : 1e-6);
        } else if ('oneOf' in e) {
            ok = e.oneOf.indexOf(a) >= 0;
        } else if ('type' in e) {
            ok = (typeof a === e.type) && (e.type !== 'string' || a.length > 0);
        } else { ok = JSON.stringify(a) === JSON.stringify(e); }
    } else if (typeof e === 'number') {
        ok = approx(a, e, Math.max(1e-9, Math.abs(e) * 1e-6));
    } else { ok = (a === e); }
    if (!ok) fails.push(key + ': got ' + JSON.stringify(a) + ' want ' + JSON.stringify(e));
}
const pass = fails.length === 0;
const actual = {};
for (const key of Object.keys(exp)) { const v = get(msg, key); actual[key] = (typeof v === 'number') ? +v.toFixed(4) : v; }
node.status({ fill: pass ? 'green' : 'red', shape: 'dot', text: (pass ? 'PASS ' : 'FAIL ') + (msg.test || '') });
return { payload: { test: msg.test, pass: pass, fails: fails, actual: actual, expected: exp }, _result: true };
`;

// custom validators -----------------------------------------------------------

const VAL_TRAINING = `
if (msg.topic !== 'stats') { return null; }
const n = msg.payload && msg.payload.samples;
const pass = (n === 10);
const test = 'training-data-collector: collect 10 → stats';
node.status({ fill: pass ? 'green' : 'red', shape: 'dot', text: (pass ? 'PASS ' : 'FAIL ') + test });
return { payload: { test: test, pass: pass, fails: pass ? [] : ['samples=' + n + ' want 10'], actual: { samples: n, totalCollected: msg.payload && msg.payload.totalCollected } }, _result: true };
`;

const VAL_SOURCE = `
if (msg.health === undefined || msg.status === undefined) { return null; }
const fails = [];
const s = msg.payload && msg.payload.sensors;
if (!(typeof msg.health === 'number' && msg.health >= 0 && msg.health <= 100)) fails.push('health=' + msg.health);
if (['normal','warning','alarm'].indexOf(msg.status) < 0) fails.push('status=' + msg.status);
if (!(s && typeof s.vibrationRMS === 'number' && s.vibrationRMS > 0 && isFinite(s.vibrationRMS))) fails.push('vibrationRMS=' + (s && s.vibrationRMS));
if (!(s && typeof s.temperature === 'number' && isFinite(s.temperature))) fails.push('temperature missing');
const pass = fails.length === 0;
const test = 'condition-monitoring-source: deterministic sample (seed 42)';
node.status({ fill: pass ? 'green' : 'red', shape: 'dot', text: (pass ? 'PASS ' : 'FAIL ') + test });
return { payload: { test: test, pass: pass, fails: fails, actual: { health: msg.health, status: msg.status, vibrationRMS: s && +(+s.vibrationRMS).toFixed(3), temperature: s && +(+s.temperature).toFixed(2) } }, _result: true };
`;

const VAL_LLM = `
if (msg.totalUsage === undefined && msg.usage === undefined) { return null; }
const fails = [];
if (!(typeof msg.payload === 'string' && msg.payload.length > 0)) fails.push('payload not non-empty string: ' + JSON.stringify(msg.payload));
const ot = msg.usage && msg.usage.outputTokens;
if (!(typeof ot === 'number' && ot > 0)) fails.push('usage.outputTokens=' + ot);
const pass = fails.length === 0;
const test = 'llm-analyzer: analyze batch via mock';
node.status({ fill: pass ? 'green' : 'red', shape: 'dot', text: (pass ? 'PASS ' : 'FAIL ') + test });
return { payload: { test: test, pass: pass, fails: fails, actual: { outputTokens: ot, text: typeof msg.payload === 'string' ? msg.payload.slice(0, 80) : msg.payload } }, _result: true };
`;

// ---- runner wiring placeholders --------------------------------------------

const triggerLinkInIds = []; // each generator's trigger link-in
const resultLinkOutIds = []; // each validator's result link-out
const errorLinkOutIds = []; // each tab's catch -> error link-out
const pngLinkOutIds = []; // vision tabs -> png stash link-out (for /preview)
const contentTabIds = []; // every tab except the runner
let resultsLinkInId = null;

// ---- builders ---------------------------------------------------------------

function makeTab(label, info) {
    const id = nid("tab");
    add({ id, type: "tab", label, disabled: false, info: info || "" });
    contentTabIds.push(id);
    return id;
}

// State-clearing message prepended to each run so the suite is repeatable
// (the nodes are stateful — their buffers survive between runs).
const RESET_BY_TYPE = {
    "anomaly-detector": { reset: true },
    "pca-anomaly": { reset: true },
    "multi-value-processor": { reset: true },
    "signal-analyzer": { reset: true },
    "trend-predictor": { reset: true },
    "training-data-collector": { action: "clear" }
    // isolation-forest-anomaly has no reset hook; its batch model is fixed after
    // the first 10 samples and the outlier stays extreme, so it is stable.
};

/*
 * A test row: inject + trigger-linkIn -> generator -> nodeUnderTest -> validator -> (debug + result linkOut)
 * opts: { z, y, name, nodeType, nodeConfig, outputs, seq, expect, validatorFn, reset }
 */
function makeTest(opts) {
    const z = opts.z;
    const y = opts.y;
    const validatorFn = opts.validatorFn || GENERIC_VALIDATOR_FN;
    const reportable = opts.reportable !== false;

    const resetMsg = opts.reset !== undefined ? opts.reset : RESET_BY_TYPE[opts.nodeType];
    const seq = resetMsg ? [Object.assign({ __msg: true }, resetMsg)].concat(opts.seq) : opts.seq;

    const genId = nid("gen");
    const nodeId = nid("nut");
    const valId = nid("val");
    const dbgId = nid("dbg");
    const injId = nid("inj");
    const linkInId = nid("lin");
    const linkOutId = reportable ? nid("lout") : null;

    // inject button (manual run) — always fires immediately
    add({
        id: injId,
        type: "inject",
        z,
        name: "▶ " + opts.name,
        props: [{ p: "payload" }],
        repeat: "",
        once: false,
        payload: "run",
        payloadType: "str",
        x: 130,
        y,
        wires: [[genId]]
    });
    // trigger from runner — optionally delayed so a network-bound test (llm) does
    // not contend with the synchronous ONNX load of the all-at-once broadcast.
    if (opts.triggerDelay) {
        const dId = nid("tdly");
        add({
            id: linkInId,
            type: "link in",
            z,
            name: "trig:" + opts.name,
            links: [],
            x: 110,
            y: y + 34,
            wires: [[dId]]
        });
        add({
            id: dId,
            type: "delay",
            z,
            name: "stagger",
            pauseType: "delay",
            timeout: String(opts.triggerDelay),
            timeoutUnits: "milliseconds",
            x: 250,
            y: y + 34,
            wires: [[genId]]
        });
    } else {
        add({
            id: linkInId,
            type: "link in",
            z,
            name: "trig:" + opts.name,
            links: [],
            x: 130,
            y: y + 34,
            wires: [[genId]]
        });
    }
    triggerLinkInIds.push(linkInId);

    // generator
    add({
        id: genId,
        type: "function",
        z,
        name: "gen",
        outputs: 1,
        func: GENERATOR_FN(seq, opts.expect || null, opts.name),
        x: 320,
        y,
        wires: [[nodeId]]
    });

    // node under test
    const outs = opts.outputs || 1;
    const nutWires = [];
    for (let i = 0; i < outs; i++) nutWires.push([valId]);
    add(
        Object.assign(
            { id: nodeId, type: opts.nodeType, z, name: opts.name, x: 530, y, wires: nutWires },
            opts.nodeConfig
        )
    );

    // validator
    const valWires = linkOutId ? [[dbgId, linkOutId]] : [[dbgId]];
    add({
        id: valId,
        type: "function",
        z,
        name: "validate",
        outputs: 1,
        func: validatorFn,
        x: 740,
        y,
        wires: valWires
    });

    // debug
    add({
        id: dbgId,
        type: "debug",
        z,
        name: opts.name,
        active: true,
        console: false,
        complete: "payload",
        targetType: "msg",
        x: 950,
        y,
        wires: []
    });

    if (linkOutId) {
        add({
            id: linkOutId,
            type: "link out",
            z,
            name: "result",
            mode: "link",
            links: [],
            x: 950,
            y: y + 34,
            wires: []
        });
        resultLinkOutIds.push(linkOutId);
    }
    return { nodeId, valId };
}

/*
 * Multi-stage test: inject/linkIn -> generator -> stage1 -> stage2 -> ... -> validator.
 * opts: { z, y, name, stages:[{type, config}], seq, expect, pngStash }
 * Each stage is a single-output node chained to the next.
 */
function makeChain(opts) {
    const z = opts.z,
        y = opts.y;
    const genId = nid("gen"),
        valId = nid("val"),
        dbgId = nid("dbg"),
        injId = nid("inj"),
        linkInId = nid("lin"),
        linkOutId = nid("lout");
    const stageIds = opts.stages.map(() => nid("st"));

    add({
        id: injId,
        type: "inject",
        z,
        name: "▶ " + opts.name,
        props: [{ p: "payload" }],
        repeat: "",
        once: false,
        payload: "run",
        payloadType: "str",
        x: 130,
        y,
        wires: [[genId]]
    });
    add({
        id: linkInId,
        type: "link in",
        z,
        name: "trig:" + opts.name,
        links: [],
        x: 130,
        y: y + 34,
        wires: [[genId]]
    });
    triggerLinkInIds.push(linkInId);

    add({
        id: genId,
        type: "function",
        z,
        name: "gen",
        outputs: 1,
        func: GENERATOR_FN(opts.seq, opts.expect || null, opts.name),
        x: 300,
        y,
        wires: [[stageIds[0]]]
    });

    opts.stages.forEach((st, i) => {
        const isLast = i === stageIds.length - 1;
        const wires = isLast ? [[valId]] : [[stageIds[i + 1]]];
        add(
            Object.assign(
                { id: stageIds[i], type: st.type, z, name: st.type, x: 460 + i * 150, y, wires: wires },
                st.config
            )
        );
    });

    // extra taps on the last stage output: png stash (/preview) and/or an
    // image-output node that renders a thumbnail under the node in the editor.
    const lastStage = nodes.find((n) => n.id === stageIds[stageIds.length - 1]);
    const lastWires = [valId];
    if (opts.pngStash) {
        // tag the message with the test name before stashing, so /preview has a key
        // even when a source node produced a fresh message (no msg.test passed through)
        const tagId = nid("ptag"),
            pngOutId = nid("plout");
        add({
            id: tagId,
            type: "function",
            z,
            name: "tag",
            outputs: 1,
            func: "msg.test = " + JSON.stringify(opts.name) + "; return msg;",
            x: 460 + stageIds.length * 150,
            y: y + 34,
            wires: [[pngOutId]]
        });
        lastWires.push(tagId);
        add({
            id: pngOutId,
            type: "link out",
            z,
            name: "png",
            mode: "link",
            links: [],
            x: 460 + (stageIds.length + 1) * 150,
            y: y + 34,
            wires: []
        });
        pngLinkOutIds.push(pngOutId);
    }
    // vision-annotator now draws its own live thumbnail under itself in the editor,
    // so a separate image-output node is only added when explicitly requested.
    const wantImage = opts.imageOut === true;
    if (wantImage) {
        const imgId = nid("imgout");
        lastWires.push(imgId);
        add({
            id: imgId,
            type: "image",
            z,
            name: "preview",
            width: "240",
            data: "payload",
            dataType: "msg",
            thumbnail: false,
            active: true,
            pass: false,
            outputs: 0,
            x: 460 + stageIds.length * 150,
            y: y + 70,
            wires: []
        });
    }
    // wire the last stage's output(s) to the validator (2 outputs for nodes that
    // route normal/anomaly separately, e.g. signal-analyzer / anomaly-detector)
    lastStage.wires = (opts.lastOutputs || 1) === 2 ? [lastWires, [valId]] : [lastWires];

    add({
        id: valId,
        type: "function",
        z,
        name: "validate",
        outputs: 1,
        func: opts.validatorFn || GENERIC_VALIDATOR_FN,
        x: 460 + (stageIds.length + 1) * 150,
        y,
        wires: [[dbgId, linkOutId]]
    });
    add({
        id: dbgId,
        type: "debug",
        z,
        name: opts.name,
        active: true,
        console: false,
        complete: "payload",
        targetType: "msg",
        x: 460 + (stageIds.length + 2) * 150,
        y,
        wires: []
    });
    add({
        id: linkOutId,
        type: "link out",
        z,
        name: "result",
        mode: "link",
        links: [],
        x: 460 + (stageIds.length + 2) * 150,
        y: y + 34,
        wires: []
    });
    resultLinkOutIds.push(linkOutId);
}

function comment(z, name, info, y) {
    add({ id: nid("cmt"), type: "comment", z, name, info: info || "", x: 160, y: y || 40, wires: [] });
}

// ============================================================================
// TAB: anomaly-detector
// ============================================================================
{
    const z = makeTab(
        "📊 anomaly-detector",
        "z-score / IQR / threshold / EMA / CUSUM — each fed a normal baseline then a known outlier."
    );
    comment(z, "anomaly-detector — outlier after a clean baseline must be flagged critical", "", 40);
    const baseline = [];
    for (let i = 0; i < 40; i++) baseline.push(i % 2 ? 10.5 : 9.5); // mean 10, sd 0.5

    makeTest({
        z,
        y: 100,
        name: "z-score critical",
        nodeType: "anomaly-detector",
        outputs: 2,
        nodeConfig: {
            method: "zscore",
            windowSize: 100,
            zscoreThreshold: 3,
            zscoreWarning: 2,
            hysteresisEnabled: false
        },
        seq: baseline.concat([100]),
        expect: { isAnomaly: true, severity: "critical", payload: 100 }
    });
    makeTest({
        z,
        y: 200,
        name: "IQR critical",
        nodeType: "anomaly-detector",
        outputs: 2,
        nodeConfig: { method: "iqr", windowSize: 100, iqrMultiplier: 1.5, hysteresisEnabled: false },
        seq: baseline.concat([100]),
        expect: { isAnomaly: true, severity: "critical" }
    });
    makeTest({
        z,
        y: 300,
        name: "threshold critical",
        nodeType: "anomaly-detector",
        outputs: 2,
        nodeConfig: {
            method: "threshold",
            minThreshold: 0,
            maxThreshold: 50,
            warningMargin: 10,
            hysteresisEnabled: false
        },
        seq: [10, 20, 30, 100],
        expect: { isAnomaly: true, severity: "critical" }
    });
    makeTest({
        z,
        y: 400,
        name: "EMA spike",
        nodeType: "anomaly-detector",
        outputs: 2,
        nodeConfig: {
            method: "ema",
            emaAlpha: 0.3,
            emaThreshold: 2,
            emaWarning: 1.5,
            emaMethod: "stddev",
            hysteresisEnabled: false
        },
        seq: baseline.concat([100]),
        expect: { isAnomaly: true }
    });
    makeTest({
        z,
        y: 500,
        name: "CUSUM drift",
        nodeType: "anomaly-detector",
        outputs: 2,
        nodeConfig: {
            method: "cusum",
            cusumTarget: 10,
            cusumThreshold: 5,
            cusumWarning: 3.5,
            cusumDrift: 0.5,
            hysteresisEnabled: false
        },
        seq: [10, 10, 13, 13, 13, 13, 13],
        expect: { isAnomaly: true }
    });
}

// ============================================================================
// TAB: isolation-forest-anomaly
// ============================================================================
{
    const z = makeTab(
        "🌲 isolation-forest",
        "Tight cluster of normals trains the forest; an extreme value must score as an anomaly."
    );
    comment(z, "isolation-forest — extreme outlier after 40-sample cluster", "", 40);
    // Near-constant baseline (tiny consistent drift) so the outlier is isolated by
    // magnitude rather than the alternating delta feature swamping the score.
    const cluster = [];
    for (let i = 0; i < 40; i++) cluster.push(50 + i * 0.01);
    makeTest({
        z,
        y: 100,
        name: "extreme outlier",
        nodeType: "isolation-forest-anomaly",
        outputs: 2,
        nodeConfig: { contamination: 0.1, windowSize: 100, numEstimators: 100, learningMode: "batch" },
        seq: cluster.concat([500]),
        expect: { isAnomaly: true, payload: 500 }
    });
}

// ============================================================================
// TAB: pca-anomaly
// ============================================================================
{
    const z = makeTab(
        "🎯 pca-anomaly",
        "Two perfectly-correlated sensors train PCA; a sample that breaks the correlation must be flagged."
    );
    comment(z, "pca-anomaly — correlation-breaking sample (SPE) flagged", "", 40);
    const seq = [];
    for (let i = 1; i <= 40; i++) seq.push({ sensorA: i, sensorB: i }); // B == A
    seq.push({ sensorA: 20, sensorB: -20 }); // breaks correlation
    // windowSize 20 -> trains after max(10, windowSize*0.5)=10 samples.
    makeTest({
        z,
        y: 100,
        name: "correlation break",
        nodeType: "pca-anomaly",
        outputs: 2,
        nodeConfig: { nComponents: 2, windowSize: 20, threshold: 3, method: "combined", autoComponents: true },
        seq,
        expect: { isAnomaly: true }
    });
}

// ============================================================================
// TAB: multi-value-processor
// ============================================================================
{
    const z = makeTab(
        "🔀 multi-value-processor",
        "aggregate (exact stats) / analyze (z-score anomaly) / correlate (Pearson)."
    );
    comment(z, "multi-value-processor — aggregate / analyze / correlate", "", 40);

    makeTest({
        z,
        y: 100,
        name: "aggregate mean exact",
        nodeType: "multi-value-processor",
        outputs: 2,
        nodeConfig: { mode: "aggregate", aggregateMethod: "mean", aggregateOutput: "all" },
        seq: [[10, 20, 30]],
        expect: {
            payload: 20,
            "aggregation.all.mean": 20,
            "aggregation.all.sum": 60,
            "aggregation.all.range": 20,
            "aggregation.all.min": 10,
            "aggregation.all.max": 30
        }
    });

    const an = [];
    for (let i = 0; i < 30; i++) an.push({ temp: i % 2 ? 20.5 : 19.5 });
    an.push({ temp: 200 });
    makeTest({
        z,
        y: 200,
        name: "analyze z-score anomaly",
        nodeType: "multi-value-processor",
        outputs: 2,
        nodeConfig: { mode: "analyze", anomalyMethod: "zscore", threshold: 3, windowSize: 100 },
        seq: an,
        expect: { hasAnomaly: true, anomalyCount: 1 }
    });

    const co = [];
    for (let i = 1; i <= 20; i++) co.push({ x: i, y: 2 * i + 1 }); // y = 2x+1 -> r = 1
    makeTest({
        z,
        y: 300,
        name: "correlate pearson ~1",
        nodeType: "multi-value-processor",
        outputs: 2,
        nodeConfig: {
            mode: "correlate",
            sensor1: "x",
            sensor2: "y",
            correlationMethod: "pearson",
            correlationThreshold: 0.7,
            windowSize: 100
        },
        seq: co,
        expect: { correlation: { approx: 1, tol: 0.02 }, isAnomalous: false }
    });
}

// ============================================================================
// TAB: signal-analyzer
// ============================================================================
{
    const z = makeTab("📈 signal-analyzer", "vibration (exact RMS/peak) / FFT (dominant frequency) / peaks (count).");
    comment(z, "signal-analyzer — vibration / fft / peaks", "", 40);

    // [3,-4] x8 -> squares mean = 12.5 -> rms = 3.53553 ; peak 4 ; peak-to-peak 7
    const vib = [];
    for (let i = 0; i < 8; i++) {
        vib.push(3, -4);
    }
    makeTest({
        z,
        y: 100,
        name: "vibration RMS exact",
        nodeType: "signal-analyzer",
        outputs: 2,
        nodeConfig: { mode: "vibration", windowSize: 256, vibInputUnit: "mm_s" },
        seq: [vib],
        expect: {
            "payload.rms": { approx: 3.53553, tol: 0.001 },
            "payload.peak": { approx: 4, tol: 1e-6 },
            "payload.peakToPeak": { approx: 7, tol: 1e-6 }
        }
    });

    // pure sine, fs = 64, N = 64, f = 8 Hz -> exact bin -> dominantFrequency = 8
    const sine = [];
    for (let n = 0; n < 64; n++) sine.push(Math.sin((2 * Math.PI * 8 * n) / 64));
    makeTest({
        z,
        y: 200,
        name: "FFT dominant freq 8Hz",
        nodeType: "signal-analyzer",
        outputs: 2,
        nodeConfig: {
            mode: "fft",
            fftSize: 64,
            samplingRate: 64,
            windowFunction: "rectangular",
            outputFormat: "peaks",
            peakThreshold: 0.1
        },
        seq: sine,
        expect: { dominantFrequency: { approx: 8, tol: 1.01 } }
    });

    // sine amplitude 10 -> repeated positive peaks
    const ramp = [];
    for (let n = 0; n < 60; n++) ramp.push(10 * Math.sin((2 * Math.PI * 4 * n) / 40));
    makeTest({
        z,
        y: 300,
        name: "peaks detected",
        nodeType: "signal-analyzer",
        outputs: 2,
        nodeConfig: { mode: "peaks", minPeakHeight: 5, minPeakDistance: 3, peakType: "positive" },
        seq: ramp,
        expect: { peakCount: { min: 1, max: 60 } }
    });
}

// ============================================================================
// TAB: trend-predictor
// ============================================================================
{
    const z = makeTab("📉 trend-predictor", "prediction (slope/trend) / rate-of-change / RUL.");
    comment(z, "trend-predictor — prediction / rate-of-change / RUL", "", 40);

    const ramp = [];
    for (let i = 0; i < 10; i++) ramp.push(2 * i); // slope 2, increasing
    makeTest({
        z,
        y: 100,
        name: "prediction slope 2",
        nodeType: "trend-predictor",
        outputs: 2,
        nodeConfig: { mode: "prediction", method: "linear", predictionSteps: 5, windowSize: 50 },
        seq: ramp,
        expect: { trend: "increasing", slope: { approx: 2, tol: 0.1 } }
    });

    const roc = [];
    for (let i = 0; i < 7; i++) roc.push({ __msg: true, payload: i * 5, timestamp: (i + 1) * 1000 }); // +5 per 1s
    makeTest({
        z,
        y: 200,
        name: "rate-of-change 5/s",
        nodeType: "trend-predictor",
        outputs: 2,
        nodeConfig: { mode: "rate-of-change", rocMethod: "absolute", timeWindow: 1 },
        seq: roc,
        expect: { rateOfChange: { approx: 5, tol: 0.5 } }
    });

    // Rising damage toward failure threshold, 10 samples 1h apart (timestamps from a
    // nonzero base so the regression intercept stays well-conditioned).
    const rul = [];
    for (let i = 0; i < 10; i++) rul.push({ __msg: true, payload: 50 + 5 * i, timestamp: 1000000 + i * 3600000 });
    makeTest({
        z,
        y: 300,
        name: "RUL hours",
        nodeType: "trend-predictor",
        outputs: 2,
        nodeConfig: {
            mode: "rul",
            failureThreshold: 150,
            warningThreshold: 120,
            degradationModel: "linear",
            rulUnit: "hours"
        },
        seq: rul,
        expect: { "rul.unit": "hours", "rul.value": { min: 5, max: 50 }, "degradation.trend": "increasing" }
    });
}

// ============================================================================
// TAB: health-index
// ============================================================================
{
    const z = makeTab("❤️ health-index", "weighted aggregation (exact) / minimum aggregation (worst sensor).");
    comment(z, "health-index — weighted 77.5 (attention) / minimum 30 (degraded)", "", 40);

    // temp score 100 (w1), vibration score 70 (anomaly -30, w3) -> (100+210)/4 = 77.5 -> attention
    makeTest({
        z,
        y: 100,
        name: "weighted 77.5",
        nodeType: "health-index",
        outputs: 2,
        nodeConfig: { aggregationMethod: "weighted", sensorWeights: '{"temp":1,"vibration":3}', outputScale: "0-100" },
        seq: [{ temp: { isAnomaly: false }, vibration: { isAnomaly: true } }],
        expect: { healthIndex: { approx: 77.5, tol: 0.5 }, status: "attention" }
    });

    // bad: anomaly(-30) + |z|>3(-40) -> 30 ; good: 100 ; minimum -> 30 -> degraded
    makeTest({
        z,
        y: 200,
        name: "minimum 30 degraded",
        nodeType: "health-index",
        outputs: 2,
        nodeConfig: { aggregationMethod: "minimum", sensorWeights: "{}", outputScale: "0-100" },
        seq: [{ bad: { isAnomaly: true, zScore: 3.5 }, good: { isAnomaly: false } }],
        expect: { healthIndex: { approx: 30, tol: 0.5 }, status: "degraded" }
    });
}

// ============================================================================
// TAB: condition-monitoring-source (custom validator: structural invariants)
// ============================================================================
{
    const z = makeTab(
        "🏭 condition-monitoring-source",
        "Deterministic (seed 42) simulated sample — validated for structural invariants."
    );
    comment(z, "condition-monitoring-source — one simulated pump sample", "", 40);
    makeTest({
        z,
        y: 100,
        name: "source sample",
        nodeType: "condition-monitoring-source",
        outputs: 1,
        nodeConfig: {
            assetType: "pump",
            rpm: 1500,
            load: 70,
            degRate: 0.06,
            noise: 0.3,
            hoursPerSample: 2,
            faultBearing: 0.5,
            autoStart: false,
            outputFormat: "object",
            seed: 42
        },
        seq: ["trigger"],
        validatorFn: VAL_SOURCE
    });
}

// ============================================================================
// TAB: training-data-collector (custom validator: sample count)
// ============================================================================
{
    const z = makeTab(
        "💾 training-data-collector",
        "Collect 10 samples in-memory, then query stats — sample count must be 10."
    );
    comment(z, "training-data-collector — collect 10 then action:stats", "", 40);
    const seq = [];
    for (let i = 0; i < 10; i++) seq.push({ __msg: true, payload: { f1: i, f2: 2 * i } });
    seq.push({ __msg: true, action: "stats" });
    makeTest({
        z,
        y: 100,
        name: "collect 10",
        nodeType: "training-data-collector",
        outputs: 1,
        nodeConfig: {
            datasetName: "test",
            mode: "batch",
            autoSave: false,
            featureSource: "payload",
            bufferSize: 1000,
            labelMode: "unlabeled",
            flushOnDeploy: false,
            s3Enabled: false
        },
        seq,
        validatorFn: VAL_TRAINING
    });
}

// ============================================================================
// TAB: llm-analyzer (custom validator: response shape, against mock)
// ============================================================================
{
    const z = makeTab(
        "💬 llm-analyzer",
        "Analyze a batch via the Anthropic-format mock (host.docker.internal:18088). Manual trigger flushes."
    );
    comment(
        z,
        "llm-analyzer — batch analyzed via mock LLM; checks text + token usage",
        "Requires the demo mock running (docker-compose.demo.yml, host port 18088). The broadcast staggers this test by ~1.5s so the network call doesn't contend with ONNX load.",
        40
    );
    const seq = [20, 21, 22, 23, 24, { __msg: true, payload: 25, flush: true }];
    makeTest({
        z,
        y: 120,
        name: "mock analysis",
        nodeType: "llm-analyzer",
        outputs: 1,
        nodeConfig: {
            provider: "anthropic",
            model: "claude-haiku-mock",
            apiUrl: "http://host.docker.internal:18088/v1/messages",
            apiKey: "mock-key",
            triggerMode: "manual",
            inputMode: "scalar",
            outputMode: "text",
            maxOutputTokens: 256,
            timeoutMs: 15000,
            sensorName: "test-sensor",
            unit: "C"
        },
        seq,
        validatorFn: VAL_LLM,
        // fire ~1.5s after the broadcast so the network call doesn't contend with
        // the synchronous ONNX inference load of all the other tests
        triggerDelay: 1500
    });
}

// ============================================================================
// TAB: ml-inference (ONNX inference against a bundled times_two model)
// ============================================================================
{
    const z = makeTab(
        "🤖 ml-inference",
        "Runs a tiny bundled ONNX model (output = input × 2) and validates the prediction."
    );
    comment(
        z,
        "ml-inference — ONNX model test-models/times_two.onnx mounted at /data/models",
        "The model computes output = input * 2. Input [1,2,3,4] -> prediction [2,4,6,8]. Needs the Debian image (onnxruntime-node) — see docker-compose.yml.",
        40
    );
    makeTest({
        z,
        y: 120,
        name: "ml-inference times_two (ONNX)",
        nodeType: "ml-inference",
        outputs: 1,
        nodeConfig: {
            modelSource: "local",
            modelPath: "/data/models/times_two.onnx",
            modelType: "onnx",
            inputProperty: "payload",
            outputProperty: "prediction",
            preprocessMode: "array",
            inputShape: "[1,4]",
            warmup: false
        },
        seq: [[1, 2, 3, 4]],
        expect: {
            "prediction.0": { approx: 2, tol: 1e-3 },
            "prediction.1": { approx: 4, tol: 1e-3 },
            "prediction.2": { approx: 6, tol: 1e-3 },
            "prediction.3": { approx: 8, tol: 1e-3 }
        }
    });
}

// ============================================================================
// TAB: vision-annotator — segmentation overlay (image output)
// ============================================================================
{
    const z = makeTab(
        "🖼️ vision: segmentation",
        "ONNX segmentation model -> vision-annotator overlay. Validates the class mask; view the PNG at /preview?test=..."
    );
    comment(
        z,
        "ml-inference (segmentation.onnx) → vision-annotator (segmentation) → mask validated",
        "Model outputs [1,3,4,4] logits: left half class 1, right half class 2. View image: GET /preview?test=vision: segmentation overlay",
        40
    );
    makeChain({
        z,
        y: 120,
        name: "vision: segmentation overlay",
        pngStash: true,
        stages: [
            {
                type: "ml-inference",
                config: {
                    modelSource: "local",
                    modelPath: "/data/models/segmentation.onnx",
                    modelType: "onnx",
                    inputProperty: "payload",
                    outputProperty: "prediction",
                    preprocessMode: "array",
                    inputShape: "[1,3,4,4]",
                    warmup: false
                }
            },
            {
                type: "vision-annotator",
                config: {
                    mode: "segmentation",
                    inputProperty: "prediction",
                    shapeProperty: "mlInference.outputShape",
                    canvasWidth: 64,
                    canvasHeight: 64,
                    alpha: 0.6
                }
            }
        ],
        // input image tensor = 1x3x4x4 zeros (model ignores it; output is constant)
        seq: [new Array(48).fill(0)],
        expect: {
            "annotations.mode": "segmentation",
            "annotations.classesPresent": [1, 2],
            "annotations.maskClassCounts.1": 8,
            "annotations.maskClassCounts.2": 8,
            contentType: "image/png"
        }
    });
}

// ============================================================================
// TAB: vision-annotator — bounding boxes (image output)
// ============================================================================
{
    const z = makeTab(
        "🖼️ vision: boxes",
        "ONNX detection model -> vision-annotator bounding boxes. Validates the boxes; view the PNG at /preview?test=..."
    );
    comment(
        z,
        "ml-inference (detection.onnx) → vision-annotator (boxes) → boxes validated",
        "Model outputs [1,2,6] decoded boxes [x1,y1,x2,y2,score,class]. View image: GET /preview?test=vision: bounding boxes",
        40
    );
    makeChain({
        z,
        y: 120,
        name: "vision: bounding boxes",
        pngStash: true,
        stages: [
            {
                type: "ml-inference",
                config: {
                    modelSource: "local",
                    modelPath: "/data/models/detection.onnx",
                    modelType: "onnx",
                    inputProperty: "payload",
                    outputProperty: "prediction",
                    preprocessMode: "array",
                    inputShape: "[1,3,100,100]",
                    warmup: false
                }
            },
            {
                type: "vision-annotator",
                config: {
                    mode: "boxes",
                    boxFormat: "xyxy",
                    inputProperty: "prediction",
                    shapeProperty: "mlInference.outputShape",
                    canvasWidth: 100,
                    canvasHeight: 100,
                    scoreThreshold: 0.3,
                    boxThickness: 2,
                    classLabels: "bolt,crack"
                }
            }
        ],
        seq: [new Array(30000).fill(0)],
        expect: {
            "annotations.mode": "boxes",
            "annotations.count": 2,
            "annotations.classesPresent": [0, 1],
            "annotations.boxes.0.x1": 10,
            "annotations.boxes.0.class": 0,
            "annotations.boxes.1.x2": 90,
            contentType: "image/png"
        }
    });
}

// ============================================================================
// TABs: vision-annotator — the remaining annotation modes
// ============================================================================
function visionTab(label, modelName, vaConfig, expect, hint) {
    const z = makeTab(label, hint || "");
    comment(
        z,
        "ml-inference (" + modelName + ".onnx) → vision-annotator (" + vaConfig.mode + ")",
        "View image: GET /preview?test=" + label.replace(/^[^a-z]*/i, ""),
        40
    );
    makeChain({
        z,
        y: 120,
        name: label.replace("🖼️ ", ""),
        pngStash: true,
        stages: [
            {
                type: "ml-inference",
                config: {
                    modelSource: "local",
                    modelPath: "/data/models/" + modelName + ".onnx",
                    modelType: "onnx",
                    inputProperty: "payload",
                    outputProperty: "prediction",
                    preprocessMode: "array",
                    inputShape: "[1,1]",
                    warmup: false
                }
            },
            { type: "vision-annotator", config: vaConfig }
        ],
        seq: [[0]],
        expect
    });
}

visionTab(
    "🖼️ vision: oriented boxes",
    "obb",
    { mode: "obb", canvasWidth: 100, canvasHeight: 100, scoreThreshold: 0.3, boxThickness: 2, classLabels: "weld" },
    {
        "annotations.mode": "obb",
        "annotations.count": 1,
        "annotations.boxes.0.class": 0,
        "annotations.boxes.0.angle": { approx: 0.5236, tol: 0.001 },
        contentType: "image/png"
    }
);

visionTab(
    "🖼️ vision: instances",
    "instances",
    { mode: "instances", canvasWidth: 64, canvasHeight: 64, alpha: 0.6, boxThickness: 1 },
    {
        "annotations.mode": "instances",
        "annotations.count": 2,
        "annotations.instances.0.area": 9,
        "annotations.instances.1.area": 16,
        contentType: "image/png"
    }
);

visionTab(
    "🖼️ vision: polygons",
    "polygons",
    { mode: "polygons", canvasWidth: 80, canvasHeight: 60, boxThickness: 1 },
    {
        "annotations.mode": "polygons",
        "annotations.count": 1,
        "annotations.polygons.0.area": { approx: 1500, tol: 1 },
        "annotations.polygons.0.perimeter": { approx: 160, tol: 1 },
        contentType: "image/png"
    }
);

visionTab(
    "🖼️ vision: keypoints",
    "keypoints",
    {
        mode: "keypoints",
        canvasWidth: 80,
        canvasHeight: 80,
        kpThreshold: 0.5,
        pointRadius: 3,
        boxThickness: 2,
        skeleton: "[[0,1],[1,2]]"
    },
    {
        "annotations.mode": "keypoints",
        "annotations.keypointCount": 3,
        "annotations.visibleCount": 2,
        contentType: "image/png"
    }
);

visionTab(
    "🖼️ vision: heatmap",
    "heatmap",
    { mode: "heatmap", canvasWidth: 64, canvasHeight: 64, alpha: 0.8, colormap: "jet" },
    {
        "annotations.mode": "heatmap",
        "annotations.min": 0,
        "annotations.max": 15,
        "annotations.mean": { approx: 7.5, tol: 0.01 },
        contentType: "image/png"
    }
);

visionTab(
    "🖼️ vision: anomaly",
    "anomaly",
    { mode: "anomaly", canvasWidth: 64, canvasHeight: 64, alpha: 0.7, threshold: 0.5, colormap: "jet" },
    {
        "annotations.mode": "anomaly",
        "annotations.regionCount": 1,
        "annotations.maxScore": 1,
        "annotations.anomalyFraction": { approx: 0.0625, tol: 0.001 },
        "annotations.regions.0.area": 4,
        contentType: "image/png"
    }
);

visionTab(
    "🖼️ vision: classification",
    "classification",
    { mode: "classification", canvasWidth: 100, canvasHeight: 40, classLabels: "ok,defect,wear,unknown" },
    {
        "annotations.mode": "classification",
        "annotations.topClass": 1,
        "annotations.topScore": { approx: 0.3777, tol: 0.01 },
        contentType: "image/png"
    }
);

// ============================================================================
// TABs: image-preprocess — real images into the pipeline
// ============================================================================
{
    // A) PNG -> exact tensor
    const z = makeTab(
        "🧪 preprocess: PNG→tensor",
        "Decode a known 2x2 PNG and check the exact normalized NCHW tensor."
    );
    comment(z, "image-preprocess (2x2 PNG, 0..1, NCHW, RGB) → exact tensor", "", 40);
    makeChain({
        z,
        y: 120,
        name: "preprocess PNG→tensor",
        stages: [
            {
                type: "image-preprocess",
                config: {
                    targetWidth: 2,
                    targetHeight: 2,
                    normalize: "0-1",
                    layout: "nchw",
                    channelOrder: "rgb",
                    keepImage: false
                }
            }
        ],
        seq: [{ __b64: PNG_2x2 }],
        // NCHW R[1,0,0,1] G[0,1,0,1] B[0,0,1,1]
        expect: {
            tensorShape: [1, 3, 2, 2],
            "payload.0": 1,
            "payload.3": 1,
            "payload.5": 1,
            "payload.10": 1,
            "payload.11": 1,
            "preprocess.width": 2
        }
    });
}
{
    // B) JPEG -> tensor (lossy, tolerant)
    const z = makeTab(
        "🧪 preprocess: JPEG→tensor",
        "Decode a solid-red 8x8 JPEG, resize to 4x4, check channel values (tolerant)."
    );
    comment(z, "image-preprocess (red JPEG → 4x4, 0..1, NCHW) → R≈1 G≈0 B≈0", "", 40);
    makeChain({
        z,
        y: 120,
        name: "preprocess JPEG→tensor",
        stages: [
            {
                type: "image-preprocess",
                config: {
                    targetWidth: 4,
                    targetHeight: 4,
                    normalize: "0-1",
                    layout: "nchw",
                    channelOrder: "rgb",
                    keepImage: false
                }
            }
        ],
        seq: [{ __b64: JPEG_RED }],
        expect: {
            tensorShape: [1, 3, 4, 4],
            "payload.0": { approx: 1, tol: 0.08 },
            "payload.16": { approx: 0, tol: 0.08 },
            "payload.32": { approx: 0, tol: 0.08 }
        }
    });
}
{
    // C) full chain: real image -> preprocess -> detect -> annotate (boxes on the photo)
    const z = makeTab(
        "🖼️ real image → detect → annotate",
        "End-to-end: a real 100x100 image is preprocessed, run through the ONNX detector, and the boxes are drawn back on the image."
    );
    comment(
        z,
        "image-preprocess → ml-inference (detection) → vision-annotator (boxes on msg.image)",
        "View: GET /preview?test=real image",
        40
    );
    makeChain({
        z,
        y: 120,
        name: "real image → detect → annotate",
        pngStash: true,
        stages: [
            {
                type: "image-preprocess",
                config: {
                    targetWidth: 100,
                    targetHeight: 100,
                    normalize: "0-1",
                    layout: "nchw",
                    channelOrder: "rgb",
                    keepImage: true
                }
            },
            {
                type: "ml-inference",
                config: {
                    modelSource: "local",
                    modelPath: "/data/models/detection.onnx",
                    modelType: "onnx",
                    inputProperty: "payload",
                    outputProperty: "prediction",
                    preprocessMode: "array",
                    inputShape: "[1,3,100,100]",
                    warmup: false
                }
            },
            {
                type: "vision-annotator",
                config: {
                    mode: "boxes",
                    boxFormat: "xyxy",
                    imageProperty: "image",
                    scoreThreshold: 0.3,
                    boxThickness: 2,
                    classLabels: "bolt,crack"
                }
            }
        ],
        seq: [{ __b64: PNG_100 }],
        expect: {
            "annotations.mode": "boxes",
            "annotations.count": 2,
            "annotations.classesPresent": [0, 1],
            "annotations.width": 100,
            "annotations.height": 100,
            contentType: "image/png"
        }
    });
}

// ============================================================================
// TABs: trained model — defect segmentation CNN (test-models/defect_seg.onnx)
// ============================================================================
if (SAMPLES) {
    const defectPng = pngFromRGB(SAMPLES.width, SAMPLES.height, SAMPLES.defect);
    const cleanPng = pngFromRGB(SAMPLES.width, SAMPLES.height, SAMPLES.clean);
    const stages = (_label) => [
        {
            type: "image-preprocess",
            config: {
                targetWidth: SAMPLES.width,
                targetHeight: SAMPLES.height,
                normalize: "0-1",
                layout: "nchw",
                channelOrder: "rgb",
                keepImage: true
            }
        },
        {
            type: "ml-inference",
            config: {
                modelSource: "local",
                modelPath: "/data/models/defect_seg.onnx",
                modelType: "onnx",
                inputProperty: "payload",
                outputProperty: "prediction",
                preprocessMode: "array",
                inputShape: "[1,3," + SAMPLES.height + "," + SAMPLES.width + "]",
                warmup: false
            }
        },
        { type: "vision-annotator", config: { mode: "segmentation", imageProperty: "image", alpha: 0.55 } }
    ];

    {
        const z = makeTab(
            "🎓 trained: defect detected",
            "Real image with a defect → image-preprocess → trained CNN (ONNX) → segmentation overlay. The model must mark defect pixels (class 1)."
        );
        comment(
            z,
            "image-preprocess → defect_seg.onnx (trained) → vision-annotator (segmentation)",
            "Trained in pure NumPy (tools/train-defect-seg.py). View: GET /preview?test=trained: defect",
            40
        );
        makeChain({
            z,
            y: 120,
            name: "trained: defect detected",
            pngStash: true,
            stages: stages(),
            seq: [{ __b64: defectPng }],
            expect: { "annotations.mode": "segmentation", "annotations.maskClassCounts.1": { min: 10, max: 800 } }
        });
    }
    {
        const z = makeTab(
            "🎓 trained: clean (no defect)",
            "Real clean image → trained CNN must report NO defect pixels (class 1 absent)."
        );
        comment(
            z,
            "image-preprocess → defect_seg.onnx (trained) → vision-annotator (segmentation) → no defect",
            "",
            40
        );
        makeChain({
            z,
            y: 120,
            name: "trained: clean no defect",
            pngStash: true,
            stages: stages(),
            seq: [{ __b64: cleanPng }],
            expect: { "annotations.mode": "segmentation", "annotations.classesPresent": [] }
        });
    }
}

// ============================================================================
// TAB: pretrained model — SqueezeNet (ImageNet) on a real photo
// ============================================================================
if (PRETRAINED) {
    const z = makeTab(
        "🌍 pretrained: SqueezeNet",
        "A real pretrained ImageNet classifier (ONNX Model Zoo) on a real photo of a dog. Full chain incl. ImageNet normalization."
    );
    comment(
        z,
        "image-preprocess (imagenet) → squeezenet.onnx (pretrained) → vision-annotator (classification)",
        "View: GET /preview?test=pretrained: SqueezeNet",
        40
    );
    makeChain({
        z,
        y: 120,
        name: "pretrained: SqueezeNet classify",
        pngStash: true,
        stages: [
            {
                type: "image-preprocess",
                config: {
                    targetWidth: 224,
                    targetHeight: 224,
                    normalize: "imagenet",
                    layout: "nchw",
                    channelOrder: "rgb",
                    keepImage: true
                }
            },
            {
                type: "ml-inference",
                config: {
                    modelSource: "local",
                    modelPath: "/data/models/squeezenet.onnx",
                    modelType: "onnx",
                    inputProperty: "payload",
                    outputProperty: "prediction",
                    preprocessMode: "array",
                    inputShape: "[1,3,224,224]",
                    warmup: false
                }
            },
            {
                type: "vision-annotator",
                config: {
                    mode: "classification",
                    imageProperty: "image",
                    classLabels: PRETRAINED.labels.map((l) => l.replace(/,/g, "/")).join(",")
                }
            }
        ],
        seq: [{ __b64: PRETRAINED.dogJpg }],
        expect: {
            "annotations.mode": "classification",
            "annotations.topClass": 258,
            "annotations.topLabel": "Samoyed",
            "annotations.topScore": { min: 0.5, max: 1.0 }
        }
    });
}

// ============================================================================
// TAB: pretrained YOLOv10 detector on a real photo
// ============================================================================
if (PRETRAINED && YOLO_OK) {
    const z = makeTab(
        "🌍 pretrained: YOLOv10",
        "A real pretrained YOLOv10n detector (NMS-free, COCO) on a real photo. Boxes drawn back on the image."
    );
    comment(
        z,
        "image-preprocess (640, 0..1) → yolov10n.onnx → vision-annotator (boxes xyxy, COCO)",
        "View: GET /preview?test=pretrained: YOLOv10",
        40
    );
    makeChain({
        z,
        y: 120,
        name: "pretrained: YOLOv10 detect",
        pngStash: true,
        stages: [
            {
                type: "image-preprocess",
                config: {
                    targetWidth: 640,
                    targetHeight: 640,
                    normalize: "0-1",
                    layout: "nchw",
                    channelOrder: "rgb",
                    keepImage: true
                }
            },
            {
                type: "ml-inference",
                config: {
                    modelSource: "local",
                    modelPath: "/data/models/yolov10n.onnx",
                    modelType: "onnx",
                    inputProperty: "payload",
                    outputProperty: "prediction",
                    preprocessMode: "array",
                    inputShape: "[1,3,640,640]",
                    warmup: false
                }
            },
            {
                type: "vision-annotator",
                config: {
                    mode: "boxes",
                    boxFormat: "xyxy",
                    imageProperty: "image",
                    scoreThreshold: 0.25,
                    boxThickness: 3,
                    classLabels: COCO80
                }
            }
        ],
        seq: [{ __b64: PRETRAINED.dog640 }],
        expect: {
            "annotations.mode": "boxes",
            "annotations.count": { min: 1, max: 300 },
            "annotations.classesPresent": [16]
        }
    });
}

// ============================================================================
// TAB: pretrained Depth-Anything (monocular depth) -> heatmap
// ============================================================================
if (PRETRAINED && DEPTH_OK) {
    const z = makeTab(
        "🌍 pretrained: Depth → heatmap",
        "A real pretrained Depth-Anything-v2 model estimates per-pixel depth from one photo; rendered as a jet heatmap."
    );
    comment(
        z,
        "image-preprocess (252, ImageNet) → depth.onnx → vision-annotator (heatmap)",
        "Different annotation (depth field) from a different model. View: GET /preview?test=Depth",
        40
    );
    makeChain({
        z,
        y: 120,
        name: "pretrained: Depth heatmap",
        pngStash: true,
        stages: [
            {
                type: "image-preprocess",
                config: {
                    targetWidth: 252,
                    targetHeight: 252,
                    normalize: "imagenet",
                    layout: "nchw",
                    channelOrder: "rgb",
                    keepImage: false
                }
            },
            {
                type: "ml-inference",
                config: {
                    modelSource: "local",
                    modelPath: "/data/models/depth.onnx",
                    modelType: "onnx",
                    inputProperty: "payload",
                    outputProperty: "prediction",
                    preprocessMode: "array",
                    inputShape: "[1,3,252,252]",
                    warmup: false
                }
            },
            {
                type: "vision-annotator",
                config: { mode: "heatmap", colormap: "jet", canvasWidth: 252, canvasHeight: 252, alpha: 1.0 }
            }
        ],
        seq: [{ __b64: PRETRAINED.dog252 }],
        expect: { "annotations.mode": "heatmap", "annotations.fieldWidth": 252, "annotations.fieldHeight": 252 }
    });
}

// ============================================================================
// TAB: pretrained YOLOv8-pose -> keypoints (real model)
// ============================================================================
if (PRETRAINED && PRETRAINED.person640 && POSE_OK) {
    const z = makeTab(
        "🌍 pretrained: Pose → keypoints",
        "A real pretrained YOLOv8-pose model finds 17 body keypoints on a real photo of a person; drawn as a skeleton."
    );
    comment(
        z,
        "image-preprocess (640) → yolov8n-pose.onnx → decode → vision-annotator (keypoints)",
        "Decodes the [1,56,8400] pose output to the top person's 17 keypoints. View: GET /preview?test=Pose",
        40
    );
    const decodePose =
        "const f = msg.prediction; const A = 8400;\n" +
        "let best = -1, bc = -1;\n" +
        "for (let a = 0; a < A; a++) { const c = f[4*A+a]; if (c > bc) { bc = c; best = a; } }\n" +
        "const kp = [];\n" +
        "for (let k = 0; k < 17; k++) { kp.push(f[(5+k*3)*A+best], f[(6+k*3)*A+best], f[(7+k*3)*A+best]); }\n" +
        "msg.prediction = kp; if (!msg.mlInference) msg.mlInference = {}; msg.mlInference.outputShape = [1,17,3];\n" +
        "return msg;";
    makeChain({
        z,
        y: 120,
        name: "pretrained: Pose keypoints",
        pngStash: true,
        stages: [
            {
                type: "image-preprocess",
                config: {
                    targetWidth: 640,
                    targetHeight: 640,
                    normalize: "0-1",
                    layout: "nchw",
                    channelOrder: "rgb",
                    keepImage: true
                }
            },
            {
                type: "ml-inference",
                config: {
                    modelSource: "local",
                    modelPath: "/data/models/yolov8n-pose.onnx",
                    modelType: "onnx",
                    inputProperty: "payload",
                    outputProperty: "prediction",
                    preprocessMode: "array",
                    inputShape: "[1,3,640,640]",
                    warmup: false
                }
            },
            { type: "function", config: { func: decodePose, outputs: 1 } },
            {
                type: "vision-annotator",
                config: {
                    mode: "keypoints",
                    imageProperty: "image",
                    kpThreshold: 0.5,
                    pointRadius: 4,
                    boxThickness: 2,
                    skeleton: COCO_SKELETON
                }
            }
        ],
        seq: [{ __b64: PRETRAINED.person640 }],
        expect: {
            "annotations.mode": "keypoints",
            "annotations.keypointCount": 17,
            "annotations.visibleCount": { min: 5, max: 17 }
        }
    });
}

// ============================================================================
// TABs: derived annotations from the real defect-segmentation model
//   (in practice you turn a model's mask into boxes / contours / instances /
//    anomaly regions — these examples do exactly that on a real model output)
// ============================================================================
if (SAMPLES && DEFECT_OK) {
    const defectPng = pngFromRGB(SAMPLES.width, SAMPLES.height, SAMPLES.defect);
    const segStages = (deriveFunc, vaConfig) => [
        {
            type: "image-preprocess",
            config: {
                targetWidth: SAMPLES.width,
                targetHeight: SAMPLES.height,
                normalize: "0-1",
                layout: "nchw",
                channelOrder: "rgb",
                keepImage: false
            }
        },
        {
            type: "ml-inference",
            config: {
                modelSource: "local",
                modelPath: "/data/models/defect_seg.onnx",
                modelType: "onnx",
                inputProperty: "payload",
                outputProperty: "prediction",
                preprocessMode: "array",
                inputShape: "[1,3," + SAMPLES.height + "," + SAMPLES.width + "]",
                warmup: false
            }
        },
        { type: "function", config: { func: deriveFunc, outputs: 1 } },
        { type: "vision-annotator", config: vaConfig }
    ];
    // common header: get the [1,2,H,W] seg logits
    const HDR =
        "const f = msg.prediction; const s = msg.mlInference.outputShape; const H = s[2], W = s[3]; const fg = (x,y)=>f[H*W+y*W+x] > f[y*W+x];\n";

    // anomaly: feed the class-1 logit field, threshold at 0
    {
        const z = makeTab(
            "🔬 derived: anomaly (from seg)",
            "The defect model's class-1 score field rendered as an anomaly heatmap with thresholded regions."
        );
        comment(z, "defect_seg.onnx → class-1 score field → vision-annotator (anomaly)", "", 40);
        const dv =
            "const f=msg.prediction; const s=msg.mlInference.outputShape; const H=s[2],W=s[3]; msg.prediction=f.slice(H*W,2*H*W); msg.mlInference.outputShape=[1,1,H,W]; return msg;";
        makeChain({
            z,
            y: 120,
            name: "derived: anomaly from seg",
            pngStash: true,
            stages: segStages(dv, {
                mode: "anomaly",
                colormap: "jet",
                canvasWidth: 256,
                canvasHeight: 256,
                alpha: 0.85,
                threshold: 0
            }),
            seq: [{ __b64: defectPng }],
            expect: { "annotations.mode": "anomaly", "annotations.regionCount": { min: 1, max: 5 } }
        });
    }
    // instances: argmax -> single binary instance mask
    {
        const z = makeTab(
            "🔬 derived: instances (from seg)",
            "The defect mask as one instance (colour + bbox + area) via instance-segmentation rendering."
        );
        comment(z, "defect_seg.onnx → argmax mask → vision-annotator (instances)", "", 40);
        const dv =
            HDR +
            "const bin=new Array(H*W); for(let y=0;y<H;y++)for(let x=0;x<W;x++)bin[y*W+x]=fg(x,y)?1:0; msg.prediction=bin; msg.mlInference.outputShape=[1,1,H,W]; return msg;";
        makeChain({
            z,
            y: 120,
            name: "derived: instances from seg",
            pngStash: true,
            stages: segStages(dv, {
                mode: "instances",
                canvasWidth: 256,
                canvasHeight: 256,
                alpha: 0.6,
                boxThickness: 2
            }),
            seq: [{ __b64: defectPng }],
            expect: {
                "annotations.mode": "instances",
                "annotations.count": 1,
                "annotations.instances.0.area": { min: 30, max: 600 }
            }
        });
    }
    // polygons: convex hull of the mask
    {
        const z = makeTab(
            "🔬 derived: polygons (from seg)",
            "The defect mask outlined as a polygon (convex hull) — area + perimeter measured."
        );
        comment(z, "defect_seg.onnx → convex hull → vision-annotator (polygons)", "", 40);
        const dv =
            HDR +
            "const pts=[]; for(let y=0;y<H;y++)for(let x=0;x<W;x++) if(fg(x,y)) pts.push([x,y]);\n" +
            "pts.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);\n" +
            "const cr=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);\n" +
            "const lo=[],up=[];\n" +
            "for(const p of pts){while(lo.length>=2&&cr(lo[lo.length-2],lo[lo.length-1],p)<=0)lo.pop();lo.push(p);}\n" +
            "for(let i=pts.length-1;i>=0;i--){const p=pts[i];while(up.length>=2&&cr(up[up.length-2],up[up.length-1],p)<=0)up.pop();up.push(p);}\n" +
            "const hull=lo.slice(0,-1).concat(up.slice(0,-1)); const sc=8; const fp=[]; for(const p of hull) fp.push(p[0]*sc,p[1]*sc);\n" +
            "msg.prediction=fp; msg.mlInference.outputShape=[1,1,hull.length,2]; return msg;";
        makeChain({
            z,
            y: 120,
            name: "derived: polygons from seg",
            pngStash: true,
            stages: segStages(dv, { mode: "polygons", canvasWidth: 256, canvasHeight: 256, boxThickness: 2 }),
            seq: [{ __b64: defectPng }],
            expect: {
                "annotations.mode": "polygons",
                "annotations.count": 1,
                "annotations.polygons.0.area": { min: 100 }
            }
        });
    }
    // obb: PCA-oriented bounding box of the mask
    {
        const z = makeTab(
            "🔬 derived: oriented box (from seg)",
            "A PCA-fitted oriented bounding box around the defect region."
        );
        comment(z, "defect_seg.onnx → PCA oriented box → vision-annotator (obb)", "", 40);
        const dv =
            HDR +
            "let n=0,sx=0,sy=0; const px=[]; for(let y=0;y<H;y++)for(let x=0;x<W;x++) if(fg(x,y)){px.push(x,y);sx+=x;sy+=y;n++;}\n" +
            "const mx=sx/n,my=sy/n; let cxx=0,cyy=0,cxy=0;\n" +
            "for(let i=0;i<n;i++){const dx=px[2*i]-mx,dy=px[2*i+1]-my;cxx+=dx*dx;cyy+=dy*dy;cxy+=dx*dy;}\n" +
            "cxx/=n;cyy/=n;cxy/=n; const tr=cxx+cyy,det=cxx*cyy-cxy*cxy; const l1=tr/2+Math.sqrt(Math.max(0,tr*tr/4-det));\n" +
            "const ang=Math.abs(cxy)>1e-6?Math.atan2(l1-cxx,cxy):0; const ca=Math.cos(ang),sa=Math.sin(ang);\n" +
            "let mnu=1e9,mxu=-1e9,mnv=1e9,mxv=-1e9; for(let i=0;i<n;i++){const dx=px[2*i]-mx,dy=px[2*i+1]-my;const u=dx*ca+dy*sa,v=-dx*sa+dy*ca; if(u<mnu)mnu=u;if(u>mxu)mxu=u;if(v<mnv)mnv=v;if(v>mxv)mxv=v;}\n" +
            "const sc=8; msg.prediction=[mx*sc,my*sc,(mxu-mnu)*sc,(mxv-mnv)*sc,ang,0.9,0]; msg.mlInference.outputShape=[1,1,7]; return msg;";
        makeChain({
            z,
            y: 120,
            name: "derived: oriented box from seg",
            pngStash: true,
            stages: segStages(dv, {
                mode: "obb",
                canvasWidth: 256,
                canvasHeight: 256,
                boxThickness: 2,
                classLabels: "defect"
            }),
            seq: [{ __b64: defectPng }],
            expect: { "annotations.mode": "obb", "annotations.count": 1 }
        });
    }
}

// ============================================================================
// TAB: image-source -> full vision pipeline (live synthetic defect images)
// ============================================================================
if (DEFECT_OK) {
    const z = makeTab(
        "🖼️ image-source → vision pipeline",
        "The image-source generates a synthetic defect image; the trained model segments it — a live vision data source driving the whole chain (no embedded image)."
    );
    comment(
        z,
        "image-source (spot defect) → image-preprocess → defect_seg.onnx → vision-annotator (segmentation)",
        "Vision counterpart of condition-monitoring-source. View: GET /preview?test=image-source",
        40
    );
    const VAL =
        "if (msg.annotations === undefined || msg.annotations.mode !== 'segmentation') { return null; }\n" +
        "const n = (msg.annotations.maskClassCounts && msg.annotations.maskClassCounts['1']) || 0;\n" +
        "const pass = n > 3;\n" +
        "const test = 'image-source → defect model → segmentation (live)';\n" +
        "node.status({ fill: pass ? 'green' : 'red', shape: 'dot', text: (pass ? 'PASS ' : 'FAIL ') + test });\n" +
        "return { payload: { test: test, pass: pass, fails: pass ? [] : ['defect px=' + n], actual: { defectPixels: n } }, _result: true };";
    makeChain({
        z,
        y: 120,
        name: "image-source → vision",
        pngStash: true,
        validatorFn: VAL,
        stages: [
            {
                type: "image-source",
                config: {
                    width: 64,
                    height: 64,
                    defect: "spot",
                    severity: 0.8,
                    noise: 0.12,
                    seed: 1,
                    autoStart: false,
                    emitMask: false
                }
            },
            {
                type: "image-preprocess",
                config: {
                    targetWidth: 32,
                    targetHeight: 32,
                    normalize: "0-1",
                    layout: "nchw",
                    channelOrder: "rgb",
                    keepImage: true
                }
            },
            {
                type: "ml-inference",
                config: {
                    modelSource: "local",
                    modelPath: "/data/models/defect_seg.onnx",
                    modelType: "onnx",
                    inputProperty: "payload",
                    outputProperty: "prediction",
                    preprocessMode: "array",
                    inputShape: "[1,3,32,32]",
                    warmup: false
                }
            },
            {
                type: "vision-annotator",
                config: { mode: "segmentation", imageProperty: "image", alpha: 0.55, canvasWidth: 64, canvasHeight: 64 }
            }
        ],
        seq: ["tick"]
    });
}

// ============================================================================
// TAB: json-source -> multi-value-processor (simulated JSON records)
// ============================================================================
{
    const z = makeTab(
        "🧾 json-source → multi-value",
        "The json-source simulates JSON sensor records; multi-value-processor aggregates them. Proves arbitrary JSON data can be simulated for the object/record nodes."
    );
    comment(
        z,
        "json-source (3 numeric + 1 string field) → multi-value-processor (aggregate mean)",
        "Generic JSON simulator for object/record nodes (health-index, pca, multi-value, training-collector, llm record).",
        40
    );
    const VAL =
        "if (!msg.aggregation) { return null; }\n" +
        "const c = msg.aggregation.count;\n" +
        "const pass = (c === 3 && typeof msg.aggregation.value === 'number');\n" +
        "const test = 'json-source → multi-value aggregate (3 numeric fields)';\n" +
        "node.status({ fill: pass ? 'green' : 'red', shape: 'dot', text: (pass ? 'PASS ' : 'FAIL ') + test });\n" +
        "return { payload: { test: test, pass: pass, fails: pass ? [] : ['count=' + c], actual: { count: c, mean: msg.aggregation.value } }, _result: true };";
    makeChain({
        z,
        y: 120,
        name: "json-source → multi-value",
        validatorFn: VAL,
        stages: [
            {
                type: "json-source",
                config: {
                    fields: '{"temperature":{"mean":60,"noise":2},"pressure":{"mean":4.5,"noise":0.15},"vibration":{"mean":2,"noise":0.3},"asset":"pump-01"}',
                    seed: 7,
                    autoStart: false
                }
            },
            {
                type: "multi-value-processor",
                config: { mode: "aggregate", aggregateMethod: "mean", aggregateOutput: "all" }
            }
        ],
        seq: ["tick"]
    });
}

// ============================================================================
// TAB: realistic source waveform -> signal-analyzer (FFT finds the fault freq)
// ============================================================================
{
    const z = makeTab(
        "🏭 source waveform → signal-analyzer",
        "The condition-monitoring-source emits a real vibration time-signal (imbalance fault); signal-analyzer's FFT recovers the fault frequency at the shaft speed (rpm 1500 → 25 Hz)."
    );
    comment(
        z,
        "condition-monitoring-source (waveform, imbalance) → signal-analyzer (FFT) → dominant freq ≈ 25 Hz",
        "Proves the simulator drives spectral analysis, not just the trend nodes.",
        40
    );
    const VAL =
        "if (msg.dominantFrequency === undefined) { return null; }\n" +
        "const f = msg.dominantFrequency;\n" +
        "const pass = (typeof f === 'number' && Math.abs(f - 25) <= 2);\n" +
        "const test = 'source waveform → signal-analyzer FFT (imbalance @ shaft 25Hz)';\n" +
        "node.status({ fill: pass ? 'green' : 'red', shape: 'dot', text: (pass ? 'PASS ' : 'FAIL ') + test });\n" +
        "return { payload: { test: test, pass: pass, fails: pass ? [] : ['dominantFrequency=' + f + ' want ~25'], actual: { dominantFrequency: f } }, _result: true };";
    makeChain({
        z,
        y: 120,
        name: "source waveform → FFT",
        lastOutputs: 2,
        validatorFn: VAL,
        stages: [
            {
                type: "condition-monitoring-source",
                config: {
                    assetType: "pump",
                    rpm: 1500,
                    load: 70,
                    noise: 0.3,
                    faultImbalance: 0.8,
                    autoStart: false,
                    outputFormat: "waveform",
                    sampleRate: 2560,
                    frameSize: 2048,
                    seed: 42
                }
            },
            {
                type: "signal-analyzer",
                config: {
                    mode: "fft",
                    fftSize: 2048,
                    samplingRate: 2560,
                    windowFunction: "hann",
                    outputFormat: "peaks",
                    peakThreshold: 0.1
                }
            }
        ],
        seq: ["tick"]
    });
}

// ============================================================================
// TAB: bundled pretrained CM model — vibration fault classifier (catalog)
// ============================================================================
{
    const z = makeTab(
        "🎛️ pretrained: bearing-fault classifier",
        "Bundled vibration fault classifier (model-catalog 'bearing-fault-clf'); 5 order-features → fault class."
    );
    comment(
        z,
        "feature vector [rms, 1×, 2×, 3.5×, 0.5×] → ml-inference (bundled bearing_fault_clf.onnx) → argmax class",
        "Proves a bundled catalog model loads (package models dir is allowlisted). Bearing features → class 3.",
        40
    );
    const VAL =
        "if (msg.prediction === undefined) { return null; }\n" +
        "const p = Array.isArray(msg.prediction) ? msg.prediction : [];\n" +
        "let arg = 0; for (let i = 1; i < p.length; i++) if (p[i] > p[arg]) arg = i;\n" +
        "const labels = ['healthy','imbalance','misalignment','bearing','looseness'];\n" +
        "const pass = (arg === 3);\n" +
        "const test = 'bundled bearing-fault classifier (bearing features → class 3)';\n" +
        "node.status({ fill: pass ? 'green' : 'red', shape: 'dot', text: (pass ? 'PASS ' : 'FAIL ') + test });\n" +
        "return { payload: { test: test, pass: pass, fails: pass ? [] : ['argmax=' + arg], actual: { predictedClass: labels[arg], argmax: arg } }, _result: true };";
    makeChain({
        z,
        y: 120,
        name: "bundled bearing classifier",
        validatorFn: VAL,
        stages: [
            {
                type: "ml-inference",
                config: {
                    modelSource: "local",
                    modelPath:
                        "/data/node_modules/node-red-contrib-condition-monitoring/nodes/models/bearing_fault_clf.onnx",
                    modelType: "onnx",
                    inputProperty: "payload",
                    outputProperty: "prediction",
                    preprocessMode: "array",
                    inputShape: "[1,5]",
                    warmup: false
                }
            }
        ],
        seq: [[0.85, 0.1, 0.1, 0.95, 0.1]] // strong 3.5× (BPFO) → bearing fault
    });
}

// ============================================================================
// TAB: Test Runner (GET /test -> JSON summary)
// ============================================================================
{
    const z = makeTab(
        "✅ 00 Test Runner",
        "GET /test broadcasts a trigger to every test and returns a pass/fail summary. GET /errors returns errors caught during the last run."
    );
    contentTabIds.pop(); // the runner tab itself is not a content tab
    comment(
        z,
        "Run all tests:  curl http://localhost:1890/test   |   Errors:  curl http://localhost:1890/errors",
        "Broadcasts to every generator, collects validator verdicts + caught errors, replies with JSON after a 3s settle.",
        40
    );

    const httpInId = nid("hin"),
        startId = nid("start"),
        trigOutId = nid("tout"),
        delayId = nid("dly"),
        respId = nid("resp"),
        httpRespId = nid("hresp"),
        accId = nid("acc"),
        sumDbgId = nid("sdbg");
    resultsLinkInId = nid("rin");

    const EXPECTED_TOTAL = resultLinkOutIds.length;

    add({
        id: httpInId,
        type: "http in",
        z,
        name: "GET /test",
        url: "/test",
        method: "get",
        upload: false,
        swaggerDoc: "",
        x: 130,
        y: 120,
        wires: [[startId]]
    });

    add({
        id: startId,
        type: "function",
        z,
        name: "start run",
        outputs: 1,
        func: "flow.set('results', {});\nflow.set('errors', []);\nreturn msg;",
        x: 320,
        y: 120,
        wires: [[trigOutId, delayId]]
    });

    add({
        id: trigOutId,
        type: "link out",
        z,
        name: "broadcast trigger",
        mode: "link",
        links: triggerLinkInIds.slice(),
        x: 540,
        y: 80,
        wires: []
    });

    add({
        id: delayId,
        type: "delay",
        z,
        name: "settle 12s",
        pauseType: "delay",
        timeout: "12",
        timeoutUnits: "seconds",
        x: 520,
        y: 160,
        wires: [[respId]]
    });

    add({
        id: respId,
        type: "function",
        z,
        name: "build summary",
        outputs: 1,
        func:
            "const res = flow.get('results') || {};\n" +
            "const tests = Object.keys(res).map(k => res[k]);\n" +
            "const passed = tests.filter(t => t.pass).length;\n" +
            "const failed = tests.filter(t => !t.pass);\n" +
            "const EXPECTED = " +
            EXPECTED_TOTAL +
            ";\n" +
            "const complete = tests.length === EXPECTED;\n" +
            "msg.statusCode = (failed.length === 0 && complete) ? 200 : 500;\n" +
            "msg.headers = { 'content-type': 'application/json' };\n" +
            "const errors = flow.get('errors') || [];\n" +
            "msg.statusCode = (failed.length === 0 && complete && errors.length === 0) ? 200 : 500;\n" +
            "msg.payload = {\n" +
            "  ok: failed.length === 0 && complete && errors.length === 0,\n" +
            "  expected: EXPECTED, reported: tests.length, passed: passed, failed: failed.length,\n" +
            "  errorCount: errors.length,\n" +
            "  missing: complete ? [] : ['some tests did not report (' + tests.length + '/' + EXPECTED + ')'],\n" +
            "  failures: failed.map(t => ({ test: t.test, fails: t.fails })),\n" +
            "  errors: errors,\n" +
            "  results: tests.map(t => ({ test: t.test, pass: t.pass, actual: t.actual })).sort((a,b)=>a.test<b.test?-1:1)\n" +
            "};\n" +
            "return msg;",
        x: 700,
        y: 160,
        wires: [[httpRespId, sumDbgId]]
    });

    add({ id: httpRespId, type: "http response", z, name: "", statusCode: "", headers: {}, x: 920, y: 120, wires: [] });
    add({
        id: sumDbgId,
        type: "debug",
        z,
        name: "summary",
        active: true,
        complete: "payload",
        targetType: "msg",
        x: 910,
        y: 200,
        wires: []
    });

    // collector
    add({
        id: resultsLinkInId,
        type: "link in",
        z,
        name: "results",
        links: resultLinkOutIds.slice(),
        x: 320,
        y: 260,
        wires: [[accId]]
    });
    add({
        id: accId,
        type: "function",
        z,
        name: "accumulate",
        outputs: 0,
        func:
            "const r = msg.payload;\n" +
            "if (!r || !r.test) return null;\n" +
            "const cur = flow.get('results') || {};\n" +
            "cur[r.test] = r;\n" +
            "flow.set('results', cur);\n" +
            "return null;",
        x: 520,
        y: 260,
        wires: []
    });

    // ---- error capture --------------------------------------------------
    const errInId = nid("errin"),
        errAccId = nid("eacc");
    add({ id: errInId, type: "link in", z, name: "errors", links: [], x: 320, y: 330, wires: [[errAccId]] });
    add({
        id: errAccId,
        type: "function",
        z,
        name: "collect errors",
        outputs: 0,
        func:
            "const e = msg.error || {};\n" +
            "const src = e.source || {};\n" +
            "const arr = flow.get('errors') || [];\n" +
            "arr.push({ node: src.name || src.id, type: src.type, message: e.message });\n" +
            "flow.set('errors', arr);\n" +
            "return null;",
        x: 520,
        y: 330,
        wires: []
    });

    // GET /errors -> last run's caught errors
    const eHttpIn = nid("ehin"),
        eFn = nid("efn"),
        eResp = nid("eresp");
    add({
        id: eHttpIn,
        type: "http in",
        z,
        name: "GET /errors",
        url: "/errors",
        method: "get",
        upload: false,
        swaggerDoc: "",
        x: 130,
        y: 410,
        wires: [[eFn]]
    });
    add({
        id: eFn,
        type: "function",
        z,
        name: "errors json",
        outputs: 1,
        func: "const errors = flow.get('errors') || [];\nmsg.headers = { 'content-type': 'application/json' };\nmsg.payload = { count: errors.length, errors: errors };\nreturn msg;",
        x: 330,
        y: 410,
        wires: [[eResp]]
    });
    add({ id: eResp, type: "http response", z, name: "", statusCode: "", headers: {}, x: 520, y: 410, wires: [] });

    // one catch node per content tab, routed to the error collector
    for (const tabId of contentTabIds) {
        const catchId = nid("catch"),
            loutId = nid("elout");
        add({
            id: catchId,
            type: "catch",
            z: tabId,
            name: "catch",
            scope: null,
            uncaught: false,
            x: 140,
            y: 540,
            wires: [[loutId]]
        });
        add({
            id: loutId,
            type: "link out",
            z: tabId,
            name: "errors",
            mode: "link",
            links: [errInId],
            x: 320,
            y: 540,
            wires: []
        });
        errorLinkOutIds.push(loutId);
    }
    // errors link-in lists every tab's error link-out as a source
    nodes.find((x) => x.id === errInId).links = errorLinkOutIds.slice();

    // ---- image preview (vision-annotator PNGs) --------------------------
    const pngInId = nid("pngin"),
        pngStashId = nid("pstash");
    add({
        id: pngInId,
        type: "link in",
        z,
        name: "png",
        links: pngLinkOutIds.slice(),
        x: 320,
        y: 480,
        wires: [[pngStashId]]
    });
    add({
        id: pngStashId,
        type: "function",
        z,
        name: "stash png",
        outputs: 0,
        func:
            "if (msg.test && Buffer.isBuffer(msg.payload)) {\n" +
            "  const m = global.get('previews') || {};\n" +
            "  m[msg.test] = msg.payload.toString('base64');\n" +
            "  global.set('previews', m);\n" +
            "}\nreturn null;",
        x: 520,
        y: 480,
        wires: []
    });
    // wire each vision tab's png link-out to this link-in
    for (const loutId of pngLinkOutIds) {
        nodes.find((x) => x.id === loutId).links = [pngInId];
    }

    // GET /preview?test=<name>  -> the annotated PNG
    const pHttpIn = nid("phin"),
        pFn = nid("pfn"),
        pResp = nid("presp");
    add({
        id: pHttpIn,
        type: "http in",
        z,
        name: "GET /preview",
        url: "/preview",
        method: "get",
        upload: false,
        swaggerDoc: "",
        x: 130,
        y: 560,
        wires: [[pFn]]
    });
    add({
        id: pFn,
        type: "function",
        z,
        name: "serve png",
        outputs: 1,
        func:
            "const m = global.get('previews') || {};\n" +
            "const want = (msg.req && msg.req.query && msg.req.query.test) || '';\n" +
            "const keys = Object.keys(m);\n" +
            "const key = m[want] ? want : keys.find(k => k.indexOf(want) >= 0);\n" +
            "if (!key) { msg.statusCode = 404; msg.headers = { 'content-type': 'application/json' }; msg.payload = { error: 'no preview', available: keys }; return msg; }\n" +
            "msg.statusCode = 200; msg.headers = { 'content-type': 'image/png' };\n" +
            "msg.payload = Buffer.from(m[key], 'base64');\n" +
            "return msg;",
        x: 320,
        y: 560,
        wires: [[pResp]]
    });
    add({ id: pResp, type: "http response", z, name: "", statusCode: "", headers: {}, x: 520, y: 560, wires: [] });

    // GET /gallery -> an HTML page showing every annotated image
    const gHttpIn = nid("ghin"),
        gFn = nid("gfn"),
        gResp = nid("gresp");
    add({
        id: gHttpIn,
        type: "http in",
        z,
        name: "GET /gallery",
        url: "/gallery",
        method: "get",
        upload: false,
        swaggerDoc: "",
        x: 130,
        y: 620,
        wires: [[gFn]]
    });
    add({
        id: gFn,
        type: "function",
        z,
        name: "gallery html",
        outputs: 1,
        func:
            "const m = global.get('previews') || {};\n" +
            "const keys = Object.keys(m).sort();\n" +
            "let cards = keys.map(k => `<figure><img src=\"/preview?test=${encodeURIComponent(k)}\"><figcaption>${k}</figcaption></figure>`).join('');\n" +
            "if (!keys.length) cards = '<p>No previews yet — run <a href=\"/test\">/test</a> first.</p>';\n" +
            "msg.headers = { 'content-type': 'text/html; charset=utf-8' };\n" +
            "msg.payload = `<!doctype html><html><head><meta charset=utf-8><title>Vision previews</title>` +\n" +
            "  `<style>body{background:#1e2127;color:#eee;font-family:sans-serif;margin:16px} h1{font-size:18px} ` +\n" +
            "  `.grid{display:flex;flex-wrap:wrap;gap:14px} figure{margin:0;background:#2b2f37;padding:8px;border-radius:8px} ` +\n" +
            "  `img{image-rendering:pixelated;width:200px;height:200px;object-fit:contain;background:#000;border-radius:4px} ` +\n" +
            "  `figcaption{font-size:12px;margin-top:6px;max-width:200px;color:#bbb}</style></head>` +\n" +
            '  `<body><h1>🖼️ Annotated previews (${keys.length})</h1><p><a style=color:#8ad href="/test">re-run /test</a></p>` +\n' +
            "  `<div class=grid>${cards}</div></body></html>`;\n" +
            "return msg;",
        x: 320,
        y: 620,
        wires: [[gResp]]
    });
    add({ id: gResp, type: "http response", z, name: "", statusCode: "", headers: {}, x: 520, y: 620, wires: [] });

    // wire link nodes: each generator trigger link-in points back to the broadcast link-out
    for (const linId of triggerLinkInIds) {
        const n = nodes.find((x) => x.id === linId);
        n.links = [trigOutId];
    }
    // each result link-out points to the results link-in
    for (const loutId of resultLinkOutIds) {
        const n = nodes.find((x) => x.id === loutId);
        n.links = [resultsLinkInId];
    }
}

// ---- write ------------------------------------------------------------------

const outPath = path.join(__dirname, "..", "examples", "test-suite.json");
fs.writeFileSync(outPath, JSON.stringify(nodes, null, 2) + "\n");
const tabs = nodes.filter((n) => n.type === "tab").length;
const tests = resultLinkOutIds.length;
console.log(`Wrote ${outPath}`);
console.log(`Tabs: ${tabs} | Auto-validated tests: ${tests} | Total nodes: ${nodes.length}`);
