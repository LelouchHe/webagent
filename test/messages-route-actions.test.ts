import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";
import { SseManager } from "../src/sse-manager.ts";
import type { AgentEvent } from "../src/types.ts";

function send(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port, path, method },
      (res) => {
        let d = "";
        res.on("data", (c: Buffer) => (d += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode!, body: d }));
      },
    );
    r.on("error", reject);
    r.end();
  });
}

describe("POST /api/v1/messages/:id/consume + ack + DELETE", () => {
  let store: Store;
  let tmpDir: string;
  let server: http.Server;
  let port: number;
  let broadcasts: AgentEvent[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-msg-action-"));
    const publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>t</h1>");
    store = new Store(tmpDir);
    const sseManager = new SseManager();
    broadcasts = [];
    const orig = sseManager.broadcast.bind(sseManager);
    sseManager.broadcast = (ev: AgentEvent) => {
      broadcasts.push(ev);
      return orig(ev);
    };

    const handler = createRequestHandler({
      sseManager,
      store,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1_048_576, image_upload: 10_485_760 },
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

  function mkMsg(id: string): void {
    store.createMessage({
      id,
      from_ref: "cron:x",
      from_label: null,
      to_ref: "user",
      deliver: "push",
      dedup_key: null,
      title: "t",
      body: "b",
      cwd: "/tmp/work",
      created_at: Date.now(),
    });
  }

  // consume --------------------------------------------------------------

  it("consume creates session, appends message event, deletes row, broadcasts message_consumed", async () => {
    mkMsg("m1");
    const r = await send(port, "POST", "/api/v1/messages/m1/consume");
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.ok(body.sessionId, "sessionId returned");

    // Row deleted
    assert.equal(store.getMessage("m1"), undefined);

    // Session exists
    const sess = store.getSession(body.sessionId);
    assert.ok(sess);
    assert.equal(sess.cwd, "/tmp/work");

    // Event written with message_id
    const events = store.getEvents(body.sessionId);
    const msgE = events.find((e) => e.type === "message");
    assert.ok(msgE);
    const data = JSON.parse(msgE.data) as Record<string, unknown>;
    assert.equal(data.message_id, "m1");

    // SSE fired
    const ev = broadcasts.find((e) => e.type === "message_consumed");
    assert.ok(ev, "message_consumed SSE");
    assert.equal(ev.messageId, "m1");
    assert.equal(ev.sessionId, body.sessionId);
  });

  it("consume is idempotent: second call returns same sessionId, no new session", async () => {
    mkMsg("m2");
    const r1 = await send(port, "POST", "/api/v1/messages/m2/consume");
    const sid1 = JSON.parse(r1.body).sessionId;

    const r2 = await send(port, "POST", "/api/v1/messages/m2/consume");
    assert.equal(r2.status, 200);
    const sid2 = JSON.parse(r2.body).sessionId;
    assert.equal(sid2, sid1, "second consume returns same sessionId");

    // Only one message event across all sessions
    const allEvents = store.getEvents(sid1).filter((e) => e.type === "message");
    assert.equal(allEvents.length, 1);
  });

  it("consume of unknown id returns 404", async () => {
    const r = await send(port, "POST", "/api/v1/messages/nope/consume");
    assert.equal(r.status, 404);
  });

  // ack / DELETE ---------------------------------------------------------

  it("ack deletes row, broadcasts message_acked", async () => {
    mkMsg("m3");
    const r = await send(port, "POST", "/api/v1/messages/m3/ack");
    assert.equal(r.status, 200);
    assert.equal(store.getMessage("m3"), undefined);

    const ev = broadcasts.find((e) => e.type === "message_acked");
    assert.ok(ev);
    assert.equal(ev.messageId, "m3");
  });

  it("DELETE /api/v1/messages/:id is an alias for ack", async () => {
    mkMsg("m4");
    const r = await send(port, "DELETE", "/api/v1/messages/m4");
    assert.equal(r.status, 200);
    assert.equal(store.getMessage("m4"), undefined);
    assert.ok(broadcasts.find((e) => e.type === "message_acked"));
  });

  it("ack of unknown id returns 404", async () => {
    const r = await send(port, "POST", "/api/v1/messages/nope/ack");
    assert.equal(r.status, 404);
  });
});
