import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "../src/store.ts";
import { handleShareRoutes } from "../src/share/routes.ts";
import type { Config } from "../src/config.ts";

/** Minimal mock res capturing status/body. */
function mockRes(): {
  res: ServerResponse;
  status: () => number;
  body: () => string;
  ended: () => boolean;
} {
  let status = 0;
  let body = "";
  let ended = false;
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    setHeader() {},
    end(chunk?: unknown) {
      if (typeof chunk === "string") body += chunk;
      ended = true;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    status: () => status,
    body: () => body,
    ended: () => ended,
  };
}

function mockReq(url: string, method = "GET"): IncomingMessage {
  return { url, method, headers: {} } as IncomingMessage;
}

const enabledCfg: Config["share"] = {
  enabled: true,
  ttl_hours: 0,
  csp_enforce: true,
  viewer_origin: "",
  internal_hosts: [],
};
const disabledCfg: Config["share"] = { ...enabledCfg, enabled: false };

describe("handleShareRoutes skeleton", () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-routes-"));
    store = new Store(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("disabled: returns false (does not intercept anything)", async () => {
    const m = mockRes();
    const handled = await handleShareRoutes(mockReq("/s/abc"), m.res, {
      store,
      config: disabledCfg,
    });
    assert.equal(handled, false);
    assert.equal(m.ended(), false);
  });

  it("enabled: claims /s/:token (24-char token, unknown -> 410)", async () => {
    const m = mockRes();
    // 24-char base64url token format; not in store -> 410 revoked/not-found path.
    const fakeToken = "AAAAAAAAAAAAAAAAAAAAAAAA";
    const handled = await handleShareRoutes(mockReq(`/s/${fakeToken}`), m.res, {
      store,
      config: enabledCfg,
      publicDir: "/tmp",
    });
    assert.equal(handled, true);
    assert.equal(m.status(), 410);
  });

  it("enabled: claims /api/v1/sessions/:id/share POST (now implemented)", async () => {
    const m = mockRes();
    const handled = await handleShareRoutes(
      mockReq("/api/v1/sessions/s1/share", "POST"),
      m.res,
      { store, config: enabledCfg },
    );
    assert.equal(handled, true);
    // POST /share is the real route (C2); session 's1' doesn't exist in the
    // skeleton fixture, so we expect 404 — but the point of this test is
    // route-claim, not behavior.
  });

  it("enabled: claims /api/v1/sessions/:id/share/publish", async () => {
    const m = mockRes();
    const handled = await handleShareRoutes(
      mockReq("/api/v1/sessions/s1/share/publish", "POST"),
      m.res,
      { store, config: enabledCfg },
    );
    assert.equal(handled, true);
  });

  it("enabled: claims /api/v1/shares and /api/v1/shared/:token", async () => {
    for (const url of [
      "/api/v1/shares",
      "/api/v1/shares/abc",
      "/api/v1/shared/abc",
      "/api/v1/shared/abc/events",
    ]) {
      const m = mockRes();
      const handled = await handleShareRoutes(mockReq(url), m.res, {
        store,
        config: enabledCfg,
      });
      assert.equal(handled, true, `should claim ${url}`);
    }
  });

  it("enabled: does NOT intercept existing routes", async () => {
    for (const url of [
      "/api/v1/sessions",
      "/api/v1/sessions/s1",
      "/api/v1/sessions/s1/events",
      "/api/v1/config",
      "/index.html",
      "/",
    ]) {
      const m = mockRes();
      const handled = await handleShareRoutes(mockReq(url), m.res, {
        store,
        config: enabledCfg,
      });
      assert.equal(handled, false, `should NOT claim ${url}`);
    }
  });

  // Guard against substring false-positives.
  it("enabled: does NOT intercept /api/v1/sessions/:id/sharefoo (not a share route)", async () => {
    const m = mockRes();
    const handled = await handleShareRoutes(
      mockReq("/api/v1/sessions/s1/sharefoo"),
      m.res,
      { store, config: enabledCfg },
    );
    assert.equal(handled, false);
  });
});
