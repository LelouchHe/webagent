import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { AgentRegistry } from "../src/agent-registry.ts";
import { AuthStore } from "../src/auth-store.ts";
import { ExecutionAuthority } from "../src/execution-authority.ts";
import { LinkSyncOwner } from "../src/host/link-sync.ts";
import { createLocalTaskOps } from "../src/host/local/adapter.ts";
import { createTaskHost } from "../src/host/tasks.ts";
import { createRequestHandler } from "../src/http/routes.ts";
import { CapabilityStore } from "../src/mcp/capability.ts";
import { opIdentity, TASK_CREATE_NAMESPACE } from "../src/op-identity.ts";
import type { SseManager } from "../src/sse-manager.ts";
import { Store } from "../src/store.ts";
import { TaskManager } from "../src/task-manager.ts";
import { createTaskOpsCore } from "../src/task-ops.ts";
import { TaskStateManager } from "../src/task-state.ts";
import type { AgentEvent, PendingPermission } from "../src/types.ts";
import { mockBridgeStubs } from "./fixtures.ts";

interface Harness {
  dir: string;
  store: Store;
  tasks: TaskManager;
  authStore: AuthStore;
  apiToken: string;
  hostToken: string;
  port: number;
  broadcasts: AgentEvent[];
  resolveCalls: Array<{ requestId: string; optionId: string }>;
  promptCalls: number;
  holdNextPrompt: () => { started: Promise<void>; release: () => void };
  addPendingPermission: (taskId: string, requestId: string) => void;
  close: () => Promise<void>;
}

