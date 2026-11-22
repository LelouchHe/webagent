import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Store } from "../src/store.ts";
import { createTaskManager, type TaskManager } from "../src/task-manager.ts";
import { mockBridgeStubs } from "./fixtures.ts";
import { requestHash } from "../src/host-protocol.ts";

let dir: string;
let store: Store;
let tasks: TaskManager;
let remoteTaskId: string;
const credentialHash = "1".repeat(64);
const parentTaskId = "parent-on-laptop";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webagent-host-account-"));
  store = new Store(dir);
  store.ensureRootTask(dir);
  const created = store.createHostTask({
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
  tasks = createTaskManager(store, dir, dir);
  tasks.registerHostExternalTask(remoteTaskId);
  tasks.liveTasks.add(remoteTaskId);
});

afterEach(() => {
  tasks.dispose();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("behavior proof: external dispatch opens the account and update settles to P", async () => {
  const received = store.receiveHostDispatch({
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
  assert.equal(store.listHostOutbox(credentialHash).at(-1)?.kind, "done");
  assert.equal(store.getTask(remoteTaskId)?.workflow_status, "done");
});

test("behavior proof: archive preserves an already-open external account", async () => {
  store.receiveHostDispatch({
    credentialHash,
    remoteMessageId: "dispatch",
    requestHash: requestHash({ body: "work" }),
    targetTaskId: remoteTaskId,
    body: "work",
  });
  const bridge = { ...mockBridgeStubs(), prompt: async () => {} };
  await tasks.drainCollaborationDeliveries(remoteTaskId, bridge);

  assert.equal(store.unarchiveTask(remoteTaskId).status, "unarchived");
  tasks.archiveTask(remoteTaskId);
  const settled = tasks.settleAgentUpdate(remoteTaskId, "blocked", "missing");
  assert.equal(settled.accountTargetTaskId, parentTaskId);
  assert.equal(store.listHostOutbox(credentialHash).at(-1)?.kind, "blocked");
});

test("behavior proof: waiting is watched and repeated turns emit an external notice", async () => {
  store.receiveHostDispatch({
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
  assert.equal(store.listHostOutbox(credentialHash).length, 0);

  tasks.onTargetTurnEnded(remoteTaskId);
  tasks.onTargetTurnEnded(remoteTaskId);
  tasks.onTargetTurnEnded(remoteTaskId);
  const notice = store
    .listHostOutbox(credentialHash)
    .find((item) => item.kind === "runtime_notice");
  assert.equal(notice?.reason, "no_update");
});
