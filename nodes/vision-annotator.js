/**
 * vision-annotator
 *
 * Renders an image-model's output as an image. Supported modes:
 *   boxes          axis-aligned bounding boxes (xyxy or yolo + NMS)
 *   obb            oriented / rotated bounding boxes
 *   segmentation   semantic per-pixel class mask overlay (+ area fractions)
 *   instances      instance masks: one colour + bbox + area per object
 *   polygons       polygon / contour outlines (+ area + perimeter)
 *   keypoints      keypoints + skeleton edges (pose)
 *   heatmap        scalar field -> colormap overlay (depth / CAM / density)
 *   anomaly        anomaly score field -> heatmap + threshold regions (+ metrics)
 *   classification whole-image label banner + status dot
 *
 * Output: msg.payload = annotated PNG Buffer, msg.annotations = structured result.
 * Pure-JS (pngjs only) — no native deps.
 */

module.exports = function (RED) {
    "use strict";

    let PNG = null;
    try {
        PNG = require("pngjs").PNG;
    } catch (e) {
        PNG = null;
    }

    // --- 5x7 bitmap font (digits + symbols) for compact labels ---------------
    const FONT = {
        0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
        1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
        2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
        3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
        4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
        5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
        6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
        7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
        8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
        9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
        ".": [0, 0, 0, 0, 0, 0x0c, 0x0c],
        "%": [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03],
        ":": [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0],
        "#": [0x0a, 0x1f, 0x0a, 0x0a, 0x1f, 0x0a, 0x00],
        "-": [0, 0, 0, 0x1f, 0, 0, 0],
        " ": [0, 0, 0, 0, 0, 0, 0]
    };

    const DEFAULT_PALETTE = [
        [0, 0, 0],
        [230, 25, 75],
        [60, 180, 75],
        [0, 130, 200],
        [245, 130, 48],
        [145, 30, 180],
        [70, 240, 240],
        [240, 50, 230],
        [210, 245, 60],
        [250, 190, 212]
    ];

    // --- colormaps -----------------------------------------------------------
    function clamp01(v) {
        return v < 0 ? 0 : v > 1 ? 1 : v;
    }
    function jet(t) {
        t = clamp01(t);
        const r = clamp01(1.5 - Math.abs(4 * t - 3));
        const g = clamp01(1.5 - Math.abs(4 * t - 2));
        const b = clamp01(1.5 - Math.abs(4 * t - 1));
        return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
    }
    function gray(t) {
        const v = Math.round(clamp01(t) * 255);
        return [v, v, v];
    }
    function colormapFn(name) {
        return name === "gray" ? gray : jet;
    }

    // --- tiny RGBA canvas ----------------------------------------------------
    function Canvas(width, height, data) {
        this.width = width;
        this.height = height;
        this.data = data || new Uint8Array(width * height * 4);
    }
    Canvas.prototype.set = function (x, y, r, g, b, a) {
        x = x | 0;
        y = y | 0;
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
        const i = (y * this.width + x) * 4;
        const af = (a === undefined || a === null ? 255 : a) / 255;
        const d = this.data;
        d[i] = Math.round(d[i] * (1 - af) + r * af);
        d[i + 1] = Math.round(d[i + 1] * (1 - af) + g * af);
        d[i + 2] = Math.round(d[i + 2] * (1 - af) + b * af);
        d[i + 3] = Math.max(d[i + 3], a === undefined || a === null ? 255 : a);
    };
    Canvas.prototype.fillRect = function (x1, y1, x2, y2, c, a) {
        for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) this.set(x, y, c[0], c[1], c[2], a);
    };
    Canvas.prototype.strokeRect = function (x1, y1, x2, y2, c, t) {
        t = t || 1;
        for (let k = 0; k < t; k++) {
            for (let x = x1; x <= x2; x++) {
                this.set(x, y1 + k, c[0], c[1], c[2], 255);
                this.set(x, y2 - k, c[0], c[1], c[2], 255);
            }
            for (let y = y1; y <= y2; y++) {
                this.set(x1 + k, y, c[0], c[1], c[2], 255);
                this.set(x2 - k, y, c[0], c[1], c[2], 255);
            }
        }
    };
    Canvas.prototype.line = function (x0, y0, x1, y1, c, t) {
        t = t || 1;
        x0 = Math.round(x0);
        y0 = Math.round(y0);
        x1 = Math.round(x1);
        y1 = Math.round(y1);
        const dx = Math.abs(x1 - x0),
            dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1,
            sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        const r = Math.floor((t - 1) / 2);
        for (;;) {
            for (let oy = -r; oy <= r; oy++)
                for (let ox = -r; ox <= r; ox++) this.set(x0 + ox, y0 + oy, c[0], c[1], c[2], 255);
            if (x0 === x1 && y0 === y1) break;
            const e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                x0 += sx;
            }
            if (e2 < dx) {
                err += dx;
                y0 += sy;
            }
        }
    };
    Canvas.prototype.circle = function (cx, cy, rad, c) {
        for (let y = -rad; y <= rad; y++)
            for (let x = -rad; x <= rad; x++)
                if (x * x + y * y <= rad * rad) this.set(cx + x, cy + y, c[0], c[1], c[2], 255);
    };
    Canvas.prototype.text = function (x, y, str, c, scale) {
        scale = scale || 1;
        let cx = x;
        for (const ch of String(str).toUpperCase()) {
            const glyph = FONT[ch] || FONT[" "];
            for (let row = 0; row < 7; row++)
                for (let col = 0; col < 5; col++)
                    if (glyph[row] & (1 << (4 - col)))
                        this.fillRect(
                            cx + col * scale,
                            y + row * scale,
                            cx + (col + 1) * scale,
                            y + (row + 1) * scale,
                            c,
                            255
                        );
            cx += 6 * scale;
        }
        return cx - x;
    };

    // --- helpers -------------------------------------------------------------
    function deepFlatten(arr, out) {
        out = out || [];
        if (Array.isArray(arr)) {
            for (const v of arr) deepFlatten(v, out);
        } else {
            out.push(arr);
        }
        return out;
    }
    function getProp(msg, path) {
        if (!path) return undefined;
        try {
            return RED.util.getMessageProperty(msg, path);
        } catch (e) {
            return String(path)
                .split(".")
                .reduce((a, k) => (a === undefined || a === null ? undefined : a[k]), msg);
        }
    }
    function iou(a, b) {
        const x1 = Math.max(a[0], b[0]),
            y1 = Math.max(a[1], b[1]);
        const x2 = Math.min(a[2], b[2]),
            y2 = Math.min(a[3], b[3]);
        const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
        const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
        const u = areaA + areaB - inter;
        return u > 0 ? inter / u : 0;
    }
    function nms(boxes, iouThr) {
        const kept = [];
        const sorted = boxes.slice().sort((p, q) => q.score - p.score);
        while (sorted.length) {
            const best = sorted.shift();
            kept.push(best);
            for (let i = sorted.length - 1; i >= 0; i--)
                if (
                    sorted[i].class === best.class &&
                    iou(
                        [best.x1, best.y1, best.x2, best.y2],
                        [sorted[i].x1, sorted[i].y1, sorted[i].x2, sorted[i].y2]
                    ) > iouThr
                )
                    sorted.splice(i, 1);
        }
        return kept;
    }
    // 4-connected components over a binary grid
    function components(bin, scores, W, H) {
        const seen = new Uint8Array(W * H);
        const regions = [];
        for (let i = 0; i < W * H; i++) {
            if (!bin[i] || seen[i]) continue;
            let minx = W,
                miny = H,
                maxx = 0,
                maxy = 0,
                area = 0,
                peak = -Infinity;
            const stack = [i];
            seen[i] = 1;
            while (stack.length) {
                const p = stack.pop();
                const x = p % W,
                    y = (p / W) | 0;
                area++;
                if (x < minx) minx = x;
                if (x > maxx) maxx = x;
                if (y < miny) miny = y;
                if (y > maxy) maxy = y;
                if (scores && scores[p] > peak) peak = scores[p];
                const nb = [p - 1, p + 1, p - W, p + W];
                if (x === 0) nb[0] = -1;
                if (x === W - 1) nb[1] = -1;
                for (const q of nb)
                    if (q >= 0 && q < W * H && bin[q] && !seen[q]) {
                        seen[q] = 1;
                        stack.push(q);
                    }
            }
            regions.push({ minx, miny, maxx, maxy, area, peak });
        }
        return regions;
    }
    function polyMetrics(pts) {
        let area = 0,
            per = 0,
            minx = Infinity,
            miny = Infinity,
            maxx = -Infinity,
            maxy = -Infinity;
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i],
                b = pts[(i + 1) % pts.length];
            area += a[0] * b[1] - b[0] * a[1];
            per += Math.hypot(b[0] - a[0], b[1] - a[1]);
            minx = Math.min(minx, a[0]);
            miny = Math.min(miny, a[1]);
            maxx = Math.max(maxx, a[0]);
            maxy = Math.max(maxy, a[1]);
        }
        return { area: Math.abs(area) / 2, perimeter: per, bbox: [minx, miny, maxx, maxy] };
    }
    function baseCanvas(msg, imageProperty, w, h) {
        const buf = getProp(msg, imageProperty);
        if (PNG && buf && Buffer.isBuffer(buf)) {
            try {
                const png = PNG.sync.read(buf);
                return new Canvas(png.width, png.height, new Uint8Array(png.data));
            } catch (e) {
                /* blank */
            }
        }
        const c = new Canvas(w, h);
        c.fillRect(0, 0, w, h, [32, 36, 44], 255);
        return c;
    }
    function num(v, d) {
        return v !== undefined && v !== null && v !== "" && isFinite(parseFloat(v)) ? parseFloat(v) : d;
    }

    // Base64 PNG of the canvas for the editor thumbnail — downscaled (nearest) when
    // the longest side exceeds maxSide, so we don't push a ~1 MB image over comms
    // on every inference. Reuses the already-encoded full PNG when small enough.
    function thumbBase64(canvas, fullPngBuf, maxSide) {
        const W = canvas.width,
            H = canvas.height;
        const longest = Math.max(W, H);
        if (longest <= maxSide) return fullPngBuf.toString("base64");
        const s = maxSide / longest;
        const dw = Math.max(1, Math.round(W * s)),
            dh = Math.max(1, Math.round(H * s));
        const src = canvas.data;
        const png = new PNG({ width: dw, height: dh });
        for (let y = 0; y < dh; y++) {
            for (let x = 0; x < dw; x++) {
                const sx = Math.min(W - 1, Math.floor(x / s)),
                    sy = Math.min(H - 1, Math.floor(y / s));
                const si = (sy * W + sx) * 4,
                    di = (y * dw + x) * 4;
                png.data[di] = src[si];
                png.data[di + 1] = src[si + 1];
                png.data[di + 2] = src[si + 2];
                png.data[di + 3] = src[si + 3];
            }
        }
        return PNG.sync.write(png).toString("base64");
    }

    function VisionAnnotatorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.mode = config.mode || "boxes";
        node.inputProperty = config.inputProperty || "prediction";
        node.shapeProperty = config.shapeProperty || "mlInference.outputShape";
        node.imageProperty = config.imageProperty || "image";
        node.canvasWidth = parseInt(config.canvasWidth, 10) || 128;
        node.canvasHeight = parseInt(config.canvasHeight, 10) || 128;
        node.alpha = Math.round(num(config.alpha, 0.5) * 255);
        node.boxFormat = config.boxFormat || "xyxy";
        node.scoreThreshold = num(config.scoreThreshold, 0.3);
        node.iouThreshold = num(config.iouThreshold, 0.45);
        node.boxThickness = parseInt(config.boxThickness, 10) || 2;
        node.normalizedCoords = config.normalizedCoords === true || config.normalizedCoords === "true";
        node.colormap = config.colormap || "jet";
        node.threshold = num(config.threshold, 0.5);
        node.pointRadius = parseInt(config.pointRadius, 10) || 3;
        node.kpThreshold = num(config.kpThreshold, 0.5);
        node.polygonClosed = config.polygonClosed !== false && config.polygonClosed !== "false";
        try {
            node.skeleton = config.skeleton ? JSON.parse(config.skeleton) : [];
            if (!Array.isArray(node.skeleton)) node.skeleton = [];
        } catch (e) {
            node.skeleton = [];
        }
        try {
            node.palette = config.palette ? JSON.parse(config.palette) : DEFAULT_PALETTE;
            if (!Array.isArray(node.palette) || !node.palette.length) node.palette = DEFAULT_PALETTE;
        } catch (e) {
            node.palette = DEFAULT_PALETTE;
        }
        node.classLabels = (config.classLabels || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        node.editorPreview = config.editorPreview !== false && config.editorPreview !== "false";
        node.previewWidth = parseInt(config.previewWidth, 10) || 200;
        node.zoomWidth = parseInt(config.zoomWidth, 10) || 500;

        const color = (cls) => node.palette[((cls % node.palette.length) + node.palette.length) % node.palette.length];
        const labelOf = (cls) => (node.classLabels[cls] !== undefined ? node.classLabels[cls] : String(cls));
        const flatOf = (msg) => deepFlatten(getProp(msg, node.inputProperty));
        const shapeOf = (msg) => {
            const s = getProp(msg, node.shapeProperty);
            return Array.isArray(s) ? s : null;
        };

        // -- boxes (axis-aligned) ---------------------------------------------
        function decodeBoxes(flat, shape, canvas) {
            const sx = node.normalizedCoords ? canvas.width : 1,
                sy = node.normalizedCoords ? canvas.height : 1;
            const boxes = [];
            if (node.boxFormat === "yolo") {
                let N, A;
                if (shape && shape.length === 3) {
                    N = shape[1];
                    A = shape[2];
                } else if (shape && shape.length === 2) {
                    N = shape[0];
                    A = shape[1];
                } else return [];
                const nc = A - 5;
                for (let i = 0; i < N; i++) {
                    const o = i * A,
                        cx = flat[o],
                        cy = flat[o + 1],
                        w = flat[o + 2],
                        h = flat[o + 3],
                        obj = flat[o + 4];
                    let bestC = 0,
                        bestP = -Infinity;
                    for (let c = 0; c < nc; c++) {
                        const p = flat[o + 5 + c];
                        if (p > bestP) {
                            bestP = p;
                            bestC = c;
                        }
                    }
                    const score = obj * (nc > 0 ? bestP : 1);
                    if (score < node.scoreThreshold) continue;
                    boxes.push({
                        x1: (cx - w / 2) * sx,
                        y1: (cy - h / 2) * sy,
                        x2: (cx + w / 2) * sx,
                        y2: (cy + h / 2) * sy,
                        score,
                        class: bestC
                    });
                }
                return nms(boxes, node.iouThreshold);
            }
            let N, A;
            if (shape && shape.length === 3) {
                N = shape[1];
                A = shape[2];
            } else if (shape && shape.length === 2) {
                N = shape[0];
                A = shape[1];
            } else {
                A = 6;
                N = Math.floor(flat.length / 6);
            }
            for (let i = 0; i < N; i++) {
                const o = i * A,
                    score = A > 4 ? flat[o + 4] : 1;
                if (score < node.scoreThreshold) continue;
                boxes.push({
                    x1: flat[o] * sx,
                    y1: flat[o + 1] * sy,
                    x2: flat[o + 2] * sx,
                    y2: flat[o + 3] * sy,
                    score,
                    class: A > 5 ? Math.round(flat[o + 5]) : 0
                });
            }
            return boxes;
        }
        function renderBoxes(msg) {
            const canvas = baseCanvas(msg, node.imageProperty, node.canvasWidth, node.canvasHeight);
            const boxes = decodeBoxes(flatOf(msg), shapeOf(msg), canvas);
            const out = [];
            for (const b of boxes) {
                const c = color(b.class + 1);
                const x1 = Math.round(b.x1),
                    y1 = Math.round(b.y1),
                    x2 = Math.round(b.x2),
                    y2 = Math.round(b.y2);
                canvas.strokeRect(x1, y1, x2, y2, c, node.boxThickness);
                const drawn = b.class + " " + Math.round(b.score * 100) + "%";
                const tagH = 9,
                    tagW = drawn.length * 6 + 2;
                canvas.fillRect(x1, Math.max(0, y1 - tagH), x1 + tagW, Math.max(tagH, y1), c, 255);
                canvas.text(x1 + 1, Math.max(1, y1 - tagH + 1), drawn, [255, 255, 255], 1);
                out.push({ x1, y1, x2, y2, score: +b.score.toFixed(4), class: b.class, label: labelOf(b.class) });
            }
            return {
                canvas,
                annotations: {
                    mode: "boxes",
                    width: canvas.width,
                    height: canvas.height,
                    count: out.length,
                    boxes: out,
                    classesPresent: Array.from(new Set(out.map((b) => b.class))).sort((a, b) => a - b)
                }
            };
        }

        // -- obb (rotated boxes) ----------------------------------------------
        function renderOBB(msg) {
            const canvas = baseCanvas(msg, node.imageProperty, node.canvasWidth, node.canvasHeight);
            const flat = flatOf(msg),
                shape = shapeOf(msg);
            let N, A;
            if (shape && shape.length === 3) {
                N = shape[1];
                A = shape[2];
            } else if (shape && shape.length === 2) {
                N = shape[0];
                A = shape[1];
            } else {
                A = 7;
                N = Math.floor(flat.length / 7);
            }
            const sx = node.normalizedCoords ? canvas.width : 1,
                sy = node.normalizedCoords ? canvas.height : 1;
            const out = [];
            for (let i = 0; i < N; i++) {
                const o = i * A,
                    cx = flat[o] * sx,
                    cy = flat[o + 1] * sy,
                    w = flat[o + 2] * sx,
                    h = flat[o + 3] * sy,
                    ang = flat[o + 4];
                const score = A > 5 ? flat[o + 5] : 1,
                    cls = A > 6 ? Math.round(flat[o + 6]) : 0;
                if (score < node.scoreThreshold) continue;
                const cos = Math.cos(ang),
                    sin = Math.sin(ang);
                const corners = [
                    [-w / 2, -h / 2],
                    [w / 2, -h / 2],
                    [w / 2, h / 2],
                    [-w / 2, h / 2]
                ].map(([dx, dy]) => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]);
                const c = color(cls + 1);
                for (let k = 0; k < 4; k++)
                    canvas.line(
                        corners[k][0],
                        corners[k][1],
                        corners[(k + 1) % 4][0],
                        corners[(k + 1) % 4][1],
                        c,
                        node.boxThickness
                    );
                canvas.text(
                    Math.round(cx) - 6,
                    Math.round(cy) - 3,
                    cls + " " + Math.round(score * 100) + "%",
                    [255, 255, 255],
                    1
                );
                out.push({
                    cx: +cx.toFixed(2),
                    cy: +cy.toFixed(2),
                    w,
                    h,
                    angle: +ang.toFixed(4),
                    score: +score.toFixed(4),
                    class: cls,
                    label: labelOf(cls),
                    corners: corners.map((p) => [Math.round(p[0]), Math.round(p[1])])
                });
            }
            return {
                canvas,
                annotations: {
                    mode: "obb",
                    width: canvas.width,
                    height: canvas.height,
                    count: out.length,
                    boxes: out,
                    classesPresent: Array.from(new Set(out.map((b) => b.class))).sort((a, b) => a - b)
                }
            };
        }

        // -- semantic segmentation --------------------------------------------
        function renderSegmentation(msg) {
            const flat = flatOf(msg);
            const shape = shapeOf(msg);
            let H, W, classMap;
            if (shape && shape.length === 4) {
                const C = shape[1];
                H = shape[2];
                W = shape[3];
                classMap = new Array(H * W);
                for (let h = 0; h < H; h++)
                    for (let w = 0; w < W; w++) {
                        let best = 0,
                            bestV = -Infinity;
                        for (let c = 0; c < C; c++) {
                            const v = flat[c * H * W + h * W + w];
                            if (v > bestV) {
                                bestV = v;
                                best = c;
                            }
                        }
                        classMap[h * W + w] = best;
                    }
            } else {
                if (shape && shape.length === 3) {
                    H = shape[1];
                    W = shape[2];
                } else if (shape && shape.length === 2) {
                    H = shape[0];
                    W = shape[1];
                } else {
                    const s = Math.round(Math.sqrt(flat.length));
                    H = s;
                    W = s;
                }
                classMap = flat.map((v) => Math.round(v));
            }
            const canvas = baseCanvas(msg, node.imageProperty, node.canvasWidth, node.canvasHeight);
            for (let y = 0; y < canvas.height; y++)
                for (let x = 0; x < canvas.width; x++) {
                    const mh = Math.min(H - 1, Math.floor((y / canvas.height) * H)),
                        mw = Math.min(W - 1, Math.floor((x / canvas.width) * W));
                    const cls = classMap[mh * W + mw] || 0;
                    if (cls > 0) {
                        const c = color(cls);
                        canvas.set(x, y, c[0], c[1], c[2], node.alpha);
                    }
                }
            const counts = {};
            for (const cls of classMap) counts[cls] = (counts[cls] || 0) + 1;
            const frac = {};
            Object.keys(counts).forEach((k) => {
                frac[k] = +(counts[k] / classMap.length).toFixed(4);
            });
            const classesPresent = Object.keys(counts)
                .map(Number)
                .filter((c) => c > 0)
                .sort((a, b) => a - b);
            return {
                canvas,
                annotations: {
                    mode: "segmentation",
                    width: canvas.width,
                    height: canvas.height,
                    maskWidth: W,
                    maskHeight: H,
                    maskClassCounts: counts,
                    classAreaFraction: frac,
                    classesPresent
                }
            };
        }

        // -- instance segmentation --------------------------------------------
        function renderInstances(msg) {
            const flat = flatOf(msg),
                shape = shapeOf(msg);
            let N, H, W;
            if (shape && shape.length === 4) {
                N = shape[1];
                H = shape[2];
                W = shape[3];
            } else if (shape && shape.length === 3) {
                N = shape[0];
                H = shape[1];
                W = shape[2];
            } else
                return {
                    canvas: baseCanvas(msg, node.imageProperty, node.canvasWidth, node.canvasHeight),
                    annotations: { mode: "instances", count: 0, instances: [] }
                };
            const canvas = baseCanvas(msg, node.imageProperty, node.canvasWidth, node.canvasHeight);
            const sxk = canvas.width / W,
                syk = canvas.height / H;
            const out = [];
            for (let i = 0; i < N; i++) {
                const c = color(i + 1);
                let minx = W,
                    miny = H,
                    maxx = -1,
                    maxy = -1,
                    area = 0;
                for (let h = 0; h < H; h++)
                    for (let w = 0; w < W; w++) {
                        if (flat[i * H * W + h * W + w] > 0.5) {
                            area++;
                            if (w < minx) minx = w;
                            if (w > maxx) maxx = w;
                            if (h < miny) miny = h;
                            if (h > maxy) maxy = h;
                            const px = Math.floor(w * sxk),
                                py = Math.floor(h * syk);
                            for (let oy = 0; oy < Math.ceil(syk); oy++)
                                for (let ox = 0; ox < Math.ceil(sxk); ox++)
                                    canvas.set(px + ox, py + oy, c[0], c[1], c[2], node.alpha);
                        }
                    }
                if (area === 0) continue;
                const bx1 = Math.round(minx * sxk),
                    by1 = Math.round(miny * syk),
                    bx2 = Math.round((maxx + 1) * sxk),
                    by2 = Math.round((maxy + 1) * syk);
                canvas.strokeRect(bx1, by1, bx2, by2, c, node.boxThickness);
                canvas.text(bx1 + 1, Math.max(1, by1 - 8), String(i), [255, 255, 255], 1);
                out.push({
                    class: i,
                    label: labelOf(i),
                    bbox: [bx1, by1, bx2, by2],
                    area,
                    areaFraction: +(area / (H * W)).toFixed(4)
                });
            }
            return {
                canvas,
                annotations: {
                    mode: "instances",
                    width: canvas.width,
                    height: canvas.height,
                    count: out.length,
                    instances: out
                }
            };
        }

        // -- polygons / contours ----------------------------------------------
        function renderPolygons(msg) {
            const flat = flatOf(msg),
                shape = shapeOf(msg);
            let N, V;
            if (shape && shape.length === 4) {
                N = shape[1];
                V = shape[2];
            } else if (shape && shape.length === 3) {
                N = shape[0];
                V = shape[1];
            } else {
                N = 1;
                V = Math.floor(flat.length / 2);
            }
            const canvas = baseCanvas(msg, node.imageProperty, node.canvasWidth, node.canvasHeight);
            const sx = node.normalizedCoords ? canvas.width : 1,
                sy = node.normalizedCoords ? canvas.height : 1;
            const out = [];
            for (let i = 0; i < N; i++) {
                const pts = [];
                for (let v = 0; v < V; v++) {
                    const o = (i * V + v) * 2;
                    pts.push([flat[o] * sx, flat[o + 1] * sy]);
                }
                const c = color(i + 1);
                const last = node.polygonClosed ? V : V - 1;
                for (let v = 0; v < last; v++)
                    canvas.line(pts[v][0], pts[v][1], pts[(v + 1) % V][0], pts[(v + 1) % V][1], c, node.boxThickness);
                const m = polyMetrics(pts);
                canvas.text(
                    Math.round(m.bbox[0]) + 1,
                    Math.max(1, Math.round(m.bbox[1]) - 8),
                    String(i),
                    [255, 255, 255],
                    1
                );
                out.push({
                    class: i,
                    vertices: V,
                    area: +m.area.toFixed(2),
                    perimeter: +m.perimeter.toFixed(2),
                    bbox: m.bbox.map(Math.round)
                });
            }
            return {
                canvas,
                annotations: {
                    mode: "polygons",
                    width: canvas.width,
                    height: canvas.height,
                    count: out.length,
                    polygons: out
                }
            };
        }

        // -- keypoints / pose --------------------------------------------------
        function renderKeypoints(msg) {
            const flat = flatOf(msg),
                shape = shapeOf(msg);
            let P, K;
            if (shape && shape.length === 4) {
                P = shape[1];
                K = shape[2];
            } else if (shape && shape.length === 3) {
                P = 1;
                K = shape[1];
            } else {
                P = 1;
                K = Math.floor(flat.length / 3);
            }
            const canvas = baseCanvas(msg, node.imageProperty, node.canvasWidth, node.canvasHeight);
            const sx = node.normalizedCoords ? canvas.width : 1,
                sy = node.normalizedCoords ? canvas.height : 1;
            const persons = [];
            let totalVisible = 0;
            for (let p = 0; p < P; p++) {
                const kps = [];
                for (let k = 0; k < K; k++) {
                    const o = (p * K + k) * 3;
                    kps.push({ x: flat[o] * sx, y: flat[o + 1] * sy, conf: flat[o + 2] });
                }
                const c = color(p + 1);
                for (const [a, b] of node.skeleton)
                    if (kps[a] && kps[b] && kps[a].conf >= node.kpThreshold && kps[b].conf >= node.kpThreshold)
                        canvas.line(kps[a].x, kps[a].y, kps[b].x, kps[b].y, c, node.boxThickness);
                const visible = [];
                kps.forEach((kp, idx) => {
                    const vis = kp.conf >= node.kpThreshold;
                    if (vis) {
                        canvas.circle(Math.round(kp.x), Math.round(kp.y), node.pointRadius, c);
                        totalVisible++;
                    }
                    visible.push({
                        index: idx,
                        x: +kp.x.toFixed(1),
                        y: +kp.y.toFixed(1),
                        conf: +kp.conf.toFixed(3),
                        visible: vis
                    });
                });
                persons.push({ person: p, keypoints: visible, visibleCount: visible.filter((v) => v.visible).length });
            }
            return {
                canvas,
                annotations: {
                    mode: "keypoints",
                    width: canvas.width,
                    height: canvas.height,
                    persons: persons,
                    personCount: P,
                    keypointCount: K,
                    visibleCount: totalVisible
                }
            };
        }

        // -- heatmap (depth / CAM / density) ----------------------------------
        function scalarField(flat, shape) {
            let H, W;
            if (shape && shape.length === 4) {
                H = shape[2];
                W = shape[3];
            } else if (shape && shape.length === 3) {
                H = shape[1];
                W = shape[2];
            } else if (shape && shape.length === 2) {
                H = shape[0];
                W = shape[1];
            } else {
                const s = Math.round(Math.sqrt(flat.length));
                H = s;
                W = s;
            }
            // Guard against a declared shape that claims more elements than the
            // data actually contains — otherwise flat[i] is undefined and the
            // metrics (min/max/mean) silently become NaN.
            if (!(H > 0) || !(W > 0) || flat.length < H * W) {
                throw new Error("Scalar field shape (" + H + "x" + W + ") exceeds data length " + flat.length);
            }
            return { H, W };
        }
        function renderHeatmap(msg) {
            const flat = flatOf(msg),
                shape = shapeOf(msg);
            const { H, W } = scalarField(flat, shape);
            let mn = Infinity,
                mx = -Infinity,
                sum = 0;
            for (let i = 0; i < H * W; i++) {
                const v = flat[i];
                if (v < mn) mn = v;
                if (v > mx) mx = v;
                sum += v;
            }
            const span = mx - mn || 1;
            const cmap = colormapFn(node.colormap);
            const canvas = baseCanvas(msg, node.imageProperty, node.canvasWidth, node.canvasHeight);
            for (let y = 0; y < canvas.height; y++)
                for (let x = 0; x < canvas.width; x++) {
                    const mh = Math.min(H - 1, Math.floor((y / canvas.height) * H)),
                        mw = Math.min(W - 1, Math.floor((x / canvas.width) * W));
                    const t = (flat[mh * W + mw] - mn) / span;
                    const c = cmap(t);
                    canvas.set(x, y, c[0], c[1], c[2], node.alpha);
                }
            return {
                canvas,
                annotations: {
                    mode: "heatmap",
                    width: canvas.width,
                    height: canvas.height,
                    fieldWidth: W,
                    fieldHeight: H,
                    min: +mn.toFixed(4),
                    max: +mx.toFixed(4),
                    mean: +(sum / (H * W)).toFixed(4)
                }
            };
        }

        // -- anomaly map (heatmap + threshold regions + metrics) ---------------
        function renderAnomaly(msg) {
            const flat = flatOf(msg),
                shape = shapeOf(msg);
            const { H, W } = scalarField(flat, shape);
            let mn = Infinity,
                mx = -Infinity,
                sum = 0;
            for (let i = 0; i < H * W; i++) {
                const v = flat[i];
                if (v < mn) mn = v;
                if (v > mx) mx = v;
                sum += v;
            }
            const span = mx - mn || 1;
            const cmap = colormapFn(node.colormap);
            const canvas = baseCanvas(msg, node.imageProperty, node.canvasWidth, node.canvasHeight);
            const bin = new Uint8Array(H * W);
            let aboveCount = 0;
            for (let i = 0; i < H * W; i++)
                if (flat[i] >= node.threshold) {
                    bin[i] = 1;
                    aboveCount++;
                }
            for (let y = 0; y < canvas.height; y++)
                for (let x = 0; x < canvas.width; x++) {
                    const mh = Math.min(H - 1, Math.floor((y / canvas.height) * H)),
                        mw = Math.min(W - 1, Math.floor((x / canvas.width) * W));
                    const t = (flat[mh * W + mw] - mn) / span;
                    const c = cmap(t);
                    canvas.set(x, y, c[0], c[1], c[2], node.alpha);
                }
            const sxk = canvas.width / W,
                syk = canvas.height / H;
            const regions = components(bin, flat, W, H)
                .map((r) => {
                    const x1 = Math.round(r.minx * sxk),
                        y1 = Math.round(r.miny * syk),
                        x2 = Math.round((r.maxx + 1) * sxk),
                        y2 = Math.round((r.maxy + 1) * syk);
                    canvas.strokeRect(x1, y1, x2, y2, [255, 255, 255], node.boxThickness);
                    return { x1, y1, x2, y2, area: r.area, peakScore: +r.peak.toFixed(4) };
                })
                .sort((a, b) => b.area - a.area);
            return {
                canvas,
                annotations: {
                    mode: "anomaly",
                    width: canvas.width,
                    height: canvas.height,
                    fieldWidth: W,
                    fieldHeight: H,
                    maxScore: +mx.toFixed(4),
                    meanScore: +(sum / (H * W)).toFixed(4),
                    threshold: node.threshold,
                    anomalyFraction: +(aboveCount / (H * W)).toFixed(4),
                    regionCount: regions.length,
                    regions
                }
            };
        }

        // -- classification banner --------------------------------------------
        function renderClassification(msg) {
            const flat = flatOf(msg);
            // softmax -> normalized confidence (models usually output raw logits)
            let mx = -Infinity;
            for (const v of flat) if (v > mx) mx = v;
            let sum = 0;
            const probs = flat.map((v) => {
                const e = Math.exp(v - mx);
                sum += e;
                return e;
            });
            for (let i = 0; i < probs.length; i++) probs[i] /= sum || 1;
            const scored = probs.map((s, i) => ({ class: i, score: s })).sort((a, b) => b.score - a.score);
            const top = scored[0] || { class: -1, score: 0 };
            const canvas = baseCanvas(msg, node.imageProperty, node.canvasWidth, node.canvasHeight);
            const c = color(top.class + 1);
            canvas.fillRect(0, 0, canvas.width, 11, c, 220);
            canvas.text(2, 2, top.class + " " + Math.round(top.score * 100) + "%", [255, 255, 255], 1);
            canvas.circle(
                canvas.width - 7,
                5,
                4,
                top.score >= 0.66 ? [60, 200, 75] : top.score >= 0.33 ? [245, 200, 60] : [230, 50, 50]
            );
            return {
                canvas,
                annotations: {
                    mode: "classification",
                    width: canvas.width,
                    height: canvas.height,
                    topClass: top.class,
                    topLabel: labelOf(top.class),
                    topScore: +top.score.toFixed(4),
                    topK: scored.slice(0, 3).map((s) => ({ class: s.class, score: +s.score.toFixed(4) }))
                }
            };
        }

        const RENDERERS = {
            boxes: renderBoxes,
            obb: renderOBB,
            segmentation: renderSegmentation,
            instances: renderInstances,
            polygons: renderPolygons,
            keypoints: renderKeypoints,
            heatmap: renderHeatmap,
            anomaly: renderAnomaly,
            classification: renderClassification
        };

        node.on("input", function (msg, send, done) {
            send =
                send ||
                function () {
                    node.send.apply(node, arguments);
                };
            done =
                done ||
                function (e) {
                    if (e) node.error(e, msg);
                };
            try {
                if (!PNG) throw new Error("pngjs not available. Install: npm install pngjs");
                const renderer = RENDERERS[node.mode] || renderBoxes;
                const result = renderer(msg);
                const png = new PNG({ width: result.canvas.width, height: result.canvas.height });
                png.data = Buffer.from(
                    result.canvas.data.buffer,
                    result.canvas.data.byteOffset,
                    result.canvas.data.byteLength
                );
                msg.payload = PNG.sync.write(png);
                msg.contentType = "image/png";
                msg.annotations = result.annotations;
                // push a live thumbnail to the editor (drawn under this node on the canvas)
                if (node.editorPreview && RED.comms && RED.comms.publish) {
                    // per-node topic + retain=true so the thumbnail survives canvas
                    // redraws and reappears after an editor reload/reconnect.
                    try {
                        RED.comms.publish(
                            "vision-annotator-preview/" + node.id,
                            {
                                id: node.id,
                                data: thumbBase64(
                                    result.canvas,
                                    msg.payload,
                                    Math.max(node.previewWidth, node.zoomWidth)
                                )
                            },
                            true
                        );
                    } catch (e) {
                        /* ignore */
                    }
                }
                const a = result.annotations;
                const summary =
                    a.count !== undefined
                        ? a.count + " obj"
                        : a.regionCount !== undefined
                          ? a.regionCount + " region"
                          : a.visibleCount !== undefined
                            ? a.visibleCount + " kp"
                            : a.topClass !== undefined
                              ? "cls " + a.topClass
                              : a.classesPresent
                                ? a.classesPresent.length + " cls"
                                : node.mode;
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: node.mode + ": " + summary + " " + result.canvas.width + "x" + result.canvas.height
                });
                send(msg);
                done();
            } catch (err) {
                node.status({ fill: "red", shape: "dot", text: err.message });
                done(err);
            }
        });

        node.on("close", function () {
            if (RED.comms && RED.comms.publish) {
                // clear the retained thumbnail for this node
                try {
                    RED.comms.publish("vision-annotator-preview/" + node.id, { id: node.id }, true);
                } catch (e) {
                    /* ignore */
                }
            }
        });
    }

    RED.nodes.registerType("vision-annotator", VisionAnnotatorNode);
};
