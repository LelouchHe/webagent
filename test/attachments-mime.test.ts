import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sniffMime, mimeToExt } from "../src/attachments.ts";

describe("sniffMime", () => {
  it("detects PDF magic bytes regardless of client-supplied mime", async () => {
    const pdf = Buffer.concat([
      Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]),
      Buffer.alloc(64),
    ]);
    assert.equal(await sniffMime(pdf), "application/pdf");
  });

  it("detects PNG magic bytes", async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
    ]);
    assert.equal(await sniffMime(png), "image/png");
  });

  it("detects ZIP magic bytes", async () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    assert.equal(await sniffMime(zip), "application/zip");
  });

  it("classifies Clojure source as text/plain", async () => {
    const clj = Buffer.from(
      `(defn hello [] (println "hi"))\n;; comment\n(+ 1 2)`,
      "utf8",
    );
    assert.equal(await sniffMime(clj), "text/plain");
  });

  it("classifies UTF-8 Chinese text as text/plain", async () => {
    const cjk = Buffer.from("你好,这是一个测试\n第二行\n", "utf8");
    assert.equal(await sniffMime(cjk), "text/plain");
  });

  it("classifies random binary as octet-stream", async () => {
    // Random non-magic bytes containing a NUL — clearly binary.
    const bin = Buffer.from([
      0x12, 0xab, 0x00, 0xcd, 0xef, 0x42, 0x00, 0x99, 0x55,
    ]);
    assert.equal(await sniffMime(bin), "application/octet-stream");
  });

  it("classifies invalid UTF-8 byte sequence as octet-stream", async () => {
    // Lone continuation byte 0x80 — not valid UTF-8, no NUL, not a known magic.
    const bad = Buffer.from([0x80, 0x81, 0x82, 0x83]);
    assert.equal(await sniffMime(bad), "application/octet-stream");
  });

  it("treats empty buffer as text/plain (degenerate but harmless)", async () => {
    assert.equal(await sniffMime(Buffer.alloc(0)), "text/plain");
  });

  it("trusts content over a lying client mime: PDF bytes always win", async () => {
    // Same PDF buffer; the function takes only the buffer, so a client
    // claiming image/png cannot mislead it.
    const pdf = Buffer.concat([
      Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
      Buffer.alloc(32),
    ]);
    assert.equal(await sniffMime(pdf), "application/pdf");
  });
});

describe("mimeToExt", () => {
  it("maps known mimes to extensions", () => {
    assert.equal(mimeToExt("application/pdf"), "pdf");
    assert.equal(mimeToExt("image/png"), "png");
    assert.equal(mimeToExt("text/plain"), "txt");
    assert.equal(mimeToExt("application/zip"), "zip");
    assert.equal(mimeToExt("application/json"), "json");
  });

  it("falls through to bin for unknown mimes", () => {
    assert.equal(mimeToExt("application/x-something-weird"), "bin");
    assert.equal(mimeToExt("application/octet-stream"), "bin");
  });

  it("is case-insensitive", () => {
    assert.equal(mimeToExt("APPLICATION/PDF"), "pdf");
    assert.equal(mimeToExt("Image/PNG"), "png");
  });
});
