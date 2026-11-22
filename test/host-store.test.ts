import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.ts";
import { TaskLocator } from "../src/task-locator.ts";
import { requestHash } from "../src/host/protocol.ts";
import Database from "better-sqlite3";
import { createTaskManager } from "../src/task-manager.ts";
import { waitFor } from "./fixtures.ts";
import { HostStore } from "../src/host/store.ts";
import { DeliveryQueue } from "../src/delivery-queue.ts";

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "webagent-host-store-"));
  const store = new Store(dir);
  store.ensureRootTask(dir);
  const hostStore = new HostStore(store);
  let closed = false;
  const close = () => {
    if (closed) return;
    store.close();
    closed = true;
  };
  t.after(() => {
    close();
    return rm(dir, { recursive: true, force: true });
  });
  return { dir, store, hostStore, close };
}

test("behavior proof: owner create binding and dispatch dedup survive reopen", async (t) => {
  const { dir, store, hostStore, close } = await fixture(t);
  const request = {
    credentialHash: "a".repeat(64),
    parentTaskId: randomUUID(),
    createKey: "create-1",
    requestHash: requestHash({ parentTaskId: "parent", title: "remote" }),
    agentId: "copilot",
    cwd: dir,
    title: "remote",
  };
  const created = hostStore.createHostTask(request);
  assert.equal(created.status, "created");
  assert.equal(store.getTask(created.taskId)?.parent_id, null);
  assert.equal(store.getTask(created.taskId)?.mode, "agent");
  assert.equal(store.getEventCount(created.taskId), 1);
  const repeated = hostStore.createHostTask(request);
  assert.equal(repeated.status, "reused");
  assert.equal(repeated.taskId, created.taskId);
  const conflict = hostStore.createHostTask({
    ...request,
    requestHash: "different",
  });
  assert.equal(conflict.status, "conflict");

  const received = hostStore.receiveHostDispatch({
    credentialHash: request.credentialHash,
    remoteMessageId: "message-1",
    requestHash: requestHash({ body: "work" }),
    targetTaskId: created.taskId,
    body: "work",
  });
  assert.equal(received.status, "accepted");
  assert.equal(
    hostStore.receiveHostDispatch({
      credentialHash: request.credentialHash,
      remoteMessageId: "message-1",
      requestHash: requestHash({ body: "work" }),
      targetTaskId: created.taskId,
      body: "work",
    }).status,
    "accepted",
  );
  assert.equal(
    hostStore.receiveHostDispatch({
      credentialHash: request.credentialHash,
      remoteMessageId: "message-1",
      requestHash: requestHash({ body: "different" }),
      targetTaskId: created.taskId,
      body: "different",
    }).status,
    "conflict",
  );
  assert.equal(
    hostStore.receiveHostDispatch({
      credentialHash: "b".repeat(64),
      remoteMessageId: "message-2",
      requestHash: requestHash({ body: "work" }),
      targetTaskId: created.taskId,
      body: "work",
    }).status,
    "forbidden",
  );

  close();
  const reopened = new Store(dir);
  const reopenedHost = new HostStore(reopened);
  t.after(() => {
    reopened.close();
  });
  const reopenedCreate = reopenedHost.createHostTask(request);
  if (reopenedCreate.status === "conflict") {
    assert.fail("reopen unexpectedly conflicted");
  }
  assert.equal(reopenedCreate.taskId, created.taskId);
  assert.equal(
    reopenedHost.receiveHostDispatch({
      credentialHash: request.credentialHash,
      remoteMessageId: "message-1",
      requestHash: requestHash({ body: "work" }),
      targetTaskId: created.taskId,
      body: "work",
    }).status,
    "accepted",
  );
});

