import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { TaskManager } from "../src/task-manager.ts";
import { mockBridgeStubs, waitFor } from "./fixtures.ts";

describe("TaskManager collaboration delivery drain", () => {
  let store: Store;
  let tasks: TaskManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-collaboration-delivery-"));
    store = new Store(tmpDir, "test-agent");
    tasks = new TaskManager(store, tmpDir, tmpDir);
    store.createTask("root", tmpDir, "root", "agent-root");
    store.createTask("source", tmpDir, "auto", "agent-source", "root");
    store.createTask("target", tmpDir, "auto", "agent-target", "root");
    store.updateTaskTitle("source", "source");
    store.updateTaskTitle("target", "target");
    tasks.liveTasks.add("target");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("merges the queued snapshot into one target prompt and marks it delivered", async () => {
    store.createCollaborationMessage({
      id: "m1",
      deliveryId: "d1",
      sourceTaskId: "source",
      directTargetTaskId: "target",
      sourceActor: "user",
      body: "先检查接口",
      createdAt: 1,
    });
    store.createCollaborationMessage({
      id: "m2",
      deliveryId: "d2",
      sourceTaskId: "source",
      directTargetTaskId: "target",
      sourceActor: "user",
      body: "再检查日志",
      createdAt: 2,
    });
    const promptCalls: Array<{ taskId: string; text: string }> = [];
    const bridge = {
      ...mockBridgeStubs(),
      async prompt(taskId: string, text: string) {
        promptCalls.push({ taskId, text });
      },
    };

    assert.equal(
      await tasks.drainCollaborationDeliveries(bridge, "target"),
      true,
    );
    await waitFor(
      () =>
        store.getCollaborationDelivery("d1")?.status === "delivered" &&
        store.getCollaborationDelivery("d2")?.status === "delivered",
    );

    assert.equal(promptCalls.length, 1);
    assert.equal(promptCalls[0].taskId, "target");
    assert.match(promptCalls[0].text, /source: 先检查接口/);
    assert.match(promptCalls[0].text, /source: 再检查日志/);
    assert.ok(
      promptCalls[0].text.indexOf("先检查接口") <
        promptCalls[0].text.indexOf("再检查日志"),
    );
    assert.equal(store.getTask("target")?.workflow_status, "running");
  });

  it("leaves deliveries queued while the target already has an active prompt", async () => {
    store.createCollaborationMessage({
      id: "m1",
      deliveryId: "d1",
      sourceTaskId: "source",
      directTargetTaskId: "target",
      sourceActor: "user",
      body: "等待下一轮",
    });
    tasks.activePrompts.add("target");

    assert.equal(
      await tasks.drainCollaborationDeliveries(mockBridgeStubs(), "target"),
      false,
    );
    assert.equal(store.getCollaborationDelivery("d1")?.status, "queued");
  });
});
