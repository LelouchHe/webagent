import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateShareToken,
  generateApiToken,
  generateSseTicket,
} from "../src/tokens.ts";

describe("tokens — auth-bearing token generators", () => {
  describe("generateShareToken", () => {
    it("produces 24 base64url characters (144 bits)", () => {
      const pattern = /^[A-Za-z0-9_-]{24}$/;
      for (let i = 0; i < 50; i++) {
        const t = generateShareToken();
        assert.equal(t.length, 24, `wrong length: ${t}`);
        assert.ok(pattern.test(t), `non-base64url chars in ${t}`);
      }
    });

    it("never includes base64 padding or non-url-safe chars", () => {
      for (let i = 0; i < 50; i++) {
        const t = generateShareToken();
        assert.ok(!t.includes("="), `padding in ${t}`);
        assert.ok(!t.includes("+"), `'+' in ${t}`);
        assert.ok(!t.includes("/"), `'/' in ${t}`);
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
