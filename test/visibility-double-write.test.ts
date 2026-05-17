/**
 * Plan C Step 1 integration test: POST /visibility must double-write to
 * BOTH PushService AND ClientRegistry. This lets identity-layer consumers
 * (TTS dispatch on voice branch) read visibility from the registry while
 * pushService continues to be the source of truth for push suppression
 * during the migration window.
 */
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
import { ClientRegistry } from "../src/client-registry.ts";

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
        res.on("end", () => {
          resolve({ status: res.statusCode!, body: d });
        });
      },
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

describe("visibility double-write (Plan C Step 1)", () => {
  let tmpDir: string;
  let store: Store;
  let push: PushService;
  let registry: ClientRegistry;
  let sseManager: SseManager;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-visibility-dw-"));
    const publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>t</h1>");
    store = new Store(tmpDir);
    push = new PushService(store, tmpDir, "mailto:test@example.com");
    registry = new ClientRegistry();
    sseManager = new SseManager();
    const handler = createRequestHandler({
      sseManager,
      store,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1_048_576, image_upload: 10_485_760 },
      pushService: push,
      clientRegistry: registry,
    });
    server = http.createServer(handler);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((res) =>
      server.close(() => {
        res();
      }),
    );
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("POST /visibility { visible:true, sessionId } updates BOTH stores", async () => {
    const clientId = "c-dw-1";
    registry.register(clientId, { capabilities: [] });

    const r = await send(
      port,
      "POST",
      `/api/beta/clients/${clientId}/visibility`,
      { visible: true, sessionId: "sess-X" },
    );
    assert.equal(r.status, 200);

    // PushService side
    const pushState = push.getClientState(clientId);
    assert.ok(pushState);
    assert.equal(pushState.visible, true);
    assert.equal(pushState.sessionId, "sess-X");

    // ClientRegistry side
    const entry = registry.get(clientId);
    assert.ok(entry);
    assert.equal(entry.visible, true);
    assert.equal(entry.active, "sess-X");
    assert.ok(registry.isVisibleForSession(clientId, "sess-X"));
    assert.ok(registry.isSessionVisibleToAnyClient("sess-X"));
  });

  it("POST /visibility { visible:false } clears BOTH stores' visible flag", async () => {
    const clientId = "c-dw-2";
    registry.register(clientId, { capabilities: [] });
    await send(port, "POST", `/api/beta/clients/${clientId}/visibility`, {
      visible: true,
      sessionId: "sess-Y",
    });
    await send(port, "POST", `/api/beta/clients/${clientId}/visibility`, {
      visible: false,
    });

    assert.equal(push.getClientState(clientId)?.visible, false);
    assert.equal(registry.get(clientId)?.visible, false);
    assert.equal(registry.isVisibleForSession(clientId, "sess-Y"), false);
  });

  it("POST /visibility omitting sessionId preserves active in registry", async () => {
    const clientId = "c-dw-3";
    registry.register(clientId, { capabilities: [] });
    await send(port, "POST", `/api/beta/clients/${clientId}/visibility`, {
      visible: true,
      sessionId: "sess-Z",
    });
    // Subsequent heartbeat without sessionId key — should preserve "sess-Z"
    await send(port, "POST", `/api/beta/clients/${clientId}/visibility`, {
      visible: true,
    });
    assert.equal(registry.get(clientId)?.active, "sess-Z");
    assert.equal(push.getClientState(clientId)?.sessionId, "sess-Z");
  });

  it("POST /visibility without clientRegistry dependency still succeeds (no-op on registry write)", async () => {
    // Belt-and-suspenders: clientRegistry is optional in createRequestHandler.
    // Re-create handler without registry and verify pushService still works.
    await new Promise<void>((res) =>
      server.close(() => {
        res();
      }),
    );
    const publicDir2 = join(tmpDir, "public2");
    mkdirSync(publicDir2);
    writeFileSync(join(publicDir2, "index.html"), "<h1>t</h1>");

    const clientId = "c-dw-4";
    // Without registry, the handler's trust check falls back to sseManager
    // membership. Pre-populate an SSE client so the POST is accepted.
    const sseM = new SseManager();
    sseM.add({
      id: clientId,
      res: {
        write: () => true,
        end: () => {},
        on: () => {},
        writableEnded: false,
      } as unknown as import("node:http").ServerResponse,
    });
    const handler = createRequestHandler({
      sseManager: sseM,
      store,
      publicDir: publicDir2,
      dataDir: tmpDir,
      limits: { bash_output: 1_048_576, image_upload: 10_485_760 },
      pushService: push,
      // no clientRegistry
    });
    server = http.createServer(handler);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    port = (server.address() as { port: number }).port;

    const r = await send(
      port,
      "POST",
      `/api/beta/clients/${clientId}/visibility`,
      { visible: true, sessionId: "sess-W" },
    );
    assert.equal(r.status, 200);
    const pushState = push.getClientState(clientId);
    assert.ok(pushState);
    assert.equal(pushState.visible, true);
  });
});
