import { afterEach, describe, it } from "node:test";
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
  const originalNow = Date.now;

  afterEach(() => {
    Date.now = originalNow;
  });

  it("re-signs a bare image URL inside JSON string", () => {
    const json = '{"path":"/api/v1/tasks/abc/attachments/123.png"}';
    const out = reSignAttachmentUrlsInJson(json, secret, 3600);
    assert.match(out, /\?exp=\d+&sig=[a-f0-9]+/);
  });

  it("re-signs an already-signed URL with fresh exp/sig", () => {
    const json =
      '{"u":"/api/v1/tasks/x/attachments/foo.png?exp=1&sig=deadbeef"}';
    const out = reSignAttachmentUrlsInJson(json, secret, 3600);
    assert.doesNotMatch(out, /exp=1&sig=deadbeef/);
    assert.match(out, /\?exp=\d{10,}&sig=[a-f0-9]+/);
  });

  it("leaves unrelated URLs untouched", () => {
    const json = '{"a":"/api/v1/tasks/x","b":"/foo/bar"}';
    const out = reSignAttachmentUrlsInJson(json, secret, 3600);
    assert.equal(out, json);
  });

  it("handles multiple images in one payload", () => {
    const json = JSON.stringify({
      images: [
        { path: "/api/v1/tasks/s1/attachments/a.png" },
        { path: "/api/v1/tasks/s1/attachments/b.jpg" },
      ],
    });
    const out = reSignAttachmentUrlsInJson(json, secret, 3600);
    const matches = out.match(/\?exp=\d+&sig=[a-f0-9]+/g);
    assert.equal(matches?.length, 2);
  });

  it("reuses one query for repeated paths while its safety margin remains", () => {
    let now = 1_800_000_000_000;
    Date.now = () => now;
    const json =
      '{"path":"/api/v1/tasks/stable/attachments/same.png?exp=1&sig=deadbeef"}';
    const first = reSignAttachmentUrlsInJson(json, secret, 3600);
    now += 30_000;
    const second = reSignAttachmentUrlsInJson(json, secret, 3600);
    assert.equal(second, first);
  });

  it("refreshes near expiry for the same path", () => {
    let now = 1_800_000_000_000;
    Date.now = () => now;
    const json = '{"path":"/api/v1/tasks/refresh/attachments/same.png"}';
    const first = reSignAttachmentUrlsInJson(json, secret, 3600);
    now += 3_541_000;
    const second = reSignAttachmentUrlsInJson(json, secret, 3600);
    assert.notEqual(second, first);
    assert.match(second, /\?exp=\d+&sig=[a-f0-9]+/);
  });

  it("isolates cache entries by secret identity and attachment path", () => {
    Date.now = () => 1_800_000_000_000;
    const pathA = "/api/v1/tasks/cache/attachments/a.png";
    const pathB = "/api/v1/tasks/cache/attachments/b.png";
    const otherSecret = Buffer.from("b".repeat(64), "hex");
    const firstA = reSignAttachmentUrlsInJson(
      JSON.stringify({ pathA }),
      secret,
    );
    const secondA = reSignAttachmentUrlsInJson(
      JSON.stringify({ pathA }),
      secret,
    );
    const firstB = reSignAttachmentUrlsInJson(
      JSON.stringify({ pathB }),
      secret,
    );
    const other = reSignAttachmentUrlsInJson(
      JSON.stringify({ pathA }),
      otherSecret,
    );
    assert.equal(secondA, firstA);
    const parse = (json: string): URL =>
      new URL(
        (JSON.parse(json) as { pathA?: string; pathB?: string }).pathA ??
          (JSON.parse(json) as { pathB: string }).pathB,
        "http://localhost",
      );
    const urlA = parse(firstA);
    const urlB = parse(firstB);
    const urlOther = parse(other);
    assert.notEqual(urlB.searchParams.get("sig"), urlA.searchParams.get("sig"));
    assert.notEqual(
      urlOther.searchParams.get("sig"),
      urlA.searchParams.get("sig"),
    );
    for (const [path, url, key] of [
      [pathA, urlA, secret],
      [pathB, urlB, secret],
      [pathA, urlOther, otherSecret],
    ] as const) {
      assert.equal(
        verifyAttachmentSig(
          path,
          url.searchParams.get("exp")!,
          url.searchParams.get("sig")!,
          key,
        ),
        true,
      );
    }
  });

  it("replaces expired input with the valid cached query", () => {
    Date.now = () => 1_800_000_000_000;
    const path = "/api/v1/tasks/expired/attachments/old.png";
    const out = reSignAttachmentUrlsInJson(
      JSON.stringify({ path: `${path}?exp=1&sig=deadbeef` }),
      secret,
    );
    const url = new URL(
      (JSON.parse(out) as { path: string }).path,
      "http://localhost",
    );
    assert.equal(
      verifyAttachmentSig(
        path,
        url.searchParams.get("exp")!,
        url.searchParams.get("sig")!,
        secret,
      ),
      true,
    );
  });

  it("bounds entries per secret and evicts the oldest path", () => {
    Date.now = () => 1_800_000_000_000;
    const boundedSecret = Buffer.from("c".repeat(64), "hex");
    const firstZero = reSignAttachmentUrlsInJson(
      JSON.stringify({
        path: "/api/v1/tasks/cap/attachments/0.png",
      }),
      boundedSecret,
    );
    const originalZero = new URLSearchParams(
      new URL(
        (JSON.parse(firstZero) as { path: string }).path,
        "http://localhost",
      ).search,
    ).get("exp");
    for (let i = 1; i <= 2048; i++) {
      reSignAttachmentUrlsInJson(
        JSON.stringify({
          path: `/api/v1/tasks/cap/attachments/${i}.png`,
        }),
        boundedSecret,
      );
    }
    Date.now = () => 1_800_000_500_000;
    const retained = reSignAttachmentUrlsInJson(
      JSON.stringify({
        path: "/api/v1/tasks/cap/attachments/1.png",
      }),
      boundedSecret,
    );
    const evicted = reSignAttachmentUrlsInJson(
      JSON.stringify({
        path: "/api/v1/tasks/cap/attachments/0.png",
      }),
      boundedSecret,
    );
    const retainedPath = (JSON.parse(retained) as { path: string }).path;
    const evictedPath = (JSON.parse(evicted) as { path: string }).path;
    assert.equal(
      new URL(retainedPath, "http://localhost").searchParams.get("exp"),
      String(1_800_003_600),
    );
    assert.notEqual(
      new URL(evictedPath, "http://localhost").searchParams.get("exp"),
      originalZero,
    );
  });
});
