/**
 * image-preprocess
 *
 * Turns a real image (PNG or JPEG Buffer) into a normalized tensor ready for
 * ml-inference, and keeps the (resized) image around so vision-annotator can
 * draw the model's predictions back onto it.
 *
 * Pure-JS: pngjs + jpeg-js — no native deps.
 *
 * Input:
 *   msg[inputProperty]   image as a Buffer (PNG/JPEG). Default "payload".
 * Output:
 *   msg[outputProperty]  flat Float array (the tensor data). Default "payload".
 *   msg[shapeProperty]   tensor shape, e.g. [1,3,224,224]. Default "tensorShape".
 *   msg.image            the resized image as a PNG Buffer (for overlay), unless keepImage=false.
 *   msg.preprocess       { srcWidth, srcHeight, width, height, layout, channels, normalize }.
 */

module.exports = function (RED) {
    "use strict";

    let PNG = null,
        jpeg = null;
    try {
        PNG = require("pngjs").PNG;
    } catch (e) {
        PNG = null;
    }
    try {
        jpeg = require("jpeg-js");
    } catch (e) {
        jpeg = null;
    }

    const IMAGENET_MEAN = [0.485, 0.456, 0.406];
    const IMAGENET_STD = [0.229, 0.224, 0.225];

    function decode(buf) {
        if (!Buffer.isBuffer(buf)) throw new Error("input is not a Buffer (expected a PNG/JPEG image)");
        if (buf.length > 3 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
            if (!PNG) throw new Error("pngjs not available");
            const p = PNG.sync.read(buf);
            return { width: p.width, height: p.height, data: p.data };
        }
        if (buf.length > 1 && buf[0] === 0xff && buf[1] === 0xd8) {
            if (!jpeg) throw new Error("jpeg-js not available");
            const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
            return { width: j.width, height: j.height, data: j.data };
        }
        throw new Error("unsupported image format (need PNG or JPEG)");
    }

    // bilinear / nearest resize over RGBA
    function resize(src, sw, sh, dw, dh, mode) {
        const out = new Uint8Array(dw * dh * 4);
        const sx = sw / dw,
            sy = sh / dh;
        for (let dy = 0; dy < dh; dy++) {
            for (let dx = 0; dx < dw; dx++) {
                const fx = (dx + 0.5) * sx - 0.5,
                    fy = (dy + 0.5) * sy - 0.5;
                const o = (dy * dw + dx) * 4;
                if (mode === "nearest") {
                    const ix = Math.min(sw - 1, Math.max(0, Math.round(fx))),
                        iy = Math.min(sh - 1, Math.max(0, Math.round(fy)));
                    const so = (iy * sw + ix) * 4;
                    out[o] = src[so];
                    out[o + 1] = src[so + 1];
                    out[o + 2] = src[so + 2];
                    out[o + 3] = src[so + 3];
                } else {
                    const x0 = Math.floor(fx),
                        y0 = Math.floor(fy);
                    // Clamp all four corner indices into bounds, and derive the
                    // interpolation weights from the clamped base so edge pixels
                    // (where fx/fy can be slightly negative) stay correct and
                    // never read out of bounds.
                    const cx0 = Math.min(sw - 1, Math.max(0, x0)),
                        cy0 = Math.min(sh - 1, Math.max(0, y0));
                    const cx1 = Math.min(sw - 1, cx0 + 1),
                        cy1 = Math.min(sh - 1, cy0 + 1);
                    const wx = Math.min(1, Math.max(0, fx - cx0)),
                        wy = Math.min(1, Math.max(0, fy - cy0));
                    for (let c = 0; c < 4; c++) {
                        const p00 = src[(cy0 * sw + cx0) * 4 + c],
                            p10 = src[(cy0 * sw + cx1) * 4 + c];
                        const p01 = src[(cy1 * sw + cx0) * 4 + c],
                            p11 = src[(cy1 * sw + cx1) * 4 + c];
                        const top = p00 + (p10 - p00) * wx,
                            bot = p01 + (p11 - p01) * wx;
                        out[o + c] = Math.round(top + (bot - top) * wy);
                    }
                }
            }
        }
        return out;
    }

    function ImagePreprocessNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.inputProperty = config.inputProperty || "payload";
        node.outputProperty = config.outputProperty || "payload";
        node.shapeProperty = config.shapeProperty || "tensorShape";
        node.targetWidth = parseInt(config.targetWidth, 10) || 224;
        node.targetHeight = parseInt(config.targetHeight, 10) || 224;
        node.normalize = config.normalize || "0-1"; // 0-1 | 0-255 | -1-1 | imagenet | custom
        node.layout = config.layout || "nchw"; // nchw | nhwc
        node.channelOrder = config.channelOrder || "rgb"; // rgb | bgr
        node.grayscale = config.grayscale === true || config.grayscale === "true";
        node.resizeMode = config.resizeMode || "bilinear";
        node.keepImage = config.keepImage !== false && config.keepImage !== "false";
        const f = (v, d) => (v !== undefined && v !== null && v !== "" && isFinite(parseFloat(v)) ? parseFloat(v) : d);
        node.mean = [f(config.meanR, 0), f(config.meanG, 0), f(config.meanB, 0)];
        node.std = [f(config.stdR, 1), f(config.stdG, 1), f(config.stdB, 1)];

        function norm(v255, ch) {
            const v = v255 / 255;
            switch (node.normalize) {
                case "0-255":
                    return v255;
                case "-1-1":
                    return v255 / 127.5 - 1;
                case "imagenet":
                    return (v - IMAGENET_MEAN[ch]) / IMAGENET_STD[ch];
                case "custom":
                    return (v - node.mean[ch]) / (node.std[ch] || 1);
                case "0-1":
                default:
                    return v;
            }
        }

        function getProp(msg, p) {
            try {
                return RED.util.getMessageProperty(msg, p);
            } catch (e) {
                return undefined;
            }
        }
        function setProp(msg, p, val) {
            try {
                RED.util.setMessageProperty(msg, p, val, true);
            } catch (e) {
                msg[p] = val;
            }
        }

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
                const img = decode(getProp(msg, node.inputProperty));
                const W = node.targetWidth,
                    H = node.targetHeight;
                const rgba =
                    img.width === W && img.height === H
                        ? img.data
                        : resize(img.data, img.width, img.height, W, H, node.resizeMode);

                const C = node.grayscale ? 1 : 3;
                const order = node.channelOrder === "bgr" ? [2, 1, 0] : [0, 1, 2];
                const tensor = new Array(C * H * W);

                const channelValue = (px, c) => {
                    if (node.grayscale) {
                        const r = rgba[px],
                            g = rgba[px + 1],
                            b = rgba[px + 2];
                        return 0.299 * r + 0.587 * g + 0.114 * b;
                    }
                    return rgba[px + order[c]];
                };

                if (node.layout === "nhwc") {
                    let k = 0;
                    for (let y = 0; y < H; y++)
                        for (let x = 0; x < W; x++) {
                            const px = (y * W + x) * 4;
                            for (let c = 0; c < C; c++) tensor[k++] = norm(channelValue(px, c), c);
                        }
                } else {
                    let k = 0;
                    for (let c = 0; c < C; c++)
                        for (let y = 0; y < H; y++)
                            for (let x = 0; x < W; x++) {
                                const px = (y * W + x) * 4;
                                tensor[k++] = norm(channelValue(px, c), c);
                            }
                }

                const shape = node.layout === "nhwc" ? [1, H, W, C] : [1, C, H, W];
                setProp(msg, node.outputProperty, tensor);
                setProp(msg, node.shapeProperty, shape);
                msg.preprocess = {
                    srcWidth: img.width,
                    srcHeight: img.height,
                    width: W,
                    height: H,
                    layout: node.layout,
                    channels: C,
                    normalize: node.normalize
                };

                if (node.keepImage && PNG) {
                    const png = new PNG({ width: W, height: H });
                    png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
                    msg.image = PNG.sync.write(png);
                }

                node.status({
                    fill: "green",
                    shape: "dot",
                    text: img.width + "x" + img.height + " → [" + shape.join(",") + "] " + node.normalize
                });
                send(msg);
                done();
            } catch (err) {
                node.status({ fill: "red", shape: "dot", text: err.message });
                done(err);
            }
        });
    }

    RED.nodes.registerType("image-preprocess", ImagePreprocessNode);
};
