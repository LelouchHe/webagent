import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "../src/store.ts";
import {
  handleShareRoutes,
  type ShareRouteDeps,
  validateLabel,
} from "../src/share/routes.ts";
import { clearProjectionCache } from "../src/share/projection.ts";
import { __clearAllLocks } from "../src/share/mutex.ts";
import type { Config } from "../src/config.ts";

interface MockRes {
  res: ServerResponse;
  status(): number;
  body(): string;
  json(): unknown;
}
function mockRes(): MockRes {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number, _h?: Record<string, string>) {
      status = code;
      return res;
    },
    setHeader() {},
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
  };
}

function ownerReq(
  url: string,
  method = "GET",
  body?: unknown,
): IncomingMessage {
  const bodyStr = body != null ? JSON.stringify(body) : "";
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {
    data: [],
    end: [],
    error: [],
  };
  const req = {
    url,
    method,
    headers: {
      "sec-fetch-site": "same-origin",
      host: "localhost:6800",
    } as Record<string, string>,
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
    headers: { host: "pub" } as Record<string, string>,
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

const cfg: Config["share"] = {
  enabled: true,
  ttl_hours: 0,
  csp_enforce: true,
  viewer_origin: "",
  internal_hosts: [],
};

async function createPreview(
  deps: ShareRouteDeps,
  sessionId: string,
): Promise<string> {
  const r = mockRes();
  await handleShareRoutes(
    ownerReq(`/api/v1/sessions/${sessionId}/share`, "POST", {}),
    r.res,
    deps,
  );
  assert.equal(r.status(), 201, r.body());
  return (r.json() as { token: string }).token;
}

async function publish(
  deps: ShareRouteDeps,
  sessionId: string,
  token: string,
): Promise<void> {
  const r = mockRes();
  await handleShareRoutes(
    ownerReq(`/api/v1/sessions/${sessionId}/share/publish`, "POST", { token }),
    r.res,
    deps,
  );
  assert.equal(r.status(), 200, r.body());
}

describe("validateLabel — owner text rules", () => {
  it("accepts empty / plain utf-8", () => {
    assert.deepEqual(validateLabel("", "x"), { ok: true, value: "" });
    assert.deepEqual(validateLabel("hello 中文", "x"), {
      ok: true,
      value: "hello 中文",
    });
    assert.deepEqual(validateLabel("tab\there", "x"), {
      ok: true,
      value: "tab\there",
    });
  });

  it("rejects control chars and DEL", () => {
    assert.equal(validateLabel("bad\x00", "x").ok, false);
    assert.equal(validateLabel("bad\x01end", "x").ok, false);
    assert.equal(validateLabel("bad\x1f", "x").ok, false);
    assert.equal(validateLabel("bad\x7f", "x").ok, false);
  });

  it("rejects bidi overrides / isolates", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE
    assert.equal(validateLabel("nice\u202eevil.exe", "x").ok, false);
    // U+2067 RIGHT-TO-LEFT ISOLATE
    assert.equal(validateLabel("\u2067trick", "x").ok, false);
  });

  it("rejects >1024 bytes utf8", () => {
    assert.equal(validateLabel("x".repeat(1025), "x").ok, false);
    // 4-byte char × 257 = 1028 > 1024
    assert.equal(validateLabel("𝕏".repeat(257), "x").ok, false);
    // 1024 exactly passes
    assert.equal(validateLabel("x".repeat(1024), "x").ok, true);
  });

  it("accepts unpaired surrogates (V3: dropped check — renders as U+FFFD, no security impact)", () => {
    assert.equal(validateLabel("\uD800", "x").ok, true);
    assert.equal(validateLabel("abc\uDC00", "x").ok, true);
    // Valid surrogate pair is also accepted.
    assert.equal(validateLabel("\uD83D\uDE00", "x").ok, true); // 😀
  });

  it("honors maxBytes parameter (display_name uses 256, owner_label uses 1024)", () => {
    assert.equal(validateLabel("x".repeat(257), "display_name", 256).ok, false);
    assert.equal(validateLabel("x".repeat(256), "display_name", 256).ok, true);
    assert.equal(validateLabel("𝕏".repeat(65), "display_name", 256).ok, false); // 4 bytes × 65 = 260
  });

  it("rejects non-string", () => {
    assert.equal(validateLabel(42, "x").ok, false);
    assert.equal(validateLabel({}, "x").ok, false);
  });
});

describe("DELETE /api/v1/sessions/:id/share — revoke", () => {
  let tmpDir: string;
  let store: Store;
  let deps: ShareRouteDeps;
  const sid = "s1";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wa-share-rvk-"));
    store = new Store(tmpDir);
    store.createSession(sid, "/tmp/p");
    store.saveEvent(sid, "user_message", { text: "hi" }, { from_ref: "agent" });
    clearProjectionCache();
    __clearAllLocks();
    deps = { store, config: cfg, dataDir: tmpDir, publicDir: "/tmp" };
  });
  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("401 without owner headers", async () => {
    const r = mockRes();
    await handleShareRoutes(
      publicReq(`/api/v1/sessions/${sid}/share`, "DELETE"),
      r.res,
      deps,
    );
    assert.equal(r.status(), 401);
  });

  it("400 when token missing", async () => {
    const r = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sid}/share`, "DELETE", {}),
      r.res,
      deps,
    );
    assert.equal(r.status(), 400);
  });

  it("revokes active share and flips viewer to 410", async () => {
    const token = await createPreview(deps, sid);
    await publish(deps, sid, token);

    const r = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sid}/share`, "DELETE", { token }),
      r.res,
      deps,
    );
    assert.equal(r.status(), 200);
    const j = r.json() as {
      ok: boolean;
      revoked: boolean;
      purge_status: string;
    };
    assert.equal(j.ok, true);
    assert.equal(j.revoked, true);
    assert.equal(j.purge_status, "skipped");

    // Public viewer JSON now 410.
    const r2 = mockRes();
    await handleShareRoutes(
      publicReq(`/api/v1/shared/${token}/events`),
      r2.res,
      deps,
    );
    assert.equal(r2.status(), 410);
  });

  it("idempotent: second revoke returns revoked=false", async () => {
    const token = await createPreview(deps, sid);
    await publish(deps, sid, token);
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sid}/share`, "DELETE", { token }),
      mockRes().res,
      deps,
    );
    const r = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sid}/share`, "DELETE", { token }),
      r.res,
      deps,
    );
    assert.equal(r.status(), 200);
    assert.equal((r.json() as { revoked: boolean }).revoked, false);
  });

  it("404 if token belongs to a different session", async () => {
    store.createSession("s2", "/tmp/p2");
    store.saveEvent(
      "s2",
      "user_message",
      { text: "hi2" },
      { from_ref: "agent" },
    );
    const tokenS2 = await createPreview(deps, "s2");
    const r = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sid}/share`, "DELETE", { token: tokenS2 }),
      r.res,
      deps,
    );
    assert.equal(r.status(), 404);
  });
});

describe("PATCH /api/v1/sessions/:id/share — label/display_name", () => {
  let tmpDir: string;
  let store: Store;
  let deps: ShareRouteDeps;
  const sid = "s1";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wa-share-pch-"));
    store = new Store(tmpDir);
    store.createSession(sid, "/tmp/p");
    store.saveEvent(sid, "user_message", { text: "hi" }, { from_ref: "agent" });
    clearProjectionCache();
    __clearAllLocks();
    deps = { store, config: cfg, dataDir: tmpDir, publicDir: "/tmp" };
  });
  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("401 without owner", async () => {
    const r = mockRes();
    await handleShareRoutes(
      publicReq(`/api/v1/sessions/${sid}/share`, "PATCH"),
      r.res,
      deps,
    );
    assert.equal(r.status(), 401);
  });

  it("updates owner_label on active share", async () => {
    const token = await createPreview(deps, sid);
    await publish(deps, sid, token);
    const r = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sid}/share`, "PATCH", {
        token,
        owner_label: "demo-share",
      }),
      r.res,
      deps,
    );
    assert.equal(r.status(), 200);
    assert.equal(
      (r.json() as { owner_label: string }).owner_label,
      "demo-share",
    );
    assert.equal(store.getShareByToken(token)?.owner_label, "demo-share");
  });

  it("empty string clears owner_label", async () => {
    const token = await createPreview(deps, sid);
    store.updateShareOwnerLabel(token, "old");
    const r = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sid}/share`, "PATCH", {
        token,
        owner_label: "",
      }),
      r.res,
      deps,
    );
    assert.equal(r.status(), 200);
    assert.equal(store.getShareByToken(token)?.owner_label, null);
  });

  it("rejects bidi override in owner_label", async () => {
    const token = await createPreview(deps, sid);
    const r = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sid}/share`, "PATCH", {
        token,
        owner_label: "nice\u202eevil.exe",
      }),
      r.res,
      deps,
    );
    assert.equal(r.status(), 400);
    assert.match((r.json() as { error: string }).error, /bidi/);
  });

  it("rejects >1024 byte owner_label", async () => {
    const token = await createPreview(deps, sid);
    const r = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sid}/share`, "PATCH", {
        token,
        owner_label: "x".repeat(1025),
      }),
      r.res,
      deps,
    );
    assert.equal(r.status(), 400);
  });

  it("rejects display_name >256 bytes", async () => {
    const token = await createPreview(deps, sid);
    const r = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sid}/share`, "PATCH", {
        token,
        display_name: "x".repeat(257),
      }),
      r.res,
      deps,
    );
    assert.equal(r.status(), 400);
  });

  it("410 if share revoked", async () => {
    const token = await createPreview(deps, sid);
    await publish(deps, sid, token);
    store.revokeShare(token);
    const r = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sid}/share`, "PATCH", {
        token,
        owner_label: "x",
      }),
      r.res,
      deps,
    );
    assert.equal(r.status(), 410);
  });

  it("404 if token belongs to different session", async () => {
    store.createSession("s2", "/tmp/p2");
    store.saveEvent(
      "s2",
      "user_message",
      { text: "hi2" },
      { from_ref: "agent" },
    );
    const tokenS2 = await createPreview(deps, "s2");
    const r = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sid}/share`, "PATCH", {
        token: tokenS2,
        owner_label: "x",
      }),
      r.res,
      deps,
    );
    assert.equal(r.status(), 404);
  });
});

