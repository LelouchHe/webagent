import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TaskRemoteCancelError } from "../src/api/tasks.ts";
import { AuthStore } from "../src/auth-store.ts";
import { isHostScopeAllowedPath } from "../src/auth-middleware.ts";
import { createLocalTaskOps } from "../src/host/local/adapter.ts";
import { HostRegistry } from "../src/host/remote/registry.ts";
import { createRoutedTaskOps, resolveCancelTarget } from "../src/host/tasks.ts";
import { createRequestHandler } from "../src/http/routes.ts";
import {
  isDeliveryLinkCategory,
  LinkProtocolError,
  parseLinkEnvelope,
} from "../src/shared/link-envelope.ts";
import { SseManager } from "../src/sse-manager.ts";
import { Store } from "../src/store.ts";
import {
  SingleAgentEnvironment,
  TaskManager,
  TaskNotFoundError,
} from "../src/task-manager.ts";
import { ExecutionAuthority } from "../src/execution-authority.ts";
import { TaskStateManager } from "../src/task-state.ts";
import type { AgentEvent } from "../src/types.ts";

describe("remote lifecycle: relation envelope and outbox schema", () => {
  it("parses valid relation(child_left) envelopes and rejects malformed ones", () => {
    const id = randomUUID();
    const parsed = parseLinkEnvelope({
      id,
      category: "relation",
      data: {
        kind: "child_left",
        parentTaskId: "parent-1",
        childTaskId: "child-1",
        accountOpen: true,
      },
    });
    assert.equal(parsed.category, "relation");
    assert.deepEqual(parsed.data, {
      kind: "child_left",
      parentTaskId: "parent-1",
      childTaskId: "child-1",
      accountOpen: true,
    });
    assert.equal(isDeliveryLinkCategory("message"), true);
    assert.equal(isDeliveryLinkCategory("report"), true);
    assert.equal(isDeliveryLinkCategory("receipt"), false);
    assert.equal(isDeliveryLinkCategory("notice"), false);
    assert.equal(isDeliveryLinkCategory("relation"), false);

    assert.throws(
      () =>
        parseLinkEnvelope({
          id,
          category: "relation",
          data: {
            kind: "unknown_kind",
            parentTaskId: "parent-1",
            childTaskId: "child-1",
            accountOpen: false,
          },
        }),
      LinkProtocolError,
    );
  });

  it("enforces relation direction (owner -> hub only) and rejects delivery_id", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-relation-env-"));
    const store = new Store(dir);
    try {
      store.ensureRootTask("/tmp/root");
      const entry = store.enqueueOutbox({
        remoteRole: "parent",
        remoteHost: "hub-a",
        category: "relation",
        data: {
          kind: "child_left",
          parentTaskId: "p1",
          childTaskId: "r1",
          accountOpen: false,
        },
      });
      assert.equal(entry.category, "relation");
      assert.equal(entry.delivery_id, null);

      assert.throws(
        () =>
          store.rejectOutboxHead(
            "parent",
            "hub-a",
            entry.entry_id,
            "link_protocol_error",
          ),
        /relation_rejected_link_fault/,
      );

      const envelope = parseLinkEnvelope({
        id: entry.entry_id,
        category: "relation",
        data: JSON.parse(entry.data_json),
      });

      assert.throws(
        () =>
          store.applyLinkPushOperation({
            remoteRole: "parent",
            remoteHost: "hub-a",
            envelope,
          }),
        (err: unknown) =>
          err instanceof LinkProtocolError &&
          err.message === "relation_not_allowed_on_push",
      );

      assert.throws(
        () =>
          store.applyLinkFeedOperation({
            remoteRole: "parent",
            remoteHost: "hub-a",
            expectedApplied: 0,
            nextApplied: 1,
            envelope,
          }),
        (err: unknown) =>
          err instanceof LinkProtocolError &&
          err.message === "relation_not_allowed_on_push",
      );

      const applied = store.applyLinkFeedOperation({
        remoteRole: "child",
        remoteHost: "owner-a",
        expectedApplied: 0,
        nextApplied: 1,
        envelope,
      });
      assert.equal(applied.committed, true);
      assert.equal(store.getOutboxCursor("child", "owner-a"), 1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function createTestHost(dir: string) {
  const store = new Store(dir);
  const root = store.ensureRootTask(dir);
  const authority = new ExecutionAuthority();
  const tasks = new TaskManager({
    store,
    defaultCwd: dir,
    dataDir: dir,
    state: new TaskStateManager(),
    authority,
    agents: new SingleAgentEnvironment("pi"),
  });
  const authStore = new AuthStore(join(dir, "tokens.json"));
  await authStore.load();
  const userToken = (await authStore.addToken("user-token", "admin")).token;
  const hostToken = (await authStore.addToken("hub-a", "host")).token;
  const wrongHostToken = (await authStore.addToken("hub-other", "host")).token;
  const cancelNotices: Array<Extract<AgentEvent, { type: "system_message" }>> =
    [];
  store.onEventsCommitted((rows) => {
    for (const row of rows) {
      if (row.type !== "system_message") continue;
      const data = JSON.parse(row.data) as Record<string, unknown>;
      if (data.kind !== "task_cancel") continue;
      cancelNotices.push({
        type: "system_message",
        taskId: row.task_id,
        ...data,
      } as Extract<AgentEvent, { type: "system_message" }>);
    }
  });
  return {
    store,
    root,
    tasks,
    authority,
    authStore,
    userToken,
    hostToken,
    wrongHostToken,
    cancelNotices,
  };
}

async function startTestServer(
  handler: ReturnType<typeof createRequestHandler>,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server failed to bind");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}

describe("remote lifecycle: cancel resolver, auth, and routing", () => {
  it("allows POST /api/v1/tasks/:id/cancel in host scope", () => {
    assert.equal(
      isHostScopeAllowedPath("POST", "/api/v1/tasks/task-1/cancel"),
      true,
    );
    assert.equal(
      isHostScopeAllowedPath("GET", "/api/v1/tasks/task-1/cancel"),
      false,
    );
  });

  it("resolves user, agent, and host cancel routes with live-parent check", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-cancel-resolve-"));
    const store = new Store(dir);
    try {
      const root = store.ensureRootTask(dir);
      store.createTask("p1", dir, "auto", "pi", "s-p1", root.id, {
        title: "Parent 1",
      });
      store.createTask("p-soft", dir, "auto", "pi", "s-ps", root.id, {
        title: "Soft Parent",
      });
      store.recordRemoteChild("p1", "r1", "owner-1");
      store.recordRemoteChild("p-soft", "r-soft", "owner-1");
      // Tombstone p-soft via active share + soft delete
      store.insertSharePreview({
        token: "token-soft",
        taskId: "p-soft",
        snapshotSeq: 0,
      });
      store.activateShare("token-soft", {});
      store.deleteTask("p-soft");

      const registry = new HostRegistry(
        {
          "owner-1": {
            url: "http://127.0.0.1:9999",
            token: "tok",
          },
        },
        {
          listLinks: () =>
            store.listRemoteChildren().map((row) => ({
              localTaskId: row.local_task_id,
              remoteTaskId: row.remote_task_id,
              host: row.remote_host,
            })),
        },
      );

      // Behavior proof: user cancel resolves local task first, then live-parent remote child, then not_found
      assert.equal(
        resolveCancelTarget({ kind: "user", taskId: "p1" }, store, registry)
          .kind,
        "local",
      );
      const remoteRoute = resolveCancelTarget(
        { kind: "user", taskId: "r1" },
        store,
        registry,
      );
      assert.equal(remoteRoute.kind, "remote");
      assert.equal(remoteRoute.target.host, "owner-1");
      assert.equal(
        resolveCancelTarget({ kind: "user", taskId: "r-soft" }, store, registry)
          .kind,
        "not_found",
      );
      assert.equal(
        resolveCancelTarget(
          { kind: "user", taskId: "missing" },
          store,
          registry,
        ).kind,
        "not_found",
      );

      // Behavior proof: agent cancel resolves only its own remote child
      const agentRoute = resolveCancelTarget(
        {
          kind: "agent",
          principal: {
            taskId: "p1",
            agentId: "pi",
            generation: 1,
            initializing: false,
          },
          targetTaskId: "r1",
          reason: "stop",
        },
        store,
        registry,
      );
      assert.equal(agentRoute.kind, "remote");
      assert.equal(
        resolveCancelTarget(
          {
            kind: "agent",
            principal: {
              taskId: root.id,
              agentId: "pi",
              generation: 1,
              initializing: false,
            },
            targetTaskId: "r1",
            reason: "stop",
          },
          store,
          registry,
        ).kind,
        "local",
      );

      // Regression guard: host cancel never forwards
      assert.equal(
        resolveCancelTarget(
          { kind: "host", taskId: "r1", actor: { kind: "user" } },
          store,
          registry,
        ).kind,
        "local",
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces owner host-scope auth, strict body parsing, and hub/owner cancel records", async () => {
    const ownerDir = mkdtempSync(join(tmpdir(), "webagent-cancel-owner-"));
    const hubDir = mkdtempSync(join(tmpdir(), "webagent-cancel-hub-"));
    const owner = await createTestHost(ownerDir);
    const hub = await createTestHost(hubDir);
    let ownerServer: Awaited<ReturnType<typeof startTestServer>> | undefined;
    let hubServer: Awaited<ReturnType<typeof startTestServer>> | undefined;
    try {
      hub.store.createTask("p1", hubDir, "auto", "pi", "s-p1", hub.root.id, {
        title: "Hub Parent",
      });
      hub.store.createTask("p2", hubDir, "auto", "pi", "s-p2", hub.root.id, {
        title: "Other Hub Parent",
      });
      hub.store.saveEvent(
        "p1",
        "system_message",
        { kind: "task_created", taskId: "r1", taskTitle: "Remote Worker" },
        { from_ref: "agent" },
      );
      owner.store.createDeferredRemoteTask({
        id: "r1",
        cwd: ownerDir,
        source: "agent",
        agentId: "pi",
        externalParentId: "p1",
        remoteHost: "hub-a",
        title: "Remote Worker",
        creationAnchor: { kind: "task_created", taskId: "r1" },
      });

      const ownerLocalOps = createLocalTaskOps({
        store: owner.store,
        tasks: owner.tasks,
      });
      const ownerRemote = new HostRegistry({}, { listLinks: () => [] });
      const ownerTaskOps = {
        ...ownerLocalOps,
        ...createRoutedTaskOps({
          local: ownerLocalOps,
          remote: ownerRemote,
          store: owner.store,
          tasks: owner.tasks,
        }),
      };
      ownerServer = await startTestServer(
        createRequestHandler({
          attachmentSecret: Buffer.alloc(32, 7),
          store: owner.store,
          tasks: owner.tasks,
          taskOps: ownerTaskOps,
          sseManager: Object.assign(new SseManager(), { broadcast() {} }),
          publicDir: ownerDir,
          dataDir: ownerDir,
          limits: { bash_output: 1024, image_upload: 1024 },
          authStore: owner.authStore,
        }),
      );

      const stats = { cancelPosts: 0 };
      let dropCancelResponsesRemaining = 0;
      let onBeforeRemoteCancel: (() => void) | undefined;
      const customFetch: typeof globalThis.fetch = async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.endsWith("/cancel")) {
          stats.cancelPosts += 1;
          onBeforeRemoteCancel?.();
          const res = await globalThis.fetch(input, init);
          if (dropCancelResponsesRemaining > 0) {
            dropCancelResponsesRemaining -= 1;
            throw new TypeError("simulated response drop");
          }
          return res;
        }
        return globalThis.fetch(input, init);
      };

      hub.store.recordRemoteChild("p1", "r1", "owner-1");
      const hubRegistry = new HostRegistry(
        {
          "owner-1": {
            url: ownerServer.origin,
            token: owner.hostToken,
          },
        },
        {
          fetch: customFetch,
          listLinks: () =>
            hub.store.listRemoteChildren().map((row) => ({
              localTaskId: row.local_task_id,
              remoteTaskId: row.remote_task_id,
              host: row.remote_host,
            })),
        },
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
        }),
      };
      hubServer = await startTestServer(
        createRequestHandler({
          attachmentSecret: Buffer.alloc(32, 7),
          store: hub.store,
          tasks: hub.tasks,
          taskOps: hubTaskOps,
          hostRegistry: hubRegistry,
          sseManager: Object.assign(new SseManager(), { broadcast() {} }),
          publicDir: hubDir,
          dataDir: hubDir,
          limits: { bash_output: 1024, image_upload: 1024 },
          authStore: hub.authStore,
        }),
      );

      // 1. Wrong host token -> 404
      const wrongRes = await fetch(
        `${ownerServer.origin}/api/v1/tasks/r1/cancel`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${owner.wrongHostToken}`,
            "Content-Type": "application/json",
            "X-Client-Op-Id": "op-1",
          },
          body: JSON.stringify({ kind: "user" }),
        },
      );
      assert.equal(wrongRes.status, 404);

      // 2. Valid host token -> executes live (status "idle")
      const liveHostRes = await fetch(
        `${ownerServer.origin}/api/v1/tasks/r1/cancel`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${owner.hostToken}`,
            "Content-Type": "application/json",
            "X-Client-Op-Id": "cached-op-1",
          },
          body: JSON.stringify({ kind: "user" }),
        },
      );
      assert.equal(liveHostRes.status, 200);
      assert.deepEqual(await liveHostRes.json(), { ok: true, status: "idle" });

      // 3. Invalid body on host route -> 400 (including forged sourceTaskId)
      const badBodyRes = await fetch(
        `${ownerServer.origin}/api/v1/tasks/r1/cancel`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${owner.hostToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            kind: "agent",
            reason: "stop",
            sourceLabel: "Hub Parent",
            sourceTaskId: "forged-parent",
          }),
        },
      );
      assert.equal(badBodyRes.status, 400);

      // 4. User cancel via hub REST -> 200 idle, NO task_cancel rows on either side
      const userRemoteRes = await fetch(
        `${hubServer.origin}/api/v1/tasks/r1/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${hub.userToken}` },
        },
      );
      assert.equal(userRemoteRes.status, 200);
      assert.deepEqual(await userRemoteRes.json(), {
        ok: true,
        status: "idle",
      });
      const hubNoticeCount = () => hub.cancelNotices.length;
      const ownerNoticeCount = () => owner.cancelNotices.length;
      assert.equal(hubNoticeCount(), 0);
      assert.equal(ownerNoticeCount(), 0);

      // 5. Agent cancel via hub TaskOps -> 1 source row on hub P, 1 target row on owner R1
      const p1Lease = hub.tasks.authority.leaseFor("p1")!;
      const p2Lease = hub.tasks.authority.leaseFor("p2")!;
      const agentRes = await hubTaskOps.cancel({
        kind: "agent",
        principal: {
          taskId: "p1",
          agentId: "pi",
          generation: p1Lease.generation,
          initializing: false,
        },
        targetTaskId: "r1",
        reason: "no longer needed",
      });
      assert.deepEqual(agentRes, {
        accepted: true,
        taskId: "r1",
        status: "idle",
      });
      assert.equal(hubNoticeCount(), 1);
      assert.equal(hub.cancelNotices[0]?.role, "source");
      assert.equal(hub.cancelNotices[0]?.sourceTaskId, "p1");
      assert.equal(hub.cancelNotices[0]?.targetTaskId, "r1");
      assert.equal(ownerNoticeCount(), 1);
      assert.equal(owner.cancelNotices[0]?.role, "target");
      assert.equal(owner.cancelNotices[0]?.sourceTaskId, "p1");
      assert.equal(owner.cancelNotices[0]?.targetTaskId, "r1");

      // 6. Non-child agent cancel rejected without hitting owner
      const postsBeforeNonChild = stats.cancelPosts;
      await assert.rejects(
        () =>
          hubTaskOps.cancel({
            kind: "agent",
            principal: {
              taskId: "p2",
              agentId: "pi",
              generation: p2Lease.generation,
              initializing: false,
            },
            targetTaskId: "r1",
            reason: "not my child",
          }),
        /task_not_found/,
      );
      assert.equal(stats.cancelPosts, postsBeforeNonChild);

      // 7. Stale generation before call rejected without hitting owner
      const staleGen = p1Lease.generation;
      hub.store.replaceAgentSession("p1", "pi", "s-p1-v2");
      const freshLease = hub.tasks.authority.leaseFor("p1")!;
      await assert.rejects(
        () =>
          hubTaskOps.cancel({
            kind: "agent",
            principal: {
              taskId: "p1",
              agentId: "pi",
              generation: staleGen,
              initializing: false,
            },
            targetTaskId: "r1",
            reason: "stale before",
          }),
        /execution_replaced/,
      );
      assert.equal(stats.cancelPosts, postsBeforeNonChild);

      // 8. Generation rotated during call -> rejected AFTER remote call, NO source row written
      const hubNoticesBeforeRotate = hubNoticeCount();
      onBeforeRemoteCancel = () => {
        hub.store.replaceAgentSession("p1", "pi", "s-p1-v3");
        onBeforeRemoteCancel = undefined;
      };
      await assert.rejects(
        () =>
          hubTaskOps.cancel({
            kind: "agent",
            principal: {
              taskId: "p1",
              agentId: "pi",
              generation: freshLease.generation,
              initializing: false,
            },
            targetTaskId: "r1",
            reason: "rotated mid-flight",
          }),
        /execution_replaced/,
      );
      assert.equal(hubNoticeCount(), hubNoticesBeforeRotate);

      // 9a. Single response drop after owner commits -> single-hop retry hits owner ops,
      //     succeeds without duplicating owner's target notice, and writes hub source notice once.
      const activeLease = hub.tasks.authority.leaseFor("p1")!;
      const postsBeforeRecover = stats.cancelPosts;
      const hubNoticesBeforeRecover = hubNoticeCount();
      const ownerNoticesBeforeRecover = ownerNoticeCount();
      dropCancelResponsesRemaining = 1;
      const recovered = await hubTaskOps.cancel({
        kind: "agent",
        principal: {
          taskId: "p1",
          agentId: "pi",
          generation: activeLease.generation,
          initializing: false,
        },
        targetTaskId: "r1",
        reason: "response dropped once",
      });
      assert.equal(recovered.status, "idle");
      assert.equal(stats.cancelPosts, postsBeforeRecover + 2);
      assert.equal(hubNoticeCount(), hubNoticesBeforeRecover + 1);
      assert.equal(ownerNoticeCount(), ownerNoticesBeforeRecover + 1);

      // 9b. All 3 attempts dropped after owner commits -> TaskRemoteCancelError(unknown),
      //     no hub source row written, owner still executed only once via ops replay.
      const postsBeforeDrop = stats.cancelPosts;
      const hubNoticesBeforeDrop = hubNoticeCount();
      const ownerNoticesBeforeDrop = ownerNoticeCount();
      dropCancelResponsesRemaining = 3;
      await assert.rejects(
        () =>
          hubTaskOps.cancel({
            kind: "agent",
            principal: {
              taskId: "p1",
              agentId: "pi",
              generation: activeLease.generation,
              initializing: false,
            },
            targetTaskId: "r1",
            reason: "response dropped persistently",
          }),
        (err: unknown) =>
          err instanceof TaskRemoteCancelError && err.detail.kind === "unknown",
      );
      assert.equal(stats.cancelPosts, postsBeforeDrop + 3);
      assert.equal(hubNoticeCount(), hubNoticesBeforeDrop);
      assert.equal(ownerNoticeCount(), ownerNoticesBeforeDrop + 1);

      // 10. Deleted R1 on owner -> user REST cancel returns 404, TaskOps throws TaskRemoteCancelError(rejected, 404)
      owner.store.deleteTask("r1");
      const deletedRes = await fetch(
        `${hubServer.origin}/api/v1/tasks/r1/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${hub.userToken}` },
        },
      );
      assert.equal(deletedRes.status, 404);
      await assert.rejects(
        () => hubTaskOps.cancel({ kind: "user", taskId: "r1" }),
        (err: unknown) =>
          err instanceof TaskRemoteCancelError &&
          err.detail.kind === "rejected" &&
          err.detail.status === 404,
      );
      await assert.rejects(
        () => hubTaskOps.cancel({ kind: "user", taskId: "never-existed" }),
        TaskNotFoundError,
      );
    } finally {
      await hubServer?.close();
      await ownerServer?.close();
      hub.store.close();
      owner.store.close();
      rmSync(hubDir, { recursive: true, force: true });
      rmSync(ownerDir, { recursive: true, force: true });
    }
  });

  it("fences agent cancel after credential resolution so a rotated lease sends zero POSTs", async () => {
    const ownerDir = mkdtempSync(join(tmpdir(), "webagent-fence-owner-"));
    const hubDir = mkdtempSync(join(tmpdir(), "webagent-fence-hub-"));
    const owner = await createTestHost(ownerDir);
    const hub = await createTestHost(hubDir);
    try {
      hub.store.createTask("p1", hubDir, "auto", "pi", "s-p1", hub.root.id, {
        title: "Fence Parent",
      });
      hub.store.recordRemoteChild("p1", "r1", "owner-1");

      const readyFile = join(hubDir, "cred-ready");
      const goFile = join(hubDir, "cred-go");
      const tokenCmd = `!node -e "const fs=require('fs');fs.writeFileSync(process.argv[1],'1');const iv=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(iv);console.log(process.argv[3]);}},10);" ${JSON.stringify(readyFile)} ${JSON.stringify(goFile)} ${JSON.stringify(owner.hostToken)}`;

      const stats = { posts: 0 };
      const hubRegistry = new HostRegistry(
        {
          "owner-1": {
            url: "http://127.0.0.1:1",
            token: tokenCmd,
          },
        },
        {
          fetch: async () => {
            stats.posts += 1;
            return new Response(JSON.stringify({ ok: true, status: "idle" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
          listLinks: () =>
            hub.store.listRemoteChildren().map((row) => ({
              localTaskId: row.local_task_id,
              remoteTaskId: row.remote_task_id,
              host: row.remote_host,
            })),
        },
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
        }),
      };

      const lease = hub.tasks.authority.leaseFor("p1")!;
      const pendingCancel = hubTaskOps.cancel({
        kind: "agent",
        principal: {
          taskId: "p1",
          agentId: "pi",
          generation: lease.generation,
          initializing: false,
        },
        targetTaskId: "r1",
        reason: "rotated while resolving token",
      });

      const deadline = Date.now() + 5_000;
      while (!existsSync(readyFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(existsSync(readyFile), true);

      // Rotate P's lease while credential resolution is in flight, then release it.
      hub.store.replaceAgentSession("p1", "pi", "s-p1-v2");
      writeFileSync(goFile, "1");

      await assert.rejects(() => pendingCancel, /execution_replaced/);
      assert.equal(stats.posts, 0);
    } finally {
      hub.store.close();
      owner.store.close();
      rmSync(hubDir, { recursive: true, force: true });
      rmSync(ownerDir, { recursive: true, force: true });
    }
  });

  it("bounds outgoing sourceLabel to 256 chars and rejects mismatched HTTP/body cancel status pairs", async () => {
    const ownerDir = mkdtempSync(join(tmpdir(), "webagent-label-owner-"));
    const hubDir = mkdtempSync(join(tmpdir(), "webagent-label-hub-"));
    const owner = await createTestHost(ownerDir);
    const hub = await createTestHost(hubDir);
    let ownerServer: Awaited<ReturnType<typeof startTestServer>> | undefined;
    try {
      const longTitle = "A".repeat(257);
      hub.store.createTask("p1", hubDir, "auto", "pi", "s-p1", hub.root.id, {
        title: longTitle,
      });
      owner.store.createDeferredRemoteTask({
        id: "r1",
        cwd: ownerDir,
        source: "agent",
        agentId: "pi",
        externalParentId: "p1",
        remoteHost: "hub-a",
        title: "Remote Worker",
        creationAnchor: { kind: "task_created", taskId: "r1" },
      });
      const ownerLocalOps = createLocalTaskOps({
        store: owner.store,
        tasks: owner.tasks,
      });
      const ownerTaskOps = {
        ...ownerLocalOps,
        ...createRoutedTaskOps({
          local: ownerLocalOps,
          remote: new HostRegistry({}, { listLinks: () => [] }),
          store: owner.store,
          tasks: owner.tasks,
        }),
      };
      ownerServer = await startTestServer(
        createRequestHandler({
          attachmentSecret: Buffer.alloc(32, 7),
          store: owner.store,
          tasks: owner.tasks,
          taskOps: ownerTaskOps,
          sseManager: Object.assign(new SseManager(), { broadcast() {} }),
          publicDir: ownerDir,
          dataDir: ownerDir,
          limits: { bash_output: 1024, image_upload: 1024 },
          authStore: owner.authStore,
        }),
      );

      let overrideResponse: { status: number; body: unknown } | null = null;
      const stats = { posts: 0 };
      hub.store.recordRemoteChild("p1", "r1", "owner-1");
      const hubRegistry = new HostRegistry(
        {
          "owner-1": {
            url: ownerServer.origin,
            token: owner.hostToken,
          },
        },
        {
          fetch: async (input, init) => {
            stats.posts += 1;
            if (overrideResponse) {
              const current = overrideResponse;
              overrideResponse = null;
              return new Response(JSON.stringify(current.body), {
                status: current.status,
                headers: { "Content-Type": "application/json" },
              });
            }
            return globalThis.fetch(input, init);
          },
          listLinks: () =>
            hub.store.listRemoteChildren().map((row) => ({
              localTaskId: row.local_task_id,
              remoteTaskId: row.remote_task_id,
              host: row.remote_host,
            })),
        },
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
        }),
      };

      const lease = hub.tasks.authority.leaseFor("p1")!;
      // Fix 2: 257-character title is bounded to 256 chars and succeeds (not 400).
      const ok = await hubTaskOps.cancel({
        kind: "agent",
        principal: {
          taskId: "p1",
          agentId: "pi",
          generation: lease.generation,
          initializing: false,
        },
        targetTaskId: "r1",
        reason: "long title test",
      });
      assert.equal(ok.status, "idle");
      assert.equal(owner.cancelNotices.length, 1);
      assert.equal(owner.cancelNotices[0]?.sourceLabel?.length, 256);
      assert.equal(hub.cancelNotices.length, 1);
      assert.equal(hub.cancelNotices[0]?.sourceLabel?.length, 256);

      // Fix 2b: surrogate pair straddling index 255/256 drops the lone high surrogate.
      const emojiSplitTitle = `${"A".repeat(255)}😀`;
      hub.store.updateTaskTitle("p1", emojiSplitTitle);
      const okEmoji = await hubTaskOps.cancel({
        kind: "agent",
        principal: {
          taskId: "p1",
          agentId: "pi",
          generation: lease.generation,
          initializing: false,
        },
        targetTaskId: "r1",
        reason: "surrogate pair boundary",
      });
      assert.equal(okEmoji.status, "idle");
      const ownerEmojiLabel = owner.cancelNotices[1]?.sourceLabel ?? "";
      assert.equal(ownerEmojiLabel, "A".repeat(255));
      assert.equal(hub.cancelNotices[1]?.sourceLabel, "A".repeat(255));

      // Exact 256-code-unit title ending in a surrogate pair is preserved intact.
      const emojiExactTitle = `${"A".repeat(254)}😀`;
      hub.store.updateTaskTitle("p1", emojiExactTitle);
      await hubTaskOps.cancel({
        kind: "agent",
        principal: {
          taskId: "p1",
          agentId: "pi",
          generation: lease.generation,
          initializing: false,
        },
        targetTaskId: "r1",
        reason: "exact 256 surrogate pair",
      });
      assert.equal(owner.cancelNotices[2]?.sourceLabel, emojiExactTitle);

      // Fix 3: 202 with "idle" and 200 with "cancelling" are treated as unknown (no retry, no source row).
      const hubCount = () => hub.cancelNotices.length;
      for (const bad of [
        { status: 202, body: { ok: true, status: "idle" } },
        { status: 200, body: { ok: true, status: "cancelling" } },
      ]) {
        const postsBefore = stats.posts;
        const hubCountBefore = hubCount();
        overrideResponse = bad;
        await assert.rejects(
          () =>
            hubTaskOps.cancel({
              kind: "agent",
              principal: {
                taskId: "p1",
                agentId: "pi",
                generation: lease.generation,
                initializing: false,
              },
              targetTaskId: "r1",
              reason: "mismatched status pair",
            }),
          (err: unknown) =>
            err instanceof TaskRemoteCancelError &&
            err.detail.kind === "unknown",
        );
        assert.equal(stats.posts, postsBefore + 1);
        assert.equal(hubCount(), hubCountBefore);
      }
    } finally {
      await ownerServer?.close();
      hub.store.close();
      owner.store.close();
      rmSync(hubDir, { recursive: true, force: true });
      rmSync(ownerDir, { recursive: true, force: true });
    }
  });

  it("does not yield between owner link check and TaskOps.cancel, and returns 404 when deleted at body end", async () => {
    const ownerDir = mkdtempSync(join(tmpdir(), "webagent-yield-owner-"));
    const owner = await createTestHost(ownerDir);
    let server: ReturnType<typeof createServer> | undefined;
    try {
      for (const id of ["r1", "r2"]) {
        owner.store.createDeferredRemoteTask({
          id,
          cwd: ownerDir,
          source: "agent",
          agentId: "pi",
          externalParentId: "p1",
          remoteHost: "hub-a",
          title: `Worker ${id}`,
          creationAnchor: { kind: "task_created", taskId: id },
        });
      }

      const ownerLocalOps = createLocalTaskOps({
        store: owner.store,
        tasks: owner.tasks,
      });
      const dispatchObserved: Array<{ taskId: string; live: boolean }> = [];
      const spiedTaskOps = {
        ...ownerLocalOps,
        cancel(command: Parameters<typeof ownerLocalOps.cancel>[0]) {
          const taskId =
            command.kind === "agent" ? command.targetTaskId : command.taskId;
          dispatchObserved.push({
            taskId,
            live: owner.store.getTask(taskId) !== undefined,
          });
          return ownerLocalOps.cancel(command);
        },
      };
      let mode: "delete-at-end" | "delete-next-microtask" = "delete-at-end";
      let currentReq: import("node:http").IncomingMessage | undefined;
      const handler = createRequestHandler({
        attachmentSecret: Buffer.alloc(32, 7),
        store: owner.store,
        tasks: owner.tasks,
        taskOps: spiedTaskOps,
        sseManager: Object.assign(new SseManager(), { broadcast() {} }),
        publicDir: ownerDir,
        dataDir: ownerDir,
        limits: { bash_output: 1024, image_upload: 1024 },
        authStore: owner.authStore,
        onRequestBodyReadStart: () => {
          const req = currentReq;
          if (!req) return;
          if (mode === "delete-at-end") {
            // Registered before readBodyRaw's "end" listener: deletes r1 at
            // request-body end before the post-body continuation runs.
            req.on("end", () => {
              owner.store.deleteTask("r1");
            });
            return;
          }
          // Registered right after readBodyRaw attaches its "end" listener:
          // queues deletion in the next microtask after readBodyRaw resolves
          // (the exact tick where an extra await after link-check yields).
          queueMicrotask(() => {
            req.on("end", () => {
              queueMicrotask(() => {
                if (owner.store.getTask("r2")) owner.store.deleteTask("r2");
              });
            });
          });
        },
      });

      server = createServer((req, res) => {
        currentReq = req;
        void handler(req, res);
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("server failed to bind");
      }
      const origin = `http://127.0.0.1:${address.port}`;

      // 1. Deleted at request-body end -> 404 and zero cancel dispatch.
      mode = "delete-at-end";
      const res1 = await fetch(`${origin}/api/v1/tasks/r1/cancel`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${owner.hostToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ kind: "user" }),
      });
      assert.equal(res1.status, 404);
      assert.equal(dispatchObserved.length, 0);

      // 2. Microtask deletion queued right after readBodyRaw resolves ->
      //    live-row/link check and TaskOps.cancel run in the same synchronous
      //    continuation with no yield, so TaskOps.cancel never runs on a deleted task.
      mode = "delete-next-microtask";
      const res2 = await fetch(`${origin}/api/v1/tasks/r2/cancel`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${owner.hostToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ kind: "user" }),
      });
      assert.equal(res2.status, 200);
      assert.deepEqual(dispatchObserved, [{ taskId: "r2", live: true }]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        server.closeAllConnections();
      });
      owner.store.close();
      rmSync(ownerDir, { recursive: true, force: true });
    }
  });
});
