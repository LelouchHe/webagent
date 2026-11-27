import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { TaskRemoteCancelError } from "../src/api/tasks.ts";
import { AgentRegistry } from "../src/agent-registry.ts";
import { AuthStore } from "../src/auth-store.ts";
import { ExecutionAuthority } from "../src/execution-authority.ts";
import { createLocalTaskOps } from "../src/host/local/adapter.ts";
import { HostConnection } from "../src/host/remote/connection.ts";
import { HostRegistry } from "../src/host/remote/registry.ts";
import { createRoutedTaskOps } from "../src/host/tasks.ts";
import { createRequestHandler } from "../src/http/routes.ts";
import { CapabilityStore } from "../src/mcp/capability.ts";
import { withRequestErrorBoundary } from "../src/request-boundary.ts";
import { SseManager } from "../src/sse-manager.ts";
import { Store } from "../src/store.ts";
import { TaskRemoteDeleteError } from "../src/task-delete.ts";
import { TaskManager } from "../src/task-manager.ts";
import { TaskStateManager } from "../src/task-state.ts";
import { mockBridgeStubs } from "./fixtures.ts";

interface HostNode {
  dir: string;
  store: Store;
  tasks: TaskManager;
  authStore: AuthStore;
  userToken: string;
  hostToken: string;
  cancelCalls: number;
  close: () => Promise<void>;
}

