import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { AgentRegistry } from "../src/agent-registry.ts";
import { AuthStore } from "../src/auth-store.ts";
import { ExecutionAuthority } from "../src/execution-authority.ts";
import { LinkSyncOwner } from "../src/host/link-sync.ts";
import { createLocalTaskOps } from "../src/host/local/adapter.ts";
import { createTaskHost } from "../src/host/tasks.ts";
import { createRequestHandler } from "../src/http/routes.ts";
import { CapabilityStore } from "../src/mcp/capability.ts";
import { opIdentity } from "../src/shared/sync/index.ts";
import { SseManager } from "../src/sse-manager.ts";
import { Store } from "../src/store.ts";
import { TaskManager } from "../src/task-manager.ts";
import { createTaskOpsCore } from "../src/task-ops.ts";
import { TaskStateManager } from "../src/task-state.ts";
import { mockBridgeStubs } from "./fixtures.ts";
import { assertIdempotentRoute } from "./fixtures/idempotency.ts";

function postJson(
  port: number,
  path: string,
  token: string,
  body: unknown,
  opId?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(payload)),
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
            body: data ? (JSON.parse(data) as unknown) : null,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("structural idempotency conformance", () => {
  let dir: string;
  let store: Store;
  let tasks: TaskManager;
  let authStore: AuthStore;
  let apiToken: string;
  let hostToken: string;
  let otherHostToken: string;
  let server: http.Server;
  let port: number;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "webagent-idempotency-"));
    const publicDir = join(dir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "");

    store = new Store(dir);
    store.ensureRootTask(dir);
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
        }) as never,
    });
    tasks = new TaskManager({
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
    authStore = new AuthStore(join(dir, "auth.json"));
    await authStore.load();
    apiToken = (await authStore.addToken("browser", "api")).token;
    hostToken = (await authStore.addToken("hub-a", "host")).token;
    otherHostToken = (await authStore.addToken("hub-b", "host")).token;
    const linkSyncOwner = new LinkSyncOwner(store);
    const sseManager = new SseManager(60_000);
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
    server = http.createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    tasks.dispose();
    await authStore.close();
    store.close();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("enforces deterministic idempotency on owner POST /api/v1/tasks (host create)", async () => {
    const opId = randomUUID();
    const expectedId = opIdentity(store.rootTaskId, "host:hub-a", opId);
    const snapshot = () => ({
      tasks: store.listTasks().length,
      events: store.getEvents(expectedId).length,
    });

    const { first } = await assertIdempotentRoute({
      expectedStatus: 201,
      opId,
      snapshot,
      invoke: (id) =>
        postJson(
          port,
          "/api/v1/tasks",
          hostToken,
          {
            agentId: "mock",
            parentId: "ext-parent-1",
            title: "Deterministic child",
          },
          id,
        ),
      invokeConflicting: (id) =>
        postJson(
          port,
          "/api/v1/tasks",
          hostToken,
          {
            agentId: "mock",
            parentId: "ext-parent-different",
            title: "Deterministic child",
          },
          id,
        ),
    });

    assert.equal((first.body as { id: string }).id, expectedId);

    // Mutating a mutable field (title) on the persisted task still replays with current state (#4).
    store.updateTaskTitle(expectedId, "Renamed child");
    const afterRename = await postJson(
      port,
      "/api/v1/tasks",
      hostToken,
      {
        agentId: "mock",
        parentId: "ext-parent-1",
        title: "Deterministic child",
      },
      opId,
    );
    assert.equal(afterRename.status, 201);
    assert.equal(
      (afterRename.body as { title: string }).title,
      "Renamed child",
    );

    // Same opId from a different caller derives a distinct task id (scoped by caller).
    const other = await postJson(
      port,
      "/api/v1/tasks",
      otherHostToken,
      {
        agentId: "mock",
        parentId: "ext-parent-1",
        title: "Deterministic child",
      },
      opId,
    );
    assert.equal(other.status, 201);
    assert.equal(
      (other.body as { id: string }).id,
      opIdentity(store.rootTaskId, "host:hub-b", opId),
    );
    assert.notEqual((other.body as { id: string }).id, expectedId);

    // Hub recordRemoteChild is idempotent for the same edge and conflicts on a different parent (#3).
    assert.equal(
      store.recordRemoteChild(store.rootTaskId, "remote-edge-1", "owner"),
      true,
    );
    assert.equal(
      store.recordRemoteChild(store.rootTaskId, "remote-edge-1", "owner"),
      false,
    );
    assert.throws(
      () => store.recordRemoteChild(expectedId, "remote-edge-1", "owner"),
      /remote_child_link_conflict/,
    );

    // Soft-deleted task replay returns explicit 404 target_deleted rather than recreating.
    store.insertSharePreview({
      token: "view-token",
      taskId: expectedId,
      snapshotSeq: 1,
    });
    store.activateShare("view-token");
    store.deleteTask(expectedId);
    const afterDelete = await postJson(
      port,
      "/api/v1/tasks",
      hostToken,
      {
        agentId: "mock",
        parentId: "ext-parent-1",
        title: "Deterministic child",
      },
      opId,
    );
    assert.equal(afterDelete.status, 404);
    assert.deepEqual(afterDelete.body, { error: "target_deleted" });
  });

  it("enforces deterministic idempotency on local POST /api/v1/tasks and creates two tasks when opId is null", async () => {
    const opId = randomUUID();
    const expectedId = opIdentity(store.rootTaskId, "token:browser", opId);
    const snapshot = () => ({
      tasks: store.listTasks().length,
      parentEvents: store.getEvents(store.rootTaskId).length,
    });

    const { first } = await assertIdempotentRoute({
      expectedStatus: 201,
      opId,
      snapshot,
      invoke: (id) =>
        postJson(
          port,
          "/api/v1/tasks",
          apiToken,
          {
            agentId: "mock",
            parentId: store.rootTaskId,
            title: "Local deterministic child",
          },
          id,
        ),
      invokeConflicting: (id) =>
        postJson(
          port,
          "/api/v1/tasks",
          apiToken,
          {
            agentId: "other-agent",
            parentId: store.rootTaskId,
            title: "Local deterministic child",
          },
          id,
        ),
    });
    assert.equal((first.body as { id: string }).id, expectedId);

    // Without X-Client-Op-Id (opId: null), two identical calls create two distinct tasks.
    const a = await postJson(port, "/api/v1/tasks", apiToken, {
      agentId: "mock",
      parentId: store.rootTaskId,
      title: "Non-idempotent A",
    });
    const b = await postJson(port, "/api/v1/tasks", apiToken, {
      agentId: "mock",
      parentId: store.rootTaskId,
      title: "Non-idempotent B",
    });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(
      (a.body as { id: string }).id,
      (b.body as { id: string }).id,
    );

    // Concurrent duplicate create colliding on PK must not revoke the winner's capability token.
    const winnerId = (a.body as { id: string }).id;
    const caps = (tasks as unknown as { capabilities: CapabilityStore })
      .capabilities;
    const winnerToken = caps.mint(winnerId, "mock", 1);
    const bridge = {
      ...mockBridgeStubs(),
      agentId: "mock",
      isAlive: true,
      async newSession() {
        return { sessionId: `sess-dup-${randomUUID()}`, configOptions: [] };
      },
    };
    await assert.rejects(() =>
      tasks.createTask(bridge, dir, undefined, "auto", {
        id: winnerId,
        parentId: store.rootTaskId,
        title: "Duplicate",
      }),
    );
    assert.ok(
      caps.resolve(winnerToken),
      "winner capability token must survive a colliding duplicate create",
    );
  });

  it("enforces deterministic idempotency on owner POST /api/v1/link/entries", async () => {
    const createOpId = randomUUID();
    const created = await postJson(
      port,
      "/api/v1/tasks",
      hostToken,
      {
        agentId: "mock",
        parentId: "ext-parent-push",
        title: "Push target",
      },
      createOpId,
    );
    assert.equal(created.status, 201);
    const targetId = (created.body as { id: string }).id;

    const entryId = randomUUID();
    const snapshot = () => ({
      queued: store.countQueuedDeliveries(targetId),
      outbox: store.listOutbox("parent", "hub-a", 0, 100).length,
    });

    await assertIdempotentRoute({
      expectedStatus: 202,
      opId: entryId,
      snapshot,
      invoke: (id) =>
        postJson(port, "/api/v1/link/entries", hostToken, {
          id,
          category: "message",
          data: {
            sourceTaskId: "ext-parent-push",
            targetTaskId: targetId,
            sourceLabel: "Hub parent",
            body: "idempotent payload",
          },
        }),
      invokeConflicting: (id) =>
        postJson(port, "/api/v1/link/entries", hostToken, {
          id,
          category: "message",
          data: {
            sourceTaskId: "ext-parent-push",
            targetTaskId: targetId,
            sourceLabel: "Hub parent",
            body: "mutated payload",
          },
        }),
    });
  });
});
