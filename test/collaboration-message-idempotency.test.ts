import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AgentRegistry } from "../src/agent-registry.ts";
import { AuthStore } from "../src/auth-store.ts";
import { ExecutionAuthority } from "../src/execution-authority.ts";
import { createRequestHandler } from "../src/http/routes.ts";
import { CapabilityStore } from "../src/mcp/capability.ts";
import { SseManager } from "../src/sse-manager.ts";
import { Store } from "../src/store.ts";
import { TaskManager } from "../src/task-manager.ts";
import { TaskStateManager } from "../src/task-state.ts";
import { mockBridgeStubs } from "./fixtures.ts";

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

function postMessage(
  port: number,
  sourceTaskId: string,
  options: {
    token?: string;
    body: unknown;
    opId?: string;
    rawBody?: string;
  },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = options.rawBody ?? JSON.stringify(options.body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(payload)),
    };
    if (options.token !== undefined) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    if (options.opId !== undefined) {
      headers["X-Client-Op-Id"] = options.opId;
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/api/v1/tasks/${encodeURIComponent(sourceTaskId)}/messages`,
        method: "POST",
        headers,
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
    req.end(payload);
  });
}

describe("REST collaboration message constructive idempotency", () => {
  let dir: string;
  let publicDir: string;
  let store: Store;
  let tasks: TaskManager;
  let authStore: AuthStore;
  let aliceToken: string;
  let bobToken: string;
  let hostToken: string;
  let server: http.Server;
  let port: number;
  let broadcastCalls: Array<Record<string, unknown>>;
  let lastActiveCalls: string[];
  let drainCalls: string[];

  function buildTaskManager(targetStore: Store): TaskManager {
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
    return new TaskManager({
      store: targetStore,
      defaultCwd: dir,
      dataDir: dir,
      capabilities: new CapabilityStore(),
      mcpBaseUrl: "http://127.0.0.1:0",
      state: new TaskStateManager(),
      authority: new ExecutionAuthority(),
      agents,
    });
  }

  function countRows(table: "messages" | "deliveries"): number {
    const db = (store as unknown as { db: import("better-sqlite3").Database })
      .db;
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "webagent-collab-idemp-"));
    publicDir = join(dir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "");

    broadcastCalls = [];
    lastActiveCalls = [];
    drainCalls = [];

    store = new Store(dir);
    store.ensureRootTask(dir);
    store.attachAgentSession(store.rootTaskId, "mock", "sess-root");
    store.createTask("task-a", dir, "auto", "mock", "sess-a", store.rootTaskId);
    store.createTask("task-b", dir, "auto", "mock", "sess-b", store.rootTaskId);
    store.createTask("task-c", dir, "auto", "mock", "sess-c", store.rootTaskId);

    const origUpdateLastActive = store.updateTaskLastActive.bind(store);
    store.updateTaskLastActive = (id: string) => {
      lastActiveCalls.push(id);
      origUpdateLastActive(id);
    };

    tasks = buildTaskManager(store);
    tasks.drainCollaborationDeliveries = async (taskId: string) => {
      drainCalls.push(taskId);
      return false;
    };

    authStore = new AuthStore(join(dir, "auth.json"));
    await authStore.load();
    aliceToken = (await authStore.addToken("alice", "api")).token;
    bobToken = (await authStore.addToken("bob", "api")).token;
    hostToken = (await authStore.addToken("hub-1", "host")).token;

    const sseManager = Object.assign(new SseManager(60_000), {
      broadcast(event: Record<string, unknown>) {
        broadcastCalls.push(event);
      },
      broadcastFeedEntry(entry: Record<string, unknown>) {
        broadcastCalls.push(entry);
      },
    });
    const handler = createRequestHandler({
      store,
      tasks,
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

  afterEach(async () => {
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

  it("handles concurrent identical requests with two 202s, identical ids, and one persisted fact", async () => {
    const opId = randomUUID();
    const [first, second] = await Promise.all([
      postMessage(port, "task-a", {
        token: aliceToken,
        opId,
        body: { targetTaskId: "task-b", body: "concurrent hello" },
      }),
      postMessage(port, "task-a", {
        token: aliceToken,
        opId,
        body: { targetTaskId: "task-b", body: "concurrent hello" },
      }),
    ]);

    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.deepEqual(second.body, first.body);
    assert.equal(first.body.clientOpId, opId);
    assert.equal(countRows("messages"), 1);
    assert.equal(countRows("deliveries"), 1);
    assert.equal(broadcastCalls.length, 1);
    assert.equal(lastActiveCalls.length, 1);
    assert.equal(drainCalls.length, 1);
  });

  it("replays with current delivery status after delivery advances and after target hard delete", async () => {
    const opId = randomUUID();
    const first = await postMessage(port, "task-a", {
      token: aliceToken,
      opId,
      body: { targetTaskId: "task-b", body: "advance me" },
    });
    assert.equal(first.status, 202);
    assert.equal(first.body.status, "queued");
    const deliveryId = first.body.deliveryId as string;

    // Advance delivery status to delivered.
    const claimed = store.claimQueuedDeliveries("task-b");
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, deliveryId);
    const afterDelivered = await postMessage(port, "task-a", {
      token: aliceToken,
      opId,
      body: { targetTaskId: "task-b", body: "advance me" },
    });
    assert.equal(afterDelivered.status, 202);
    assert.equal(afterDelivered.body.messageId, first.body.messageId);
    assert.equal(afterDelivered.body.deliveryId, deliveryId);
    assert.equal(afterDelivered.body.status, "delivered");
    assert.equal(afterDelivered.body.clientOpId, opId);

    // Hard-delete target task (no shares -> row removed from tasks table).
    store.deleteTask("task-b");
    assert.equal(store.getTaskIncludingDeleted("task-b"), undefined);

    const afterDelete = await postMessage(port, "task-a", {
      token: aliceToken,
      opId,
      body: { targetTaskId: "task-b", body: "advance me" },
    });
    assert.equal(afterDelete.status, 202);
    assert.equal(afterDelete.body.messageId, first.body.messageId);
    assert.equal(afterDelete.body.deliveryId, deliveryId);
    assert.equal(afterDelete.body.status, "delivered");
    assert.equal(afterDelete.body.clientOpId, opId);

    // Also verify failed status replay on a separate op when target is hard-deleted while queued.
    const opId2 = randomUUID();
    const first2 = await postMessage(port, "task-a", {
      token: aliceToken,
      opId: opId2,
      body: { targetTaskId: "task-c", body: "fail on delete" },
    });
    assert.equal(first2.status, 202);
    store.deleteTask("task-c");
    assert.equal(store.getTaskIncludingDeleted("task-c"), undefined);

    const afterDelete2 = await postMessage(port, "task-a", {
      token: aliceToken,
      opId: opId2,
      body: { targetTaskId: "task-c", body: "fail on delete" },
    });
    assert.equal(afterDelete2.status, 202);
    assert.equal(afterDelete2.body.messageId, first2.body.messageId);
    assert.equal(afterDelete2.body.deliveryId, first2.body.deliveryId);
    assert.equal(afterDelete2.body.status, "failed");
    assert.equal(afterDelete2.body.clientOpId, opId2);
  });

  it("replays the same message in an archived tree after Root exit", async () => {
    store.createTask(
      "archived-child",
      dir,
      "auto",
      "mock",
      "sess-arch-child",
      "task-a",
    );
    store.archiveTask("task-a");

    const opId = randomUUID();
    const rootBefore = store.rootTaskId;
    const first = await postMessage(port, "task-a", {
      token: aliceToken,
      opId,
      body: { targetTaskId: "archived-child", body: "before root exit" },
    });
    assert.equal(first.status, 202);

    await tasks.exitRoot();
    assert.notEqual(
      store.rootTaskId,
      rootBefore,
      "Root exit must mint a new rootTaskId",
    );

    const replay = await postMessage(port, "task-a", {
      token: aliceToken,
      opId,
      body: { targetTaskId: "archived-child", body: "before root exit" },
    });
    assert.equal(replay.status, 202);
    assert.equal(replay.body.messageId, first.body.messageId);
    assert.equal(replay.body.deliveryId, first.body.deliveryId);
    assert.equal(countRows("messages"), 1);
  });

  it("replays the same message across a fresh handler and store on the same DB (simulated restart)", async () => {
    const opId = randomUUID();
    const first = await postMessage(port, "task-a", {
      token: aliceToken,
      opId,
      body: { targetTaskId: "task-b", body: "survives restart" },
    });
    assert.equal(first.status, 202);

    const restartedStore = new Store(dir);
    restartedStore.ensureRootTask(dir);
    const restartedTasks = buildTaskManager(restartedStore);
    restartedTasks.drainCollaborationDeliveries = async () => false;
    const restartedHandler = createRequestHandler({
      store: restartedStore,
      tasks: restartedTasks,
      authStore,
      sseManager: new SseManager(60_000),
      publicDir,
      dataDir: dir,
      limits: { bash_output: 1024, image_upload: 1024 },
      serverVersion: "0.0.0-test",
    });
    const restartedServer = http.createServer(restartedHandler);
    await new Promise<void>((resolve) => {
      restartedServer.listen(0, "127.0.0.1", resolve);
    });
    const restartedPort = (restartedServer.address() as { port: number }).port;
    try {
      const replay = await postMessage(restartedPort, "task-a", {
        token: aliceToken,
        opId,
        body: { targetTaskId: "task-b", body: "survives restart" },
      });
      assert.equal(replay.status, 202);
      assert.deepEqual(replay.body, first.body);
      assert.equal(countRows("messages"), 1);
    } finally {
      restartedTasks.dispose();
      restartedStore.close();
      await new Promise<void>((resolve) => {
        restartedServer.close(() => {
          resolve();
        });
      });
    }
  });

  it("returns 409 on source, target, or verbatim body mismatch even when target is missing or self, while new ops keep 404/400", async () => {
    const opId = randomUUID();
    const first = await postMessage(port, "task-a", {
      token: aliceToken,
      opId,
      body: { targetTaskId: "task-b", body: "exact body" },
    });
    assert.equal(first.status, 202);

    // Different source task -> 409
    const diffSource = await postMessage(port, "task-c", {
      token: aliceToken,
      opId,
      body: { targetTaskId: "task-b", body: "exact body" },
    });
    assert.equal(diffSource.status, 409);

    // Different target task -> 409
    const diffTarget = await postMessage(port, "task-a", {
      token: aliceToken,
      opId,
      body: { targetTaskId: "task-c", body: "exact body" },
    });
    assert.equal(diffTarget.status, 409);

    // Different body -> 409
    const diffBody = await postMessage(port, "task-a", {
      token: aliceToken,
      opId,
      body: { targetTaskId: "task-b", body: "different body" },
    });
    assert.equal(diffBody.status, 409);

    // Whitespace difference in body is compared verbatim -> 409
    const paddedBody = await postMessage(port, "task-a", {
      token: aliceToken,
      opId,
      body: { targetTaskId: "task-b", body: " exact body " },
    });
    assert.equal(paddedBody.status, 409);

    // Known op mismatch with missing target -> 409 (not 404)
    const missingTargetConflict = await postMessage(port, "task-a", {
      token: aliceToken,
      opId,
      body: { targetTaskId: "no-such-target", body: "exact body" },
    });
    assert.equal(missingTargetConflict.status, 409);

    // Known op mismatch with self-send -> 409 (not 400)
    const selfSendConflict = await postMessage(port, "task-a", {
      token: aliceToken,
      opId,
      body: { targetTaskId: "task-a", body: "exact body" },
    });
    assert.equal(selfSendConflict.status, 409);

    // Syntax/shape validation still runs before replay (known op + blank body -> 400).
    const blankBody = await postMessage(port, "task-a", {
      token: aliceToken,
      opId,
      body: { targetTaskId: "task-b", body: "   " },
    });
    assert.equal(blankBody.status, 400);

    // Source task existence still runs before replay (known op + missing source -> 404).
    const missingSource = await postMessage(port, "no-such-source", {
      token: aliceToken,
      opId,
      body: { targetTaskId: "task-b", body: "exact body" },
    });
    assert.equal(missingSource.status, 404);

    // New op with missing target -> 404
    const newMissingTarget = await postMessage(port, "task-a", {
      token: aliceToken,
      opId: randomUUID(),
      body: { targetTaskId: "no-such-target", body: "fresh" },
    });
    assert.equal(newMissingTarget.status, 404);

    // New op with self-send -> 400
    const newSelfSend = await postMessage(port, "task-a", {
      token: aliceToken,
      opId: randomUUID(),
      body: { targetTaskId: "task-a", body: "fresh" },
    });
    assert.equal(newSelfSend.status, 400);
  });

  it("isolates op ids by token name and rejects missing or host tokens before replay", async () => {
    const sharedOpId = randomUUID();
    const alice = await postMessage(port, "task-a", {
      token: aliceToken,
      opId: sharedOpId,
      body: { targetTaskId: "task-b", body: "hello" },
    });
    assert.equal(alice.status, 202);

    const bob = await postMessage(port, "task-a", {
      token: bobToken,
      opId: sharedOpId,
      body: { targetTaskId: "task-b", body: "hello" },
    });
    assert.equal(bob.status, 202);
    assert.notEqual(bob.body.messageId, alice.body.messageId);
    assert.notEqual(bob.body.deliveryId, alice.body.deliveryId);
    assert.equal(countRows("messages"), 2);

    const beforeDenied = {
      messages: countRows("messages"),
      deliveries: countRows("deliveries"),
      broadcasts: broadcastCalls.length,
      lastActive: lastActiveCalls.length,
      drains: drainCalls.length,
    };

    // Missing token replaying an accepted op -> 401 with zero mutations/side effects
    const unauth = await postMessage(port, "task-a", {
      opId: sharedOpId,
      body: { targetTaskId: "task-b", body: "hello" },
    });
    assert.equal(unauth.status, 401);

    // Host token replaying an accepted op -> 403 with zero mutations/side effects
    const hostReplay = await postMessage(port, "task-a", {
      token: hostToken,
      opId: sharedOpId,
      body: { targetTaskId: "task-b", body: "hello" },
    });
    assert.equal(hostReplay.status, 403);

    // Fresh op with missing or host token -> 401 / 403 with zero mutations/side effects
    const unauthFresh = await postMessage(port, "task-a", {
      opId: randomUUID(),
      body: { targetTaskId: "task-b", body: "unauthorized fresh" },
    });
    assert.equal(unauthFresh.status, 401);

    const hostFresh = await postMessage(port, "task-a", {
      token: hostToken,
      opId: randomUUID(),
      body: { targetTaskId: "task-b", body: "host fresh" },
    });
    assert.equal(hostFresh.status, 403);

    assert.deepEqual(
      {
        messages: countRows("messages"),
        deliveries: countRows("deliveries"),
        broadcasts: broadcastCalls.length,
        lastActive: lastActiveCalls.length,
        drains: drainCalls.length,
      },
      beforeDenied,
    );
  });

  it("emits zero replay side effects (SSE, lastActive, drain)", async () => {
    const opId = randomUUID();
    const first = await postMessage(port, "task-a", {
      token: aliceToken,
      opId,
      body: { targetTaskId: "task-b", body: "side-effect check" },
    });
    assert.equal(first.status, 202);
    assert.equal(broadcastCalls.length, 1);
    assert.equal(lastActiveCalls.length, 1);
    assert.equal(drainCalls.length, 1);

    const replay = await postMessage(port, "task-a", {
      token: aliceToken,
      opId,
      body: { targetTaskId: "task-b", body: "side-effect check" },
    });
    assert.equal(replay.status, 202);
    assert.deepEqual(replay.body, first.body);
    assert.equal(broadcastCalls.length, 1, "replay must not broadcast SSE");
    assert.equal(
      lastActiveCalls.length,
      1,
      "replay must not call updateTaskLastActive",
    );
    assert.equal(
      drainCalls.length,
      1,
      "replay must not call drainCollaborationDeliveries",
    );
  });

  it("creates two distinct facts without echoing opId when header is omitted, and rejects empty or >128 opId with 400", async () => {
    const a = await postMessage(port, "task-a", {
      token: aliceToken,
      body: { targetTaskId: "task-b", body: "no header" },
    });
    const b = await postMessage(port, "task-a", {
      token: aliceToken,
      body: { targetTaskId: "task-b", body: "no header" },
    });
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    assert.notEqual(a.body.messageId, b.body.messageId);
    assert.notEqual(a.body.deliveryId, b.body.deliveryId);
    assert.equal("clientOpId" in a.body, false);
    assert.equal("clientOpId" in b.body, false);
    assert.equal(countRows("messages"), 2);
    assert.equal(countRows("deliveries"), 2);

    const emptyHeader = await postMessage(port, "task-a", {
      token: aliceToken,
      opId: "",
      body: { targetTaskId: "task-b", body: "empty header" },
    });
    assert.equal(emptyHeader.status, 400);

    const tooLongHeader = await postMessage(port, "task-a", {
      token: aliceToken,
      opId: "x".repeat(129),
      body: { targetTaskId: "task-b", body: "too long" },
    });
    assert.equal(tooLongHeader.status, 400);

    const maxLengthHeader = await postMessage(port, "task-a", {
      token: aliceToken,
      opId: "x".repeat(128),
      body: { targetTaskId: "task-b", body: "max length" },
    });
    assert.equal(maxLengthHeader.status, 202);
    assert.equal(maxLengthHeader.body.clientOpId, "x".repeat(128));
  });
});