test("behavior proof: external parent is queued and acked in the owner outbox", async (t) => {
  const { dir, store, hostStore } = await fixture(t);
  const credentialHash = "c".repeat(64);
  const parentTaskId = randomUUID();
  const created = hostStore.createHostTask({
    credentialHash,
    parentTaskId,
    createKey: "create-outbox",
    requestHash: requestHash({ title: "child" }),
    agentId: "copilot",
    cwd: dir,
    title: "child",
  });
  assert.equal(created.status, "created");
  const locator = new TaskLocator(store, [hostStore]);
  const queue = new DeliveryQueue(store, locator);
  const message = queue.enqueue({
    sourceId: created.taskId,
    targetId: parentTaskId,
    kind: "message",
    body: "progress",
  });
  const update = queue.enqueue({
    sourceId: created.taskId,
    targetId: parentTaskId,
    kind: "update",
    body: "Task status: done\nfinished",
    updateStatus: "done",
    mutate: () => {
      store.recordAgentWorkflowUpdateState(
        created.taskId,
        "done",
        "finished",
        parentTaskId,
        "settled",
      );
    },
  });
  const outbox = hostStore.listHostOutbox(credentialHash);
  assert.deepEqual(
    outbox.map((item) => item.kind),
    ["collaboration", "done"],
  );
  assert.equal(outbox[0].parent_task_id, parentTaskId);
  assert.equal(outbox[1].id, update.message.id);
  assert.equal(message.delivery.status, "queued");
  const updateAudit = store
    .getEvents(created.taskId)
    .map((event) => JSON.parse(event.data) as Record<string, unknown>)
    .find(
      (data) =>
        data.kind === "collaboration" && data.messageId === update.message.id,
    );
  assert.ok(updateAudit);

  assert.equal(
    hostStore.ackHostMessage(credentialHash, message.message.id).status,
    "acked",
  );
  assert.equal(
    hostStore.ackHostMessage(credentialHash, message.message.id).status,
    "acked",
  );
  assert.equal(
    hostStore.ackHostMessage("d".repeat(64), update.message.id).status,
    "forbidden",
  );
  assert.equal(hostStore.listHostOutbox(credentialHash).length, 1);
});

test("behavior proof: hub locator and report receipt use the persisted edge", async (t) => {
  const { dir, store, hostStore } = await fixture(t);
  const parent = store.createTask(randomUUID(), dir, "agent", "copilot");
  const remoteTaskId = randomUUID();
  const edge = hostStore.createHostEdge({
    parentTaskId: parent.id,
    hostName: "mini",
    remoteTaskId,
    title: "build",
    credentialHash: "e".repeat(64),
    createKey: "edge-1",
    requestHash: "request-1",
    event: {
      title: "Created remote task",
      body: "build",
      kind: "task_created_remote",
      taskId: remoteTaskId,
      taskTitle: "build",
      agentId: "copilot",
      cwd: "owner default",
      model: null,
      thinking: null,
    },
  });
  assert.equal(edge.status, "created");
  assert.ok(edge.edge);
  const duplicate = hostStore.createHostEdge({
    parentTaskId: parent.id,
    hostName: "mini",
    remoteTaskId: randomUUID(),
    title: "build",
    credentialHash: "e".repeat(64),
    createKey: "edge-2",
    requestHash: "request-2",
    event: {
      title: "duplicate",
      body: "duplicate",
      kind: "task_created_remote",
      taskId: "duplicate",
      taskTitle: "build",
      agentId: "copilot",
      cwd: "owner default",
      model: null,
      thinking: null,
    },
  });
  assert.equal(duplicate.status, "conflict");
  const locator = new TaskLocator(store, [hostStore]);
  const route = locator.route(parent.id, remoteTaskId);
  assert.ok(route);
  assert.equal(route.relation, "child");
  assert.equal(store.getTask(remoteTaskId), undefined);
  assert.equal(route.description.local, false);

  const dispatched = hostStore.createRemoteDispatch({
    parentTaskId: parent.id,
    edge: edge.edge,
    body: "first",
  });
  const second = hostStore.createRemoteDispatch({
    parentTaskId: parent.id,
    edge: edge.edge,
    body: "second",
  });
  assert.equal(hostStore.hasOpenHostDispatch(parent.id), true);
  assert.equal(
    hostStore.nextHostDispatch(edge.edge.id)?.delivery.id,
    dispatched.delivery.id,
  );
  hostStore.markHostDispatchHandedOff(dispatched.delivery.id);

  const received = hostStore.ingestHostReport({
    hostName: "mini",
    credentialHash: "e".repeat(64),
    ownerMessageId: "owner-message-1",
    ownerTaskId: remoteTaskId,
    parentTaskId: parent.id,
    kind: "done",
    body: "Task status: done\nfinished",
  });
  assert.equal(received.status, "queued");
  assert.equal(
    hostStore.ingestHostReport({
      hostName: "mini",
      credentialHash: "e".repeat(64),
      ownerMessageId: "owner-message-1",
      ownerTaskId: remoteTaskId,
      parentTaskId: parent.id,
      kind: "done",
      body: "Task status: done\nfinished",
    }).status,
    "duplicate",
  );
  assert.equal(hostStore.hasOpenHostDispatch(parent.id), false);
  assert.equal(hostStore.getHostDispatch(second.delivery.id)?.state, "pending");
  assert.equal(
    store.getCollaborationDelivery(second.delivery.id)?.status,
    "queued",
  );
  assert.equal(
    hostStore.nextHostDispatch(edge.edge.id)?.delivery.id,
    second.delivery.id,
  );
  assert.equal(
    hostStore.nextHostDispatch(edge.edge.id)?.message.body,
    "second",
  );

  store.deleteTask(parent.id);
  assert.equal(
    hostStore.ingestHostReport({
      hostName: "mini",
      credentialHash: "e".repeat(64),
      ownerMessageId: "late-message",
      ownerTaskId: remoteTaskId,
      parentTaskId: parent.id,
      kind: "blocked",
      body: "late",
    }).status,
    "parent_deleted",
  );
});

