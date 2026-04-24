import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { assertOwner, OwnerAuthError } from "../src/share/auth.ts";

function fakeReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("assertOwner", () => {
  describe("accepts", () => {
    it("CF Access authenticated user", () => {
      assert.doesNotThrow(() =>
        assertOwner(fakeReq({ "cf-access-authenticated-user-email": "alice@example.com" })),
      );
    });

    it("Sec-Fetch-Site: same-origin", () => {
      assert.doesNotThrow(() =>
        assertOwner(fakeReq({ "sec-fetch-site": "same-origin", host: "localhost:6800" })),
      );
    });

    it("Sec-Fetch-Site: none (address bar navigation)", () => {
      assert.doesNotThrow(() =>
        assertOwner(fakeReq({ "sec-fetch-site": "none", host: "localhost:6800" })),
      );
    });

    it("Origin matches Host WITH Sec-Fetch-Site same-origin (belt + suspenders)", () => {
      assert.doesNotThrow(() =>
        assertOwner(fakeReq({ "sec-fetch-site": "same-origin", origin: "http://localhost:6800", host: "localhost:6800" })),
      );
    });
  });

  describe("rejects", () => {
    it("naked curl (no Origin, no Sec-Fetch, no CF) — 'no_origin_no_sec_fetch'", () => {
      assert.throws(
        () => assertOwner(fakeReq({ host: "localhost:6800" })),
        (e: unknown) => e instanceof OwnerAuthError && e.reason === "no_origin_no_sec_fetch",
      );
    });

    it("Origin set but no Sec-Fetch-Site — 'origin_without_sec_fetch' (curl signature)", () => {
      // Modern browsers always emit Sec-Fetch-Site alongside Origin.
      // Every Origin-only shape — match, mismatch, malformed, case-diff —
      // must collapse into the same reject reason so a future policy
      // loosening cannot accidentally re-enable a subset.
      const samples: Array<Record<string, string>> = [
        { origin: "http://localhost:6800", host: "localhost:6800" },       // match
        { origin: "https://example.com", host: "example.com" },             // match https
        { origin: "https://Example.COM", host: "example.com" },             // case-insensitive match
        { origin: "https://evil.com", host: "localhost:6800" },             // mismatch
        { origin: "not-a-url", host: "localhost:6800" },                    // malformed URL
      ];
      for (const headers of samples) {
        assert.throws(
          () => assertOwner(fakeReq(headers)),
          (e: unknown) => e instanceof OwnerAuthError && e.reason === "origin_without_sec_fetch",
          `expected 'origin_without_sec_fetch' for ${JSON.stringify(headers)}`,
        );
      }
    });

    it("Sec-Fetch-Site: cross-site — 'sec_fetch_cross_site'", () => {
      assert.throws(
        () =>
          assertOwner(
            fakeReq({ "sec-fetch-site": "cross-site", origin: "https://evil.com", host: "localhost:6800" }),
          ),
        (e: unknown) => e instanceof OwnerAuthError && e.reason === "sec_fetch_cross_site",
      );
    });

    it("Sec-Fetch-Site: same-site (sibling subdomain) — 'sec_fetch_cross_site'", () => {
      assert.throws(
        () => assertOwner(fakeReq({ "sec-fetch-site": "same-site", host: "a.example.com" })),
        (e: unknown) => e instanceof OwnerAuthError && e.reason === "sec_fetch_cross_site",
      );
    });

    it("CF Access header present but not an email shape — falls through to other checks", () => {
      // Empty or malformed CF header must not grant access
      assert.throws(() => assertOwner(fakeReq({ "cf-access-authenticated-user-email": "" })));
      assert.throws(() =>
        assertOwner(fakeReq({ "cf-access-authenticated-user-email": "not-an-email" })),
      );
    });
  });

  describe("precedence", () => {
    it("Sec-Fetch-Site cross-site rejects even with matching Origin (strict wins)", () => {
      // Modern browser signal is more trustworthy; reject regardless of Origin.
      assert.throws(
        () =>
          assertOwner(
            fakeReq({
              "sec-fetch-site": "cross-site",
              origin: "http://localhost:6800",
              host: "localhost:6800",
            }),
          ),
      );
    });

    it("CF Access accepted email bypasses even cross-site Sec-Fetch", () => {
      assert.doesNotThrow(() =>
        assertOwner(
          fakeReq({
            "cf-access-authenticated-user-email": "alice@example.com",
            "sec-fetch-site": "cross-site",
          }),
        ),
      );
    });
  });

  describe("OwnerAuthError", () => {
    it("has status 401", () => {
      const err = new OwnerAuthError("no_origin_no_sec_fetch");
      assert.equal(err.status, 401);
    });

    it("includes reason in default message", () => {
      const err = new OwnerAuthError("sec_fetch_cross_site");
      assert.match(err.message, /sec_fetch_cross_site/);
    });
  });
});
