/**
 * Image dimension guard
 * =====================
 *
 * Reads the declared size out of a PNG or JPEG header and refuses images
 * whose pixel count exceeds a cap, BEFORE a decoder gets to allocate for
 * them. pngjs sizes its output buffer from the IHDR chunk and zero-fills
 * whatever pixel data is missing, so a 68-byte PNG claiming 20000x20000
 * decodes into a 1.6 GB buffer. jpeg-js has its own 100 MP / 512 MB cap;
 * the JPEG check here only makes the limit uniform and the error message
 * ours.
 *
 * Nothing in here allocates in proportion to the declared size: the PNG
 * check reads eight fixed bytes, the JPEG check walks the marker table.
 *
 * @module utils/image-guard
 */

"use strict";

// 50 megapixels: 200 MB of RGBA, far above any model input and the editor
// preview, far below the point where a decode starts hurting the process.
const DEFAULT_MAX_PIXELS = 50 * 1000 * 1000;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < PNG_SIGNATURE.length) return false;
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
        if (buf[i] !== PNG_SIGNATURE[i]) return false;
    }
    return true;
}

function isJpeg(buf) {
    return Buffer.isBuffer(buf) && buf.length > 1 && buf[0] === 0xff && buf[1] === 0xd8;
}

function tooLarge(width, height, maxPixels) {
    const err = new Error(
        "image too large: " +
            width +
            "x" +
            height +
            " (" +
            ((width * height) / 1e6).toFixed(1) +
            " MP) exceeds the " +
            (maxPixels / 1e6).toFixed(0) +
            " MP limit"
    );
    err.code = "EIMAGETOOLARGE";
    // Short form for the node status line (error-handler convention: the
    // full text goes to node.error, the status shows a class).
    err.statusText = "image too large";
    return err;
}

function resolveMaxPixels(opts) {
    const n = opts && Number(opts.maxPixels);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PIXELS;
}

function checkDimensions(width, height, maxPixels) {
    if (!(width > 0) || !(height > 0)) {
        const err = new Error("invalid image header: " + width + "x" + height);
        err.code = "EIMAGEHEADER";
        err.statusText = "bad image header";
        throw err;
    }
    if (width * height > maxPixels) throw tooLarge(width, height, maxPixels);
    return { width, height };
}

/**
 * Validate the IHDR dimensions of a PNG buffer.
 *
 * @param {Buffer} buf
 * @param {Object} [opts]
 * @param {number} [opts.maxPixels=50e6] - width*height cap
 * @returns {{width:number, height:number}} the declared size
 * @throws {Error} code EIMAGETOOLARGE when the cap is exceeded, EIMAGEHEADER
 *   when the buffer is not a PNG or the header is truncated / zero-sized
 */
function assertPngDimensions(buf, opts) {
    const maxPixels = resolveMaxPixels(opts);
    // Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4).
    if (!isPng(buf) || buf.length < 24) {
        const err = new Error("invalid image header: not a PNG or truncated before IHDR");
        err.code = "EIMAGEHEADER";
        err.statusText = "bad image header";
        throw err;
    }
    return checkDimensions(buf.readUInt32BE(16), buf.readUInt32BE(20), maxPixels);
}

/**
 * Validate the SOFn dimensions of a JPEG buffer by walking the marker
 * segments. A buffer without a readable SOF marker is left to the decoder
 * (it fails there with its own message) — this guard only ever rejects
 * what it can prove too large.
 *
 * @param {Buffer} buf
 * @param {Object} [opts]
 * @param {number} [opts.maxPixels=50e6]
 * @returns {{width:number, height:number}|null} the declared size, or null
 *   when no SOF marker was found
 * @throws {Error} code EIMAGETOOLARGE when the cap is exceeded
 */
function assertJpegDimensions(buf, opts) {
    const maxPixels = resolveMaxPixels(opts);
    if (!isJpeg(buf)) return null;
    let i = 2;
    while (i + 3 < buf.length) {
        if (buf[i] !== 0xff) {
            i++;
            continue;
        }
        const marker = buf[i + 1];
        // Fill bytes and stand-alone markers (RSTn, SOI, EOI, TEM) carry no length.
        if (marker === 0xff) {
            i++;
            continue;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
            i += 2;
            continue;
        }
        if (marker === 0xda) return null; // start of scan: no SOF seen before the image data
        const length = buf.readUInt16BE(i + 2);
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
            if (i + 8 >= buf.length) return null;
            // SOF payload: precision (1), height (2), width (2), …
            const height = buf.readUInt16BE(i + 5);
            const width = buf.readUInt16BE(i + 7);
            return checkDimensions(width, height, maxPixels);
        }
        if (length < 2) return null;
        i += 2 + length;
    }
    return null;
}

/**
 * Format-dispatching guard: PNG and JPEG buffers are checked, anything else
 * is returned as null for the caller's own format handling.
 *
 * @param {Buffer} buf
 * @param {Object} [opts]
 * @param {number} [opts.maxPixels=50e6]
 * @returns {{width:number, height:number}|null}
 */
function assertImageDimensions(buf, opts) {
    if (isPng(buf)) return assertPngDimensions(buf, opts);
    if (isJpeg(buf)) return assertJpegDimensions(buf, opts);
    return null;
}

module.exports = {
    DEFAULT_MAX_PIXELS,
    isPng,
    isJpeg,
    assertPngDimensions,
    assertJpegDimensions,
    assertImageDimensions
};
