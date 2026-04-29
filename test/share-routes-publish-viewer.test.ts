import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "../src/store.ts";
import { handleShareRoutes, type ShareRouteDeps } from "../src/share/routes.ts";
import type { Config } from "../src/config.ts";

// --- test doubles ---

interface MockRes {
  res: ServerResponse;
  status(): number;
  body(): string;
  json(): unknown;
  headers(): Record<string, string>;
}

function mockRes(): MockRes {
  let status = 0;
  let body = "";
  const headers: Record<string, string> = {};
  const res = {
    writeHead(code: number, h?: Record<string, string>) {
      status = code;
      if (h) Object.assign(headers, h);
      return res;
    },
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    end(chunk?: unknown) {
      if (chunk instanceof Buffer) body += chunk.toString("binary");
      else if (typeof chunk === "string") body += chunk;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    status: () => status,
    body: () => body,
    json: () => {
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    },
    headers: () => headers,
  };
}

function ownerReq(
  url: string,
  method = "GET",
  opts?: { body?: unknown; headers?: Record<string, string> },
): IncomingMessage {
  const bodyStr = opts?.body != null ? JSON.stringify(opts.body) : "";
  const headers = {
    "sec-fetch-site": "same-origin",
    host: "localhost:6800",
    ...opts?.headers,
  };
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {
    data: [],
    end: [],
    error: [],
  };
  const req = {
    url,
    method,
    headers,
    on(ev: string, cb: (arg?: unknown) => void) {
      listeners[ev].push(cb);
      return req;
    },
  };
  queueMicrotask(() => {
    if (bodyStr) for (const cb of listeners.data) cb(Buffer.from(bodyStr));
    for (const cb of listeners.end) cb();
  });
  return req as unknown as IncomingMessage;
}

function publicReq(url: string, method = "GET"): IncomingMessage {
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {
    data: [],
    end: [],
    error: [],
  };
  const req = {
    url,
    method,
    headers: { host: "public.example.com" } as Record<string, string>,
    on(ev: string, cb: (arg?: unknown) => void) {
      listeners[ev].push(cb);
      return req;
    },
  };
  queueMicrotask(() => {
    for (const cb of listeners.end) cb();
  });
  return req as unknown as IncomingMessage;
}

const enabledCfg: Config["share"] = {
  enabled: true,
  ttl_hours: 0,
  csp_enforce: true,
  viewer_origin: "",
  internal_hosts: [],
};

async function createAndPublishShare(
  deps: ShareRouteDeps,
  sessionId: string,
  extraBody?: Record<string, unknown>,
): Promise<{ token: string }> {
  // Create preview first.
  const r1 = mockRes();
  await handleShareRoutes(
    ownerReq(`/api/v1/sessions/${sessionId}/share`, "POST", { body: {} }),
    r1.res,
    deps,
  );
  assert.equal(r1.status(), 201, `preview create failed: ${r1.body()}`);
  const token = (r1.json() as { token: string }).token;

  // Publish.
  const r2 = mockRes();
  await handleShareRoutes(
    ownerReq(`/api/v1/sessions/${sessionId}/share/publish`, "POST", {
      body: { token, ...extraBody },
    }),
    r2.res,
    deps,
  );
  assert.equal(r2.status(), 200, `publish failed: ${r2.body()}`);
  return { token };
}

// --- tests ---

describe("share publish route — POST /api/v1/sessions/:id/share/publish", () => {
  let tmpDir: string;
  let store: Store;
  let deps: ShareRouteDeps;
  const sessionId = "sess-pub";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wa-share-pub-"));
    store = new Store(tmpDir);
    store.createSession(sessionId, "/tmp/project");
    store.saveEvent(
      sessionId,
      "user_message",
      { text: "hi" },
      { from_ref: "agent" },
    );
    store.saveEvent(
      sessionId,
      "assistant_message",
      { text: "hello" },
      { from_ref: "agent" },
    );
    deps = { store, config: enabledCfg, dataDir: tmpDir, publicDir: "/tmp" };
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("activates preview, flips shared_at, returns public_url", async () => {
    const r1 = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sessionId}/share`, "POST", { body: {} }),
      r1.res,
      deps,
    );
    const token = (r1.json() as { token: string }).token;

    const r2 = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sessionId}/share/publish`, "POST", {
        body: { token, display_name: "alice" },
      }),
      r2.res,
      deps,
    );
    assert.equal(r2.status(), 200);
    const body = r2.json() as {
      token: string;
      shared_at: number;
      display_name: string;
      public_url: string;
    };
    assert.equal(body.token, token);
    assert.ok(body.shared_at > 0);
    assert.equal(body.display_name, "alice");
    assert.match(body.public_url, new RegExp(`/s/${token}$`));

    // Verify row moved.
    const row = store.getShareByToken(token);
    assert.ok(row);
    assert.ok(row.shared_at != null);
    // display_name persisted into owner_prefs for next default.
    assert.equal(store.getOwnerPref("share.default_display_name"), "alice");
  });

  it("409 on double-publish", async () => {
    const { token } = await createAndPublishShare(deps, sessionId);
    const r = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sessionId}/share/publish`, "POST", {
        body: { token },
      }),
      r.res,
      deps,
    );
    assert.equal(r.status(), 409);
  });

  it("404 on publishing a revoked (hard-deleted) preview", async () => {
    const r1 = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sessionId}/share`, "POST", { body: {} }),
      r1.res,
      deps,
    );
    const token = (r1.json() as { token: string }).token;
    store.revokeShare(token);

    const r2 = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sessionId}/share/publish`, "POST", {
        body: { token },
      }),
      r2.res,
      deps,
    );
    assert.equal(r2.status(), 404);
  });

  it("404 when token does not belong to this session", async () => {
    const other = "sess-other";
    store.createSession(other, "/tmp/other");
    store.saveEvent(
      other,
      "user_message",
      { text: "x" },
      { from_ref: "agent" },
    );
    const r1 = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${other}/share`, "POST", { body: {} }),
      r1.res,
      deps,
    );
    const token = (r1.json() as { token: string }).token;

    const r2 = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sessionId}/share/publish`, "POST", {
        body: { token },
      }),
      r2.res,
      deps,
    );
    assert.equal(r2.status(), 404);
  });

  it("400 when body.token missing", async () => {
    const r = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sessionId}/share/publish`, "POST", {
        body: {},
      }),
      r.res,
      deps,
    );
    assert.equal(r.status(), 400);
  });

  it("V3: rejects bidi override in display_name at publish (previously silently null'd)", async () => {
    const r1 = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sessionId}/share`, "POST", {
        body: { display_name: "alice" },
      }),
      r1.res,
      deps,
    );
    const token = (r1.json() as { token: string }).token;

    const r2 = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sessionId}/share/publish`, "POST", {
        body: { token, display_name: "evil\u202etxt" },
      }),
      r2.res,
      deps,
    );
    assert.equal(r2.status(), 400);
    assert.match((r2.json() as { error: string }).error, /bidi override/);

    // Preview row's display_name is preserved (not nulled by the failed publish).
    const row = store.getShareByToken(token);
    assert.ok(row, "share row exists");
    assert.equal(row.display_name, "alice");
    assert.equal(row.shared_at, null, "publish rejected → still a preview");
  });

  it("V3: rejects over-limit owner_label at publish (UTF-8 bytes, not UTF-16 length)", async () => {
    const r1 = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sessionId}/share`, "POST", { body: {} }),
      r1.res,
      deps,
    );
    const token = (r1.json() as { token: string }).token;

    const r2 = mockRes();
    // 1024 UTF-16 chars of 𝕏 = 2048 UTF-8 bytes > 1024
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sessionId}/share/publish`, "POST", {
        body: { token, owner_label: "𝕏".repeat(300) },
      }),
      r2.res,
      deps,
    );
    assert.equal(r2.status(), 400);
    assert.match((r2.json() as { error: string }).error, /exceeds 1024 bytes/);
  });
});