async function createNode(prefix: string): Promise<HostNode> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "public"), { recursive: true });
  writeFileSync(join(dir, "public", "index.html"), "");
  const store = new Store(dir);
  store.ensureRootTask(dir);
  let cancelCalls = 0;
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
          return { sessionId: `sess-${randomUUID()}`, configOptions: [] };
        },
        async cancel() {
          cancelCalls += 1;
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
  const authStore = new AuthStore(join(dir, "auth.json"));
  await authStore.load();
  const userToken = (await authStore.addToken("user", "api")).token;
  const hostToken = (await authStore.addToken("hub-a", "host")).token;
  return {
    dir,
    store,
    tasks,
    authStore,
    userToken,
    hostToken,
    get cancelCalls() {
      return cancelCalls;
    },
    async close() {
      tasks.dispose();
      await authStore.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function startHttp(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<void>,
): Promise<{
  server: http.Server;
  origin: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(withRequestErrorBoundary(handler));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

describe("contract-07 multi-hop: HostConnection single-hop retries, beforeSend fence, and op_aborted", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("retries remote cancel (REST and MCP) and cascade multi-child delete against real Owner ops without repeating side effects", async () => {
    const owner = await createNode("wa-c07-mh-owner-");
    cleanups.push(() => owner.close());
    const hub = await createNode("wa-c07-mh-hub-");
    cleanups.push(() => hub.close());

    // Seed parent p1 on hub, and two remote children r1, r2 on owner.
    hub.store.createTask(
      "p1",
      hub.dir,
      "auto",
      "mock",
      "s-p1",
      hub.store.rootTaskId,
    );
    hub.store.updateTaskTitle("p1", "Hub Parent");
    await hub.tasks.resolveTaskExecution("p1");

    for (const rid of ["r1", "r2"]) {
      owner.store.createDeferredRemoteTask({
        id: rid,
        cwd: owner.dir,
        source: "agent",
        agentId: "mock",
        externalParentId: "p1",
        remoteHost: "hub-a",
        title: `Remote ${rid}`,
        creationAnchor: { kind: "task_created", taskId: rid },
      });
      hub.store.recordRemoteChild("p1", rid, "owner-1");
    }

    const ownerLocalOps = createLocalTaskOps({
      store: owner.store,
      tasks: owner.tasks,
    });
    const ownerHttp = await startHttp(
      createRequestHandler({
        store: owner.store,
        tasks: owner.tasks,
        taskOps: ownerLocalOps,
        sseManager: Object.assign(new SseManager(), { broadcast() {} }),
        publicDir: join(owner.dir, "public"),
        dataDir: owner.dir,
        limits: { bash_output: 1024, image_upload: 1024 },
        authStore: owner.authStore,
      }),
    );
    cleanups.push(() => ownerHttp.close());

    // Track every HTTP attempt from Hub -> Owner and drop the first response per target path.
    const attempts: Array<{
      method: string;
      path: string;
      opId: string | null;
    }> = [];
    const droppedFirst = new Set<string>();
    const flakyFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      const method = (init?.method ?? "GET").toUpperCase();
      const opId = new Headers(init?.headers).get("x-client-op-id");
      attempts.push({ method, path: url.pathname, opId });
      const res = await globalThis.fetch(input, init);
      const dropKey = `${method} ${url.pathname}`;
      if (
        (url.pathname.endsWith("/cancel") || method === "DELETE") &&
        !droppedFirst.has(dropKey)
      ) {
        droppedFirst.add(dropKey);
        throw new TypeError("simulated lost response after owner commit");
      }
      return res;
    };

    const hubRegistry = new HostRegistry(
      { "owner-1": { url: ownerHttp.origin, token: owner.hostToken } },
      {
        fetch: flakyFetch,
        listLinks: () =>
          hub.store.listRemoteChildren().map((row) => ({
            localTaskId: row.local_task_id,
            remoteTaskId: row.remote_task_id,
            host: row.remote_host,
          })),
      },
    );
    hub.tasks.setRemoteTaskDeleter((host, taskId, beforeSend) =>
      hubRegistry.deleteRemote(host, taskId, beforeSend),
    );
    const hubLocalOps = createLocalTaskOps({
      store: hub.store,
      tasks: hub.tasks,
    });
    const hubTaskOps = {
      ...hubLocalOps,
      ...createRoutedTaskOps({
        local: hubLocalOps,
        remote: hubRegistry,
        store: hub.store,
        tasks: hub.tasks,
        broadcastCollaboration: () => {},
      }),
    };
    const hubHttp = await startHttp(
      createRequestHandler({
        store: hub.store,
        tasks: hub.tasks,
        taskOps: hubTaskOps,
        hostRegistry: hubRegistry,
        sseManager: Object.assign(new SseManager(), { broadcast() {} }),
        publicDir: join(hub.dir, "public"),
        dataDir: hub.dir,
        limits: { bash_output: 1024, image_upload: 1024 },
        authStore: hub.authStore,
      }),
    );
    cleanups.push(() => hubHttp.close());

    // 1. REST-triggered remote cancel on r1: 1st response dropped, 2nd hits Owner ops and succeeds.
    await owner.tasks.resolveTaskExecution("r1");
    owner.tasks.activePrompts.add("r1");
    owner.tasks.syncBusy("r1");
    const restCancelRes = await fetch(
      `${hubHttp.origin}/api/v1/tasks/r1/cancel`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${hub.userToken}`,
          "X-Client-Op-Id": "upstream-rest-cancel",
        },
      },
    );
    assert.equal(restCancelRes.status, 202);
    assert.deepEqual(await restCancelRes.json(), {
      ok: true,
      status: "cancelling",
    });
    const r1RestAttempts = attempts.filter(
      (a) => a.method === "POST" && a.path === "/api/v1/tasks/r1/cancel",
    );
    assert.equal(r1RestAttempts.length, 2);
    assert.ok(r1RestAttempts[0].opId);
    assert.equal(
      r1RestAttempts[0].opId,
      r1RestAttempts[1].opId,
      "single-hop cancel retry must reuse generated opId",
    );
    assert.notEqual(
      r1RestAttempts[0].opId,
      "upstream-rest-cancel",
      "HostConnection generates its own single-hop opId",
    );
    assert.equal(owner.cancelCalls, 1, "Owner executed cancel only once");
    owner.tasks.activePrompts.delete("r1");
    owner.tasks.syncBusy("r1");

    // 2. MCP-triggered remote cancel on r2: 1st response dropped, retry hits Owner ops,
    //    Owner writes only ONE target task_cancel audit event.
    const lease = hub.tasks.authority.leaseFor("p1")!;
    const mcpCancelRes = await hubTaskOps.cancel({
      kind: "agent",
      principal: {
        taskId: "p1",
        agentId: "mock",
        generation: lease.generation,
        initializing: false,
      },
      targetTaskId: "r2",
      reason: "mcp cancel drop recovery",
    });
    assert.equal(mcpCancelRes.status, "idle");
    const r2CancelAttempts = attempts.filter(
      (a) => a.method === "POST" && a.path === "/api/v1/tasks/r2/cancel",
    );
    assert.equal(r2CancelAttempts.length, 2);
    assert.equal(r2CancelAttempts[0].opId, r2CancelAttempts[1].opId);
    const ownerR2CancelEvents = owner.store
      .getEvents("r2")
      .filter(
        (e) =>
          e.type === "system_message" &&
          (JSON.parse(e.data) as { kind?: string }).kind === "task_cancel",
      );
    assert.equal(
      ownerR2CancelEvents.length,
      1,
      "Owner recorded target cancel audit only once",
    );

    // 3. Parent cascade delete of p1 (owning remote children r1 & r2 on same Owner):
    //    Each child gets its own distinct single-hop opId; first response dropped on BOTH r1 & r2;
    //    both retry against Owner ops (replaying 200 { taskId }) and complete cleanly!
    const delRes = await fetch(`${hubHttp.origin}/api/v1/tasks/p1`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${hub.userToken}`,
        "X-Client-Op-Id": "upstream-cascade-delete",
      },
    });
    assert.equal(delRes.status, 200);
    assert.equal(hub.store.getTask("p1"), undefined);
    assert.equal(owner.store.getTask("r1"), undefined);
    assert.equal(owner.store.getTask("r2"), undefined);

    const r1DelAttempts = attempts.filter(
      (a) => a.method === "DELETE" && a.path === "/api/v1/tasks/r1",
    );
    const r2DelAttempts = attempts.filter(
      (a) => a.method === "DELETE" && a.path === "/api/v1/tasks/r2",
    );
    assert.equal(r1DelAttempts.length, 2);
    assert.equal(r2DelAttempts.length, 2);
    assert.ok(r1DelAttempts[0].opId && r2DelAttempts[0].opId);
    assert.equal(r1DelAttempts[0].opId, r1DelAttempts[1].opId);
    assert.equal(r2DelAttempts[0].opId, r2DelAttempts[1].opId);
    assert.notEqual(
      r1DelAttempts[0].opId,
      r2DelAttempts[0].opId,
      "each cascade-deleted remote child must have its own single-hop opId",
    );
  });

  it("stops retrying and reports unknown when beforeSend fence fails after first unknown attempt (real createRoutedTaskOps cancel rotation & delete archive)", async () => {
    // 1. Real createRoutedTaskOps cancel fence: source execution rotates via
    //    store.replaceAgentSession while packet 1 is in flight / unknown ->
    //    real authorize(principal) fence blocks packet 2, throws TaskRemoteCancelError(unknown),
    //    and writes zero hub source cancel rows.
    const cancelHub = await createNode("wa-c07-fence-cancel-hub-");
    cleanups.push(() => cancelHub.close());
    cancelHub.store.createTask(
      "p1",
      cancelHub.dir,
      "auto",
      "mock",
      "s-p1-v1",
      cancelHub.store.rootTaskId,
    );
    cancelHub.store.updateTaskTitle("p1", "Rotating Parent");
    await cancelHub.tasks.resolveTaskExecution("p1");
    const leaseBeforeRotate = cancelHub.tasks.authority.leaseFor("p1")!;
    cancelHub.store.recordRemoteChild("p1", "r1", "owner-1");

    let cancelFetches = 0;
    const cancelHubRegistry = new HostRegistry(
      { "owner-1": { url: "http://owner.example", token: "wat_host" } },
      {
        fetch: async () => {
          cancelFetches += 1;
          // Rotate source task execution while attempt 0 is in flight / timing out.
          cancelHub.store.replaceAgentSession("p1", "mock", "s-p1-v2");
          throw new TypeError("socket timed out");
        },
        listLinks: () =>
          cancelHub.store.listRemoteChildren().map((row) => ({
            localTaskId: row.local_task_id,
            remoteTaskId: row.remote_task_id,
            host: row.remote_host,
          })),
      },
    );
    const cancelLocalOps = createLocalTaskOps({
      store: cancelHub.store,
      tasks: cancelHub.tasks,
    });
    const cancelHubOps = {
      ...cancelLocalOps,
      ...createRoutedTaskOps({
        local: cancelLocalOps,
        remote: cancelHubRegistry,
        store: cancelHub.store,
        tasks: cancelHub.tasks,
        broadcastCollaboration: () => {},
      }),
    };
    await assert.rejects(
      () =>
        cancelHubOps.cancel({
          kind: "agent",
          principal: {
            taskId: "p1",
            agentId: "mock",
            generation: leaseBeforeRotate.generation,
            initializing: false,
          },
          targetTaskId: "r1",
          reason: "stop after rotation",
        }),
      (err: unknown) =>
        err instanceof TaskRemoteCancelError && err.detail.kind === "unknown",
    );
    assert.equal(
      cancelFetches,
      1,
      "must not send packet 2 after source generation rotates during attempt 0",
    );
    const hubCancelRows = cancelHub.store
      .getEvents("p1")
      .filter(
        (e) =>
          e.type === "system_message" &&
          (JSON.parse(e.data) as { kind?: string }).kind === "task_cancel",
      );
    assert.equal(
      hubCancelRows.length,
      0,
      "must not write hub source cancel row on unknown outcome",
    );

    // 2. Delete fence: subtree edge removed (beforeSend returns false) while packet 1 was unknown ->
    //    attempt 1 MUST NOT be sent, and deleteTask returns unknown (NOT skipped!).
    let deleteFetches = 0;
    let edgeStillInSubtree = true;
    const deleteConn = new HostConnection(
      { url: "http://owner.example", token: "wat_host" },
      {
        fetch: async () => {
          deleteFetches += 1;
          edgeStillInSubtree = false;
          throw new TypeError("timeout");
        },
      },
    );
    const deleteOutcome = await deleteConn.deleteTask(
      "r1",
      () => edgeStillInSubtree,
    );
    assert.equal(deleteOutcome.kind, "unknown");
    assert.equal(
      deleteFetches,
      1,
      "must not send packet 2 after post-unknown beforeSend returns false",
    );

    // 3. End-to-end synchronized delete: edge archived while packet 1 is unknown ->
    //    parent preserved with TaskRemoteDeleteError(unknown), zero 2nd packet!
    const hub = await createNode("wa-c07-fence-hub-");
    cleanups.push(() => hub.close());
    hub.store.createTask(
      "p1",
      hub.dir,
      "auto",
      "mock",
      "s-p1",
      hub.store.rootTaskId,
    );
    hub.store.createTask("c1", hub.dir, "auto", "mock", "s-c1", "p1");
    hub.store.recordRemoteChild("c1", "r1", "owner-1");

    let e2eDeleteFetches = 0;
    const hubRegistry = new HostRegistry(
      { "owner-1": { url: "http://owner.example", token: "wat_host" } },
      {
        fetch: async () => {
          e2eDeleteFetches += 1;
          // Archive c1 mid-flight so verifyBeforeSend returns false before retry.
          hub.store.archiveTask("c1");
          throw new TypeError("owner timeout");
        },
        listLinks: () =>
          hub.store.listRemoteChildren().map((row) => ({
            localTaskId: row.local_task_id,
            remoteTaskId: row.remote_task_id,
            host: row.remote_host,
          })),
      },
    );
    hub.tasks.setRemoteTaskDeleter((host, taskId, beforeSend) =>
      hubRegistry.deleteRemote(host, taskId, beforeSend),
    );
    await assert.rejects(
      () => hub.tasks.deleteTask(undefined, "p1"),
      (err: unknown) =>
        err instanceof TaskRemoteDeleteError && err.outcome === "unknown",
    );
    assert.equal(e2eDeleteFetches, 1);
    assert.ok(hub.store.getTask("p1"), "parent must be preserved on unknown");
  });

  it("classifies 409 op_aborted and post-unknown 4xx as terminal unknown without further retries", async () => {
    // 1. Direct 409 op_aborted on cancel & delete -> terminal unknown, 1 attempt only.
    let cancelAbortedCalls = 0;
    const abortedCancelConn = new HostConnection(
      { url: "http://owner.example", token: "wat_host" },
      {
        fetch: async () => {
          cancelAbortedCalls += 1;
          return Response.json(
            {
              error: "Previous attempt with this operation ID did not complete",
              code: "op_aborted",
            },
            { status: 409 },
          );
        },
      },
    );
    await assert.rejects(
      () => abortedCancelConn.cancelTask("owner-1", "r1", { kind: "user" }),
      (err: unknown) =>
        err instanceof TaskRemoteCancelError && err.detail.kind === "unknown",
    );
    assert.equal(cancelAbortedCalls, 1);

    let deleteAbortedCalls = 0;
    const abortedDeleteConn = new HostConnection(
      { url: "http://owner.example", token: "wat_host" },
      {
        fetch: async () => {
          deleteAbortedCalls += 1;
          return Response.json(
            {
              error: "Previous attempt with this operation ID did not complete",
              code: "op_aborted",
            },
            { status: 409 },
          );
        },
      },
    );
    const delAborted = await abortedDeleteConn.deleteTask("r1");
    assert.equal(delAborted.kind, "unknown");
    assert.equal(deleteAbortedCalls, 1);

    // 2. Unknown on attempt 0 followed by 4xx (401/404/409) on attempt 1 ->
    //    terminal unknown (NOT rejected!), stops after 2 attempts.
    for (const postUnknownStatus of [401, 404, 409]) {
      let cancelCalls = 0;
      const cConn = new HostConnection(
        { url: "http://owner.example", token: "wat_host" },
        {
          fetch: async () => {
            cancelCalls += 1;
            if (cancelCalls === 1) throw new TypeError("network drop");
            return Response.json(
              { error: "Rejected on retry", code: "not_found" },
              { status: postUnknownStatus },
            );
          },
        },
      );
      await assert.rejects(
        () => cConn.cancelTask("owner-1", "r1", { kind: "user" }),
        (err: unknown) =>
          err instanceof TaskRemoteCancelError && err.detail.kind === "unknown",
      );
      assert.equal(
        cancelCalls,
        2,
        `cancel must stop retrying after post-unknown ${postUnknownStatus}`,
      );

      let deleteCalls = 0;
      const dConn = new HostConnection(
        { url: "http://owner.example", token: "wat_host" },
        {
          fetch: async () => {
            deleteCalls += 1;
            if (deleteCalls === 1) throw new TypeError("network drop");
            return Response.json(
              { error: "Rejected on retry", code: "not_found" },
              { status: postUnknownStatus },
            );
          },
        },
      );
      const delOutcome = await dConn.deleteTask("r1");
      assert.equal(
        delOutcome.kind,
        "unknown",
        `delete post-unknown ${postUnknownStatus} must be unknown, not rejected`,
      );
      assert.equal(deleteCalls, 2);
    }

    // 3. Contrast: first-attempt business 404 / 409 stays rejected (never treated as deleted/unknown).
    const first404Conn = new HostConnection(
      { url: "http://owner.example", token: "wat_host" },
      {
        fetch: async () =>
          Response.json(
            { error: "Task not found", code: "not_found" },
            { status: 404 },
          ),
      },
    );
    assert.deepEqual(await first404Conn.deleteTask("r1"), {
      kind: "rejected",
      status: 404,
      reason: "Task not found",
    });
  });
});
