import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthStore } from "../src/auth-store.ts";
import { Store } from "../src/store.ts";
import { SseManager } from "../src/sse-manager.ts";
import { TicketStore } from "../src/sse-ticket.ts";
import { createRequestHandler } from "../src/routes.ts";
import { createTaskManager } from "../src/task-manager.ts";
import { HostRegistry } from "../src/host-registry.ts";
import { createMcpTaskToolHost } from "../src/mcp/task-host.ts";
import { mockBridgeStubs, waitFor } from "./fixtures.ts";

test("behavior proof: two runtimes close create, dispatch, update, ACK, and wake", async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), "webagent-host-loop-"));
  const ownerDir = join(rootDir, "owner");
  const hubDir = join(rootDir, "hub");
  mkdirSync(ownerDir);
  mkdirSync(hubDir);
  const publicDir = join(rootDir, "public");
  mkdirSync(publicDir);
  writeFileSync(join(publicDir, "index.html"), "<p>host loop</p>");

  const ownerStore = new Store(ownerDir);
  ownerStore.ensureRootTask(ownerDir);
  const hubStore = new Store(hubDir);
  hubStore.ensureRootTask(hubDir);
  const ownerTasks = createTaskManager(ownerStore, ownerDir, ownerDir);
  const hubTasks = createTaskManager(hubStore, hubDir, hubDir);
  const ownerPrompts: Array<{ taskId: string; text: string }> = [];
  const hubPrompts: Array<{ taskId: string; text: string }> = [];
  ownerTasks.attachExecutionBridge({
    ...mockBridgeStubs(),
    async prompt(taskId: string, text: string) {
      ownerPrompts.push({ taskId, text });
    },
  });
  hubTasks.attachExecutionBridge({
    ...mockBridgeStubs(),
    async prompt(taskId: string, text: string) {
      hubPrompts.push({ taskId, text });
    },
  });
  hubStore.createTask(
    "parent",
    hubDir,
    "agent",
    "test-agent",
    "session-parent",
    hubStore.rootTaskId,
  );
  hubTasks.liveTasks.add("parent");
  hubStore.createTask(
    "notice-parent",
    hubDir,
    "agent",
    "test-agent",
    "notice-parent-session",
    hubStore.rootTaskId,
  );
  hubTasks.liveTasks.add("notice-parent");

  const authStore = new AuthStore(join(ownerDir, "auth.json"), 0);
  await authStore.load();
  const token = (await authStore.addToken("laptop", "api")).token;
  const ticketStore = new TicketStore();
  const sseManager = new SseManager();
  ownerTasks.setExternalMessageBroadcast((credentialHash) => {
    sseManager.broadcastToCredential(credentialHash, {
      type: "host_message_pending",
    });
  });
  sseManager.setRevocationCheck(
    (credentialHash) => !authStore.hasTokenHash(credentialHash),
  );
  sseManager.startHeartbeat();
  const ownerServer = createServer(
    createRequestHandler({
      store: ownerStore,
      tasks: ownerTasks,
      sseManager,
      publicDir,
      dataDir: ownerDir,
      defaultCwd: ownerDir,
      agentIds: ["test-agent"],
      limits: { bash_output: 1_048_576, image_upload: 10_485_760 },
      authStore,
      ticketStore,
    }),
  );
  await new Promise<void>((resolve) =>
    ownerServer.listen(0, "127.0.0.1", resolve),
  );
  const ownerPort = (ownerServer.address() as { port: number }).port;
  const hosts = new HostRegistry(
    {
      mini: {
        url: `http://127.0.0.1:${ownerPort}`,
        token,
      },
    },
    hubStore,
    hubTasks,
  );
  hosts.start();
  t.after(async () => {
    hosts.stop();
    sseManager.stopHeartbeat();
    ownerTasks.dispose();
    hubTasks.dispose();
    await new Promise<void>((resolve) => {
      ownerServer.close(() => {
        resolve();
      });
    });
    await authStore.close();
    ownerStore.close();
    hubStore.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  await waitFor(() => hosts.state("mini")?.status === "ok", {
    timeoutMs: 2000,
  });
  const mcp = createMcpTaskToolHost({
    store: hubStore,
    tasks: hubTasks,
    hosts,
  });
  const lease = hubTasks.authority.leaseFor("parent");
  assert.ok(lease);
  const principal = {
    taskId: "parent",
    agentId: "test-agent",
    generation: lease.generation,
    initializing: false,
  };
  const created = await mcp.create(principal, {
    title: "build",
    agent: "test-agent@mini",
  });
  ownerTasks.liveTasks.add(created.taskId);
  await mcp.send(principal, created.taskId, "run remotely");

  await waitFor(() => ownerPrompts.length === 1, { timeoutMs: 2000 });
  assert.match(ownerPrompts[0].text, /run remotely/);
  assert.match(ownerPrompts[0].text, /External task parent/);
  const externalInbound = ownerStore
    .getEvents(created.taskId)
    .filter((event) => event.type === "system_message")
    .map((event) => JSON.parse(event.data) as Record<string, unknown>)
    .find((data) => data.kind === "collaboration");
  assert.ok(externalInbound);
  assert.equal(externalInbound.externalSource, true);
  assert.match(String(externalInbound.sourceLabel), /External task parent/);
  assert.equal(ownerStore.unarchiveTask(created.taskId).status, "unarchived");
  const ownerBroadcasts: string[] = [];
  const ownerMcp = createMcpTaskToolHost({
    store: ownerStore,
    tasks: ownerTasks,
    broadcastCollaboration: (event) => {
      ownerBroadcasts.push(event.targetTaskId);
    },
  });
  const ownerLease = ownerTasks.authority.leaseFor(created.taskId);
  assert.ok(ownerLease);
  await ownerMcp.update(
    {
      taskId: created.taskId,
      agentId: "test-agent",
      generation: ownerLease.generation,
      initializing: false,
    },
    "done",
    "finished remotely",
  );
  assert.deepEqual(ownerBroadcasts, ["parent"]);
  await waitFor(() => hubPrompts.length === 1, { timeoutMs: 2000 });
  assert.match(hubPrompts[0].text, /Task status: done/);
  assert.match(hubPrompts[0].text, /finished remotely/);
  const credential = authStore.findByToken(token);
  assert.ok(credential);
  await waitFor(() => ownerStore.listHostOutbox(credential.hash).length === 0, {
    timeoutMs: 2000,
  });
  assert.equal(hubStore.countQueuedDeliveries("parent"), 0);

  const noticeLease = hubTasks.authority.leaseFor("notice-parent");
  assert.ok(noticeLease);
  const noticeTask = await mcp.create(
    {
      taskId: "notice-parent",
      agentId: "test-agent",
      generation: noticeLease.generation,
      initializing: false,
    },
    { title: "notice-source", agent: "test-agent@mini" },
  );
  ownerTasks.liveTasks.add(noticeTask.taskId);
  const externalSource = ownerStore.getHostExternalSource(noticeTask.taskId);
  assert.ok(externalSource);
  ownerStore.createHostRuntimeNotice({
    sourceTaskId: noticeTask.taskId,
    source: externalSource,
    reason: "no_activity",
    body: "No activity for 15 minutes",
  });
  ownerTasks.notifyExternalMessage(externalSource.credential_hash);
  await waitFor(() => hubPrompts.length === 2, { timeoutMs: 2000 });
  assert.match(hubPrompts[1].text, /Runtime message:/);
  assert.match(hubPrompts[1].text, /No activity for 15 minutes/);
  assert.equal(
    hubStore
      .getEvents("notice-parent")
      .filter((event) => event.type === "task_outcome_notice").length,
    1,
  );
  assert.equal(
    hubStore
      .getEvents("notice-parent")
      .filter(
        (event) =>
          event.type === "system_message" &&
          JSON.parse(event.data).kind === "task_outcome_notice",
      ).length,
    1,
  );
});
