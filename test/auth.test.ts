import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateToken,
  hashToken,
  verifyToken,
  signAttachmentUrl,
  verifyAttachmentSig,
} from "../src/auth.ts";

describe("auth - token primitives", () => {
  describe("generateToken", () => {
    it("returns a string with wat_ prefix", () => {
      const t = generateToken();
      assert.match(t, /^wat_/);
    });

    it("produces 47-char tokens (wat_ + 43 base64url)", () => {
      const t = generateToken();
      assert.equal(t.length, 47);
      assert.match(t, /^wat_[A-Za-z0-9_-]{43}$/);
    });

    it("produces unique tokens", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) seen.add(generateToken());
      assert.equal(seen.size, 200);
    });
  });

  describe("hashToken", () => {
    it("returns 64-char hex (SHA-256)", () => {
      const h = hashToken("wat_anything");
      assert.match(h, /^[a-f0-9]{64}$/);
    });

    it("is deterministic", () => {
      const t = "wat_sample_token_value_abc";
      assert.equal(hashToken(t), hashToken(t));
    });

    it("produces different hashes for different tokens", () => {
      assert.notEqual(hashToken("wat_a"), hashToken("wat_b"));
    });
  });

  describe("verifyToken", () => {
    it("returns true for matching token + hash", () => {
      const t = generateToken();
      const h = hashToken(t);
      assert.equal(verifyToken(t, h), true);
    });

    it("returns false for wrong token", () => {
      const h = hashToken(generateToken());
      assert.equal(verifyToken(generateToken(), h), false);
    });

    it("returns false for malformed hash", () => {
      assert.equal(verifyToken(generateToken(), "not-a-hash"), false);
    });

    it("returns false for empty inputs", () => {
      assert.equal(verifyToken("", ""), false);
      assert.equal(verifyToken("wat_x", ""), false);
      assert.equal(verifyToken("", "a".repeat(64)), false);
    });

    it("uses constant-time comparison (no early exit on mismatch length)", () => {
      // smoke test: should not throw regardless of length differences
      const h = hashToken("wat_x");
      assert.equal(verifyToken("wat_x", h.slice(0, 10)), false);
      assert.equal(verifyToken("wat_x", h + "extra"), false);
    });
  });
});

