import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { SessionManager } from "../src/session-manager.ts";
import { SseManager } from "../src/sse-manager.ts";
import { createRequestHandler } from "../src/routes.ts";

function req(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port, path, method },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    r.on("error", reject);
    r.end();
  });
}

describe("GET /api/v1/sessions/:id/snapshot", () => {
  let store: Store;
  let sessions: SessionManager;
  let sse: SseManager;
  let server: http.Server;
  let tmpDir: string;
  let port: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-snapshot-"));
    mkdirSync(join(tmpDir, "public"));
    store = new Store(tmpDir);
    sessions = new SessionManager(store, tmpDir, tmpDir);
    sse = new SseManager();
    const handler = createRequestHandler({
      store,
      sessions,
      sseManager: sse,
      publicDir: join(tmpDir, "public"),
      dataDir: tmpDir,
      limits: {
        bash_output: 1_048_576,
        image_upload: 10_485_760,
        cancel_timeout: 10_000,
      },
    });
    server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 404 for unknown session", async () => {
    const res = await req(port, "GET", "/api/v1/sessions/nope/snapshot");
    assert.equal(res.status, 404);
  });

  it("returns idle snapshot for a fresh session", async () => {
    store.createSession("s1", "/tmp/cwd");
    const res = await req(port, "GET", "/api/v1/sessions/s1/snapshot");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.version, 1);
    assert.equal(body.seq, 0);
    assert.equal(body.session.id, "s1");
    assert.equal(body.session.cwd, "/tmp/cwd");
    assert.equal(body.runtime.busy, null);
    assert.deepEqual(body.runtime.pendingPermissions, []);
    assert.deepEqual(body.runtime.streaming, {
      assistant: false,
      thinking: false,
    });
    assert.equal(body.session.lastEventSeq, 0);
  });

  it("reflects agent busy when a prompt is active", async () => {
    store.createSession("s1", "/tmp/cwd");
    sessions.activePrompts.add("s1");
    const res = await req(port, "GET", "/api/v1/sessions/s1/snapshot");
    const body = JSON.parse(res.body);
    assert.ok(body.runtime.busy);
    assert.equal(body.runtime.busy.kind, "agent");
    assert.ok(body.seq >= 1);
  });

  it("includes session.lastEventSeq from stored events", async () => {
    store.createSession("s1", "/tmp/cwd");
    store.saveEvent("s1", "user_message", { text: "hi" }, { from_ref: "user" });
    const res = await req(port, "GET", "/api/v1/sessions/s1/snapshot");
    const body = JSON.parse(res.body);
    assert.ok(body.session.lastEventSeq >= 1);
  });
});
