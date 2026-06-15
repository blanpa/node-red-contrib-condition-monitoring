/**
 * image-source (CM Image Source)
 *
 * A synthetic image data source for the vision pipeline — the visual counterpart
 * of condition-monitoring-source. It generates inspection-style images of a
 * surface with optional defects (bright pit/corrosion spot, dark scratch/crack)
 * so image-preprocess → ml-inference → vision-annotator can be driven live and
 * the trained defect model can be exercised. Pure-JS (pngjs), deterministic via
 * an optional seed, with a ground-truth mask + defect list for validation.
 *
 * Output:
 *   msg.payload   PNG Buffer of the generated image
 *   msg.mask      PNG Buffer of the ground-truth defect mask (white = defect)
 *   msg.defects   [{ type, x, y, r|len, severity }]
 *   msg.severity  current defect severity (0..1)
 *   msg.topic
 *
 * Control:  msg.payload/msg.command "start"|"stop"|"reset"  · msg.config {...}
 */

module.exports = function (RED) {
    "use strict";

    let PNG = null;
    try {
        PNG = require("pngjs").PNG;
    } catch (e) {
        PNG = null;
    }

    function mulberry32(a) {
        return function () {
            a |= 0;
            a = (a + 0x6d2b79f5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    const clampInt = (v, lo, hi, d) => {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
    };
    const clampFloat = (v, lo, hi, d) => {
        const n = parseFloat(v);
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
    };
    const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

    function ImageSourceNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.width = clampInt(config.width, 8, 4096, 64);
        node.height = clampInt(config.height, 8, 4096, 64);
        node.defect = config.defect || "spot"; // none | spot | scratch | multi
        node.severity = clampFloat(config.severity, 0, 1, 0.7);
        node.noise = clampFloat(config.noise, 0, 1, 0.12);
        node.degrade = config.degrade === true; // grow the defect over time
        node.degStep = clampFloat(config.degStep, 0, 1, 0.03);
        node.intervalMs = clampInt(config.intervalMs, 50, 86400000, 1000);
        node.autoStart = config.autoStart === true;
        node.emitMask = config.emitMask !== false && config.emitMask !== "false";
        node.outputTopic = config.outputTopic || "";
        const seed = parseInt(config.seed, 10);
        node.seedBase = Number.isFinite(seed) ? seed : null;

        node.sampleCount = 0;
        node.curSeverity = node.severity;
        node.timer = null;
        node.running = false;

        function rngFor() {
            return node.seedBase !== null ? mulberry32(node.seedBase + node.sampleCount) : Math.random;
        }

        // Generate one image + ground-truth mask at the given severity.
        function generate(sev) {
            const W = node.width,
                H = node.height;
            const rng = rngFor();
            const rgba = new Uint8Array(W * H * 4);
            const mask = new Uint8Array(W * H);
            // textured background: random base colour per channel + per-pixel noise
            const base = [0.1 + rng() * 0.25, 0.1 + rng() * 0.25, 0.1 + rng() * 0.25];
            for (let i = 0; i < W * H; i++) {
                for (let c = 0; c < 3; c++) {
                    const v = clamp01(base[c] + (rng() - 0.5) * 2 * node.noise);
                    rgba[i * 4 + c] = Math.round(v * 255);
                }
                rgba[i * 4 + 3] = 255;
            }
            const defects = [];
            const setPx = (x, y, col) => {
                if (x < 0 || y < 0 || x >= W || y >= H) return;
                const i = (y * W + x) * 4;
                for (let c = 0; c < 3; c++)
                    rgba[i + c] = Math.round(clamp01(col[c] + (rng() - 0.5) * 2 * node.noise) * 255);
                mask[y * W + x] = 1;
            };
            const wantSpot = (node.defect === "spot" || node.defect === "multi") && sev > 0;
            const wantScratch = (node.defect === "scratch" || node.defect === "multi") && sev > 0;

            if (wantSpot) {
                const count = node.defect === "multi" ? 1 + Math.floor(rng() * 2) : 1;
                for (let k = 0; k < count; k++) {
                    const r = Math.max(1, Math.round((0.06 + 0.14 * sev) * Math.min(W, H)));
                    const cx = r + Math.floor(rng() * Math.max(1, W - 2 * r));
                    const cy = r + Math.floor(rng() * Math.max(1, H - 2 * r));
                    const bright = [0.75 + rng() * 0.25, 0.75 + rng() * 0.25, 0.75 + rng() * 0.25];
                    for (let y = cy - r; y <= cy + r; y++) {
                        for (let x = cx - r; x <= cx + r; x++) {
                            if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) setPx(x, y, bright);
                        }
                    }
                    defects.push({ type: "spot", x: cx, y: cy, r: r, severity: +sev.toFixed(3) });
                }
            }
            if (wantScratch) {
                const len = Math.round((0.3 + 0.5 * sev) * W);
                const x0 = Math.floor(rng() * (W - len));
                const y0 = Math.floor(rng() * H);
                const slope = (rng() - 0.5) * 1.2;
                const dark = [0.02, 0.02, 0.02];
                for (let d = 0; d < len; d++) {
                    const x = x0 + d,
                        y = Math.round(y0 + slope * d);
                    setPx(x, y, dark);
                    setPx(x, y + 1, dark);
                }
                defects.push({ type: "scratch", x: x0, y: y0, len: len, severity: +sev.toFixed(3) });
            }
            return { rgba, mask, defects, width: W, height: H };
        }

        function maskToPng(mask, W, H) {
            const png = new PNG({ width: W, height: H });
            for (let i = 0; i < W * H; i++) {
                const v = mask[i] ? 255 : 0;
                png.data[i * 4] = v;
                png.data[i * 4 + 1] = v;
                png.data[i * 4 + 2] = v;
                png.data[i * 4 + 3] = 255;
            }
            return PNG.sync.write(png);
        }

        function emit(send) {
            if (!PNG) {
                node.error("pngjs not available. Install: npm install pngjs");
                return;
            }
            node.sampleCount++;
            if (node.degrade && node.defect !== "none") node.curSeverity = clamp01(node.curSeverity + node.degStep);
            const sev = node.curSeverity;
            const g = generate(sev);
            const png = new PNG({ width: g.width, height: g.height });
            png.data = Buffer.from(g.rgba.buffer, g.rgba.byteOffset, g.rgba.byteLength);
            const msg = {
                topic: node.outputTopic || "image-source",
                payload: PNG.sync.write(png),
                contentType: "image/png",
                defects: g.defects,
                defectCount: g.defects.length,
                severity: +sev.toFixed(3),
                width: g.width,
                height: g.height,
                sampleCount: node.sampleCount
            };
            if (node.emitMask) msg.mask = maskToPng(g.mask, g.width, g.height);
            send(msg);
            node.status({
                fill: g.defects.length ? "yellow" : "green",
                shape: node.running ? "dot" : "ring",
                text:
                    (g.defects.length ? g.defects.length + " defect" : "clean") +
                    " · sev " +
                    sev.toFixed(2) +
                    " · #" +
                    node.sampleCount
            });
        }

        function start() {
            if (node.timer) return;
            node.running = true;
            node.timer = setInterval(() => emit((m) => node.send(m)), node.intervalMs);
        }
        function stop() {
            node.running = false;
            if (node.timer) {
                clearInterval(node.timer);
                node.timer = null;
            }
        }
        function reset() {
            node.sampleCount = 0;
            node.curSeverity = node.severity;
        }

        node.on("input", function (msg, send, done) {
            send = send || ((m) => node.send(m));
            const cmd = (
                typeof msg.payload === "string" ? msg.payload : typeof msg.command === "string" ? msg.command : ""
            ).toLowerCase();
            if (msg.config && typeof msg.config === "object") {
                if (msg.config.severity !== undefined)
                    node.curSeverity = clampFloat(msg.config.severity, 0, 1, node.curSeverity);
                if (msg.config.defect !== undefined) node.defect = msg.config.defect;
                if (msg.config.noise !== undefined) node.noise = clampFloat(msg.config.noise, 0, 1, node.noise);
            }
            if (cmd === "stop" || msg.stop === true) {
                stop();
                if (done) done();
                return;
            }
            if (cmd === "reset" || msg.reset === true) {
                reset();
                if (done) done();
                return;
            }
            if (cmd === "start" || msg.start === true) {
                start();
                if (done) done();
                return;
            }
            emit(send); // any other input emits one image
            if (done) done();
        });

        node.on("close", function (done) {
            stop();
            if (done) done();
        });

        if (node.autoStart) start();
    }

    RED.nodes.registerType("image-source", ImageSourceNode);
};
