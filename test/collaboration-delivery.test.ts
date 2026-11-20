import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import type { TaskManager } from "../src/task-manager.ts";
import { createTaskManager } from "../src/task-manager.ts";
import { mockBridgeStubs, waitFor } from "./fixtures.ts";

describe("TaskManager collaboration delivery drain", () => {
  let store: Store;
  let tasks: TaskManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-collaboration-delivery-"));
    store = new Store(tmpDir);
    tasks = createTaskManager(store, tmpDir, tmpDir);
    store.attachAgentSession(
      store.ensureRootTask(tmpDir).id,
      "test-agent",
      "agent-root",
    );
    store.createTask(
      "source",
      tmpDir,
      "auto",
      "test-agent",
      "agent-source",
      store.rootTaskId,
    );
    store.createTask(
      "target",
      tmpDir,
      "auto",
      "test-agent",
      "agent-target",
      store.rootTaskId,
    );
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
      await tasks.drainCollaborationDeliveries("target", bridge),
      true,
    );
    await waitFor(
      () =>
        store.getCollaborationDelivery("d1")?.status === "delivered" &&
        store.getCollaborationDelivery("d2")?.status === "delivered",
    );

    assert.equal(promptCalls.length, 1);
    assert.equal(promptCalls[0].taskId, "target");
    assert.match(
      promptCalls[0].text,
      /From "source" \(task id source\):\n---8<---\n先检查接口\n---8<---/,
    );
    assert.match(
      promptCalls[0].text,
      /From "source" \(task id source\):\n---8<---\n再检查日志\n---8<---/,
    );
    assert.ok(
      promptCalls[0].text.indexOf("先检查接口") <
        promptCalls[0].text.indexOf("再检查日志"),
    );
    assert.equal(store.getTask("target")?.workflow_status, "running");
  });

  it("writes the receiver's row at drain, not at creation", async () => {
    store.createCollaborationMessage({
      id: "m-drain",
      deliveryId: "d-drain",
      sourceTaskId: "source",
      directTargetTaskId: "target",
      sourceActor: "user",
      body: "deliver at the boundary",
      createdAt: 1,
    });

    // The sender's row exists immediately; the receiver's does not yet.
    const systemRows = (taskId: string) =>
      store
        .getEvents(taskId)
        .filter((event) => event.type === "system_message")
        .map((event) => JSON.parse(event.data) as Record<string, unknown>);
    assert.equal(
      systemRows("source").some((row) => row.messageId === "m-drain"),
      true,
    );
    assert.equal(
      systemRows("target").some((row) => row.messageId === "m-drain"),
      false,
      "a message must not sit in a turn that never saw it",
    );

    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    let enteredPrompt!: () => void;
    const inPrompt = new Promise<void>((resolve) => {
      enteredPrompt = resolve;
    });
    const bridge = {
      ...mockBridgeStubs(),
      async prompt() {
        enteredPrompt();
        await promptGate;
      },
    };
    const draining = tasks.drainCollaborationDeliveries("target", bridge);
    assert.equal(await draining, true);
    await inPrompt;
    const targetRows = systemRows("target");
    const deliveredRow = targetRows.find((row) => row.messageId === "m-drain");
    assert.ok(deliveredRow, "the row appears when the batch is handed over");
    assert.equal(deliveredRow.role, "target");

    // The row precedes everything the turn itself writes: an output event
    // saved after the hand-over must have a higher seq.
    store.saveEvent(
      "target",
      "assistant_message",
      { text: "turn output" },
      { from_ref: "agent" },
    );
    const rows = store.getEvents("target");
    const rowSeq = rows.find(
      (event) => JSON.parse(event.data).messageId === "m-drain",
    )!.seq;
    const outputSeq = rows.find(
      (event) => event.type === "assistant_message",
    )!.seq;
    assert.ok(rowSeq < outputSeq, "the delivery row leads the turn output");
    releasePrompt();
  });

  it("broadcasts delivered after the prompt and failed after a rejection", async () => {
    const events: Array<{ messageId: string; status: string }> = [];
    tasks.setDeliveryStatusBroadcast((event) => {
      events.push({ messageId: event.messageId, status: event.status });
    });
    store.createCollaborationMessage({
      id: "m-status",
      deliveryId: "d-status",
      sourceTaskId: "source",
      directTargetTaskId: "target",
      sourceActor: "user",
      body: "status please",
      createdAt: 1,
    });

    assert.equal(
      await tasks.drainCollaborationDeliveries("target", {
        ...mockBridgeStubs(),
        async prompt() {},
      }),
      true,
    );
    await waitFor(() => events.length === 1);
    assert.deepEqual(events[0], {
      messageId: "m-status",
      status: "delivered",
    });

    store.createTask(
      "target2",
      tmpDir,
      "auto",
      "test-agent",
      "agent-target2",
      store.rootTaskId,
    );
    tasks.liveTasks.add("target2");
    store.createCollaborationMessage({
      id: "m-failed",
      deliveryId: "d-failed",
      sourceTaskId: "source",
      directTargetTaskId: "target2",
      sourceActor: "user",
      body: "this one fails",
      createdAt: 2,
    });
    assert.equal(
      await tasks.drainCollaborationDeliveries("target2", {
        ...mockBridgeStubs(),
        async prompt() {
          throw new Error("rejected");
        },
      }),
      true,
    );
    await waitFor(() => events.length === 2);
    assert.deepEqual(events[1], {
      messageId: "m-failed",
      status: "failed",
    });
  });

  it("does not churn the busy turn when nothing is queued", async () => {
    const busyPatches: Array<string | null> = [];
    const unsubscribe = tasks.state.onPatch((event) => {
      const busy = event.patch.runtime?.busy;
      if (busy !== undefined) busyPatches.push(busy?.promptId ?? null);
    });
    try {
      assert.equal(
        await tasks.drainCollaborationDeliveries("target", mockBridgeStubs()),
        false,
      );
      assert.deepEqual(
        busyPatches,
        [],
        "a drain with nothing queued must not enter a busy turn",
      );
    } finally {
      unsubscribe();
    }
  });

  it("fails claimed deliveries and returns the target to idle when the prompt rejects", async () => {
    store.createCollaborationMessage({
      id: "reject-message",
      deliveryId: "reject-delivery",
      sourceTaskId: "source",
      directTargetTaskId: "target",
      sourceActor: "user",
      body: "这次投递会失败",
      createdAt: 3,
    });
    const bridge = {
      ...mockBridgeStubs(),
      async prompt() {
        throw new Error("agent subprocess died");
      },
    };

    assert.equal(
      await tasks.drainCollaborationDeliveries("target", bridge),
      true,
    );
    await waitFor(
      () =>
        store.getCollaborationDelivery("reject-delivery")?.status === "failed",
    );
    assert.equal(
      store.getCollaborationDelivery("reject-delivery")?.failure_reason,
      "prompt_failed",
    );
    assert.equal(
      store.getTask("target")?.workflow_status,
      "idle",
      "a failed delivery prompt must not strand the target in running",
    );
  });

  it("terminates all outstanding deliveries when clear replaces the execution", async () => {
    store.createCollaborationMessage({
      id: "draining-message",
      deliveryId: "draining-delivery",
      sourceTaskId: "source",
      directTargetTaskId: "target",
      sourceActor: "user",
      body: "也不要重放",
    });
    store.claimQueuedDeliveries("target");
    store.createCollaborationMessage({
      id: "queued-message",
      deliveryId: "queued-delivery",
      sourceTaskId: "source",
      directTargetTaskId: "target",
      sourceActor: "user",
      body: "不要投给新 execution",
    });

    await tasks.clearTask(
      {
        ...mockBridgeStubs(),
        async newSession() {
          return { sessionId: "agent-target-replacement", configOptions: [] };
        },
      },
      "target",
    );

    assert.equal(
      store.getCollaborationDelivery("queued-delivery")?.status,
      "failed",
    );
    assert.equal(
      store.getCollaborationDelivery("queued-delivery")?.failure_reason,
      "cleared_before_delivery",
    );
    assert.equal(
      store.getCollaborationDelivery("draining-delivery")?.status,
      "failed",
    );
    assert.equal(
      store.getCollaborationDelivery("draining-delivery")?.failure_reason,
      "cleared_during_delivery",
    );
    assert.equal(store.getTask("target")?.workflow_status, "idle");
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
      await tasks.drainCollaborationDeliveries("target", mockBridgeStubs()),
      false,
    );
    assert.equal(store.getCollaborationDelivery("d1")?.status, "queued");
  });

  function seedDispatchFamily(): void {
    store.createTask(
      "parent",
      tmpDir,
      "auto",
      "test-agent",
      "agent-parent",
      store.rootTaskId,
    );
    store.createTask(
      "child",
      tmpDir,
      "auto",
      "test-agent",
      "agent-child",
      "parent",
    );
    store.createCollaborationMessage({
      id: "dispatch-message",
      deliveryId: "dispatch-delivery",
      sourceTaskId: "parent",
      directTargetTaskId: "child",
      sourceActor: "agent",
      body: "do the work",
      createdAt: 1,
    });
  }

  function sourceNotice(taskId: string): Record<string, unknown> | undefined {
    const row = store
      .getEvents(taskId)
      .filter((event) => event.type === "task_outcome_notice")
      .at(-1);
    return row ? (JSON.parse(row.data) as Record<string, unknown>) : undefined;
  }

  it("reports target_removed when a dispatch prompt fails", async () => {
    seedDispatchFamily();
    assert.ok(tasks.hasOpenObligation("parent", "child"));
    const bridge = {
      ...mockBridgeStubs(),
      async prompt() {
        throw new Error("rejected");
      },
    };

    assert.equal(
      await tasks.drainCollaborationDeliveries("child", bridge),
      true,
    );
    assert.equal(tasks.hasOpenObligation("parent", "child"), false);
    assert.equal(
      store.getCollaborationDelivery("dispatch-delivery")?.status,
      "failed",
    );
    const notice = sourceNotice("parent");
    assert.equal(notice?.reason, "target_removed");
    assert.equal(notice.targetTaskId, "child");
  });

  it("reports target_removed when a drain cannot resume the target", async () => {
    seedDispatchFamily();
    const bridge = {
      ...mockBridgeStubs(),
      async loadSession() {
        throw new Error("resume failed");
      },
    };

    assert.equal(
      await tasks.drainCollaborationDeliveries("child", bridge),
      false,
    );
    assert.equal(
      store.getCollaborationDelivery("dispatch-delivery")?.status,
      "failed",
      "a failed resume must not strand the row in queued",
    );
    assert.equal(
      store.getCollaborationDelivery("dispatch-delivery")?.failure_reason,
      "resume_failed",
    );
    assert.equal(tasks.hasOpenObligation("parent", "child"), false);
    assert.equal(sourceNotice("parent")?.reason, "target_removed");
  });

  it("reports target_removed when /clear drops the queued dispatch", async () => {
    seedDispatchFamily();
    await tasks.clearTask(mockBridgeStubs(), "child");

    assert.equal(
      store.getCollaborationDelivery("dispatch-delivery")?.status,
      "failed",
    );
    assert.equal(
      store.getCollaborationDelivery("dispatch-delivery")?.failure_reason,
      "cleared_before_delivery",
    );
    assert.equal(tasks.hasOpenObligation("parent", "child"), false);
    assert.equal(sourceNotice("parent")?.reason, "target_removed");
  });

  it("holds a closing reminder behind a running turn and drains it at the boundary", async () => {
    store.createTask(
      "parent",
      tmpDir,
      "auto",
      "test-agent",
      "agent-parent",
      store.rootTaskId,
    );
    store.createTask(
      "child",
      tmpDir,
      "auto",
      "test-agent",
      "agent-child",
      "parent",
    );
    tasks.liveTasks.add("child");
    const prompts: string[] = [];
    const bridge = {
      ...mockBridgeStubs(),
      async prompt(_taskId: string, text: string) {
        prompts.push(text);
      },
    };
    tasks.attachExecutionBridge(bridge);
    tasks.beginAgentTurn("child", { origin: "interactive" });

    tasks.submitObligationReminder("parent", "child");
    assert.equal(store.countQueuedDeliveries("child"), 1);
    assert.deepEqual(prompts, [], "a busy target is not interrupted");

    tasks.endTurn("child");
    assert.equal(
      await tasks.drainCollaborationDeliveries("child", bridge),
      true,
    );
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /runtime-injected closing turn/i);
    assert.equal(store.countQueuedDeliveries("child"), 0);
  });
});
