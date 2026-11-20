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
  body?: string,
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
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
    if (body !== undefined) r.write(body);
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
      archiveTask: (id: string) => {
        const result = store.archiveTask(id);
        if (result?.parentId) dropped.push([result.parentId, id]);
        return result;
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
      "/api/v1/tasks?archived=true",
      apiToken,
    );
    assert.deepEqual(
      (JSON.parse(only.body) as Array<{ id: string }>)
        .map((task) => task.id)
        .sort(),
      ["area", "work"],
    );
    const explicitActive = await req(
      port,
      "GET",
      "/api/v1/tasks?archived=false",
      apiToken,
    );
    assert.deepEqual(
      (JSON.parse(explicitActive.body) as Array<{ id: string }>)
        .map((task) => task.id)
        .sort(),
      ids.sort(),
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

  it("marks queued deliveries across the cut edge as interrupted", async () => {
    // One outgoing request (area → work) and one account (work → area), plus a
    // tree-internal edge (work → work-child) that must survive the archive.
    store.createTask(
      "work-child",
      dir,
      "auto",
      "agent-a",
      "wc-session",
      "work",
      {
        title: "work-child",
      },
    );
    for (const [id, source, target, body] of [
      ["m-request", "area", "work", "request"],
      ["m-account", "work", "area", "account"],
      ["m-internal", "work", "work-child", "internal"],
    ] as const) {
      store.createCollaborationMessage({
        id,
        deliveryId: `d-${id}`,
        sourceTaskId: source,
        directTargetTaskId: target,
        sourceActor: "agent",
        body,
      });
    }

    const res = await req(port, "POST", "/api/v1/tasks/work/archive", apiToken);
    assert.equal(res.status, 200);

    for (const deliveryId of ["d-m-request", "d-m-account"]) {
      const delivery = store.getCollaborationDelivery(deliveryId);
      assert.ok(delivery);
      assert.equal(delivery.status, "failed");
      assert.equal(delivery.failure_reason, "archived_edge_cut");
    }
    // The message rows are kept as evidence.
    assert.equal(store.getCollaborationMessage("m-request")?.body, "request");
    assert.equal(store.getCollaborationMessage("m-account")?.body, "account");
    // Internal work is untouched.
    assert.equal(
      store.getCollaborationDelivery("d-m-internal")?.status,
      "queued",
    );
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

  it("rejects a rename collision with a sibling inside an archived tree", async () => {
    store.createTask("work2", dir, "auto", "agent-a", "work2-session", "area", {
      title: "work2",
    });
    await req(port, "POST", "/api/v1/tasks/area/archive", apiToken);
    // `work` and `work2` are still siblings under the archived top. Their
    // parent is non-null, so the partial unique index really does reject the
    // rename; the pre-check must see the archived sibling and answer 400
    // without reaching the DB error.
    const res = await req(
      port,
      "PUT",
      "/api/v1/tasks/work2/title",
      apiToken,
      JSON.stringify({ value: "work" }),
    );
    assert.equal(res.status, 400, res.body);
    assert.match(res.body, /already has that title/);
    assert.equal(store.getTask("work2")?.title, "work2");
  });

  it("reports a concurrent out-of-scope send as 4xx, not 500", async () => {
    const original = store.createCollaborationMessage.bind(store);
    store.createCollaborationMessage = () => {
      throw new Error("Collaboration tasks have no common ancestor");
    };
    try {
      const res = await req(
        port,
        "POST",
        "/api/v1/tasks/area/messages",
        apiToken,
        JSON.stringify({ targetTaskId: "work", body: "hi" }),
      );
      assert.equal(res.status, 400, res.body);
      assert.match(res.body, /outside the local collaboration scope/);
    } finally {
      store.createCollaborationMessage = original;
    }
  });

  it("keeps lineage invariant failures as 5xx", async () => {
    const original = store.createCollaborationMessage.bind(store);
    store.createCollaborationMessage = () => {
      throw new Error("Cannot determine collaboration task lineage");
    };
    try {
      const res = await req(
        port,
        "POST",
        "/api/v1/tasks/area/messages",
        apiToken,
        JSON.stringify({ targetTaskId: "work", body: "hi" }),
      );
      assert.equal(res.status, 500, res.body);
      assert.match(res.body, /lineage/);
    } finally {
      store.createCollaborationMessage = original;
    }
  });

  it("answers a store failure as a diagnosable archive error", async () => {
    const original = store.archiveTask.bind(store);
    store.archiveTask = () => {
      throw new Error("simulated write failure");
    };
    try {
      const res = await req(
        port,
        "POST",
        "/api/v1/tasks/area/archive",
        apiToken,
      );
      assert.equal(res.status, 500, res.body);
      assert.match(res.body, /Archive failed: simulated write failure/);
    } finally {
      store.archiveTask = original;
    }
    // The failed call wrote nothing: the task is still attached.
    assert.equal(store.getTask("area")?.parent_id, store.rootTaskId);
  });

  it("rejects an unknown archived filter", async () => {
    for (const value of ["bogus", "include", "only", "exclude"]) {
      const res = await req(
        port,
        "GET",
        `/api/v1/tasks?archived=${value}`,
        apiToken,
      );
      assert.equal(res.status, 400, value);
    }
  });
});
