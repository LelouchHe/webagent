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

function post(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c: Buffer) => (d += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode!, body: d }));
      },
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

describe("POST /api/v1/messages — ingress", () => {
  let store: Store;
  let tmpDir: string;
  let server: http.Server;
  let port: number;
  let sseManager: SseManager;
  let broadcasts: AgentEvent[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-msg-post-"));
    const publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>t</h1>");
    store = new Store(tmpDir);
    sseManager = new SseManager();

    // Spy on broadcasts
    broadcasts = [];
    const origBroadcast = sseManager.broadcast.bind(sseManager);
    sseManager.broadcast = (ev: AgentEvent) => {
      broadcasts.push(ev);
      return origBroadcast(ev);
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

  function baseBody(overrides: Record<string, unknown> = {}) {
    return {
      from_ref: "cron:nightly",
      to: "user",
      title: "backup done",
      body: "snapshot 42s",
      ...overrides,
    };
  }

  it("400 on invalid JSON", async () => {
    // send raw broken JSON
    const raw = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const r = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/v1/messages",
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (res) => {
            let d = "";
            res.on("data", (c: Buffer) => (d += c.toString()));
            res.on("end", () => resolve({ status: res.statusCode!, body: d }));
          },
        );
        r.on("error", reject);
        r.write("{not json");
        r.end();
      },
    );
    assert.equal(raw.status, 400);
  });

  it("400 when from_ref uses reserved 'user' prefix", async () => {
    const r = await post(
      port,
      "/api/v1/messages",
      baseBody({ from_ref: "user" }),
    );
    assert.equal(r.status, 400);
  });

  it("400 when from_ref uses 'session:<id>' (reserved for auth)", async () => {
    const r = await post(
      port,
      "/api/v1/messages",
      baseBody({ from_ref: "session:abc" }),
    );
    assert.equal(r.status, 400);
  });

  it("400 when required field 'title' is missing", async () => {
    const { title, ...rest } = baseBody();
    void title;
    const r = await post(port, "/api/v1/messages", rest);
    assert.equal(r.status, 400);
  });

  it("unbound to=user inserts a message row, returns id + delivered=pending, SSE broadcasts message_created", async () => {
    const r = await post(port, "/api/v1/messages", baseBody());
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.ok(body.id, "id returned");
    assert.equal(body.delivered, "pending");

    const row = store.getMessage(body.id);
    assert.ok(row, "message row persisted");
    assert.equal(row.from_ref, "cron:nightly");
    assert.equal(row.to_ref, "user");

    const ev = broadcasts.find((e) => e.type === "message_created");
    assert.ok(ev, "message_created broadcast fired");
    assert.equal(ev.messageId, body.id);
  });

  it("bound to=session:<id> with unknown session returns 400 session_not_found (no fallback to inbox)", async () => {
    const r = await post(
      port,
      "/api/v1/messages",
      baseBody({ to: "session:no-such-sid" }),
    );
    assert.equal(r.status, 400);
    const body = JSON.parse(r.body);
    assert.equal(body.error, "session_not_found");
    // Must not leak into messages table
    assert.equal(store.listUnprocessed().length, 0);
  });

  it("bound to=session:<existing> appends a message event to that session", async () => {
    const sid = "sess-target";
    store.createSession(sid, "/tmp", "test");
    const r = await post(
      port,
      "/api/v1/messages",
      baseBody({ to: `session:${sid}` }),
    );
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.ok(body.id);
    assert.equal(body.delivered, "session");

    // Bound never touches messages table
    assert.equal(store.getMessage(body.id), undefined);

    // An event was appended
    const events = store.getEvents(sid);
    const msgEvent = events.find((e) => e.type === "message");
    assert.ok(msgEvent, "message event persisted in target session");
    const parsedData = JSON.parse(msgEvent.data) as Record<string, unknown>;
    assert.equal(parsedData.message_id, body.id);
    assert.equal(parsedData.from_ref, "cron:nightly");
    assert.equal(msgEvent.from_ref, "cron:nightly");
  });

  it("idempotent via X-Client-Op-Id: second call returns identical id without duplicating the row", async () => {
    const opId = "op-abc";
    const r1 = await post(port, "/api/v1/messages", baseBody(), {
      "X-Client-Op-Id": opId,
    });
    assert.equal(r1.status, 200);
    const id1 = JSON.parse(r1.body).id;

    const r2 = await post(port, "/api/v1/messages", baseBody(), {
      "X-Client-Op-Id": opId,
    });
    assert.equal(r2.status, 200);
    assert.equal(JSON.parse(r2.body).id, id1, "replay returns same id");

    assert.equal(store.listUnprocessed().length, 1, "no duplicate row created");
  });

  it("dedup_key supersede: second unbound with same (to, dedup_key) replaces older row", async () => {
    const r1 = await post(
      port,
      "/api/v1/messages",
      baseBody({ dedup_key: "backup-daily", body: "v1" }),
    );
    const id1 = JSON.parse(r1.body).id;

    const r2 = await post(
      port,
      "/api/v1/messages",
      baseBody({ dedup_key: "backup-daily", body: "v2" }),
    );
    const id2 = JSON.parse(r2.body).id;

    assert.notEqual(id1, id2, "new id per request");
    // Old row gone, new row present
    assert.equal(store.getMessage(id1), undefined, "superseded row deleted");
    const newRow = store.getMessage(id2);
    assert.ok(newRow);
    assert.equal(newRow.body, "v2");
    assert.equal(store.listUnprocessed().length, 1);
  });
});