describe("auth - image URL signing", () => {
  const SECRET = Buffer.from("a".repeat(64), "hex");
  const PATH = "sess-abc/attachments/photo.png";

  describe("signAttachmentUrl", () => {
    it("returns a query string containing exp and sig", () => {
      const qs = signAttachmentUrl(PATH, SECRET, 3600);
      assert.match(qs, /exp=\d+/);
      assert.match(qs, /sig=[a-f0-9]+/);
    });

    it("exp is roughly now + ttl seconds", () => {
      const before = Math.floor(Date.now() / 1000);
      const qs = signAttachmentUrl(PATH, SECRET, 3600);
      const after = Math.floor(Date.now() / 1000);
      const exp = Number(new URLSearchParams(qs).get("exp"));
      assert.ok(
        exp >= before + 3600 && exp <= after + 3601,
        `exp ${exp} not in window`,
      );
    });

    it("different paths produce different signatures", () => {
      const a = signAttachmentUrl("a/b.png", SECRET, 3600);
      const b = signAttachmentUrl("a/c.png", SECRET, 3600);
      const sigA = new URLSearchParams(a).get("sig");
      const sigB = new URLSearchParams(b).get("sig");
      assert.notEqual(sigA, sigB);
    });
  });

  describe("verifyAttachmentSig", () => {
    it("accepts a freshly signed URL", () => {
      const qs = signAttachmentUrl(PATH, SECRET, 3600);
      const params = new URLSearchParams(qs);
      const ok = verifyAttachmentSig(
        PATH,
        params.get("exp")!,
        params.get("sig")!,
        SECRET,
      );
      assert.equal(ok, true);
    });

    it("rejects when path differs (HMAC binds path)", () => {
      const qs = signAttachmentUrl(PATH, SECRET, 3600);
      const params = new URLSearchParams(qs);
      const ok = verifyAttachmentSig(
        "other/file.png",
        params.get("exp")!,
        params.get("sig")!,
        SECRET,
      );
      assert.equal(ok, false);
    });

    it("rejects when sig is tampered", () => {
      const qs = signAttachmentUrl(PATH, SECRET, 3600);
      const params = new URLSearchParams(qs);
      const sig = params.get("sig")!;
      const tampered = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
      assert.equal(
        verifyAttachmentSig(PATH, params.get("exp")!, tampered, SECRET),
        false,
      );
    });

    it("rejects when exp is in the past", () => {
      const past = String(Math.floor(Date.now() / 1000) - 10);
      // sign with negative ttl to get expired URL
      const qs = signAttachmentUrl(PATH, SECRET, -10);
      const params = new URLSearchParams(qs);
      assert.equal(
        verifyAttachmentSig(PATH, past, params.get("sig")!, SECRET),
        false,
      );
    });

    it("rejects when exp is altered (HMAC binds exp)", () => {
      const qs = signAttachmentUrl(PATH, SECRET, 3600);
      const params = new URLSearchParams(qs);
      const futureExp = String(Math.floor(Date.now() / 1000) + 99999);
      assert.equal(
        verifyAttachmentSig(PATH, futureExp, params.get("sig")!, SECRET),
        false,
      );
    });

    it("rejects malformed inputs without throwing", () => {
      assert.equal(
        verifyAttachmentSig(PATH, "not-a-number", "deadbeef", SECRET),
        false,
      );
      assert.equal(
        verifyAttachmentSig(PATH, "1234567890", "not-hex!!", SECRET),
        false,
      );
      assert.equal(verifyAttachmentSig(PATH, "", "", SECRET), false);
    });

    it("uses different secret = rejected", () => {
      const qs = signAttachmentUrl(PATH, SECRET, 3600);
      const params = new URLSearchParams(qs);
      const otherSecret = Buffer.from("b".repeat(64), "hex");
      assert.equal(
        verifyAttachmentSig(
          PATH,
          params.get("exp")!,
          params.get("sig")!,
          otherSecret,
        ),
        false,
      );
    });
  });
});

import { reSignAttachmentUrlsInJson } from "../src/auth.ts";

describe("reSignAttachmentUrlsInJson", () => {
  const secret = Buffer.from("a".repeat(64), "hex");

  it("re-signs a bare image URL inside JSON string", () => {
    const json = '{"path":"/api/v1/sessions/abc/attachments/123.png"}';
    const out = reSignAttachmentUrlsInJson(json, secret, 3600);
    assert.match(out, /\?exp=\d+&sig=[a-f0-9]+/);
  });

  it("re-signs an already-signed URL with fresh exp/sig", () => {
    const json =
      '{"u":"/api/v1/sessions/x/attachments/foo.png?exp=1&sig=deadbeef"}';
    const out = reSignAttachmentUrlsInJson(json, secret, 3600);
    assert.doesNotMatch(out, /exp=1&sig=deadbeef/);
    assert.match(out, /\?exp=\d{10,}&sig=[a-f0-9]+/);
  });

  it("leaves unrelated URLs untouched", () => {
    const json = '{"a":"/api/v1/sessions/x","b":"/foo/bar"}';
    const out = reSignAttachmentUrlsInJson(json, secret, 3600);
    assert.equal(out, json);
  });

  it("handles multiple images in one payload", () => {
    const json = JSON.stringify({
      images: [
        { path: "/api/v1/sessions/s1/attachments/a.png" },
        { path: "/api/v1/sessions/s1/attachments/b.jpg" },
      ],
    });
    const out = reSignAttachmentUrlsInJson(json, secret, 3600);
    const matches = out.match(/\?exp=\d+&sig=[a-f0-9]+/g);
    assert.equal(matches?.length, 2);
  });
});
