import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";
import { SseManager } from "../src/sse-manager.ts";
import { PushService } from "../src/push-service.ts";

/**
 * acp-push-close: handled signals from the server must fire sendClose on
 * the matching push tag so stale banners on other devices disappear.
 *
 * Covered signals:
 *   1. Permission response (POST /sessions/:id/permissions/:reqId)
 *        → sendClose("sess-<sid>-perm-<requestId>")
 *   2. Client visibility → viewing session X
 *        → sendClose("sess-<sid>-done") AND perm tags of that session's
 *          pending permissions.
 *
 * Bash close is intentionally NOT server-side: the SW handles it on render
 * via getNotifications({tag}).close() (see frontend-sse todo).
 */

class SpyPushService extends PushService {
  public closes: string[] = [];
  override async sendClose(tag: string): Promise<void> {
    this.closes.push(tag);
  }
}

function send(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? "" : JSON.stringify(body);
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data).toString(),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c: Buffer) => (d += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode!, body: d }));
      },
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

describe("acp-push-close: handled signals fire sendClose", () => {
  let tmpDir: string;
  let store: Store;
  let push: SpyPushService;
  let server: http.Server;
  let port: number;
  let sessionId: string;
  let sessionManager: {
    pendingPermissions: Map<
      string,
      {
        requestId: string;
        sessionId: string;
        options: { optionId: string; label: string }[];
        title: string;
      }
    >;
    syncPendingPermissions: () => void;
    flushBuffers: () => void;
  };
  let sseManager: SseManager;
  let bridgeCalls: { requestId: string; optionId?: string; denied?: boolean }[];
  const addFakeSseClient = (id: string): void => {
    sseManager.add({
      id,
      res: {
        write: () => true,
        end: () => {},
        on: () => {},
        writableEnded: false,
      } as unknown as import("node:http").ServerResponse,
    });
  };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-push-close-"));
    const publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>t</h1>");
    store = new Store(tmpDir);
    sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    store.createSession(sessionId, "/tmp");
    push = new SpyPushService(store, tmpDir, "mailto:test@example.com");

    bridgeCalls = [];
    sessionManager = {
      pendingPermissions: new Map(),
      syncPendingPermissions: () => {},
      flushBuffers: () => {},
    };

    sseManager = new SseManager();
    const handler = createRequestHandler({
      sseManager,
      store,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1_048_576, image_upload: 10_485_760 },
      pushService: push,
      sessions: sessionManager as unknown as Parameters<typeof createRequestHandler>[0]["sessions"],
      getBridge: () =>
        ({
          resolvePermission: (requestId: string, optionId: string) =>
            bridgeCalls.push({ requestId, optionId }),
          denyPermission: (requestId: string) => bridgeCalls.push({ requestId, denied: true }),
        }) as unknown as Parameters<
          typeof createRequestHandler
        >[0]["getBridge"] extends () => infer R
          ? R
          : never,
    });
    server = http.createServer(handler);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("permission response fires sendClose(sess-<sid>-perm-<requestId>)", async () => {
    const requestId = "req-abc";
    sessionManager.pendingPermissions.set(requestId, {
      requestId,
      sessionId,
      title: "Run ls?",
      options: [
        { optionId: "allow_once", label: "Allow" },
        { optionId: "deny", label: "Deny" },
      ],
    });

    const r = await send(port, "POST", `/api/v1/sessions/${sessionId}/permissions/${requestId}`, {
      optionId: "allow_once",
    });
    assert.equal(r.status, 200);
    assert.deepEqual(push.closes, [`sess-${sessionId}-perm-${requestId}`]);
  });

  it("permission deny also fires sendClose", async () => {
    const requestId = "req-xyz";
    sessionManager.pendingPermissions.set(requestId, {
      requestId,
      sessionId,
      title: "Run rm?",
      options: [{ optionId: "deny", label: "Deny" }],
    });

    const r = await send(port, "POST", `/api/v1/sessions/${sessionId}/permissions/${requestId}`, {
      denied: true,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(push.closes, [`sess-${sessionId}-perm-${requestId}`]);
  });

  it("client visibility → viewing session closes prompt-done + pending perms for that session", async () => {
    const clientId = "client-1";
    const pendingPerm = {
      requestId: "req-pending",
      sessionId,
      title: "Pending",
      options: [{ optionId: "deny", label: "Deny" }],
    };
    sessionManager.pendingPermissions.set("req-pending", pendingPerm);

    addFakeSseClient(clientId);
    push.registerClient(clientId, "https://push.example.com/1");

    const r = await send(port, "POST", `/api/beta/clients/${clientId}/visibility`, {
      visible: true,
      sessionId,
    });
    assert.equal(r.status, 200);

    assert.ok(
      push.closes.includes(`sess-${sessionId}-done`),
      `expected done close, got ${JSON.stringify(push.closes)}`,
    );
    assert.ok(
      push.closes.includes(`sess-${sessionId}-perm-req-pending`),
      `expected pending perm close, got ${JSON.stringify(push.closes)}`,
    );
  });

  it("visibility false does NOT fire session closes", async () => {
    const clientId = "client-2";
    addFakeSseClient(clientId);
    push.registerClient(clientId, "https://push.example.com/2");
    const r = await send(port, "POST", `/api/beta/clients/${clientId}/visibility`, {
      visible: false,
      sessionId,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(push.closes, []);
  });

  it("visibility without sessionId does NOT fire any close", async () => {
    const clientId = "client-3";
    addFakeSseClient(clientId);
    push.registerClient(clientId, "https://push.example.com/3");
    const r = await send(port, "POST", `/api/beta/clients/${clientId}/visibility`, {
      visible: true,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(push.closes, []);
  });

  it("sendClose fires once on edge, NOT on subsequent heartbeat refreshes", async () => {
    const clientId = "client-edge";
    addFakeSseClient(clientId);
    push.registerClient(clientId, "https://push.example.com/edge");

    // First transition: visible:true + sessionId = edge → one sendClose.
    let r = await send(port, "POST", `/api/beta/clients/${clientId}/visibility`, {
      visible: true,
      sessionId,
    });
    assert.equal(r.status, 200);
    const afterEdge = push.closes.length;
    assert.ok(afterEdge >= 1, `expected ≥1 close on edge, got ${afterEdge}`);

    // Five heartbeat refreshes (same visible:true, same sessionId preserved)
    // must produce ZERO additional sendClose. This is what the previous
    // design got wrong — it would re-close banners every 15s on every device.
    for (let i = 0; i < 5; i++) {
      r = await send(port, "POST", `/api/beta/clients/${clientId}/visibility`, {
        visible: true,
        sessionId,
      });
      assert.equal(r.status, 200);
    }
    assert.equal(
      push.closes.length,
      afterEdge,
      "heartbeat refreshes must not amplify sendClose calls",
    );
  });

  it("POST without sessionId key preserves previously-set session", async () => {
    const clientId = "client-preserve";
    addFakeSseClient(clientId);
    push.registerClient(clientId, "https://push.example.com/p");

    await send(port, "POST", `/api/beta/clients/${clientId}/visibility`, {
      visible: true,
      sessionId,
    });
    // Omit sessionId key entirely → preserve.
    await send(port, "POST", `/api/beta/clients/${clientId}/visibility`, {
      visible: true,
    });
    assert.equal(push.getClientState(clientId)?.sessionId, sessionId);
  });

  it("POST with sessionId:null explicitly clears the session", async () => {
    const clientId = "client-clear";
    addFakeSseClient(clientId);
    push.registerClient(clientId, "https://push.example.com/cl");

    await send(port, "POST", `/api/beta/clients/${clientId}/visibility`, {
      visible: true,
      sessionId,
    });
    await send(port, "POST", `/api/beta/clients/${clientId}/visibility`, {
      visible: true,
      sessionId: null,
    });
    assert.equal(push.getClientState(clientId)?.sessionId, null);
  });
});