async function createHarness(existingDir?: string): Promise<Harness> {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), "webagent-c07-"));
  const publicDir = join(dir, "public");
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, "index.html"), "");

  const store = new Store(dir);
  store.ensureRootTask(dir);

  const broadcasts: AgentEvent[] = [];
  const resolveCalls: Array<{ requestId: string; optionId: string }> = [];
  let promptCalls = 0;
  let heldTurn: {
    notifyStarted: () => void;
    gate: Promise<void>;
  } | null = null;

  const agents = new AgentRegistry({
    agents: { mock: { cmd: "false" } },
    defaultAgentId: "mock",
    createTransport: () =>
      ({
        ...mockBridgeStubs(),
        agentId: "mock",
        isAlive: true,
        async start() {},
        async newSession() {
          return {
            sessionId: `sess-${randomUUID()}`,
            configOptions: [],
          };
        },
        async prompt() {
          promptCalls += 1;
          const activeHold = heldTurn;
          heldTurn = null;
          if (activeHold) {
            activeHold.notifyStarted();
            await activeHold.gate;
          }
          return { stopReason: "end_turn" };
        },
        async cancel() {},
        resolvePermission(requestId: string, optionId: string) {
          resolveCalls.push({ requestId, optionId });
        },
      }) as never,
  });

  const tasks = new TaskManager({
    store,
    defaultCwd: dir,
    dataDir: dir,
    capabilities: new CapabilityStore(),
    mcpBaseUrl: "http://127.0.0.1:0",
    state: new TaskStateManager(),
    authority: new ExecutionAuthority(),
    agents,
  });

  const local = createLocalTaskOps({ store, tasks });
  const taskOps = {
    ...local,
    ...createTaskOpsCore({
      host: createTaskHost({
        local,
        remote: {
          async create() {
            throw new Error("no remote relay");
          },
        },
      }),
      store,
      tasks,
    }),
  };

  const authStore = new AuthStore(join(dir, "auth.json"));
  await authStore.load();
  const apiToken = (await authStore.addToken("browser", "api")).token;
  const hostToken = (await authStore.addToken("hub-a", "host")).token;
  const linkSyncOwner = new LinkSyncOwner(store);

  const sseManager = {
    broadcast(event: AgentEvent) {
      broadcasts.push(event);
    },
    broadcastGlobal() {},
  } as unknown as SseManager;

  const handler = createRequestHandler({
    store,
    tasks,
    taskOps,
    linkSyncOwner,
    authStore,
    sseManager,
    publicDir,
    dataDir: dir,
    limits: { bash_output: 1024, image_upload: 1024 },
    serverVersion: "0.0.0-test",
  });

  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;

  return {
    dir,
    store,
    tasks,
    authStore,
    apiToken,
    hostToken,
    port,
    broadcasts,
    resolveCalls,
    get promptCalls() {
      return promptCalls;
    },
    holdNextPrompt() {
      let notifyStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      heldTurn = { notifyStarted, gate };
      return { started, release };
    },
    addPendingPermission(taskId: string, requestId: string) {
      const lease = tasks.authority.leaseFor(taskId);
      assert.ok(lease, "task must have an execution lease");
      const perm: PendingPermission = {
        requestId,
        taskId,
        title: "Run command",
        options: [
          { optionId: "allow_once", label: "Allow once" },
          { optionId: "deny", label: "Deny" },
        ],
        execution: { agentId: "mock", lease },
      };
      tasks.pendingPermissions.set(requestId, perm);
    },
    async close() {
      tasks.dispose();
      await authStore.close();
      store.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

function postJson(
  port: number,
  path: string,
  token: string,
  body?: unknown,
  opId?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(payload)),
              }),
          ...(opId ? { "X-Client-Op-Id": opId } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: data ? (JSON.parse(data) as Record<string, unknown>) : {},
          });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("contract-07: client_ops removal and fixed task create namespace", () => {
  const cleanupDirs: string[] = [];
  const openHarnesses: Harness[] = [];

  async function track(h: Harness): Promise<Harness> {
    openHarnesses.push(h);
    if (!cleanupDirs.includes(h.dir)) cleanupDirs.push(h.dir);
    return h;
  }

  afterEach(async () => {
    while (openHarnesses.length > 0) {
      await openHarnesses.pop()!.close();
    }
    while (cleanupDirs.length > 0) {
      rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("fresh DB has no client_ops table; legacy orphan table and rows stay untouched and unread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-c07-orphan-"));
    cleanupDirs.push(dir);

    // 1. Fresh DB has no client_ops table.
    const freshStore = new Store(dir);
    freshStore.ensureRootTask(dir);
    freshStore.close();

    const dbPath = join(dir, "webagent.db");
    const dbCheck = new Database(dbPath);
    const freshTable = dbCheck
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'client_ops'",
      )
      .get();
    assert.equal(
      freshTable,
      undefined,
      "fresh DB must not create client_ops table",
    );

    // 2. Seed an orphan legacy client_ops table with recognizable sentinel rows
    //    at the exact keys used by the four routes.
    const taskId = "legacy-task-1";
    const permOpId = "op-legacy-perm";
    const cancelOpId = "op-legacy-cancel";
    const promptOpId = "op-legacy-prompt";
    const ingressOpId = "op-legacy-ingress";

    dbCheck.exec(`
      CREATE TABLE client_ops (
        task_id      TEXT NOT NULL,
        client_op_id TEXT NOT NULL,
        result_json  TEXT NOT NULL,
        created_at   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (task_id, client_op_id)
      );
    `);
    const insertLegacy = dbCheck.prepare(
      "INSERT INTO client_ops (task_id, client_op_id, result_json, created_at) VALUES (?, ?, ?, ?)",
    );
    const legacyRows = [
      {
        task_id: taskId,
        client_op_id: permOpId,
        result_json: JSON.stringify({
          status: 200,
          body: { ok: true, sentinel: "legacy-perm" },
        }),
        created_at: 1700000001000,
      },
      {
        task_id: taskId,
        client_op_id: cancelOpId,
        result_json: JSON.stringify({
          status: 200,
          body: { ok: true, status: "cancelled", sentinel: "legacy-cancel" },
        }),
        created_at: 1700000002000,
      },
      {
        task_id: taskId,
        client_op_id: promptOpId,
        result_json: JSON.stringify({
          status: 202,
          body: { status: "accepted", sentinel: "legacy-prompt" },
        }),
        created_at: 1700000003000,
      },
      {
        task_id: "__ingress__",
        client_op_id: ingressOpId,
        result_json: JSON.stringify({
          status: 200,
          body: { id: "msg-legacy-sentinel", delivered: "pending" },
        }),
        created_at: 1700000004000,
      },
    ];
    for (const row of legacyRows) {
      insertLegacy.run(
        row.task_id,
        row.client_op_id,
        row.result_json,
        row.created_at,
      );
    }
    const ddlBefore = (
      dbCheck
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'client_ops'",
        )
        .get() as { sql: string }
    ).sql;
    dbCheck.close();

    // 3. Re-open through the real startup path and exercise all four routes
    //    with the exact seeded op ids.
    const h = await track(await createHarness(dir));
    h.store.createTask(
      taskId,
      dir,
      "auto",
      "mock",
      "sess-legacy",
      h.store.rootTaskId,
    );
    await h.tasks.resolveTaskExecution(taskId);
    h.addPendingPermission(taskId, "perm-legacy");

    const permRes = await postJson(
      h.port,
      `/api/v1/tasks/${taskId}/permissions/perm-legacy`,
      h.apiToken,
      { optionId: "allow_once" },
      permOpId,
    );
    assert.equal(permRes.status, 200);
    assert.deepEqual(permRes.body, { ok: true });
    assert.equal(h.resolveCalls.length, 1);

    const cancelRes = await postJson(
      h.port,
      `/api/v1/tasks/${taskId}/cancel`,
      h.apiToken,
      undefined,
      cancelOpId,
    );
    assert.equal(cancelRes.status, 200);
    assert.deepEqual(cancelRes.body, { ok: true, status: "idle" });

    const promptRes = await postJson(
      h.port,
      `/api/v1/tasks/${taskId}/prompt`,
      h.apiToken,
      { text: "live prompt" },
      promptOpId,
    );
    assert.equal(promptRes.status, 202);
    assert.deepEqual(promptRes.body, { status: "accepted" });
    await waitUntil(() => h.promptCalls === 1);

    const ingressRes = await postJson(
      h.port,
      "/api/v1/messages",
      h.apiToken,
      {
        from_ref: "cron:test",
        to: "user",
        title: "Live ingress",
        body: "body",
      },
      ingressOpId,
    );
    assert.equal(ingressRes.status, 200);
    assert.notEqual(ingressRes.body.id, "msg-legacy-sentinel");
    assert.equal(ingressRes.body.delivered, "pending");

    // 4. Orphan table DDL and legacy rows remain untouched after boot and calls.
    await h.close();
    openHarnesses.pop();
    const dbAfter = new Database(dbPath, { readonly: true });
    const ddlAfter = (
      dbAfter
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'client_ops'",
        )
        .get() as { sql: string }
    ).sql;
    const rowsAfter = dbAfter
      .prepare(
        "SELECT task_id, client_op_id, result_json, created_at FROM client_ops ORDER BY created_at",
      )
      .all();
    dbAfter.close();

    assert.equal(ddlAfter, ddlBefore);
    assert.deepEqual(rowsAfter, legacyRows);
  });

  it("permission resend with same opId returns 404 and answers agent only once", async () => {
    const h = await track(await createHarness());
    const created = await postJson(h.port, "/api/v1/tasks", h.apiToken, {
      agentId: "mock",
    });
    const taskId = created.body.id as string;
    await h.tasks.resolveTaskExecution(taskId);
    h.addPendingPermission(taskId, "perm-1");

    const opId = `op-perm-${randomUUID()}`;
    const body = { optionId: "allow_once" };
    const first = await postJson(
      h.port,
      `/api/v1/tasks/${taskId}/permissions/perm-1`,
      h.apiToken,
      body,
      opId,
    );
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { ok: true });
    assert.equal(h.resolveCalls.length, 1);

    const resend = await postJson(
      h.port,
      `/api/v1/tasks/${taskId}/permissions/perm-1`,
      h.apiToken,
      body,
      opId,
    );
    assert.equal(resend.status, 404);
    assert.equal(h.resolveCalls.length, 1);
  });

  it("cancel resend with same opId transitions from 202 cancelling to 200 idle after work settles", async () => {
    const h = await track(await createHarness());
    const created = await postJson(h.port, "/api/v1/tasks", h.apiToken, {
      agentId: "mock",
    });
    const taskId = created.body.id as string;

    const hold = h.holdNextPrompt();
    const promptRes = await postJson(
      h.port,
      `/api/v1/tasks/${taskId}/prompt`,
      h.apiToken,
      { text: "long turn" },
    );
    assert.equal(promptRes.status, 202);
    await hold.started;

    const opId = `op-cancel-${randomUUID()}`;
    const firstCancel = await postJson(
      h.port,
      `/api/v1/tasks/${taskId}/cancel`,
      h.apiToken,
      undefined,
      opId,
    );
    assert.equal(firstCancel.status, 202);
    assert.deepEqual(firstCancel.body, { ok: true, status: "cancelling" });

    hold.release();
    await waitUntil(() => !h.tasks.activePrompts.has(taskId));

    const resendCancel = await postJson(
      h.port,
      `/api/v1/tasks/${taskId}/cancel`,
      h.apiToken,
      undefined,
      opId,
    );
    assert.equal(resendCancel.status, 200);
    assert.deepEqual(resendCancel.body, { ok: true, status: "idle" });
  });

  it("prompt resend with same opId returns 409 while busy and keeps raw clientOpId correlation", async () => {
    const h = await track(await createHarness());
    const created = await postJson(h.port, "/api/v1/tasks", h.apiToken, {
      agentId: "mock",
    });
    const taskId = created.body.id as string;

    const hold = h.holdNextPrompt();
    const opId = `op-prompt-${randomUUID()}`;
    const body = { text: "hello world" };

    const first = await postJson(
      h.port,
      `/api/v1/tasks/${taskId}/prompt`,
      h.apiToken,
      body,
      opId,
    );
    assert.equal(first.status, 202);
    await hold.started;

    const busyResend = await postJson(
      h.port,
      `/api/v1/tasks/${taskId}/prompt`,
      h.apiToken,
      body,
      opId,
    );
    assert.equal(busyResend.status, 409);
    assert.equal(h.promptCalls, 1);

    // Regression guard: raw clientOpId is preserved on both stored event and SSE.
    const storedUserEvents = h.store
      .getEvents(taskId)
      .filter((e) => e.type === "user_message");
    assert.equal(storedUserEvents.length, 1);
    assert.equal(
      (JSON.parse(storedUserEvents[0].data) as { clientOpId?: string })
        .clientOpId,
      opId,
    );
    const sseUserEvents = h.broadcasts.filter(
      (e) => e.type === "user_message" && e.taskId === taskId,
    );
    assert.equal(sseUserEvents.length, 1);
    assert.equal(
      (sseUserEvents[0] as { clientOpId?: string }).clientOpId,
      opId,
    );

    hold.release();
    await waitUntil(() => !h.tasks.activePrompts.has(taskId));

    const afterIdle = await postJson(
      h.port,
      `/api/v1/tasks/${taskId}/prompt`,
      h.apiToken,
      body,
      opId,
    );
    assert.equal(afterIdle.status, 202);
    await waitUntil(() => h.promptCalls === 2);
  });

  it("ingress resend with same opId produces distinct messages and replaces on dedup_key", async () => {
    const h = await track(await createHarness());
    const created = await postJson(h.port, "/api/v1/tasks", h.apiToken, {
      agentId: "mock",
    });
    const taskId = created.body.id as string;

    // 1. Direct to:task:<id> produces two distinct message events.
    const directOpId = `op-ingress-direct-${randomUUID()}`;
    const directBody = {
      from_ref: "cron:nightly",
      to: `task:${taskId}`,
      title: "Direct ping",
      body: "hello",
    };
    const d1 = await postJson(
      h.port,
      "/api/v1/messages",
      h.apiToken,
      directBody,
      directOpId,
    );
    const d2 = await postJson(
      h.port,
      "/api/v1/messages",
      h.apiToken,
      directBody,
      directOpId,
    );
    assert.equal(d1.status, 200);
    assert.equal(d2.status, 200);
    assert.notEqual(d2.body.id, d1.body.id);
    const taskMsgEvents = h.store
      .getEvents(taskId)
      .filter((e) => e.type === "message");
    assert.equal(taskMsgEvents.length, 2);

    // 2. Unbound to:user without dedup_key produces two rows.
    const unboundOpId = `op-ingress-unbound-${randomUUID()}`;
    const unboundBody = {
      from_ref: "external:ci",
      to: "user",
      title: "Build done",
      body: "ok",
    };
    const u1 = await postJson(
      h.port,
      "/api/v1/messages",
      h.apiToken,
      unboundBody,
      unboundOpId,
    );
    const u2 = await postJson(
      h.port,
      "/api/v1/messages",
      h.apiToken,
      unboundBody,
      unboundOpId,
    );
    assert.equal(u1.status, 200);
    assert.equal(u2.status, 200);
    assert.notEqual(u2.body.id, u1.body.id);
    assert.equal(h.store.listUnprocessed().length, 2);

    // 3. Unbound to:user with same dedup_key replaces the old row with a new id.
    const dedupOpId = `op-ingress-dedup-${randomUUID()}`;
    const dedupBody = {
      from_ref: "cron:backup",
      to: "user",
      dedup_key: "daily-backup",
      title: "Backup",
      body: "done",
    };
    const k1 = await postJson(
      h.port,
      "/api/v1/messages",
      h.apiToken,
      dedupBody,
      dedupOpId,
    );
    const k2 = await postJson(
      h.port,
      "/api/v1/messages",
      h.apiToken,
      dedupBody,
      dedupOpId,
    );
    assert.equal(k1.status, 200);
    assert.equal(k2.status, 200);
    assert.notEqual(k2.body.id, k1.body.id);
    assert.equal(h.store.getMessage(k1.body.id as string), undefined);
    assert.ok(h.store.getMessage(k2.body.id as string));
  });

  it("local create replay hits surviving child under archived parent across Root exit", async () => {
    const h = await track(await createHarness());
    const parentRes = await postJson(h.port, "/api/v1/tasks", h.apiToken, {
      agentId: "mock",
      parentId: h.store.rootTaskId,
      title: "Archived parent",
    });
    assert.equal(parentRes.status, 201);
    const parentId = parentRes.body.id as string;

    const opId = `op-local-create-${randomUUID()}`;
    const expectedId = opIdentity(TASK_CREATE_NAMESPACE, "token:browser", opId);
    const first = await postJson(
      h.port,
      "/api/v1/tasks",
      h.apiToken,
      {
        agentId: "mock",
        parentId,
        title: "Surviving child",
      },
      opId,
    );
    assert.equal(first.status, 201);
    assert.equal(first.body.id, expectedId);

    // Archive the parent (not the child itself) so the subtree survives Root exit.
    const archived = h.store.archiveTask(parentId);
    assert.equal(archived?.status, "archived");

    const rootBefore = h.store.rootTaskId;
    const replaced = h.store.replaceRoot(rootBefore);
    assert.notEqual(replaced.rootTaskId, rootBefore);
    assert.notEqual(h.store.rootTaskId, rootBefore);

    const replay = await postJson(
      h.port,
      "/api/v1/tasks",
      h.apiToken,
      {
        agentId: "mock",
        parentId,
        title: "Surviving child",
      },
      opId,
    );
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, expectedId);

    const db = (h.store as unknown as { db: Database.Database }).db;
    const childRows = db
      .prepare(
        "SELECT id FROM tasks WHERE parent_id = ? AND deleted_at IS NULL",
      )
      .all(parentId) as Array<{ id: string }>;
    assert.equal(childRows.length, 1);
    assert.equal(childRows[0].id, expectedId);
    assert.equal(h.store.getBindingAgent(expectedId), "mock");
    const bindingCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_sessions WHERE task_id = ?",
        )
        .get(expectedId) as { count: number }
    ).count;
    assert.equal(bindingCount, 1);
  });

  it("host create replay hits surviving task with external parent link across owner Root exit", async () => {
    const h = await track(await createHarness());
    const opId = `op-host-create-${randomUUID()}`;
    const expectedId = opIdentity(TASK_CREATE_NAMESPACE, "host:hub-a", opId);
    const reqBody = {
      agentId: "mock",
      parentId: "hub-parent-1",
      title: "Remote survivor",
    };

    const first = await postJson(
      h.port,
      "/api/v1/tasks",
      h.hostToken,
      reqBody,
      opId,
    );
    assert.equal(first.status, 201);
    assert.equal(first.body.id, expectedId);

    // Exit owner's Root without unlinking the external parent.
    const rootBefore = h.store.rootTaskId;
    const replaced = h.store.replaceRoot(rootBefore);
    assert.notEqual(replaced.rootTaskId, rootBefore);
    assert.notEqual(h.store.rootTaskId, rootBefore);

    const replay = await postJson(
      h.port,
      "/api/v1/tasks",
      h.hostToken,
      reqBody,
      opId,
    );
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, expectedId);

    const db = (h.store as unknown as { db: Database.Database }).db;
    const nonRootTasks = db
      .prepare("SELECT id FROM tasks WHERE id != ? AND deleted_at IS NULL")
      .all(h.store.rootTaskId) as Array<{ id: string }>;
    assert.equal(nonRootTasks.length, 1);
    assert.equal(nonRootTasks[0].id, expectedId);

    const bindingCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_sessions WHERE task_id = ?",
        )
        .get(expectedId) as { count: number }
    ).count;
    assert.equal(bindingCount, 1);

    const extLinkCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM remote_tasks WHERE local_task_id = ? AND remote_role = 'parent'",
        )
        .get(expectedId) as { count: number }
    ).count;
    assert.equal(extLinkCount, 1);
  });
});