describe("GET /api/v1/shares — owner list", () => {
  let tmpDir: string;
  let store: Store;
  let deps: ShareRouteDeps;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wa-share-ls-"));
    store = new Store(tmpDir);
    clearProjectionCache();
    __clearAllLocks();
    deps = { store, config: cfg, dataDir: tmpDir, publicDir: "/tmp" };
  });
  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("401 without owner", async () => {
    const r = mockRes();
    await handleShareRoutes(publicReq("/api/v1/shares"), r.res, deps);
    assert.equal(r.status(), 401);
  });

  it("returns empty list initially", async () => {
    const r = mockRes();
    await handleShareRoutes(ownerReq("/api/v1/shares"), r.res, deps);
    assert.equal(r.status(), 200);
    assert.deepEqual((r.json() as { shares: unknown[] }).shares, []);
  });

  it("lists preview + active, omits revoked", async () => {
    store.createSession("sA", "/tmp/a");
    store.saveEvent("sA", "user_message", { text: "a" }, { from_ref: "agent" });
    store.createSession("sB", "/tmp/b");
    store.saveEvent("sB", "user_message", { text: "b" }, { from_ref: "agent" });
    store.createSession("sC", "/tmp/c");
    store.saveEvent("sC", "user_message", { text: "c" }, { from_ref: "agent" });

    const tA = await createPreview(deps, "sA"); // preview-only
    const tB = await createPreview(deps, "sB");
    await publish(deps, "sB", tB); // active
    const tC = await createPreview(deps, "sC");
    store.revokeShare(tC); // revoked

    const r = mockRes();
    await handleShareRoutes(ownerReq("/api/v1/shares"), r.res, deps);
    assert.equal(r.status(), 200);
    const { shares } = r.json() as {
      shares: Array<{ token: string; shared_at: number | null }>;
    };
    const tokens = shares.map((s) => s.token).sort();
    assert.deepEqual(tokens.includes(tA), true);
    assert.deepEqual(tokens.includes(tB), true);
    assert.deepEqual(
      tokens.includes(tC),
      false,
      "revoked share should NOT be listed",
    );
    // preview row has shared_at null; active has number
    const rowA = shares.find((s) => s.token === tA)!;
    const rowB = shares.find((s) => s.token === tB)!;
    assert.equal(rowA.shared_at, null);
    assert.equal(typeof rowB.shared_at, "number");
  });
});
