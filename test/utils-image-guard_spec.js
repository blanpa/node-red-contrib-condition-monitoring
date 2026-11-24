"use strict";

/**
 * utils/image-guard: header-only size checks that run before pngjs / jpeg-js
 * get to allocate for a declared image size.
 */

const zlib = require("zlib");
const { PNG } = require("pngjs");
const guard = require("../nodes/utils/image-guard");

let jpeg = null;
try {
    jpeg = require("jpeg-js");
} catch {
    jpeg = null;
}

// --- minimal PNG writer: a valid file whose IHDR claims W x H but carries one pixel
function crc32(buf) {
    let c,
        crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function pngClaiming(width, height) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(Buffer.alloc(5))),
        chunk("IEND", Buffer.alloc(0))
    ]);
}

// A JPEG that is nothing but SOI, an APP0 segment and a SOF0 claiming W x H.
function jpegClaiming(width, height) {
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    sof.writeUInt16BE(height, 5);
    sof.writeUInt16BE(width, 7);
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]), sof]);
}

describe("utils/image-guard", () => {
    it("accepts a real small PNG and reports its declared size", () => {
        const png = PNG.sync.write(new PNG({ width: 3, height: 2 }));
        expect(guard.assertPngDimensions(png)).toEqual({ width: 3, height: 2 });
        expect(guard.assertImageDimensions(png)).toEqual({ width: 3, height: 2 });
    });

    it("rejects a 68-byte PNG claiming 20000x20000 quickly and without allocating for it", () => {
        const bomb = pngClaiming(20000, 20000);
        expect(bomb.length).toBe(68);
        const before = process.memoryUsage().arrayBuffers;
        const started = Date.now();
        expect(() => guard.assertPngDimensions(bomb)).toThrow(
            "image too large: 20000x20000 (400.0 MP) exceeds the 50 MP limit"
        );
        expect(Date.now() - started).toBeLessThan(200);
        // pngjs would have taken 1.6 GB here.
        expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024);
        let err;
        try {
            guard.assertPngDimensions(bomb);
        } catch (e) {
            err = e;
        }
        expect(err.code).toBe("EIMAGETOOLARGE");
        expect(err.statusText).toBe("image too large");
    });

    it("honours a custom maxPixels", () => {
        const png = pngClaiming(100, 100);
        expect(guard.assertPngDimensions(png, { maxPixels: 10000 })).toEqual({ width: 100, height: 100 });
        expect(() => guard.assertPngDimensions(png, { maxPixels: 9999 })).toThrow(/exceeds the 0 MP limit/);
        // Nonsense caps fall back to the default.
        expect(guard.assertPngDimensions(png, { maxPixels: -1 })).toEqual({ width: 100, height: 100 });
        expect(guard.DEFAULT_MAX_PIXELS).toBe(50000000);
    });

    it("rejects zero-sized, truncated and non-PNG headers with a header error", () => {
        for (const bad of [
            pngClaiming(0, 10),
            pngClaiming(10, 0),
            pngClaiming(5, 5).subarray(0, 20),
            Buffer.from("hi")
        ]) {
            let err;
            try {
                guard.assertPngDimensions(bad);
            } catch (e) {
                err = e;
            }
            expect(err && err.code).toBe("EIMAGEHEADER");
            expect(err.statusText).toBe("bad image header");
        }
    });

    it("reads the SOF marker of a JPEG and applies the same cap", () => {
        expect(guard.assertJpegDimensions(jpegClaiming(640, 480))).toEqual({ width: 640, height: 480 });
        expect(() => guard.assertJpegDimensions(jpegClaiming(20000, 20000))).toThrow(/image too large: 20000x20000/);
        expect(() => guard.assertImageDimensions(jpegClaiming(20000, 20000))).toThrow(/image too large/);
        expect(() => guard.assertJpegDimensions(jpegClaiming(640, 480), { maxPixels: 1000 })).toThrow(
            /image too large/
        );
    });

    (jpeg ? it : it.skip)("agrees with jpeg-js on a real encoded JPEG", () => {
        const encoded = jpeg.encode({ width: 5, height: 3, data: Buffer.alloc(5 * 3 * 4) }, 60).data;
        expect(guard.assertJpegDimensions(encoded)).toEqual({ width: 5, height: 3 });
        expect(jpeg.decode(encoded)).toMatchObject({ width: 5, height: 3 });
    });

    it("leaves a JPEG without a readable SOF, and other formats, to the decoder", () => {
        // SOI immediately followed by SOS: no frame header before the scan.
        expect(guard.assertJpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
        expect(guard.assertJpegDimensions(Buffer.from([0xff, 0xd8]))).toBeNull();
        expect(guard.assertJpegDimensions(Buffer.from("GIF89a"))).toBeNull();
        expect(guard.assertImageDimensions(Buffer.from("GIF89a"))).toBeNull();
        expect(guard.assertImageDimensions("not a buffer")).toBeNull();
        expect(guard.isPng(Buffer.from("GIF89a"))).toBe(false);
        expect(guard.isJpeg(jpegClaiming(1, 1))).toBe(true);
    });
});
