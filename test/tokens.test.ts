import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateShareToken,
  generateApiToken,
  generateSseTicket,
} from "../src/tokens.ts";

describe("tokens — auth-bearing token generators", () => {
  describe("generateShareToken", () => {
    it("produces 36 lowercase hex characters (144 bits / double-click-friendly)", () => {
      const pattern = /^[0-9a-f]{36}$/;
      for (let i = 0; i < 50; i++) {
        const t = generateShareToken();
        assert.equal(t.length, 36, `wrong length: ${t}`);
        assert.ok(pattern.test(t), `non-hex chars in ${t}`);
      }
    });

    it("contains no word-boundary chars (double-click selects whole token)", () => {
      // Hex is a strict subset of [A-Za-z0-9]; no '-' or '_' which break
      // double-click word selection in browsers.
      for (let i = 0; i < 50; i++) {
        const t = generateShareToken();
        assert.ok(!t.includes("-"), `share token has '-': ${t}`);
        assert.ok(!t.includes("_"), `share token has '_': ${t}`);
      }
    });

    it("generates unique tokens over 1000 calls", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const t = generateShareToken();
        assert.ok(!seen.has(t), `duplicate at ${i}: ${t}`);
        seen.add(t);
      }
    });
  });

  describe("generateApiToken", () => {
    it("returns wat_ prefix + 43 base64url chars (47 total / 256 bits)", () => {
      const pattern = /^wat_[A-Za-z0-9_-]{43}$/;
      for (let i = 0; i < 50; i++) {
        const t = generateApiToken();
        assert.equal(t.length, 47, `wrong length: ${t}`);
        assert.ok(pattern.test(t), `bad shape: ${t}`);
      }
    });

    it("never includes base64 padding or non-url-safe chars", () => {
      for (let i = 0; i < 50; i++) {
        const t = generateApiToken();
        assert.ok(!t.includes("="), `padding in ${t}`);
        assert.ok(!t.includes("+"), `'+' in ${t}`);
        assert.ok(!t.includes("/"), `'/' in ${t}`);
      }
    });

    it("generates unique tokens over 200 calls", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) seen.add(generateApiToken());
      assert.equal(seen.size, 200);
    });
  });

  describe("generateSseTicket", () => {
    it("produces 32 base64url chars (192 bits)", () => {
      const pattern = /^[A-Za-z0-9_-]{32}$/;
      for (let i = 0; i < 50; i++) {
        const t = generateSseTicket();
        assert.equal(t.length, 32, `wrong length: ${t}`);
        assert.ok(pattern.test(t), `bad shape: ${t}`);
      }
    });

    it("never includes base64 padding or non-url-safe chars", () => {
      for (let i = 0; i < 50; i++) {
        const t = generateSseTicket();
        assert.ok(!t.includes("="), `padding in ${t}`);
        assert.ok(!t.includes("+"), `'+' in ${t}`);
        assert.ok(!t.includes("/"), `'/' in ${t}`);
      }
    });

    it("generates unique tickets over 200 calls", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) seen.add(generateSseTicket());
      assert.equal(seen.size, 200);
    });
  });
});