describe("share public viewer — GET /s/:token + /api/v1/shared/:token/events", () => {
  let tmpDir: string;
  let publicDir: string;
  let store: Store;
  let deps: ShareRouteDeps;
  const sessionId = "sess-view";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wa-share-view-"));
    publicDir = mkdtempSync(join(tmpdir(), "wa-share-public-"));
    writeFileSync(
      join(publicDir, "share-viewer.html"),
      "<!doctype html><html><body data-viewer>ok</body></html>",
    );
    store = new Store(tmpDir);
    store.createSession(sessionId, "/tmp/project");
    store.saveEvent(
      sessionId,
      "user_message",
      { text: "question" },
      { from_ref: "agent" },
    );
    store.saveEvent(
      sessionId,
      "assistant_message",
      { text: "answer" },
      { from_ref: "agent" },
    );
    deps = { store, config: enabledCfg, dataDir: tmpDir, publicDir };
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(publicDir, { recursive: true, force: true });
  });

  it("GET /s/:token -> 410 for unknown token", async () => {
    const bogus = "AAAAAAAAAAAAAAAAAAAAAAAA"; // 24 chars
    const r = mockRes();
    await handleShareRoutes(publicReq(`/s/${bogus}`), r.res, deps);
    assert.equal(r.status(), 410);
    // CSP still set on error pages.
    assert.match(
      r.headers()["Content-Security-Policy"] ?? "",
      /default-src 'self'/,
    );
  });

  it("GET /s/:token -> 410 for preview (not yet activated)", async () => {
    // Preview-only token; never publish.
    const r1 = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sessionId}/share`, "POST", { body: {} }),
      r1.res,
      deps,
    );
    const token = (r1.json() as { token: string }).token;

    const r = mockRes();
    await handleShareRoutes(publicReq(`/s/${token}`), r.res, deps);
    assert.equal(r.status(), 410);
  });

  it("GET /s/:token -> 200 HTML with CSP + no-frame + noindex headers after publish", async () => {
    const { token } = await createAndPublishShare(deps, sessionId);
    const r = mockRes();
    await handleShareRoutes(publicReq(`/s/${token}`), r.res, deps);
    assert.equal(r.status(), 200);
    const h = r.headers();
    assert.match(h["Content-Type"] ?? "", /text\/html/);
    const csp = h["Content-Security-Policy"] ?? "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.equal(h["X-Frame-Options"], "DENY");
    assert.equal(h["Referrer-Policy"], "no-referrer");
    assert.match(h["X-Robots-Tag"] ?? "", /noindex/);
    assert.match(r.body(), /data-viewer/);
  });

  it("GET /s/:token -> CSP-Report-Only when csp_enforce=false", async () => {
    deps.config = { ...enabledCfg, csp_enforce: false };
    const { token } = await createAndPublishShare(deps, sessionId);
    const r = mockRes();
    await handleShareRoutes(publicReq(`/s/${token}`), r.res, deps);
    assert.equal(r.status(), 200);
    const h = r.headers();
    assert.ok(
      h["Content-Security-Policy-Report-Only"],
      "must emit report-only header",
    );
    assert.ok(!h["Content-Security-Policy"], "must not emit enforcing header");
  });

  it("GET /api/v1/shared/:token/events -> 200 JSON with sanitized events, NO session_id leak", async () => {
    const { token } = await createAndPublishShare(deps, sessionId);
    const r = mockRes();
    await handleShareRoutes(
      publicReq(`/api/v1/shared/${token}/events`),
      r.res,
      deps,
    );
    assert.equal(r.status(), 200);
    const body = r.json() as {
      share: Record<string, unknown>;
      events: unknown[];
    };
    // session_id MUST NOT be in the public JSON.
    assert.ok(
      !("session_id" in body.share),
      "session_id leaked to public viewer",
    );
    assert.ok(Array.isArray(body.events));
    assert.ok(body.events.length >= 2);
    assert.match(r.headers()["Content-Type"] ?? "", /application\/json/);
    assert.match(r.headers()["Cache-Control"] ?? "", /no-store/);
  });

  it("GET /api/v1/shared/:token/events -> 410 for revoked share", async () => {
    const { token } = await createAndPublishShare(deps, sessionId);
    store.revokeShare(token);
    const r = mockRes();
    await handleShareRoutes(
      publicReq(`/api/v1/shared/${token}/events`),
      r.res,
      deps,
    );
    assert.equal(r.status(), 410);
  });

  it("GET /api/v1/shared/:token/events -> 410 for preview token", async () => {
    const r1 = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sessionId}/share`, "POST", { body: {} }),
      r1.res,
      deps,
    );
    const token = (r1.json() as { token: string }).token;

    const r = mockRes();
    await handleShareRoutes(
      publicReq(`/api/v1/shared/${token}/events`),
      r.res,
      deps,
    );
    assert.equal(r.status(), 410);
  });

  it("GET /s/:token -> 410 after ttl expiry", async () => {
    // TTL 1h, publish with shared_at manually rewound 2h.
    const r1 = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sessionId}/share`, "POST", {
        body: { ttl_hours: 1 },
      }),
      r1.res,
      deps,
    );
    const token = (r1.json() as { token: string }).token;

    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sessionId}/share/publish`, "POST", {
        body: { token },
      }),
      mockRes().res,
      deps,
    );
    // Rewind shared_at 2h past to expire.
    const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
    store["db"]
      .prepare("UPDATE shares SET shared_at = ? WHERE token = ?")
      .run(twoHoursAgo, token);

    const r = mockRes();
    await handleShareRoutes(publicReq(`/s/${token}`), r.res, deps);
    assert.equal(r.status(), 410);
  });
});