test("behavior proof: typed-404 transaction rolls back edge, rows, hint, and notice together", async (t) => {
  const { dir, store, hostStore } = await fixture(t);
  const parent = store.createTask(randomUUID(), dir, "agent", "copilot");
  const edge = hostStore.createHostEdge({
    parentTaskId: parent.id,
    hostName: "mini",
    remoteTaskId: randomUUID(),
    title: "atomic",
    credentialHash: "i".repeat(64),
    createKey: "atomic-404",
    requestHash: "atomic-404",
    event: {
      title: "atomic",
      body: "atomic",
      kind: "task_created_remote",
      taskId: "atomic",
      taskTitle: "atomic",
      agentId: "copilot",
      cwd: dir,
      model: null,
      thinking: null,
    },
  });
  assert.ok(edge.edge);
  const dispatch = hostStore.createRemoteDispatch({
    parentTaskId: parent.id,
    edge: edge.edge,
    body: "remove",
  });
  const original = store.enqueueDeliveryRows.bind(store);
  store.enqueueDeliveryRows = () => {
    throw new Error("fault after transport terminalization");
  };
  try {
    assert.throws(
      () => hostStore.failHostEdgeTargetNotFound(dispatch.delivery.id),
      /fault/,
    );
  } finally {
    store.enqueueDeliveryRows = original;
  }
  assert.equal(hostStore.getHostEdge(edge.edge.id)?.status, "active");
  assert.equal(
    store.getCollaborationDelivery(dispatch.delivery.id)?.status,
    "queued",
  );
  assert.equal(hostStore.hasOpenHostDispatch(parent.id), true);
  assert.equal(
    store
      .getEvents(parent.id)
      .filter((event) => event.type === "task_outcome_notice").length,
    0,
  );
});

test("regression guard: archive leaves queued external endpoint deliveries alone", async (t) => {
  const { dir, store, hostStore } = await fixture(t);
  const parent = store.createTask(randomUUID(), dir, "agent", "copilot");
  const remoteTaskId = randomUUID();
  const edge = hostStore.createHostEdge({
    parentTaskId: parent.id,
    hostName: "mini",
    remoteTaskId,
    title: "build",
    credentialHash: "f".repeat(64),
    createKey: "edge-archive",
    requestHash: "request-archive",
    event: {
      title: "Created remote task",
      body: "build",
      kind: "task_created_remote",
      taskId: remoteTaskId,
      taskTitle: "build",
      agentId: "copilot",
      cwd: dir,
      model: null,
      thinking: null,
    },
  });
  assert.ok(edge.edge);
  const dispatched = hostStore.createRemoteDispatch({
    parentTaskId: parent.id,
    edge: edge.edge,
    body: "run",
  });
  store.archiveTask(parent.id);
  assert.equal(
    store.getCollaborationDelivery(dispatched.delivery.id)?.status,
    "queued",
  );
});

test("behavior proof: the additive host schema upgrades a 1bacca0-shaped Store twice", async (t) => {
  const { dir, store, close } = await fixture(t);
  const root = store.ensureRootTask(dir);
  const parent = store.createTask(
    "upgrade-parent",
    dir,
    "agent",
    "copilot",
    "session-parent",
    root.id,
  );
  const child = store.createTask(
    "upgrade-child",
    dir,
    "agent",
    "copilot",
    "session-child",
    parent.id,
  );
  store.saveEvent(
    parent.id,
    "user_message",
    { text: "kept" },
    {
      from_ref: "user",
    },
  );
  store.createCollaborationMessage({
    id: "upgrade-message",
    deliveryId: "upgrade-delivery",
    sourceTaskId: parent.id,
    directTargetTaskId: child.id,
    sourceActor: "agent",
    body: "queued",
  });
  close();

  const oldShape = new Database(join(dir, "webagent.db"));
  for (const table of [
    "host_report_receipts",
    "host_message_types",
    "host_wake_hints",
    "host_dispatches",
    "host_received_dispatches",
    "host_edges",
    "host_external_sources",
  ]) {
    oldShape.exec(`DROP TABLE ${table}`);
  }
  oldShape.close();

  const reopened = new Store(dir);
  reopened.close();
  const reopenedAgain = new Store(dir);
  const reopenedAgainHost = new HostStore(reopenedAgain);
  t.after(() => {
    reopenedAgain.close();
  });
  assert.equal(reopenedAgain.getTask(parent.id)?.title, parent.title);
  assert.equal(reopenedAgain.getEventCount(child.id), 0);
  assert.equal(
    reopenedAgain.getEvents(parent.id)[0]?.data.includes("kept"),
    true,
  );
  assert.equal(
    reopenedAgain.getCollaborationDelivery("upgrade-delivery")?.status,
    "queued",
  );
  assert.equal(reopenedAgainHost.hasHostFacts(), false);
});

