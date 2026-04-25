import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";
import { verifyAndStoreToken, TOKEN_STORAGE_KEY } from "../public/js/login-core.ts";

describe("login-core", () => {
  beforeEach(() => setupDOM());
  afterEach(() => teardownDOM());

  describe("verifyAndStoreToken", () => {
    it("rejects empty input without calling fetch", async () => {
      let fetchCalled = false;
      const fetchFn = async () => {
        fetchCalled = true;
        return new Response("", { status: 200 });
      };
      const r = await verifyAndStoreToken("", { fetch: fetchFn });
      assert.equal(r.ok, false);
      assert.match(r.error!, /empty|required/i);
      assert.equal(fetchCalled, false);
      assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), null);
    });

    it("trims whitespace from token before sending", async () => {
      let captured: { url: string; auth: string } | null = null;
      const fetchFn = async (url: string | URL, init?: RequestInit) => {
        captured = {
          url: String(url),
          auth: String((init?.headers as Record<string, string>)?.Authorization ?? ""),
        };
        return new Response(JSON.stringify({ ok: true, name: "x", scope: "admin" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };
      const r = await verifyAndStoreToken("  wat_padded  \n", { fetch: fetchFn as typeof fetch });
      assert.equal(r.ok, true);
      assert.ok(captured);
      assert.equal(captured!.auth, "Bearer wat_padded");
      assert.equal(captured!.url, "/api/v1/auth/verify");
    });

    it("stores token in localStorage on 200", async () => {
      const fetchFn: typeof fetch = async () =>
        new Response(JSON.stringify({ ok: true, name: "lap", scope: "admin" }), { status: 200 });
      const r = await verifyAndStoreToken("wat_good", { fetch: fetchFn });
      assert.equal(r.ok, true);
      assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), "wat_good");
    });

    it("does NOT store token on 401", async () => {
      const fetchFn: typeof fetch = async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      const r = await verifyAndStoreToken("wat_bad", { fetch: fetchFn });
      assert.equal(r.ok, false);
      assert.match(r.error!, /invalid|reject/i);
      assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), null);
    });

    it("reports network failure without storing", async () => {
      const fetchFn: typeof fetch = async () => {
        throw new Error("ECONNREFUSED");
      };
      const r = await verifyAndStoreToken("wat_x", { fetch: fetchFn });
      assert.equal(r.ok, false);
      assert.match(r.error!, /network|connection|ECONNREFUSED/i);
      assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), null);
    });

    it("treats unexpected status as failure (not 200/401)", async () => {
      const fetchFn: typeof fetch = async () => new Response("oops", { status: 500 });
      const r = await verifyAndStoreToken("wat_x", { fetch: fetchFn });
      assert.equal(r.ok, false);
    });

    it("returns name + scope on success", async () => {
      const fetchFn: typeof fetch = async () =>
        new Response(JSON.stringify({ ok: true, name: "phone", scope: "api" }), { status: 200 });
      const r = await verifyAndStoreToken("wat_x", { fetch: fetchFn });
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.equal(r.name, "phone");
        assert.equal(r.scope, "api");
      }
    });
  });
});
