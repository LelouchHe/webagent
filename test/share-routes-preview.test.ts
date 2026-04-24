import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "../src/store.ts";
import { handleShareRoutes, type ShareRouteDeps } from "../src/share/routes.ts";
import { clearProjectionCache } from "../src/share/projection.ts";
import { __clearAllLocks } from "../src/share/mutex.ts";
import type { Config } from "../src/config.ts";
import type { SessionManager } from "../src/session-manager.ts";

interface MockRes {
  res: ServerResponse;
  status(): number;
  body(): unknown;
  ended(): boolean;
}

function mockRes(): MockRes {
  let status = 0;
  let body = "";
  let ended = false;
  const headers: Record<string, string> = {};
  const res = {
    writeHead(code: number, h?: Record<string, string>) {
      status = code;
      if (h) Object.assign(headers, h);
      return res;
    },
    setHeader(k: string, v: string) { headers[k] = v; },
    end(chunk?: unknown) {
      if (typeof chunk === "string") body += chunk;
      ended = true;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    status: () => status,
    body: () => (body ? JSON.parse(body) : null),
    ended: () => ended,
  };
}

function mockReq(url: string, method: string, opts?: {
  body?: unknown;
  headers?: Record<string, string>;
}): IncomingMessage {
  const bodyStr = opts?.body != null ? JSON.stringify(opts.body) : "";
  const headers = {
    "sec-fetch-site": "same-origin",
    host: "localhost:6800",
    ...opts?.headers,
  };
  // Minimal IncomingMessage mock — needs .on for body reader.
  const listeners: Record<string, Array<(arg?: unknown) => void>> = { data: [], end: [], error: [] };
  const req = {
    url, method, headers,
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

const enabledCfg: Config["share"] = {
  enabled: true, ttl_hours: 0, csp_enforce: true, viewer_origin: "", internal_hosts: [],
};

function makeSessionsMock(opts?: { busy?: boolean }): Partial<SessionManager> {
  return {
    getBusyKind(_id: string) { return opts?.busy ? "agent" : null; },
    flushBuffers(_id: string) {},
  };
}

describe("share preview routes — POST /api/v1/sessions/:id/share", () => {
  let tmpDir: string;
  let store: Store;
  let deps: ShareRouteDeps;
  const sessionId = "sess-1";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wa-share-routes-"));
    store = new Store(tmpDir);
    store.createSession(sessionId, "/tmp/project");
    clearProjectionCache();
    __clearAllLocks();
    deps = {
      store,
      sessions: makeSessionsMock() as SessionManager,
      config: enabledCfg,
    };
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("401 when owner-auth fails (naked curl)", async () => {
    const m = mockRes();
    await handleShareRoutes(
      { url: `/api/v1/sessions/${sessionId}/share`, method: "POST", headers: {},
        on(_ev: string, cb: () => void) { setImmediate(cb); return this; } } as unknown as IncomingMessage,
      m.res, deps,
    );
    assert.equal(m.status(), 401);
  });

  it("404 when session does not exist", async () => {
    const m = mockRes();
    await handleShareRoutes(mockReq("/api/v1/sessions/ghost/share", "POST", { body: {} }), m.res, deps);
    assert.equal(m.status(), 404);
  });

  it("409 when session is busy with agent", async () => {
    deps.sessions = makeSessionsMock({ busy: true }) as SessionManager;
    const m = mockRes();
    await handleShareRoutes(mockReq(`/api/v1/sessions/${sessionId}/share`, "POST", { body: {} }), m.res, deps);
    assert.equal(m.status(), 409);
  });

  it("201 on first create; dedupes to 200 on second", async () => {
    // seed an event so snapshot_seq > 0
    store.saveEvent(sessionId, "assistant_message", { text: "hello" });

    const m1 = mockRes();
    await handleShareRoutes(mockReq(`/api/v1/sessions/${sessionId}/share`, "POST", { body: {} }), m1.res, deps);
    assert.equal(m1.status(), 201);
    const b1 = m1.body() as { token: string; snapshot_seq: number; reused: boolean };
    assert.ok(b1.token);
    assert.equal(b1.reused, false);
    assert.equal(b1.snapshot_seq, 1);

    const m2 = mockRes();
    await handleShareRoutes(mockReq(`/api/v1/sessions/${sessionId}/share`, "POST", { body: {} }), m2.res, deps);
    assert.equal(m2.status(), 200);
    const b2 = m2.body() as { token: string; reused: boolean };
    assert.equal(b2.token, b1.token, "should return same preview token");
    assert.equal(b2.reused, true);
  });

  it("400 when sanitize hard-rejects an event (private key)", async () => {
    store.saveEvent(sessionId, "assistant_message", {
      text: "key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END-----",
    });
    const m = mockRes();
    await handleShareRoutes(mockReq(`/api/v1/sessions/${sessionId}/share`, "POST", { body: {} }), m.res, deps);
    assert.equal(m.status(), 400);
    const b = m.body() as { error: string; event_id: number; rule: string };
    assert.equal(b.rule, "private_key");
    assert.ok(typeof b.event_id === "number");
    // And no preview row created (partial unique index unscarred).
    assert.equal(store.findActivePreviewBySession(sessionId), undefined);
  });

  it("accepts optional body fields (ttl_hours clamping, display_name, owner_label)", async () => {
    const m = mockRes();
    await handleShareRoutes(
      mockReq(`/api/v1/sessions/${sessionId}/share`, "POST", {
        body: { ttl_hours: 500, display_name: "Alice", owner_label: "demo" },
      }),
      m.res, deps,
    );
    assert.equal(m.status(), 201);
    const b = m.body() as { ttl_hours: number; display_name: string; owner_label: string };
    assert.equal(b.ttl_hours, 168, "clamped to MAX_TTL_HOURS");
    assert.equal(b.display_name, "Alice");
    assert.equal(b.owner_label, "demo");
  });

  it("ttl_hours=0 passes through (never expires)", async () => {
    const m = mockRes();
    await handleShareRoutes(
      mockReq(`/api/v1/sessions/${sessionId}/share`, "POST", { body: { ttl_hours: 0 } }),
      m.res, deps,
    );
    const b = m.body() as { ttl_hours: number };
    assert.equal(b.ttl_hours, 0);
  });

  it("concurrent requests serialize — second sees dedup", async () => {
    store.saveEvent(sessionId, "assistant_message", { text: "x" });
    const m1 = mockRes();
    const m2 = mockRes();
    await Promise.all([
      handleShareRoutes(mockReq(`/api/v1/sessions/${sessionId}/share`, "POST", { body: {} }), m1.res, deps),
      handleShareRoutes(mockReq(`/api/v1/sessions/${sessionId}/share`, "POST", { body: {} }), m2.res, deps),
    ]);
    const b1 = m1.body() as { token: string };
    const b2 = m2.body() as { token: string };
    assert.equal(b1.token, b2.token, "concurrent creates dedup under withSessionLock");
    // exactly one preview in db
    const rows = store.listOwnerShares();
    assert.equal(rows.length, 1);
  });
});

describe("share preview routes — GET /api/v1/sessions/:id/share/preview", () => {
  let tmpDir: string;
  let store: Store;
  let deps: ShareRouteDeps;
  const sessionId = "sess-1";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wa-share-preview-"));
    store = new Store(tmpDir);
    store.createSession(sessionId, "/tmp/project");
    store.updateSessionTitle(sessionId, "Test session");
    clearProjectionCache();
    __clearAllLocks();
    deps = {
      store,
      sessions: makeSessionsMock() as SessionManager,
      config: enabledCfg,
    };
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("400 when X-Share-Token header is missing", async () => {
    const m = mockRes();
    await handleShareRoutes(
      mockReq(`/api/v1/sessions/${sessionId}/share/preview`, "GET"),
      m.res, deps,
    );
    assert.equal(m.status(), 400);
  });

  it("404 when token unknown", async () => {
    const m = mockRes();
    await handleShareRoutes(
      mockReq(`/api/v1/sessions/${sessionId}/share/preview`, "GET", {
        headers: { "x-share-token": "nosuchtoken" },
      }),
      m.res, deps,
    );
    assert.equal(m.status(), 404);
  });

  it("200 returns sanitized events + staleness metadata", async () => {
    store.saveEvent(sessionId, "assistant_message", { text: "cd /tmp/project/src" });
    // Create preview
    const m0 = mockRes();
    await handleShareRoutes(mockReq(`/api/v1/sessions/${sessionId}/share`, "POST", { body: {} }), m0.res, deps);
    const token = (m0.body() as { token: string }).token;

    // Add one more event AFTER snapshot
    store.saveEvent(sessionId, "assistant_message", { text: "stale event" });

    const m = mockRes();
    await handleShareRoutes(
      mockReq(`/api/v1/sessions/${sessionId}/share/preview`, "GET", {
        headers: { "x-share-token": token },
      }),
      m.res, deps,
    );
    assert.equal(m.status(), 200);
    const b = m.body() as {
      schema_version: string;
      events: Array<{ data: { text: string } }>;
      share: { snapshot_seq: number; current_last_seq: number; events_since_snapshot: number };
    };
    assert.equal(b.schema_version, "1.0");
    assert.equal(b.events.length, 1, "stale event after snapshot excluded");
    assert.equal(b.events[0].data.text, "cd <cwd>/src", "sanitized cwd rewrite applied");
    assert.equal(b.share.snapshot_seq, 1);
    assert.equal(b.share.current_last_seq, 2);
    assert.equal(b.share.events_since_snapshot, 1);
  });

  it("409 when share already active", async () => {
    const m0 = mockRes();
    await handleShareRoutes(mockReq(`/api/v1/sessions/${sessionId}/share`, "POST", { body: {} }), m0.res, deps);
    const token = (m0.body() as { token: string }).token;
    store.activateShare(token);
    const m = mockRes();
    await handleShareRoutes(
      mockReq(`/api/v1/sessions/${sessionId}/share/preview`, "GET", {
        headers: { "x-share-token": token },
      }),
      m.res, deps,
    );
    assert.equal(m.status(), 409);
  });

  it("410 when share revoked", async () => {
    const m0 = mockRes();
    await handleShareRoutes(mockReq(`/api/v1/sessions/${sessionId}/share`, "POST", { body: {} }), m0.res, deps);
    const token = (m0.body() as { token: string }).token;
    store.revokeShare(token);
    const m = mockRes();
    await handleShareRoutes(
      mockReq(`/api/v1/sessions/${sessionId}/share/preview`, "GET", {
        headers: { "x-share-token": token },
      }),
      m.res, deps,
    );
    assert.equal(m.status(), 410);
  });
});
