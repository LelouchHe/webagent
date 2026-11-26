import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { Store } from "../src/store.ts";
import type { TaskManager } from "../src/task-manager.ts";
import { createTaskManager } from "../src/task-manager.ts";
import { handleAgentEvent } from "../src/event-handler.ts";
import {
  makeEventHandlerConfig,
  mockBridgeStubs,
  waitFor,
} from "./fixtures.ts";

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

  it("uses the persisted envelope source label when a remote report is drained", async () => {
    store.enqueueReportDelivery({
      id: "remote-report",
      deliveryId: "remote-report-delivery",
      idempotencyKey: "remote-report:owner:remote-child:1",
      sourceTaskId: "remote-child",
      targetTaskId: "target",
      body: "Task status: done\ncomplete",
      sourceLabel: 'Child "quoted"',
    });
    const prompts: string[] = [];
    await tasks.drainCollaborationDeliveries("target", {
      ...mockBridgeStubs(),
      async prompt(_taskId, text) {
        prompts.push(text);
      },
    });
    await waitFor(() =>
      store
        .getEvents("target")
        .some((event) => JSON.parse(event.data).messageId === "remote-report"),
    );
    assert.match(
      prompts[0],
      /From "Child \\"quoted\\"" \(task id remote-child\):/,
    );
    const data = JSON.parse(
      store
        .getEvents("target")
        .find((event) => JSON.parse(event.data).messageId === "remote-report")!
        .data,
    ) as Record<string, unknown>;
    assert.equal(data.sourceLabel, 'Child "quoted"');
  });

  it("drops an external parent's cached label after projection", async () => {
    store.enqueueTargetCollaboration({
      id: "external-dispatch",
      deliveryId: "external-delivery",
      sourceTaskId: "external-parent",
      targetTaskId: "target",
      body: "work",
    });
    tasks.rememberCollaborationSourceLabel(
      "external-dispatch",
      'External "parent"',
    );
    await tasks.drainCollaborationDeliveries("target", {
      ...mockBridgeStubs(),
      async prompt() {},
    });
    const labels = (
      tasks as unknown as {
        collaborationSourceLabels: Map<string, string>;
      }
    ).collaborationSourceLabels;
    assert.equal(labels.has("external-dispatch"), false);
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

  it("broadcasts delivered at handover, before the turn ends, and failed after a rejection", async () => {
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

    let endTurn!: () => void;
    const turnRunning = new Promise<void>((resolve) => {
      endTurn = resolve;
    });
    assert.equal(
      await tasks.drainCollaborationDeliveries("target", {
        ...mockBridgeStubs(),
        async prompt() {
          await turnRunning;
        },
      }),
      true,
    );
    // The recipient's turn is still running: delivery is already settled.
    assert.deepEqual(events, [{ messageId: "m-status", status: "delivered" }]);
    assert.equal(
      store.getCollaborationDelivery("d-status")?.status,
      "delivered",
    );
    endTurn();

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
    await waitFor(() => events.length === 3);
    assert.deepEqual(events.slice(1), [
      { messageId: "m-failed", status: "delivered" },
      { messageId: "m-failed", status: "failed" },
    ]);
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
    tasks.rememberCollaborationSourceLabel("reject-message", "external-parent");
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
      store.getCollaborationDelivery("reject-delivery")?.delivered_at,
      null,
    );
    assert.equal(
      store.getTask("target")?.workflow_status,
      "idle",
      "a failed delivery prompt must not strand the target in running",
    );
    assert.equal(
      (
        tasks as unknown as {
          collaborationSourceLabels: Map<string, string>;
        }
      ).collaborationSourceLabels.has("reject-message"),
      false,
    );
  });

  it("fails queued deliveries but keeps handed-over ones when clear replaces the execution", async () => {
    store.createCollaborationMessage({
      id: "handed-message",
      deliveryId: "handed-delivery",
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
      store.getCollaborationDelivery("handed-delivery")?.status,
      "delivered",
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

  /** An account as a delivered dispatch leaves it, without running a drain. */
  function armDeliveredDispatch(): void {
    store.claimQueuedDeliveries("child");
    (
      tasks as unknown as {
        obligations: { arm(source: string, target: string): void };
      }
    ).obligations.arm("parent", "child");
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
    assert.equal(
      tasks.hasOpenObligation("parent", "child"),
      false,
      "a queued dispatch opens no account",
    );
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

  it("opens the account at handover, so a dispatch queued behind a settled turn gets its own", async () => {
    seedDispatchFamily();
    let endTurn!: () => void;
    const bridge = {
      ...mockBridgeStubs(),
      async prompt() {
        await new Promise<void>((resolve) => {
          endTurn = resolve;
        });
      },
    };
    assert.equal(
      await tasks.drainCollaborationDeliveries("child", bridge),
      true,
    );
    assert.ok(tasks.hasOpenObligation("parent", "child"));

    // A second dispatch arrives while the child's turn runs; the child settles
    // before it sees it.
    store.createCollaborationMessage({
      id: "second-message",
      deliveryId: "second-delivery",
      sourceTaskId: "parent",
      directTargetTaskId: "child",
      sourceActor: "agent",
      body: "one more",
    });
    tasks.settleAgentUpdate("child", "done", "first only");
    assert.equal(tasks.hasOpenObligation("parent", "child"), false);
    assert.equal(
      store.getCollaborationDelivery("second-delivery")?.status,
      "queued",
    );

    endTurn();
    tasks.endTurn("child");
    await tasks.drainCollaborationDeliveries("child", bridge);
    assert.equal(
      store.getCollaborationDelivery("second-delivery")?.status,
      "delivered",
    );
    assert.ok(
      tasks.hasOpenObligation("parent", "child"),
      "the second dispatch opens a new account when it is handed over",
    );
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
    const deliveryEvents: Array<{ messageId: string }> = [];
    tasks.setDeliveryStatusBroadcast((event) => {
      deliveryEvents.push(event);
    });
    tasks.beginAgentTurn("child", { origin: "interactive" });

    tasks.submitObligationReminder("parent", "child");
    assert.equal(store.countQueuedDeliveries("child"), 1);
    assert.deepEqual(prompts, [], "a busy target is not interrupted");
    assert.equal(
      store
        .getEvents("child")
        .filter((event) => event.type === "system_message")
        .map((event) => JSON.parse(event.data) as Record<string, unknown>)
        .filter((data) => data.kind === "handoff_reminder").length,
      0,
      "a runtime message is not visible before its drain",
    );

    tasks.endTurn("child");
    await waitFor(() => prompts.length === 1, {
      message: "the turn boundary drains the reminder automatically",
    });
    assert.match(prompts[0], /Runtime message:/);
    assert.match(prompts[0], /runtime-injected closing turn/i);
    assert.equal(store.countQueuedDeliveries("child"), 0);
    assert.equal(
      store
        .getEvents("child")
        .filter((event) => event.type === "handoff_reminder").length,
      1,
      "the reminder still has audit metadata",
    );

    const rows = store
      .getEvents("child")
      .filter((event) => event.type === "system_message")
      .map((event) => JSON.parse(event.data) as Record<string, unknown>)
      .filter((data) => data.kind === "handoff_reminder");
    assert.equal(rows.length, 1, "exactly one recipient-visible row");
    assert.equal(
      "sourceLabel" in rows[0],
      false,
      "the runtime is not a Task, so the row carries no source handle",
    );
    assert.equal(
      rows[0].kind,
      "handoff_reminder",
      "the row names the fact it reports, not the collaboration container: its " +
        "title carries no task reference for a kind-dispatched client to mark",
    );
    assert.equal(
      rows[0].title,
      "Task handoff required",
      "a runtime message is titled in the runtime's own voice",
    );
    assert.doesNotMatch(
      String(rows[0].title),
      / sent /,
      "a runtime message must not borrow the correspondence sentence: it has no " +
        "sender, and the recipient the sentence would name is the reader",
    );
    assert.equal("sourceTaskId" in rows[0], false);
    assert.equal(deliveryEvents.length, 0, "no mark for a system item");
  });

  it("delivers a runtime message that has no record without inventing a row", async () => {
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
    tasks.attachExecutionBridge({
      ...mockBridgeStubs(),
      async prompt(_taskId: string, text: string) {
        prompts.push(text);
      },
    });
    tasks.beginAgentTurn("child", { origin: "interactive" });

    // No audit event records what this item is, so the row has nothing honest to
    // say. The body must still reach the agent; only the transcript entry is
    // skipped, and no placeholder title is invented for it.
    store.createSystemDelivery({
      messageId: "unrecorded-item",
      deliveryId: "unrecorded-delivery",
      fromTaskId: "parent",
      recipientTaskId: "child",
      body: "unrecorded runtime text",
    });

    tasks.endTurn("child");
    await waitFor(() => prompts.length === 1, {
      message: "an unrecorded runtime message must still reach the agent",
    });
    assert.match(prompts[0], /Runtime message:/);
    assert.match(prompts[0], /unrecorded runtime text/);

    const rows = store
      .getEvents("child")
      .filter((event) => event.type === "system_message")
      .map((event) => JSON.parse(event.data) as Record<string, unknown>);
    assert.deepEqual(rows, [], "an unnamed item claims no transcript row");
  });

  it("drains a runtime message past an unrelated row holding malformed JSON", async () => {
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
    tasks.attachExecutionBridge({
      ...mockBridgeStubs(),
      async prompt(_taskId: string, text: string) {
        prompts.push(text);
      },
    });
    tasks.beginAgentTurn("child", { origin: "interactive" });

    // `events.data` is unconstrained TEXT, so a row can hold unparseable JSON —
    // a hand-edited database, or a writer from an older version. The recovered
    // item kind is a display detail, and a drain that cannot read it must still
    // deliver: `claimQueuedDeliveries` has already marked this batch delivered,
    // so a throw here loses the message for good.
    //
    // Two rows, one on each side of the audit event the reminder writes: a scan
    // in insertion order meets the older one first, and a newest-first read
    // meets the newer one first. Neither may end the drain.
    const db = (store as unknown as { db: Database.Database }).db;
    const insertMalformed = (): void => {
      const nextSeq = (
        db
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE task_id = ?",
          )
          .get("child") as { next: number }
      ).next;
      db.prepare(
        `INSERT INTO events (task_id, seq, type, data, from_ref, created_at)
         VALUES (?, ?, 'handoff_reminder', ?, 'system', ?)`,
      ).run("child", nextSeq, '{"messageId": "trunc', Date.now());
    };
    insertMalformed();

    tasks.submitObligationReminder("parent", "child");
    insertMalformed();

    tasks.endTurn("child");
    await waitFor(() => prompts.length === 1, {
      message: "a malformed sibling row must not lose the claimed batch",
    });
    assert.match(prompts[0], /runtime-injected closing turn/i);

    const rows = store
      .getEvents("child")
      .filter((event) => event.type === "system_message")
      .map((event) => JSON.parse(event.data) as Record<string, unknown>);
    assert.equal(
      rows.at(-1)?.title,
      "Task handoff required",
      "the delivered item still names itself after the unreadable row",
    );
  });

  it("keeps the account when an unrelated delivery fails", async () => {
    seedDispatchFamily();
    armDeliveredDispatch();
    store.createCollaborationMessage({
      id: "third-party",
      deliveryId: "third-party-delivery",
      sourceTaskId: store.rootTaskId,
      directTargetTaskId: "child",
      sourceActor: "user",
      body: "unrelated note",
    });
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
    assert.equal(
      store.getCollaborationDelivery("third-party-delivery")?.status,
      "failed",
    );
    assert.equal(
      tasks.hasOpenObligation("parent", "child"),
      true,
      "a third-party failure must not settle the dispatch account",
    );
    assert.equal(sourceNotice("parent"), undefined);
  });

  it("leaves queued work for the current execution after a stale resume", async () => {
    seedDispatchFamily();
    let released = false;
    const bridge = {
      ...mockBridgeStubs(),
      async loadSession() {
        const submissionId = tasks.pendingPromptSubmissions.get("child");
        assert.ok(submissionId !== undefined);
        tasks.releasePromptSubmission("child", submissionId, false);
        released = true;
        throw new Error("resume superseded");
      },
    };

    assert.equal(
      await tasks.drainCollaborationDeliveries("child", bridge),
      false,
    );
    assert.equal(released, true);
    assert.equal(
      store.getCollaborationDelivery("dispatch-delivery")?.status,
      "queued",
      "a stale attempt must not fail the current queue",
    );
    assert.equal(
      tasks.hasOpenObligation("parent", "child"),
      false,
      "still queued, so no account yet",
    );
    assert.equal(sourceNotice("parent"), undefined);
  });

  it("drains same-time deliveries in enqueue order", async () => {
    store.createCollaborationMessage({
      id: "z-first",
      deliveryId: "zz-order-first",
      sourceTaskId: "source",
      directTargetTaskId: "target",
      sourceActor: "user",
      body: "FIRST",
      createdAt: 5,
    });
    store.createCollaborationMessage({
      id: "a-second",
      deliveryId: "aa-order-second",
      sourceTaskId: "source",
      directTargetTaskId: "target",
      sourceActor: "user",
      body: "SECOND",
      createdAt: 5,
    });
    const prompts: string[] = [];
    const bridge = {
      ...mockBridgeStubs(),
      async prompt(_taskId: string, text: string) {
        prompts.push(text);
      },
    };

    assert.equal(
      await tasks.drainCollaborationDeliveries("target", bridge),
      true,
    );
    await waitFor(
      () =>
        store.getCollaborationDelivery("zz-order-first")?.status ===
          "delivered" &&
        store.getCollaborationDelivery("aa-order-second")?.status ===
          "delivered",
    );
    assert.equal(prompts.length, 1);
    assert.ok(
      prompts[0].indexOf("FIRST") < prompts[0].indexOf("SECOND"),
      "same-time items keep insertion order, not id order",
    );
  });

  it("runs the rejection path, not the turn-end check, after a request-level error", async () => {
    seedDispatchFamily();
    const sse = { broadcast() {} };
    const bridge: {
      prompt(
        taskId: string,
        text: string,
        attachments?: unknown,
        promptId?: string,
      ): Promise<void>;
    } & ReturnType<typeof mockBridgeStubs> = {
      ...mockBridgeStubs(),
      async prompt(taskId, _text, _attachments, promptId) {
        const lease = tasks.authority.leaseFor(taskId);
        handleAgentEvent(
          {
            type: "error",
            taskId,
            promptId,
            message: "never handed over",
            requestLevel: true,
            ...(lease ? { executionLease: lease } : {}),
          } as never,
          tasks,
          store,
          bridge as never,
          makeEventHandlerConfig(),
          sse as never,
        );
        throw new Error("rejected");
      },
    };

    assert.equal(
      await tasks.drainCollaborationDeliveries("child", bridge),
      true,
    );
    assert.equal(tasks.hasOpenObligation("parent", "child"), false);
    assert.equal(sourceNotice("parent")?.reason, "target_removed");
    const reminderRows = store
      .getEvents("child")
      .filter((event) => event.type === "handoff_reminder");
    assert.equal(reminderRows.length, 0);
    const visibleReminders = store
      .getEvents("child")
      .filter((event) => event.type === "system_message")
      .map((event) => JSON.parse(event.data) as Record<string, unknown>)
      .filter(
        (data) =>
          data.kind === "collaboration" &&
          typeof data.body === "string" &&
          data.body.includes("Task Handoff Required"),
      );
    assert.equal(visibleReminders.length, 0);
    assert.equal(
      store.countQueuedDeliveries("child"),
      0,
      "a rejected prompt queues no reminder for the target",
    );
    const noUpdateRows = store
      .getEvents("parent")
      .filter((event) => event.type === "task_outcome_notice")
      .map((event) => JSON.parse(event.data) as Record<string, unknown>)
      .filter((data) => data.reason === "no_update");
    assert.equal(noUpdateRows.length, 0);
  });

  it("does not mark a turn when the update transaction fails", () => {
    seedDispatchFamily();
    armDeliveredDispatch();
    tasks.beginAgentTurn("child", { origin: "interactive" });
    tasks.notePromptSubmitted("child");
    const original = store.recordAgentWorkflowUpdate.bind(store);
    store.recordAgentWorkflowUpdate = () => {
      throw new Error("transaction failed");
    };
    try {
      assert.throws(
        () => tasks.settleAgentUpdate("child", "done", "not committed"),
        /transaction failed/,
      );
    } finally {
      store.recordAgentWorkflowUpdate = original;
    }
    assert.equal(
      (
        tasks as unknown as { obligations: { updated: Set<string> } }
      ).obligations.updated.has("child"),
      false,
    );
    assert.equal(tasks.hasOpenObligation("parent", "child"), true);
  });

  it("silently closes matching external account on inbound failure without emitting notice or touching local accounts", () => {
    store.createDeferredRemoteTask({
      id: "ext-child",
      cwd: tmpDir,
      source: "auto",
      agentId: "test-agent",
      externalParentId: "ext-parent",
      remoteHost: "hub-a",
      title: "Ext Child",
      creationAnchor: { kind: "task_created", title: "Ext Child" },
    });
    const entryId = randomUUID();
    store.applyLinkPushOperation({
      remoteRole: "parent",
      remoteHost: "hub-a",
      envelope: {
        id: entryId,
        category: "message",
        data: {
          sourceTaskId: "ext-parent",
          targetTaskId: "ext-child",
          sourceLabel: "External Parent",
          body: "do work",
        },
      },
    });
    // Open the external account (as drain would on handover), then fail the
    // inbound delivery via clear/prompt failure.
    (
      tasks as unknown as {
        obligations: {
          arm: (s: string, t: string, k: "local" | "external") => void;
        };
      }
    ).obligations.arm("ext-parent", "ext-child", "external");
    assert.equal(tasks.hasOpenObligation("ext-parent", "ext-child"), true);
    store.failQueuedDeliveries("ext-child", "clear");
    assert.equal(tasks.hasOpenObligation("ext-parent", "ext-child"), false);
    assert.equal(
      store
        .getEvents("ext-child")
        .filter((e) => e.type === "task_outcome_notice").length,
      0,
    );

    // On hub side: a local parent→child account on P is NOT closed when an
    // inbound child→parent message from remote child fails on P.
    seedDispatchFamily();
    armDeliveredDispatch();
    store.recordRemoteChild("child", "remote-grandchild", "owner-b");
    const revId = randomUUID();
    store.applyLinkFeedOperation({
      remoteRole: "child",
      remoteHost: "owner-b",
      expectedApplied: 0,
      nextApplied: 1,
      envelope: {
        id: revId,
        category: "message",
        data: {
          sourceTaskId: "remote-grandchild",
          targetTaskId: "child",
          sourceLabel: "Remote Grandchild",
          body: "hello",
        },
      },
    });
    store.failQueuedDeliveries("child", "clear");
    // Local account parent→child must still be open, and no notice emitted.
    assert.equal(tasks.hasOpenObligation("parent", "child"), true);
    assert.equal(
      store.getEvents("child").filter((e) => e.type === "task_outcome_notice")
        .length,
      0,
    );
  });

  it("routes emitObligationNotice to local, external parent outbox, or drops unknown source", () => {
    // 1. Local source -> local audit + delivery
    seedDispatchFamily();
    tasks.emitObligationNotice({
      reason: "no_update",
      sourceTaskId: "parent",
      targetTaskId: "child",
      message: "Local child did not update.",
    });
    const localAudit = store
      .getEvents("parent")
      .filter((e) => e.type === "task_outcome_notice");
    assert.equal(localAudit.length, 1);

    // 2. External parent source -> parent outbox notice with real title
    store.createDeferredRemoteTask({
      id: "ext-r1",
      cwd: tmpDir,
      source: "auto",
      agentId: "test-agent",
      externalParentId: "hub-p1",
      remoteHost: "hub-a",
      title: "Real Worker Title",
      creationAnchor: { kind: "task_created", title: "Real Worker Title" },
    });
    tasks.emitObligationNotice({
      reason: "no_activity",
      sourceTaskId: "hub-p1",
      targetTaskId: "ext-r1",
      message: "Silent worker.",
    });
    const outbox = store.listOutbox("parent", "hub-a");
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].category, "notice");
    assert.equal(outbox[0].delivery_id, null);
    assert.deepEqual(JSON.parse(outbox[0].data_json), {
      sourceTaskId: "hub-p1",
      targetTaskId: "ext-r1",
      reason: "no_activity",
      message: "Silent worker.",
      targetLabel: "Real Worker Title",
    });

    // 3. Unknown source -> dropped
    tasks.emitObligationNotice({
      reason: "no_update",
      sourceTaskId: "stranger",
      targetTaskId: "ext-r1",
      message: "Should drop.",
    });
    assert.equal(store.listOutbox("parent", "hub-a").length, 1);
  });

  it("emits target_removed notice with real title on hard delete and Root exit, and suppresses A3 when A1 already failed a queued inbound message", async () => {
    const obligations = (
      tasks as unknown as {
        obligations: {
          arm: (s: string, t: string, k: "local" | "external") => void;
        };
      }
    ).obligations;

    // Case A: Hard delete with open external account and no queued inbound message -> A3 notice with real title.
    store.createDeferredRemoteTask({
      id: "r-del",
      cwd: tmpDir,
      source: "auto",
      agentId: "test-agent",
      externalParentId: "hub-p",
      remoteHost: "hub-a",
      title: "Deleted Worker",
      creationAnchor: { kind: "task_created", title: "Deleted Worker" },
    });
    obligations.arm("hub-p", "r-del", "external");
    await tasks.deleteTask(undefined, "r-del");
    const afterDel = store.listOutbox("parent", "hub-a");
    assert.equal(afterDel.length, 1);
    assert.equal(afterDel[0].category, "notice");
    assert.deepEqual(JSON.parse(afterDel[0].data_json), {
      sourceTaskId: "hub-p",
      targetTaskId: "r-del",
      reason: "target_removed",
      message:
        "The target left this edge (deleted or archived); the account is gone.",
      targetLabel: "Deleted Worker",
    });

    // Case 6a: Open external account + queued inbound message on same edge -> delete fails delivery (receipt for A1) and closes account silently (no A3 notice).
    store.createDeferredRemoteTask({
      id: "r-queued",
      cwd: tmpDir,
      source: "auto",
      agentId: "test-agent",
      externalParentId: "hub-p",
      remoteHost: "hub-a",
      title: "Queued Worker",
      creationAnchor: { kind: "task_created", title: "Queued Worker" },
    });
    const inboundId = randomUUID();
    store.applyLinkPushOperation({
      remoteRole: "parent",
      remoteHost: "hub-a",
      envelope: {
        id: inboundId,
        category: "message",
        data: {
          sourceTaskId: "hub-p",
          targetTaskId: "r-queued",
          sourceLabel: "Hub Parent",
          body: "queued work",
        },
      },
    });
    obligations.arm("hub-p", "r-queued", "external");
    await tasks.deleteTask(undefined, "r-queued");
    const after6a = store.listOutbox("parent", "hub-a", afterDel[0].pos, 10);
    assert.equal(after6a.length, 1);
    assert.equal(after6a[0].category, "receipt");
    assert.deepEqual(JSON.parse(after6a[0].data_json), {
      originalEntryId: inboundId,
      status: "failed",
      failureReason: "target_deleted",
    });

    // Case 6c: Unarchived R1 attached to Root, deleted recursively by Root exit -> A3 notice with real title.
    store.createDeferredRemoteTask({
      id: "r-root",
      cwd: tmpDir,
      source: "auto",
      agentId: "test-agent",
      externalParentId: "hub-p",
      remoteHost: "hub-a",
      title: "Unarchived Worker",
      creationAnchor: { kind: "task_created", title: "Unarchived Worker" },
    });
    store.unarchiveTask("r-root");
    obligations.arm("hub-p", "r-root", "external");
    await tasks.exitRoot(mockBridgeStubs());
    const afterRoot = store.listOutbox("parent", "hub-a", after6a[0].pos, 10);
    assert.equal(afterRoot.length, 1);
    assert.equal(afterRoot[0].category, "notice");
    assert.deepEqual(JSON.parse(afterRoot[0].data_json), {
      sourceTaskId: "hub-p",
      targetTaskId: "r-root",
      reason: "target_removed",
      message:
        "The target left this edge (deleted or archived); the account is gone.",
      targetLabel: "Unarchived Worker",
    });
  });
});
