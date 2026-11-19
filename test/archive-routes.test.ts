import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import type { TaskManager } from "../src/task-manager.ts";
import { createRequestHandler } from "../src/routes.ts";
import { AuthStore } from "../src/auth-store.ts";
import type { AgentEvent } from "../src/types.ts";

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
        res.on("data", (c: Buffer) => (data += c.toString()));
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

describe("POST /api/v1/tasks/:id/archive", () => {
  let store: Store;
  let dir: string;
  let server: http.Server;
  let port: number;
  let authStore: AuthStore;
  let apiToken: string;
  let broadcasts: AgentEvent[];
  let owed: boolean;
  let dropped: Array<[string, string]>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "webagent-archive-routes-"));
    mkdirSync(join(dir, "public"));
    store = new Store(dir);
    store.ensureRootTask(dir);
    store.createTask(
      "area",
      dir,
      "auto",
      "agent-a",
      "area-session",
      undefined,
      {
        title: "area",
      },
    );
    store.createTask("work", dir, "auto", "agent-a", "work-session", "area", {
      title: "work",
    });

    authStore = new AuthStore(join(dir, "auth.json"));
    await authStore.load();
    apiToken = (await authStore.addToken("api1", "api")).token;

    owed = false;
    dropped = [];
    broadcasts = [];
    const fakeTasks = {
      liveTasks: new Map(),
      hasOpenObligation: () => owed,
      dropObligationEdge: (source: string, target: string) => {
        dropped.push([source, target]);
      },
    } as unknown as TaskManager;

    const handler = createRequestHandler({
      store,
      tasks: fakeTasks,
      authStore,
      sseManager: {
        broadcast: (event: AgentEvent) => broadcasts.push(event),
        broadcastGlobal: () => {},
      } as never,
      publicDir: join(dir, "public"),
      dataDir: dir,
      limits: { bash_output: 1024, image_upload: 1024 },
    });
    ({ server, port } = await listen(handler));
  });

  afterEach(async () => {
    await authStore.close();
    store.close();
    await new Promise<void>((r) =>
      server.close(() => {
        r();
      }),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("archives the task and broadcasts one system message", async () => {
    const res = await req(port, "POST", "/api/v1/tasks/area/archive", apiToken);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body) as {
      status: string;
      parentId: string;
      parentPath: string;
      pendingAccount: boolean;
    };
    assert.equal(body.status, "archived");
    assert.equal(body.parentId, store.rootTaskId);
    assert.equal(body.parentPath, "@/");
    assert.equal(body.pendingAccount, false);

    assert.equal(store.getTask("area")?.parent_id, null);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].type, "system_message");
    const event = broadcasts[0];
    assert.equal(event.taskId, "area");
    assert.equal(event.kind, "task_archive");
    assert.match(event.body ?? "", /original parent/);

    const list = await req(port, "GET", "/api/v1/tasks", apiToken);
    const ids = (JSON.parse(list.body) as Array<{ id: string }>).map(
      (task) => task.id,
    );
    assert.ok(!ids.includes("area"));
    assert.ok(!ids.includes("work"));

    const only = await req(
      port,
      "GET",
      "/api/v1/tasks?archived=only",
      apiToken,
    );
    assert.deepEqual(
      (JSON.parse(only.body) as Array<{ id: string }>)
        .map((task) => task.id)
        .sort(),
      ["area", "work"],
    );
  });

  it("drops a pending account edge and reports it", async () => {
    owed = true;
    const res = await req(port, "POST", "/api/v1/tasks/work/archive", apiToken);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body) as { pendingAccount: boolean };
    assert.equal(body.pendingAccount, true);
    assert.deepEqual(dropped, [["area", "work"]]);
  });

  it("reports an archived top as a no-op", async () => {
    await req(port, "POST", "/api/v1/tasks/area/archive", apiToken);
    const res = await req(port, "POST", "/api/v1/tasks/area/archive", apiToken);
    assert.equal(res.status, 200);
    assert.equal(
      (JSON.parse(res.body) as { status: string }).status,
      "already_archived",
    );
  });

  it("refuses to archive Root", async () => {
    const res = await req(
      port,
      "POST",
      `/api/v1/tasks/${store.rootTaskId}/archive`,
      apiToken,
    );
    assert.equal(res.status, 400);
    assert.match(res.body, /Root cannot be archived/);
  });

  it("returns 404 for an unknown task", async () => {
    const res = await req(
      port,
      "POST",
      "/api/v1/tasks/missing/archive",
      apiToken,
    );
    assert.equal(res.status, 404);
  });

  it("rejects an unknown archived filter", async () => {
    const res = await req(
      port,
      "GET",
      "/api/v1/tasks?archived=bogus",
      apiToken,
    );
    assert.equal(res.status, 400);
  });
});
