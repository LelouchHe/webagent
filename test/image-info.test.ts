import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { imageSize } from "image-size";
import { readImageInfo } from "../src/image-info.ts";
import { gif, jpeg, png } from "./image-bytes.ts";

// Header-only fixtures over the shared builders: `image-bytes.ts` takes the
// total byte length first, and a container header is all the parser needs.
const pngHeader = (width: number, height: number) => png(24, width, height);
const gifHeader = (width: number, height: number) => gif(10, width, height);
const jpegHeader = (width: number, height: number, sof = 0xc0) =>
  jpeg(26, width, height, sof);

/** RIFF/WEBP wrapper around one chunk body. */
function webp(chunk: string, body: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(12 + body.length, 4);
  head.write("WEBP", 8, "latin1");
  head.write(chunk, 12, "latin1");
  head.writeUInt32LE(body.length, 16);
  return Buffer.concat([head, body]);
}

/** Lossy: `VP8 ` chunk, dimensions little-endian after the start code. */
function webpLossy(width: number, height: number): Buffer {
  const body = Buffer.alloc(10);
  body[0] = 0x30; // frame tag low byte
  body[3] = 0x9d;
  body[4] = 0x01;
  body[5] = 0x2a;
  body.writeUInt16LE(width, 6);
  body.writeUInt16LE(height, 8);
  return webp("VP8 ", body);
}

/** Lossless: `VP8L` chunk, 14-bit width then 14-bit height, both minus one. */
function webpLossless(width: number, height: number): Buffer {
  const body = Buffer.alloc(10);
  const w = width - 1;
  const h = height - 1;
  body[0] = 0x2f; // signature byte
  body[1] = w & 0xff;
  body[2] = ((w >> 8) & 0x3f) | ((h & 0x3) << 6);
  body[3] = (h >> 2) & 0xff;
  body[4] = (h >> 10) & 0xf;
  return webp("VP8L", body);
}

/** Extended: `VP8X` chunk, 24-bit canvas width and height, both minus one. */
function webpExtended(width: number, height: number): Buffer {
  const body = Buffer.alloc(10);
  body[0] = 0x00; // flags: no ICC/alpha/EXIF/XMP, no reserved bits
  body.writeUIntLE(width - 1, 4, 3);
  body.writeUIntLE(height - 1, 7, 3);
  return webp("VP8X", body);
}

function bmp(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("BM", 0, "latin1");
  buf.writeUInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  return buf;
}

/** A minimal AVIF: ftyp/meta/iprp/ipco/ispe, a container we do not store. */
function avif(width: number, height: number): Buffer {
  const box = (name: string, children: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + children.length, 0);
    head.write(name, 4, "latin1");
    return Buffer.concat([head, children]);
  };
  const ispeBody = Buffer.alloc(12); // version/flags, width, height
  ispeBody.writeUInt32BE(width, 4);
  ispeBody.writeUInt32BE(height, 8);
  const meta = box(
    "meta",
    Buffer.concat([
      Buffer.alloc(4),
      box("iprp", box("ipco", box("ispe", ispeBody))),
    ]),
  );
  const ftypBody = Buffer.from("avif", "latin1"); // major brand
  return Buffer.concat([box("ftyp", ftypBody), meta]);
}

describe("readImageInfo: containers and dimensions", () => {
  it("reads PNG IHDR dimensions", () => {
    assert.deepEqual(readImageInfo(pngHeader(320, 240)), {
      mime: "image/png",
      width: 320,
      height: 240,
    });
  });

  it("reads GIF logical screen dimensions", () => {
    assert.deepEqual(readImageInfo(gifHeader(320, 240)), {
      mime: "image/gif",
      width: 320,
      height: 240,
    });
  });

  it("reads JPEG SOF dimensions in width-height order", () => {
    assert.deepEqual(readImageInfo(jpegHeader(320, 240)), {
      mime: "image/jpeg",
      width: 320,
      height: 240,
    });
  });

  it("reads a lossy WebP (`VP8 `) frame header", () => {
    assert.deepEqual(readImageInfo(webpLossy(320, 240)), {
      mime: "image/webp",
      width: 320,
      height: 240,
    });
  });

  it("reads a lossless WebP (`VP8L`) bit-packed size", () => {
    assert.deepEqual(readImageInfo(webpLossless(300, 200)), {
      mime: "image/webp",
      width: 300,
      height: 200,
    });
  });

  it("reads an extended WebP (`VP8X`) canvas size", () => {
    assert.deepEqual(readImageInfo(webpExtended(640, 480)), {
      mime: "image/webp",
      width: 640,
      height: 480,
    });
  });

  it("reads a progressive JPEG (SOF2): strict is not baseline-only", () => {
    assert.deepEqual(readImageInfo(jpegHeader(320, 240, 0xc2)), {
      mime: "image/jpeg",
      width: 320,
      height: 240,
    });
  });

  it("drops a zero dimension instead of reserving a zero-height box", () => {
    // The container is still recognized; only an unusable size is discarded.
    assert.deepEqual(readImageInfo(pngHeader(0, 240)), {
      mime: "image/png",
      width: null,
      height: null,
    });
  });
});

describe("readImageInfo: refusals", () => {
  it("refuses BMP even though the library parses its dimensions", () => {
    const bytes = bmp(64, 32);
    assert.equal(imageSize(bytes).type, "bmp");
    assert.equal(readImageInfo(bytes), null);
  });

  it("refuses AVIF even though the library parses its dimensions", () => {
    const bytes = avif(48, 32);
    assert.deepEqual(
      { ...imageSize(bytes), type: imageSize(bytes).type },
      { width: 48, height: 32, type: "avif" },
    );
    assert.equal(readImageInfo(bytes), null);
  });

  it("refuses SVG text, which the library also measures", () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    );
    assert.equal(imageSize(svg).type, "svg");
    assert.equal(readImageInfo(svg), null);
  });

  it("returns null for bytes no container claims", () => {
    assert.equal(readImageInfo(Buffer.from("hello")), null);
    assert.equal(readImageInfo(Buffer.alloc(0)), null);
  });
});

describe("readImageInfo: a container whose header cannot be parsed", () => {
  it("refuses a PNG that carries only its signature, with no IHDR", () => {
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(40),
    ]);
    assert.equal(readImageInfo(bytes), null);
  });

  it("refuses a lossless JPEG (SOF3), which no browser renders", () => {
    // The bytes are a well-formed JPEG: SOI, APP0, then a SOF3 frame header
    // with width and height. Kindling a layout box for a picture the client
    // cannot decode would only put a broken image in the transcript, so this
    // frame type is refused on purpose. SOF3/5-15 are all in that group.
    const bytes = jpegHeader(320, 240, 0xc3);
    assert.equal(bytes.subarray(0, 3).toString("hex"), "ffd8ff");
    assert.equal(readImageInfo(bytes), null);
  });

  it("refuses a non-container that merely resembles one", () => {
    assert.equal(readImageInfo(Buffer.from([0xff, 0xd8])), null);
  });
});
