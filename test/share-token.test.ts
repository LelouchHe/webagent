import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateShareToken } from "../src/share/token.ts";

describe("generateShareToken", () => {
  it("produces 24 characters", () => {
    for (let i = 0; i < 20; i++) {
      assert.equal(generateShareToken().length, 24);
    }
  });

  it("uses base64url charset only (A-Z a-z 0-9 _ -)", () => {
    const pattern = /^[A-Za-z0-9_-]{24}$/;
    for (let i = 0; i < 50; i++) {
      const t = generateShareToken();
      assert.ok(pattern.test(t), `token ${t} contains non-base64url chars`);
    }
  });

  it("never includes base64 padding chars or slashes", () => {
    for (let i = 0; i < 50; i++) {
      const t = generateShareToken();
      assert.ok(!t.includes("="), "token has '='");
      assert.ok(!t.includes("+"), "token has '+'");
      assert.ok(!t.includes("/"), "token has '/'");
    }
  });

  it("generates unique tokens over 1000 calls (collision prob negligible)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const t = generateShareToken();
      assert.ok(!seen.has(t), `duplicate token ${t} at iteration ${i}`);
      seen.add(t);
    }
  });
});
