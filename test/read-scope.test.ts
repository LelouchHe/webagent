import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import {
  createTaskManager,
  type DeliveryBridge,
  type TaskManager,
} from "../src/task-manager.ts";
import { SseManager } from "../src/sse-manager.ts";
import { createRequestHandler } from "../src/routes.ts";
import { AuthStore } from "../src/auth-store.ts";

interface Resp {
  status: number;
  body: string;
}

function req(
  port: number,
  method: string,
  path: string,
  token?: string,
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => {
          data += c.toString();
        });
        res.on("end", () => {
          resolve({ status: res.statusCode!, body: data });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

async function listen(handler: http.RequestListener): Promise<{
  server: http.Server;
  port: number;
}> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as { port: number }).port };
}

describe("read-scope auth", () => {
  let store: Store;
  let tasks: TaskManager;
  let dir: string;
  let server: http.Server;
  let port: number;
  let authStore: AuthStore;
  let readToken: string;
  let apiToken: string;
  let bridge: DeliveryBridge & { loads: number };

  function makeBridge(): DeliveryBridge & { loads: number } {
    let loads = 0;
    return {
      get loads() {
        return loads;
      },
      async newSession() {
        return { sessionId: "created-session", configOptions: [] };
      },
      async setConfigOption() {
        return [];
      },
      async loadSession(taskId: string) {
        loads++;
        return { taskId, configOptions: [] };
      },
      async prompt() {},
      async cancel() {},
      resolvePermission: () => {},
      denyPermission: () => {},
      isAvailable: () => true,
    };
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "webagent-read-scope-"));
    mkdirSync(join(dir, "public"));
    store = new Store(dir);
    store.ensureRootTask(dir);
    tasks = createTaskManager(store, dir, dir, undefined, undefined, "agent-a");
    bridge = makeBridge();
    tasks.attachExecutionBridge(bridge);

    authStore = new AuthStore(join(dir, "auth.json"));
    await authStore.load();
    readToken = (await authStore.addToken("reader", "read")).token;
    apiToken = (await authStore.addToken("editor", "api")).token;

    const handler = createRequestHandler({
      store,
      tasks,
      authStore,
      sseManager: new SseManager(),
      publicDir: join(dir, "public"),
      dataDir: dir,
      limits: { bash_output: 1024, image_upload: 1024 },
    });
    ({ server, port } = await listen(handler));
  });

  afterEach(async () => {
    tasks.dispose();
    await authStore.close();
    store.close();
    await new Promise<void>((r) =>
      server.close(() => {
        r();
      }),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(id: string): void {
    store.createTask(id, dir, "auto", "agent-a", `${id}-session`);
    store.saveEvent(id, "user_message", { text: id }, { from_ref: "user" });
  }

  it("allows the task list and stored history", async () => {
    seed("t1");
    const list = await req(port, "GET", "/api/v1/tasks", readToken);
    assert.equal(list.status, 200);
    // The archived filter is part of the same read surface.
    const archived = await req(
      port,
      "GET",
      "/api/v1/tasks?archived=only",
      readToken,
    );
    assert.equal(archived.status, 200);
    const events = await req(port, "GET", "/api/v1/tasks/t1/events", readToken);
    assert.equal(events.status, 200);
    assert.match(events.body, /"seq":1/);
  });

  it("allows task detail without warming the execution", async () => {
    seed("t1");
    const detail = await req(port, "GET", "/api/v1/tasks/t1", readToken);
    assert.equal(detail.status, 200);
    await settle();
    assert.equal(bridge.loads, 0, "task detail must not start a restore");
    assert.equal(tasks.liveTasks.has("t1"), false);
  });

  it("denies the warming snapshot read", async () => {
    seed("t1");
    const snapshot = await req(
      port,
      "GET",
      "/api/v1/tasks/t1/snapshot",
      readToken,
    );
    assert.equal(snapshot.status, 403);
    await settle();
    assert.equal(bridge.loads, 0);
  });

  it("returns persisted events only, without flushing buffers or seq", async () => {
    seed("t1");
    tasks.assistantBuffers.set("t1", "unflushed");
    const before = store.getEvents("t1").length;
    const lastSeq = store.getLastEventSeq("t1");

    const res = await req(port, "GET", "/api/v1/tasks/t1/events", readToken);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body) as {
      events: unknown[];
      streaming: { thinking: boolean; assistant: boolean };
    };
    assert.equal(body.events.length, before);
    assert.deepEqual(body.streaming, { thinking: false, assistant: false });
    assert.equal(store.getEvents("t1").length, before);
    assert.equal(store.getLastEventSeq("t1"), lastSeq);
    assert.equal(tasks.assistantBuffers.get("t1"), "unflushed");

    // Control: an ordinary api read still flushes (existing behavior).
    const api = await req(port, "GET", "/api/v1/tasks/t1/events", apiToken);
    assert.equal(api.status, 200);
    assert.equal(store.getEvents("t1").length, before + 1);
    assert.ok(store.getLastEventSeq("t1") > lastSeq);
    assert.equal(tasks.assistantBuffers.has("t1"), false);
  });

  it("accepts the trailing-slash forms the routes already support", async () => {
    seed("t1");
    const detail = await req(port, "GET", "/api/v1/tasks/t1/", readToken);
    assert.equal(detail.status, 200);
    const status = await req(
      port,
      "GET",
      "/api/v1/tasks/t1/status/",
      readToken,
    );
    assert.equal(status.status, 200);
  });

  it("still warms for an ordinary api token (control)", async () => {
    seed("t1");
    const detail = await req(port, "GET", "/api/v1/tasks/t1", apiToken);
    assert.equal(detail.status, 200);
    await settle();
    assert.equal(bridge.loads, 1, "the api-scope read warm is observable");
  });

  it("denies writes and undeclared reads", async () => {
    seed("t1");
    const cases: Array<[string, string]> = [
      ["POST", "/api/v1/tasks/t1/archive"],
      ["POST", "/api/v1/tasks/t1/prompt"],
      ["DELETE", "/api/v1/tasks/t1"],
      ["POST", "/api/v1/tasks"],
      ["GET", "/api/v1/files/info"],
    ];
    for (const [method, path] of cases) {
      const res = await req(port, method, path, readToken);
      assert.equal(res.status, 403, `${method} ${path} must be denied`);
    }
    // The api scope control still reaches the same read route (not 403).
    const detail = await req(port, "GET", "/api/v1/tasks/t1", apiToken);
    assert.equal(detail.status, 200);
  });

  it("never touches execution for the task list or events", async () => {
    seed("t1");
    const list = await req(port, "GET", "/api/v1/tasks", apiToken);
    assert.equal(list.status, 200);
    await settle();
    assert.equal(bridge.loads, 0, "the task list must not warm anything");

    const events = await req(port, "GET", "/api/v1/tasks/t1/events", apiToken);
    assert.equal(events.status, 200);
    await settle();
    assert.equal(bridge.loads, 0, "stored history must not warm anything");
    assert.equal(tasks.liveTasks.has("t1"), false);
  });
});
