import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Store } from "../src/store.ts";
import {
  SingleAgentEnvironment,
  TaskManager,
  type ObligationRuntime,
} from "../src/task-manager.ts";
import { mockBridgeStubs } from "./fixtures.ts";
import { requestHash } from "../src/host/protocol.ts";
import {
  ObligationController,
  type TimerHandle,
} from "../src/obligation-controller.ts";
import { TaskStateManager } from "../src/task-state.ts";
import { ExecutionAuthority } from "../src/execution-authority.ts";
import { HostStore } from "../src/host/store.ts";
import { TaskLocator } from "../src/task-locator.ts";

let dir: string;
let store: Store;
let hostStore: HostStore;
let tasks: TaskManager;
let remoteTaskId: string;
const credentialHash = "1".repeat(64);
const parentTaskId = "parent-on-laptop";
let now = 1_000;
let timers: Array<{ at: number; fn: () => void; handle: TimerHandle }> = [];
let nextTimer = 1;

function advanceTime(milliseconds: number): void {
  now += milliseconds;
  let due = timers.filter((timer) => timer.at <= now);
  timers = timers.filter((timer) => timer.at > now);
  while (due.length > 0) {
    for (const timer of due.sort((a, b) => a.at - b.at)) timer.fn();
    due = timers.filter((timer) => timer.at <= now);
    timers = timers.filter((timer) => timer.at > now);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webagent-host-account-"));
  store = new Store(dir);
  store.ensureRootTask(dir);
  hostStore = new HostStore(store);
  const created = hostStore.createHostTask({
    credentialHash,
    parentTaskId,
    createKey: "account-create",
    requestHash: requestHash({ title: "remote" }),
    agentId: "test-agent",
    cwd: dir,
    title: "remote",
  });
  if (created.status === "conflict") assert.fail("host create conflicted");
  remoteTaskId = created.taskId;
  const taskRef: { current?: ObligationRuntime } = {};
  const obligations = new ObligationController({
    now: () => now,
    setTimer: (fn, ms) => {
      const handle = nextTimer++ as unknown as TimerHandle;
      timers.push({ at: now + ms, fn, handle });
      return handle;
    },
    clearTimer: (handle) => {
      timers = timers.filter((timer) => timer.handle !== handle);
    },
    submitReminder: (sourceTaskId, targetTaskId) => {
      taskRef.current?.submitObligationReminder(sourceTaskId, targetTaskId);
    },
    emitOutcome: (fact) => {
      taskRef.current?.emitObligationOutcome(fact);
    },
    silenceMs: 900_000,
  });
  tasks = new TaskManager({
    store,
    defaultCwd: dir,
    dataDir: dir,
    state: new TaskStateManager(),
    authority: new ExecutionAuthority(),
    agents: new SingleAgentEnvironment("test-agent"),
    obligations,
    locator: new TaskLocator(store, [hostStore]),
  });
  taskRef.current = tasks;
  tasks.liveTasks.add(remoteTaskId);
});

afterEach(() => {
  tasks.dispose();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  now = 1_000;
  timers = [];
  nextTimer = 1;
});

test("behavior proof: external dispatch opens the account and update settles to P", async () => {
  const fallback = tasks.settleAgentUpdate(
    remoteTaskId,
    "blocked",
    "fallback before dispatch",
  );
  assert.equal(fallback.accountTargetTaskId, parentTaskId);
  assert.equal(
    JSON.parse(
      store
        .getEvents(remoteTaskId)
        .find((event) => event.type === "task_update")!.data,
    ).reason,
    "fallback",
  );

  const received = hostStore.receiveHostDispatch({
    credentialHash,
    remoteMessageId: "dispatch",
    requestHash: requestHash({ body: "work" }),
    targetTaskId: remoteTaskId,
    body: "work",
  });
  assert.equal(received.status, "accepted");
  const bridge = { ...mockBridgeStubs(), prompt: async () => {} };
  assert.equal(
    await tasks.drainCollaborationDeliveries(remoteTaskId, bridge),
    true,
  );

  const settled = tasks.settleAgentUpdate(remoteTaskId, "done", "finished");
  assert.equal(settled.accountTargetTaskId, parentTaskId);
  assert.equal(hostStore.listHostOutbox(credentialHash).at(-1)?.kind, "done");
  assert.equal(store.getTask(remoteTaskId)?.workflow_status, "done");
  assert.equal(
    JSON.parse(
      store
        .getEvents(remoteTaskId)
        .filter((event) => event.type === "task_update")
        .at(-1)!.data,
    ).reason,
    "settled",
  );
});

test("behavior proof: archive preserves an already-open external account", async () => {
  hostStore.receiveHostDispatch({
    credentialHash,
    remoteMessageId: "dispatch",
    requestHash: requestHash({ body: "work" }),
    targetTaskId: remoteTaskId,
    body: "work",
  });
  const bridge = { ...mockBridgeStubs(), prompt: async () => {} };
  await tasks.drainCollaborationDeliveries(remoteTaskId, bridge);

  assert.equal(store.unarchiveTask(remoteTaskId).status, "unarchived");
  const waiting = tasks.settleAgentUpdate(
    remoteTaskId,
    "waiting",
    "waiting after unarchive",
  );
  assert.equal(waiting.silenceWatchMs, 900_000);
  tasks.archiveTask(remoteTaskId);
  advanceTime(900_000);
  const notice = hostStore
    .listHostOutbox(credentialHash)
    .find((item) => item.kind === "runtime_notice");
  assert.equal(notice?.reason, "no_activity");
});

test("behavior proof: waiting is watched and repeated turns emit an external notice", async () => {
  hostStore.receiveHostDispatch({
    credentialHash,
    remoteMessageId: "dispatch-notice",
    requestHash: requestHash({ body: "work" }),
    targetTaskId: remoteTaskId,
    body: "work",
  });
  const bridge = { ...mockBridgeStubs(), prompt: async () => {} };
  await tasks.drainCollaborationDeliveries(remoteTaskId, bridge);
  const waiting = tasks.settleAgentUpdate(
    remoteTaskId,
    "waiting",
    "still busy",
  );
  assert.equal(waiting.silenceWatchMs, 900_000);
  assert.equal(hostStore.listHostOutbox(credentialHash).length, 0);

  tasks.onTargetTurnEnded(remoteTaskId);
  tasks.onTargetTurnEnded(remoteTaskId);
  tasks.onTargetTurnEnded(remoteTaskId);
  const notice = hostStore
    .listHostOutbox(credentialHash)
    .find((item) => item.kind === "runtime_notice");
  assert.equal(notice?.reason, "no_update");
});

test("behavior proof: deleting queued R1 still emits exactly one notice to P", async () => {
  hostStore.receiveHostDispatch({
    credentialHash,
    remoteMessageId: "dispatch-delete",
    requestHash: requestHash({ body: "work" }),
    targetTaskId: remoteTaskId,
    body: "work",
  });
  assert.equal(store.countQueuedDeliveries(remoteTaskId), 1);

  await tasks.deleteTask(undefined, remoteTaskId);

  const outbox = hostStore.listHostOutbox(credentialHash);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].kind, "runtime_notice");
  assert.equal(outbox[0].reason, "target_removed");
  assert.equal(
    store
      .getEvents(remoteTaskId)
      .filter((event) => event.type === "task_outcome_notice").length,
    0,
  );
});
