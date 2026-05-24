import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readImageDimensions } from "../src/image-dimensions.ts";

describe("readImageDimensions", () => {
  it("reads PNG IHDR dimensions", () => {
    const buf = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x01, 0x40, 0x00, 0x00, 0x00, 0xf0,
    ]);
    assert.deepEqual(readImageDimensions(buf), { width: 320, height: 240 });
  });

  it("reads GIF logical screen dimensions", () => {
    const buf = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00,
    ]);
    assert.deepEqual(readImageDimensions(buf), { width: 320, height: 240 });
  });

  it("reads JPEG SOF dimensions in width-height order", () => {
    const buf = Buffer.from([
      0xff, 0xd8,
      // APP0 segment, length 4 (2 payload bytes)
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      // SOF0 segment, length 17. Precision=8, height=240, width=320.
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xf0, 0x01, 0x40, 0x03, 0x01, 0x11,
      0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    ]);
    assert.deepEqual(readImageDimensions(buf), { width: 320, height: 240 });
  });

  it("returns null for non-image bytes", () => {
    assert.equal(readImageDimensions(Buffer.from("hello")), null);
  });
});
