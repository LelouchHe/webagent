import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import type { TaskManager } from "../src/task-manager.ts";
import { createRequestHandler } from "../src/routes.ts";
import { withRequestErrorBoundary } from "../src/request-boundary.ts";
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
      configOptionsForTask: () => [],
      applyStoredConfig: (options: unknown) => options,
      warmTaskInBackground: () => {},
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
    ({ server, port } = await listen(withRequestErrorBoundary(handler)));
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

  it("reports archived on task detail for a non-top archived task", async () => {
    const active = await req(port, "GET", "/api/v1/tasks/work", apiToken);
    assert.equal(active.status, 200);
    assert.equal(
      (JSON.parse(active.body) as { archived: boolean }).archived,
      false,
    );

    await req(port, "POST", "/api/v1/tasks/area/archive", apiToken);
    for (const id of ["area", "work"]) {
      const detail = await req(port, "GET", `/api/v1/tasks/${id}`, apiToken);
      assert.equal(detail.status, 200);
      assert.equal(
        (JSON.parse(detail.body) as { archived: boolean }).archived,
        true,
        id,
      );
    }
  });

  it("unarchives an archived tree top under its recorded parent", async () => {
    await req(port, "POST", "/api/v1/tasks/area/archive", apiToken);
    const res = await req(
      port,
      "POST",
      "/api/v1/tasks/area/unarchive",
      apiToken,
    );
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(JSON.parse(res.body), {
      status: "unarchived",
      taskId: "area",
      parentId: store.rootTaskId,
      parentPath: "@/",
    });
    assert.equal(store.getTask("area")?.parent_id, store.rootTaskId);
    assert.equal(store.getTask("work")?.parent_id, "area");
    const events = store.getEvents("area");
    const last = JSON.parse(events.at(-1)!.data) as { kind: string };
    assert.equal(last.kind, "task_unarchive");
    const active = await req(port, "GET", "/api/v1/tasks", apiToken);
    assert.ok(
      (JSON.parse(active.body) as Array<{ id: string }>).some(
        (task) => task.id === "area",
      ),
    );
  });

  it("answers malformed encoding from an existing route centrally", async () => {
    const res = await req(
      port,
      "GET",
      "/api/v1/tasks/%E0%A4%A/status",
      apiToken,
    );
    assert.equal(res.status, 400);
    assert.equal(
      (JSON.parse(res.body) as { error: string }).error,
      "Invalid URL encoding",
    );
    const list = await req(port, "GET", "/api/v1/tasks", apiToken);
    assert.equal(list.status, 200);
  });

  it("answers malformed task-id encoding without crashing", async () => {
    const res = await req(
      port,
      "POST",
      "/api/v1/tasks/%E0%A4%A/unarchive",
      apiToken,
    );
    assert.equal(res.status, 400);
    // The listener still serves after the bad request.
    const list = await req(port, "GET", "/api/v1/tasks", apiToken);
    assert.equal(list.status, 200);
  });

  it("refuses to unarchive Root or a deeper archived task", async () => {
    const rootRes = await req(
      port,
      "POST",
      `/api/v1/tasks/${store.rootTaskId}/unarchive`,
      apiToken,
    );
    assert.equal(rootRes.status, 400);

    await req(port, "POST", "/api/v1/tasks/area/archive", apiToken);
    const deepRes = await req(
      port,
      "POST",
      "/api/v1/tasks/work/unarchive",
      apiToken,
    );
    assert.equal(deepRes.status, 400);
  });

  it("returns 404 for unarchiving an unknown task", async () => {
    const res = await req(
      port,
      "POST",
      "/api/v1/tasks/missing/unarchive",
      apiToken,
    );
    assert.equal(res.status, 404);
  });

  it("falls back to Root when the recorded parent is gone", async () => {
    // No archive record: a parentless task from a delete collision.
    store.createTask("orphan", dir, "auto", "agent-a", "orphan-session");
    store["db"]
      .prepare("UPDATE tasks SET parent_id = NULL WHERE id = ?")
      .run("orphan");
    const orphan = await req(
      port,
      "POST",
      "/api/v1/tasks/orphan/unarchive",
      apiToken,
    );
    assert.equal(orphan.status, 200, orphan.body);
    assert.equal(
      (JSON.parse(orphan.body) as { parentId: string }).parentId,
      store.rootTaskId,
    );
    assert.match(store.getEvents("orphan").at(-1)!.data, /none recorded/);

    // Original parent deleted.
    store.createTask("holder", dir, "auto", "agent-a", "holder-session");
    store.createTask("leaf", dir, "auto", "agent-a", "leaf-session", "holder");
    await req(port, "POST", "/api/v1/tasks/leaf/archive", apiToken);
    store["db"]
      .prepare("UPDATE tasks SET deleted_at = ? WHERE id = ?")
      .run(Date.now(), "holder");
    const unavailable = await req(
      port,
      "POST",
      "/api/v1/tasks/leaf/unarchive",
      apiToken,
    );
    assert.equal(unavailable.status, 200, unavailable.body);
    assert.equal(
      (JSON.parse(unavailable.body) as { parentId: string }).parentId,
      store.rootTaskId,
    );
    assert.match(
      store.getEvents("leaf").at(-1)!.data,
      /holder no longer exists/,
    );
  });

  it("restores under the new Root after a Root exit", async () => {
    await req(port, "POST", "/api/v1/tasks/area/archive", apiToken);
    const oldRoot = store.rootTaskId;
    const { rootTaskId: newRoot } = store.replaceRoot(oldRoot);
    assert.notEqual(newRoot, oldRoot);

    const restored = await req(
      port,
      "POST",
      "/api/v1/tasks/area/unarchive",
      apiToken,
    );
    assert.equal(restored.status, 200, restored.body);
    assert.equal(
      (JSON.parse(restored.body) as { parentId: string }).parentId,
      newRoot,
    );
    assert.equal(store.getTask("area")?.parent_id, newRoot);
    assert.match(
      store.getEvents("area").at(-1)!.data,
      new RegExp(`${oldRoot} no longer exists`),
    );
  });

  it("reports archived-parent and Root title conflicts", async () => {
    // Original parent itself inside an archived tree.
    store.createTask("grand", dir, "auto", "agent-a", "grand-session");
    store.createTask("mid", dir, "auto", "agent-a", "mid-session", "grand");
    store.createTask("leaf2", dir, "auto", "agent-a", "leaf2-session", "mid");
    await req(port, "POST", "/api/v1/tasks/grand/archive", apiToken);
    await req(port, "POST", "/api/v1/tasks/leaf2/archive", apiToken);
    const archivedParent = await req(
      port,
      "POST",
      "/api/v1/tasks/leaf2/unarchive",
      apiToken,
    );
    assert.equal(archivedParent.status, 409);
    assert.equal(
      (JSON.parse(archivedParent.body) as { reason: string }).reason,
      "original_parent_unavailable",
    );

    // Title collision under the original parent.
    await req(port, "POST", "/api/v1/tasks/work/archive", apiToken);
    store.createTask(
      "work-copy",
      dir,
      "auto",
      "agent-a",
      "work-copy-session",
      "area",
      { title: "work" },
    );
    const conflict = await req(
      port,
      "POST",
      "/api/v1/tasks/work/unarchive",
      apiToken,
    );
    assert.equal(conflict.status, 409);
    assert.equal(
      (JSON.parse(conflict.body) as { reason: string }).reason,
      "title_conflict",
    );
  });

  it("reports a title conflict when falling back to Root", async () => {
    await req(port, "POST", "/api/v1/tasks/area/archive", apiToken);
    store.replaceRoot(store.rootTaskId);
    store.createTask(
      "area-copy",
      dir,
      "auto",
      "agent-a",
      "area-copy-session",
      undefined,
      { title: "area" },
    );
    const conflict = await req(
      port,
      "POST",
      "/api/v1/tasks/area/unarchive",
      apiToken,
    );
    assert.equal(conflict.status, 409);
    assert.equal(
      (JSON.parse(conflict.body) as { reason: string }).reason,
      "title_conflict",
    );
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