test("behavior proof: boot replay selects only a committed queued hub receipt", async (t) => {
  const { dir, store, hostStore, close } = await fixture(t);
  const parent = store.createTask(randomUUID(), dir, "agent", "copilot");
  const localTarget = store.createTask(
    randomUUID(),
    dir,
    "agent",
    "copilot",
    randomUUID(),
    parent.id,
  );
  store.createCollaborationMessage({
    id: "unrelated-local",
    deliveryId: "unrelated-local-delivery",
    sourceTaskId: parent.id,
    directTargetTaskId: localTarget.id,
    sourceActor: "agent",
    body: "local work",
  });
  const remoteTaskId = randomUUID();
  const edge = hostStore.createHostEdge({
    parentTaskId: parent.id,
    hostName: "mini",
    remoteTaskId,
    title: "remote",
    credentialHash: "g".repeat(64),
    createKey: "boot-edge",
    requestHash: "boot-edge",
    event: {
      title: "remote",
      body: "remote",
      kind: "task_created_remote",
      taskId: remoteTaskId,
      taskTitle: "remote",
      agentId: "copilot",
      cwd: dir,
      model: null,
      thinking: null,
    },
  });
  assert.ok(edge.edge);
  const report = hostStore.ingestHostReport({
    hostName: "mini",
    credentialHash: "g".repeat(64),
    ownerMessageId: "acked-report",
    ownerTaskId: remoteTaskId,
    parentTaskId: parent.id,
    kind: "blocked",
    body: "needs input",
  });
  assert.equal(report.status, "queued");
  close();

  const reopened = new Store(dir);
  const reopenedHost = new HostStore(reopened);
  const tasks = createTaskManager(
    reopened,
    dir,
    dir,
    undefined,
    undefined,
    "test-agent",
    new TaskLocator(reopened, [reopenedHost]),
  );
  const replayed: string[] = [];
  tasks.drainCollaborationDeliveries = async (taskId: string) => {
    replayed.push(taskId);
    return true;
  };
  for (const taskId of reopenedHost.queuedHostReportRecipients()) {
    void tasks.drainCollaborationDeliveries(taskId);
  }
  await waitFor(() => replayed.length > 0);
  assert.deepEqual(replayed, [parent.id]);
  assert.equal(
    reopened.getCollaborationDelivery("unrelated-local-delivery")?.status,
    "queued",
  );
  tasks.dispose();
  reopened.close();

  const ownerDir = await mkdtemp(join(tmpdir(), "webagent-owner-boot-"));
  const owner = new Store(ownerDir);
  const ownerHost = new HostStore(owner);
  const ownerRoot = owner.ensureRootTask(ownerDir);
  const ownerLocal = owner.createTask(
    randomUUID(),
    ownerDir,
    "agent",
    "copilot",
    randomUUID(),
    ownerRoot.id,
  );
  owner.createCollaborationMessage({
    id: "owner-local",
    deliveryId: "owner-local-delivery",
    sourceTaskId: ownerRoot.id,
    directTargetTaskId: ownerLocal.id,
    sourceActor: "agent",
    body: "do not replay on owner boot",
  });
  const external = ownerHost.createHostTask({
    credentialHash: "h".repeat(64),
    parentTaskId: randomUUID(),
    createKey: "owner-boot",
    requestHash: "owner-boot",
    agentId: "copilot",
    cwd: ownerDir,
    title: "external",
  });
  assert.notEqual(external.status, "conflict");
  owner.close();
  const reopenedOwner = new Store(ownerDir);
  const reopenedOwnerHost = new HostStore(reopenedOwner);
  const ownerTasks = createTaskManager(reopenedOwner, ownerDir, ownerDir);
  const ownerReplays: string[] = [];
  ownerTasks.drainCollaborationDeliveries = async (taskId: string) => {
    ownerReplays.push(taskId);
    return true;
  };
  for (const taskId of reopenedOwnerHost.queuedHostReportRecipients()) {
    void ownerTasks.drainCollaborationDeliveries(taskId);
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(ownerReplays, []);
  ownerTasks.dispose();
  reopenedOwner.close();
  await rm(ownerDir, { recursive: true, force: true });
});
