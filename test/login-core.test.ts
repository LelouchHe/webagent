import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";
import {
  verifyAndStoreToken,
  consumeUrlHashToken,
  TOKEN_STORAGE_KEY,
} from "../public/js/login-core.ts";

describe("login-core", () => {
  beforeEach(() => {
    setupDOM();
  });
  afterEach(() => {
    teardownDOM();
  });

  describe("verifyAndStoreToken", () => {
    it("rejects empty input without calling fetch", async () => {
      let fetchCalled = false;
      const fetchFn = async () => {
        fetchCalled = true;
        return new Response("", { status: 200 });
      };
      const r = await verifyAndStoreToken("", { fetch: fetchFn });
      assert.equal(r.ok, false);
      assert.match(r.error, /empty|required/i);
      assert.equal(fetchCalled, false);
      assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), null);
    });

    it("trims whitespace from token before sending", async () => {
      let captured: { url: string; auth: string } | null = null;
      const fetchFn = async (url: string | URL, init?: RequestInit) => {
        captured = {
          url: String(url),
          auth: String(
            (init?.headers as Record<string, string> | undefined)
              ?.Authorization ?? "",
          ),
        };
        return new Response(
          JSON.stringify({ ok: true, name: "x", scope: "admin" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      };
      const r = await verifyAndStoreToken("  wat_padded  \n", {
        fetch: fetchFn as typeof fetch,
      });
      assert.equal(r.ok, true);
      const c = captured as { url: string; auth: string } | null;
      assert.ok(c); // runtime guard
      assert.equal(c.auth, "Bearer wat_padded");
      assert.equal(c.url, "/api/v1/auth/verify");
    });

    it("stores token in localStorage on 200", async () => {
      const fetchFn: typeof fetch = async () =>
        new Response(
          JSON.stringify({ ok: true, name: "lap", scope: "admin" }),
          { status: 200 },
        );
      const r = await verifyAndStoreToken("wat_good", { fetch: fetchFn });
      assert.equal(r.ok, true);
      assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), "wat_good");
    });

    it("does NOT store token on 401", async () => {
      const fetchFn: typeof fetch = async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
        });
      const r = await verifyAndStoreToken("wat_bad", { fetch: fetchFn });
      assert.equal(r.ok, false);
      assert.match(r.error, /invalid|reject/i);
      assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), null);
    });

    it("reports network failure without storing", async () => {
      const fetchFn: typeof fetch = async () => {
        throw new Error("ECONNREFUSED");
      };
      const r = await verifyAndStoreToken("wat_x", { fetch: fetchFn });
      assert.equal(r.ok, false);
      assert.match(r.error, /network|connection|ECONNREFUSED/i);
      assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), null);
    });

    it("treats unexpected status as failure (not 200/401)", async () => {
      const fetchFn: typeof fetch = async () =>
        new Response("oops", { status: 500 });
      const r = await verifyAndStoreToken("wat_x", { fetch: fetchFn });
      assert.equal(r.ok, false);
    });

    it("returns name + scope on success", async () => {
      const fetchFn: typeof fetch = async () =>
        new Response(
          JSON.stringify({ ok: true, name: "phone", scope: "api" }),
          { status: 200 },
        );
      const r = await verifyAndStoreToken("wat_x", { fetch: fetchFn });
      assert.equal(r.ok, true);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- type narrowing
      if (r.ok) {
        assert.equal(r.name, "phone");
        assert.equal(r.scope, "api");
      }
    });
  });

  describe("consumeUrlHashToken", () => {
    function setHash(hash: string): void {
      // happy-dom 接受 location.hash 直接赋值
      location.hash = hash;
    }

    it("consumes a valid #t= fragment and stores token", () => {
      setHash("#t=wat_AbCdEf123-_");
      const r = consumeUrlHashToken();
      assert.equal(r.ok, true);
      assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), "wat_AbCdEf123-_");
      assert.equal(location.hash, "", "hash should be cleared");
    });

    it("preserves pathname and search when clearing the hash", () => {
      // happy-dom 不允许直接改 location.pathname,只能用 history API
      history.pushState(null, "", "/login?next=foo#t=wat_xyz");
      const r = consumeUrlHashToken();
      assert.equal(r.ok, true);
      assert.equal(location.pathname, "/login");
      assert.equal(location.search, "?next=foo");
      assert.equal(location.hash, "");
    });

    it("rejects hash without wat_ prefix", () => {
      setHash("#t=notatoken");
      const r = consumeUrlHashToken();
      assert.equal(r.ok, false);
      assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), null);
      assert.equal(location.hash, "#t=notatoken", "hash should be preserved");
    });

    it("rejects hash with disallowed characters in token body", () => {
      setHash("#t=wat_with spaces");
      const r = consumeUrlHashToken();
      assert.equal(r.ok, false);
      assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), null);
    });

    it("rejects hash with wrong key (e.g. #token=...)", () => {
      setHash("#token=wat_xyz");
      const r = consumeUrlHashToken();
      assert.equal(r.ok, false);
      assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), null);
    });

    it("rejects empty hash", () => {
      // 默认无 hash
      const r = consumeUrlHashToken();
      assert.equal(r.ok, false);
      assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), null);
    });

    it("rejects hash with extra trailing junk after token", () => {
      setHash("#t=wat_xyz&other=1");
      const r = consumeUrlHashToken();
      assert.equal(r.ok, false);
      assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), null);
    });
  });
});
