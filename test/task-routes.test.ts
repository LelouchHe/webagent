import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT_TASK_ID, Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";
import { SseManager } from "../src/sse-manager.ts";
import { SessionManager } from "../src/session-manager.ts";
import type { AgentEvent } from "../src/types.ts";
import { mockBridgeStubs } from "./fixtures.ts";

function send(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
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
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

describe("task-plane API", () => {
  let store: Store;
  let tmpDir: string;
  let server: http.Server;
  let port: number;
  let broadcasts: AgentEvent[];
  let failNewSession: boolean;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-task-routes-"));
    const publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "<h1>t</h1>");
    store = new Store(tmpDir, "test-agent");
    const sessions = new SessionManager(store, tmpDir, tmpDir);
    failNewSession = false;
    const bridge = {
      ...mockBridgeStubs(),
      async newSession(_cwd: string, _opts?: unknown) {
        if (failNewSession) throw new Error("agent create failed");
        return { sessionId: `agent-${randomId()}`, configOptions: [] };
      },
      async setConfigOption() {
        return [];
      },
      async loadSession() {
        throw new Error("should not resume in these tests");
      },
    };
    const sseManager = new SseManager();
    broadcasts = [];
    const orig = sseManager.broadcast.bind(sseManager);
    sseManager.broadcast = (ev: AgentEvent) => {
      broadcasts.push(ev);
      orig(ev);
    };
    const handler = createRequestHandler({
      sseManager,
      store,
      sessions,
      getBridge: () => bridge,
      publicDir,
      dataDir: tmpDir,
      limits: { bash_output: 1_048_576, image_upload: 10_485_760 },
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

  function randomId(): string {
    return `id-${Math.random().toString(36).slice(2, 10)}`;
  }

  function seedRoot(): string {
    store.createTask({ id: ROOT_TASK_ID, name: "root", cwd: tmpDir });
    return ROOT_TASK_ID;
  }

  it("GET /tasks lists live tasks with liveSessionId", async () => {
    const rootId = seedRoot();
    const res = await send(port, "GET", "/api/v1/tasks");
    assert.equal(res.status, 200);
    const { tasks } = JSON.parse(res.body);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, rootId);
    assert.equal(tasks[0].liveSessionId, null);
  });

  it("POST /tasks creates a child task with a bound session", async () => {
    seedRoot();
    const res = await send(port, "POST", "/api/v1/tasks", {
      name: "child-a",
      brief: "do things",
    });
    assert.equal(res.status, 201);
    const { task } = JSON.parse(res.body);
    assert.equal(task.name, "child-a");
    assert.equal(task.brief, "do things");
    assert.equal(task.parent_id, store.getRootTaskId());
    assert.ok(task.liveSessionId); // first session spawned

    const list = await send(port, "GET", "/api/v1/tasks");
    assert.equal(JSON.parse(list.body).tasks.length, 2);
    assert.ok(
      broadcasts.some((e) => e.type === "task_created" && e.taskId === task.id),
    );
  });

  it("POST /tasks rejects duplicate name under the same parent", async () => {
    seedRoot();
    await send(port, "POST", "/api/v1/tasks", { name: "dup" });
    const dup = await send(port, "POST", "/api/v1/tasks", { name: "dup" });
    assert.equal(dup.status, 409);
  });

  it("POST /tasks removes the task when its first session fails", async () => {
    seedRoot();
    failNewSession = true;
    const res = await send(port, "POST", "/api/v1/tasks", { name: "orphan" });
    assert.equal(res.status, 500);
    assert.equal(
      store.listTasks().some((t) => t.name === "orphan"),
      false,
    );
  });

  it("GET /tasks/:id returns the detail incl. live session; 404 for unknowns", async () => {
    const rootId = seedRoot();
    const created = await send(port, "POST", "/api/v1/tasks", { name: "c" });
    const taskId = JSON.parse(created.body).task.id;
    const detail = await send(port, "GET", `/api/v1/tasks/${taskId}`);
    assert.equal(detail.status, 200);
    const { task } = JSON.parse(detail.body);
    assert.equal(task.name, "c");
    assert.ok(task.liveSessionId);
    const missing = await send(port, "GET", "/api/v1/tasks/nope");
    assert.equal(missing.status, 404);
    assert.equal(JSON.parse(missing.body).error, "Task not found");
    void rootId;
  });

  it("GET /tasks/:id/events aggregates across executions in global order", async () => {
    const rootId = seedRoot();
    const created = await send(port, "POST", "/api/v1/tasks", { name: "ev" });
    const taskId = JSON.parse(created.body).task.id;
    const sess1 = store.getTaskLiveSession(taskId)!.id;
    store.saveEvent(
      sess1,
      "user_message",
      { text: "one" },
      { from_ref: "user" },
    );
    store.retireSession(sess1);
    const cleared = await send(port, "POST", `/api/v1/tasks/${taskId}/clear`);
    assert.equal(cleared.status, 200);
    const sess2 = JSON.parse(cleared.body).sessionId;
    store.saveEvent(
      sess2,
      "user_message",
      { text: "two" },
      { from_ref: "user" },
    );

    const events = await send(port, "GET", `/api/v1/tasks/${taskId}/events`);
    const { events: rows } = JSON.parse(events.body);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((e: { session_id: string }) => e.session_id),
      [sess1, sess2],
    );
    assert.ok(rows[0].id < rows[1].id);
    void rootId;
  });

  it("PUT /tasks/:id renames; PUT /tasks/:id/:configId writes task config", async () => {
    const rootId = seedRoot();
    const created = await send(port, "POST", "/api/v1/tasks", { name: "old" });
    const taskId = JSON.parse(created.body).task.id;

    const renamed = await send(port, "PUT", `/api/v1/tasks/${taskId}`, {
      name: "new-name",
      title: "Title",
    });
    assert.equal(renamed.status, 200);
    assert.equal(store.getTask(taskId)?.name, "new-name");
    assert.equal(store.getTask(taskId)?.title, "Title");

    const cfg = await send(port, "PUT", `/api/v1/tasks/${taskId}/mode`, {
      value: "plan",
    });
    assert.equal(cfg.status, 200);
    assert.equal(store.getTask(taskId)?.mode, "plan");
    assert.ok(
      broadcasts.some((e) => e.type === "task_updated" && e.taskId === taskId),
    );
    void rootId;
  });

  it("POST /tasks/:id/clear retires the old execution and spawns a new one", async () => {
    const rootId = seedRoot();
    const created = await send(port, "POST", "/api/v1/tasks", { name: "clr" });
    const taskId = JSON.parse(created.body).task.id;
    const sess1 = store.getTaskLiveSession(taskId)!.id;

    const res = await send(port, "POST", `/api/v1/tasks/${taskId}/clear`);
    assert.equal(res.status, 200);
    const { sessionId: sess2 } = JSON.parse(res.body);
    assert.notEqual(sess2, sess1);
    assert.equal(store.getTaskLiveSession(taskId)?.id, sess2);
    assert.ok(store.getSessionIncludingDeleted(sess1)?.deleted_at);
    assert.ok(
      broadcasts.some((e) => e.type === "task_cleared" && e.taskId === taskId),
    );
    void rootId;
  });

  it("DELETE /tasks/:id refuses the root and cascades children", async () => {
    const rootId = seedRoot();
    const rootDelete = await send(port, "DELETE", `/api/v1/tasks/${rootId}`);
    assert.equal(rootDelete.status, 400);

    const created = await send(port, "POST", "/api/v1/tasks", { name: "leaf" });
    const leafId = JSON.parse(created.body).task.id;
    const del = await send(port, "DELETE", `/api/v1/tasks/${leafId}`);
    assert.equal(del.status, 204);
    assert.equal(store.getTask(leafId), undefined);
    const detail = await send(port, "GET", `/api/v1/tasks/${leafId}`);
    assert.equal(detail.status, 404);
    assert.ok(
      broadcasts.some((e) => e.type === "task_deleted" && e.taskId === leafId),
    );
  });
});
