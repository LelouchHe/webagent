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

  it("returns null for non-image bytes", () => {
    assert.equal(readImageDimensions(Buffer.from("hello")), null);
  });
});
