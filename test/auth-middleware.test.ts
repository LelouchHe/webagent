import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthStore } from "../src/auth-store.ts";
import {
  isWhitelistedPath,
  authenticate,
  requireScope,
  type AuthResult,
} from "../src/auth-middleware.ts";

describe("auth-middleware", () => {
  describe("isWhitelistedPath", () => {
    it("allows known unauthenticated endpoints", () => {
      assert.equal(isWhitelistedPath("GET", "/api/v1/version"), true);
      assert.equal(isWhitelistedPath("GET", "/api/beta/push/vapid-key"), true);
    });

    it("allows static assets and root", () => {
      assert.equal(isWhitelistedPath("GET", "/"), true);
      assert.equal(isWhitelistedPath("GET", "/login"), true);
      assert.equal(isWhitelistedPath("GET", "/manifest.json"), true);
      assert.equal(isWhitelistedPath("GET", "/sw.js"), true);
      assert.equal(isWhitelistedPath("GET", "/favicon.ico"), true);
      assert.equal(isWhitelistedPath("GET", "/icons/icon-192.png"), true);
      assert.equal(isWhitelistedPath("GET", "/js/app.abc12345.js"), true);
      assert.equal(isWhitelistedPath("GET", "/styles.abc12345.css"), true);
    });

    it("blocks all /api/** by default", () => {
      assert.equal(isWhitelistedPath("GET", "/api/v1/sessions"), false);
      assert.equal(
        isWhitelistedPath("POST", "/api/v1/sessions/x/messages"),
        false,
      );
      assert.equal(isWhitelistedPath("DELETE", "/api/v1/tokens/laptop"), false);
      assert.equal(isWhitelistedPath("GET", "/api/v1/auth/verify"), false);
    });

    it("blocks non-whitelisted methods on whitelisted paths", () => {
      assert.equal(isWhitelistedPath("POST", "/api/v1/version"), false);
      assert.equal(isWhitelistedPath("DELETE", "/"), false);
    });

    it("does not allow path traversal tricks", () => {
      assert.equal(
        isWhitelistedPath("GET", "/api/v1/version/../sessions"),
        false,
      );
      assert.equal(isWhitelistedPath("GET", "/icons/../auth.json"), false);
    });
  });

  describe("authenticate", () => {
    let tmpDir: string;
    let store: AuthStore;
    let validToken: string;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "webagent-mw-"));
      store = new AuthStore(join(tmpDir, "auth.json"));
      await store.load();
      const result = await store.addToken("laptop", "admin");
      validToken = result.token;
    });

    afterEach(async () => {
      await store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function authHeader(token: string | null): Record<string, string> {
      return token ? { authorization: `Bearer ${token}` } : {};
    }

    it("returns ok=true for valid Bearer token", () => {
      const r = authenticate(authHeader(validToken), store);
      assert.equal(r.ok, true);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- type narrowing
      if (r.ok) {
        assert.equal(r.principal.name, "laptop");
        assert.equal(r.principal.scope, "admin");
      }
    });

    it("returns ok=false for missing header", () => {
      const r = authenticate({}, store);
      assert.equal(r.ok, false);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- type narrowing
      if (!r.ok) assert.equal(r.reason, "missing");
    });

    it("returns ok=false for malformed header", () => {
      assert.equal(
        authenticate({ authorization: "Token foo" }, store).ok,
        false,
      );
      assert.equal(authenticate({ authorization: "Bearer" }, store).ok, false);
      assert.equal(authenticate({ authorization: "" }, store).ok, false);
      assert.equal(
        authenticate({ authorization: "Bearer  " }, store).ok,
        false,
      );
    });

    it("returns ok=false for unknown token", () => {
      const r = authenticate(authHeader("wat_unknownunknown"), store);
      assert.equal(r.ok, false);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- type narrowing
      if (!r.ok) assert.equal(r.reason, "invalid");
    });

    it("returns ok=false for revoked token", async () => {
      await store.revokeToken("laptop");
      const r = authenticate(authHeader(validToken), store);
      assert.equal(r.ok, false);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- type narrowing
      if (!r.ok) assert.equal(r.reason, "invalid");
    });

    it("touches lastUsedAt on successful auth", () => {
      const before = store.findByToken(validToken)!.lastUsedAt;
      assert.equal(before, null);
      const r = authenticate(authHeader(validToken), store);
      assert.equal(r.ok, true);
      const after = store.findByToken(validToken)!.lastUsedAt;
      assert.ok(after && after > 0);
    });

    it("supports case-insensitive Bearer scheme", () => {
      assert.equal(
        authenticate({ authorization: `bearer ${validToken}` }, store).ok,
        true,
      );
      assert.equal(
        authenticate({ authorization: `BEARER ${validToken}` }, store).ok,
        true,
      );
    });

    it("array authorization headers are rejected", () => {
      // Node may pass array if duplicated header
      const r = authenticate(
        { authorization: [`Bearer ${validToken}`, `Bearer foo`] },
        store,
      );
      assert.equal(r.ok, false);
    });
  });

  describe("requireScope", () => {
    function admin(): AuthResult {
      return {
        ok: true,
        principal: {
          name: "a",
          scope: "admin",
          lastUsedAt: null,
          createdAt: 0,
          hash: "x",
        },
      };
    }
    function api(): AuthResult {
      return {
        ok: true,
        principal: {
          name: "b",
          scope: "api",
          lastUsedAt: null,
          createdAt: 0,
          hash: "x",
        },
      };
    }

    it("admin scope passes admin requirement", () => {
      assert.equal(requireScope(admin(), "admin"), true);
    });

    it("api scope fails admin requirement", () => {
      assert.equal(requireScope(api(), "admin"), false);
    });

    it("admin scope passes api requirement (admin is superset)", () => {
      assert.equal(requireScope(admin(), "api"), true);
    });

    it("api scope passes api requirement", () => {
      assert.equal(requireScope(api(), "api"), true);
    });

    it("non-ok auth always fails scope check", () => {
      const r: AuthResult = { ok: false, reason: "missing" };
      assert.equal(requireScope(r, "api"), false);
      assert.equal(requireScope(r, "admin"), false);
    });
  });
});