describe("share image proxy — GET /s/:token/attachments/:file", () => {
  let tmpDir: string;
  let publicDir: string;
  let store: Store;
  let deps: ShareRouteDeps;
  const sessionId = "sess-img";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wa-share-img-"));
    publicDir = mkdtempSync(join(tmpdir(), "wa-share-img-pub-"));
    writeFileSync(join(publicDir, "share-viewer.html"), "<!doctype html>");
    mkdirSync(join(tmpDir, "sessions", sessionId, "attachments"), {
      recursive: true,
    });
    writeFileSync(
      join(tmpDir, "sessions", sessionId, "attachments", "a.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    store = new Store(tmpDir);
    store.createSession(sessionId, "/tmp/project");
    store.saveEvent(
      sessionId,
      "user_message",
      { text: "see img" },
      { from_ref: "agent" },
    );
    deps = { store, config: enabledCfg, dataDir: tmpDir, publicDir };
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(publicDir, { recursive: true, force: true });
  });

  it("serves image for active share", async () => {
    const { token } = await createAndPublishShare(deps, sessionId);
    const r = mockRes();
    await handleShareRoutes(
      publicReq(`/s/${token}/attachments/a.png`),
      r.res,
      deps,
    );
    assert.equal(r.status(), 200);
    assert.equal(r.headers()["Content-Type"], "image/png");
    assert.equal(r.headers()["X-Content-Type-Options"], "nosniff");
  });

  it("rejects path traversal", async () => {
    const { token } = await createAndPublishShare(deps, sessionId);
    // encoded %2f and ../
    const r = mockRes();
    await handleShareRoutes(
      publicReq(`/s/${token}/attachments/..%2f..%2fetc%2fpasswd`),
      r.res,
      deps,
    );
    // route matcher won't allow / or encoded /, path regex will reject dots
    // -> either 404 from matcher (url doesn't match /s/:token/attachments/:file) or 404 from invalid file.
    // We assert it does NOT return 200.
    assert.notEqual(r.status(), 200);
  });

  it("404 for invalid filename chars", async () => {
    const { token } = await createAndPublishShare(deps, sessionId);
    const r = mockRes();
    await handleShareRoutes(
      publicReq(`/s/${token}/attachments/.hidden`),
      r.res,
      deps,
    );
    assert.equal(r.status(), 404);
  });

  it("410 when share revoked", async () => {
    const { token } = await createAndPublishShare(deps, sessionId);
    store.revokeShare(token);
    const r = mockRes();
    await handleShareRoutes(
      publicReq(`/s/${token}/attachments/a.png`),
      r.res,
      deps,
    );
    assert.equal(r.status(), 410);
  });

  it("410 for preview-only token", async () => {
    const r1 = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sessionId}/share`, "POST", { body: {} }),
      r1.res,
      deps,
    );
    const token = (r1.json() as { token: string }).token;
    const r = mockRes();
    await handleShareRoutes(
      publicReq(`/s/${token}/attachments/a.png`),
      r.res,
      deps,
    );
    assert.equal(r.status(), 410);
  });
});
