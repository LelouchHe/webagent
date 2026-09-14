import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { TaskManager } from "../src/task-manager.ts";
import { handleAgentEvent } from "../src/event-handler.ts";
import { createMcpTaskToolHost } from "../src/mcp/task-host.ts";
import { getLogLevel, setLogLevel, setLogSink } from "../src/log.ts";
import type { AgentEvent } from "../src/types.ts";
import type { DirectedObligation } from "../src/obligation-controller.ts";
import { makeEventHandlerConfig } from "./fixtures.ts";

function createMockSseManager() {
  const broadcasted: AgentEvent[] = [];
  return {
    sseManager: {
      broadcast(event: AgentEvent) {
        broadcasted.push(event);
      },
    },
    broadcasted,
  };
}

function createMockBridge(promptErrors: Array<Error | undefined> = []) {
  const calls = {
    resolvePermission: [] as Array<{ requestId: string; optionId: string }>,
    prompts: [] as Array<{ taskId: string; text: string; promptId?: string }>,
  };
  return {
    bridge: {
      async newSession() {
        return { sessionId: "", configOptions: [] };
      },
      async setConfigOption() {
        return [];
      },
      async loadSession(taskId: string) {
        return { taskId, configOptions: [] };
      },
      resolvePermission(requestId: string, optionId: string) {
        calls.resolvePermission.push({ requestId, optionId });
      },
      prompt(
        taskId: string,
        text: string,
        _attachments?: unknown,
        promptId?: string,
      ) {
        calls.prompts.push({ taskId, text, promptId });
        const promptError = promptErrors.shift();
        return promptError ? Promise.reject(promptError) : Promise.resolve();
      },
    } as any,
    calls,
  };
}

/**
 * Bridge that resolves prompts only when the test completes them, so turn
 * boundaries can be driven in the same order as the live bridge (prompt_done
 * fires while the prompt promise is still pending).
 */
function createControllableBridge() {
  const calls = {
    prompts: [] as Array<{
      taskId: string;
      text: string;
      promptId?: string;
      resolve: () => void;
      reject: (error: Error) => void;
    }>,
  };
  return {
    bridge: {
      async newSession() {
        return { sessionId: "", configOptions: [] };
      },
      async setConfigOption() {
        return [];
      },
      async loadSession(taskId: string) {
        return { taskId, configOptions: [] };
      },
      prompt(
        taskId: string,
        text: string,
        _attachments?: unknown,
        promptId?: string,
      ) {
        return new Promise<void>((resolve, reject) => {
          calls.prompts.push({ taskId, text, promptId, resolve, reject });
        });
      },
    } as any,
    calls,
  };
}

/** Arm a directed obligation the way a direct parent dispatch does. */
async function armDirectDispatch(
  store: Store,
  tasks: TaskManager,
  bridge: any,
  sourceTaskId: string,
  targetTaskId: string,
  body = "Do the assigned work.",
): Promise<DirectedObligation> {
  const host = createMcpTaskToolHost({ store, tasks, getBridge: () => bridge });
  await host.send(sourceTaskId, targetTaskId, body);
  const obligation = tasks.getObligation(sourceTaskId, targetTaskId);
  assert.ok(obligation, "a direct parent dispatch must arm an obligation");
  return obligation;
}

/** Let queued zero-delay reminder timers and drain microtasks run. */
async function flushTimers(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("handleAgentEvent", () => {
  let tmpDir: string;
  let store: Store;
  let tasks: TaskManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-server-test-"));
    store = new Store(tmpDir, "test-agent");
    tasks = new TaskManager(store, tmpDir, tmpDir);
  });

  afterEach(() => {
    setLogSink(null);
    setLogLevel("off");
    tasks.dispose();
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Event routing ---

  it("routes message_chunk through assistant buffer and broadcasts", () => {
    store.createTask("s1", "/tmp");
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      { type: "message_chunk", taskId: "s1", text: "hello" } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.equal(broadcasted.length, 1);
    assert.deepEqual(broadcasted[0], {
      type: "message_chunk",
      taskId: "s1",
      text: "hello",
    });
    // Text is buffered, not yet flushed to store
    assert.equal(tasks.assistantBuffers.get("s1"), "hello");
  });

  it("flushes thinking buffer before appending assistant text", () => {
    store.createTask("s1", "/tmp");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    // Start thinking
    handleAgentEvent(
      { type: "thought_chunk", taskId: "s1", text: "hmm" } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    assert.equal(tasks.thinkingBuffers.get("s1"), "hmm");

    // Switch to message — should flush thinking
    handleAgentEvent(
      { type: "message_chunk", taskId: "s1", text: "answer" } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    assert.equal(tasks.thinkingBuffers.has("s1"), false);
    const events = store.getEvents("s1");
    assert.ok(events.some((e) => e.type === "thinking"));
  });

  it("saves tool_call events to store and broadcasts", () => {
    store.createTask("s1", "/tmp");
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      {
        type: "tool_call",
        taskId: "s1",
        id: "tc1",
        title: "Read file",
        kind: "read",
        rawInput: "{}",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    const events = store.getEvents("s1");
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "tool_call");
    assert.equal(broadcasted.length, 1);
  });

  it("stores plan history and updates the current runtime plan", () => {
    store.createTask("s1", "/tmp");
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();
    const entries = [
      { content: "Implement state", status: "in_progress" },
      { content: "Verify clients", status: "pending" },
    ];

    handleAgentEvent(
      { type: "plan", taskId: "s1", entries },
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.deepEqual(tasks.state.getState("s1").runtime.plan, entries);
    assert.ok(store.getEvents("s1").some((event) => event.type === "plan"));
    assert.equal(broadcasted.at(-1)?.type, "plan");
  });

  it("clears runtime plan when every entry is completed", () => {
    store.createTask("s1", "/tmp");
    tasks.state.patch("s1", {
      runtime: {
        plan: [{ content: "Old work", status: "in_progress" }],
      },
    });
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      {
        type: "plan",
        taskId: "s1",
        entries: [{ content: "Old work", status: "completed" }],
      },
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.equal(tasks.state.getState("s1").runtime.plan, null);
  });

  it("saves prompt_done and clears active prompt", () => {
    store.createTask("s1", "/tmp");
    tasks.activePrompts.add("s1");
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      { type: "prompt_done", taskId: "s1", stopReason: "end_turn" } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.equal(tasks.activePrompts.has("s1"), false);
    const events = store.getEvents("s1");
    assert.ok(events.some((e) => e.type === "prompt_done"));
    assert.equal(broadcasted.length, 1);
  });

  function seedFamily() {
    store.createTask("grand", "/tmp", "root", "agent-grand");
    store.createTask("parent", "/tmp", "agent", "agent-parent", "grand");
    store.createTask("child", "/tmp", "agent", "agent-child", "parent");
    store.createTask("sibling", "/tmp", "agent", "agent-sibling", "parent");
    tasks.liveTasks.add("child");
  }

  function endTurn(
    bridge: Parameters<TaskManager["drainCollaborationDeliveries"]>[0],
    taskId: string,
    promptId: string | undefined,
    stopReason = "end_turn",
  ) {
    const { sseManager } = createMockSseManager();
    handleAgentEvent(
      { type: "prompt_done", taskId, promptId, stopReason } as any,
      tasks,
      store,
      bridge as any,
      makeEventHandlerConfig(),
      sseManager as any,
    );
  }

  it("arms a direct parent dispatch and leaves unrelated sends ordinary", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    const obligation = await armDirectDispatch(
      store,
      tasks,
      bridge,
      "parent",
      "child",
      "Work on the assignment.",
    );
    assert.equal(calls.prompts.length, 1);
    assert.match(calls.prompts[0].text, /Work on the assignment\./);
    // No correlation token is injected: settlement is derived from the record.
    assert.doesNotMatch(calls.prompts[0].text, /obligation id/i);
    // The drain handed the dispatch to the session, so the record is open (or
    // already due for a reminder), not waiting.
    assert.notEqual(obligation.state, "awaiting_delivery");

    // A sibling message to the same child is ordinary delivery: it never arms.
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => bridge,
    });
    await host.send("sibling", "child", "A sibling note.");
    // Mutation evidence: arming on any local relation puts a record here.
    assert.equal(tasks.getObligation("sibling", "child"), undefined);
    calls.prompts[0].resolve();
    calls.prompts[1]?.resolve();
    await flushTimers();
  });

  it("treats an in-turn agent error as delivered, not a transport failure", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    await armDirectDispatch(store, tasks, bridge, "parent", "child");
    await flushTimers();
    const promptId = calls.prompts[0].promptId;

    // Real bridge contract: an in-turn agent error emits an error event and
    // then resolves, so the drain must not treat it as a transport failure.
    const { sseManager } = createMockSseManager();
    handleAgentEvent(
      {
        type: "error",
        taskId: "child",
        promptId,
        message: "turn boom",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    calls.prompts[0].resolve();
    await flushTimers();

    // Mutation evidence: treating every non-success as a request-level failure
    // would reset this to awaiting_delivery and retry the dispatch.
    assert.notEqual(
      tasks.getObligation("parent", "child")?.state,
      "awaiting_delivery",
    );
    assert.equal(
      calls.prompts.filter((prompt) =>
        prompt.text.includes("Do the assigned work."),
      ).length,
      1,
    );
    assert.ok(
      calls.prompts.some((prompt) =>
        prompt.text.includes("Task Handoff Required"),
      ),
      "the errored dispatch turn still needs a closing reminder",
    );
    calls.prompts.at(-1)?.resolve();
    await flushTimers();
  });

  it("retries a rejected initial dispatch at an idle boundary", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    await armDirectDispatch(store, tasks, bridge, "parent", "child");
    await flushTimers();
    assert.equal(calls.prompts.length, 1);

    // The original dispatch prompt is rejected before the target sees it.
    calls.prompts[0].reject(new Error("bridge unavailable"));
    await flushTimers();

    const obligation = tasks.getObligation("parent", "child");
    assert.ok(obligation);
    assert.equal(obligation.state, "awaiting_delivery");
    // The retry is held for the controller's backoff: an immediate idle drain
    // would bypass the transport budget. Mutation evidence: requeuing in the
    // rejection handler submits a second prompt right here.
    assert.equal(calls.prompts.length, 1);

    // The bounded retry resubmits the same dispatch.
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    await flushTimers();
    assert.equal(calls.prompts.length, 2);
    assert.match(calls.prompts[1].text, /Do the assigned work\./);
    calls.prompts[1].resolve();
    await flushTimers();
  });

  it("ends a dispatch whose resume keeps failing", async () => {
    seedFamily();
    // Keep the task non-live so every attempt must resume, and make resume fail.
    tasks.liveTasks.delete("child");
    const broadcasts: Array<{ body: string }> = [];
    tasks.setCollaborationBroadcast((event) => broadcasts.push(event));
    const bridge = {
      async newSession() {
        return { sessionId: "", configOptions: [] };
      },
      async setConfigOption() {
        return [];
      },
      async loadSession() {
        throw new Error("resume keeps failing");
      },
      async prompt() {
        throw new Error("prompt must not be reached");
      },
    };

    await armDirectDispatch(store, tasks, bridge, "parent", "child");
    await flushTimers();
    assert.equal(
      tasks.getObligation("parent", "child")?.state,
      "awaiting_delivery",
    );

    // The bounded transport retries (1s then 2s backoff) exhaust the budget.
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    await flushTimers();
    await new Promise<void>((resolve) => setTimeout(resolve, 2_100));
    await flushTimers();

    // Mutation evidence: without resume-failure accounting (or the dispatch
    // deadline) the record waits forever with no notice.
    assert.equal(tasks.getObligation("parent", "child")?.state, "unanswered");
    assert.equal(broadcasts.length, 1);
    const notice = JSON.parse(broadcasts[0].body) as {
      reason: string;
      evidence: Record<string, unknown>;
    };
    assert.equal(notice.reason, "no_account");
    assert.equal(notice.evidence.deliveryUnavailable, true);
    await flushTimers();
  });

  it("does not arm for a user-originated parent send", async () => {
    seedFamily();
    // A human message in the parent session is ordinary collaboration, not the
    // parent agent's dispatch contract, even though the direction is the same.
    // Mutation evidence: dropping the actor term arms this edge.
    store.createCollaborationMessage({
      id: "user-parent-message",
      deliveryId: "user-parent-delivery",
      sourceTaskId: "parent",
      directTargetTaskId: "child",
      sourceActor: "user",
      body: "A human message in the parent session.",
    });
    assert.equal(tasks.getObligation("parent", "child"), undefined);
  });

  it("emits one factual no_account notice when initial delivery keeps failing", async () => {
    seedFamily();
    const broadcasts: Array<{
      messageId: string;
      sourceTaskId: string;
      targetTaskId: string;
      body: string;
    }> = [];
    tasks.setCollaborationBroadcast((event) => broadcasts.push(event));
    const { bridge, calls } = createControllableBridge();
    await armDirectDispatch(store, tasks, bridge, "parent", "child");
    await flushTimers();
    assert.equal(calls.prompts.length, 1);

    calls.prompts[0].reject(new Error("down"));
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    await flushTimers();
    assert.equal(calls.prompts.length, 2);
    calls.prompts[1].reject(new Error("down"));
    await new Promise<void>((resolve) => setTimeout(resolve, 2_100));
    await flushTimers();
    assert.equal(calls.prompts.length, 3);
    calls.prompts[2].reject(new Error("down"));
    await flushTimers();

    assert.equal(tasks.getObligation("parent", "child")?.state, "unanswered");
    // One notice, routed target->stored source with system actor.
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].sourceTaskId, "child");
    assert.equal(broadcasts[0].targetTaskId, "parent");
    const notice = JSON.parse(broadcasts[0].body) as {
      sourceTaskId: string;
      targetTaskId: string;
      openingMessageId: string;
      openingDeliveryId: string;
      reason: string;
      evidence: Record<string, unknown>;
    };
    assert.equal(notice.sourceTaskId, "parent");
    assert.equal(notice.targetTaskId, "child");
    assert.ok(notice.openingMessageId);
    assert.ok(notice.openingDeliveryId);
    assert.equal(notice.reason, "no_account");
    assert.equal(notice.evidence.deliveryUnavailable, true);
    assert.ok(
      store
        .getEvents("child")
        .some((event) => event.type === "task_outcome_notice"),
    );

    // Let the notice delivery drain finish before the store closes.
    await flushTimers();
    calls.prompts.at(-1)?.resolve();
    await flushTimers();
  });

  it("reminds at the dispatch turn boundary and states the closing-only contract", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    await armDirectDispatch(store, tasks, bridge, "parent", "child");
    endTurn(bridge, "child", calls.prompts[0].promptId);
    calls.prompts[0].resolve();
    await flushTimers();

    assert.equal(calls.prompts.length, 2);
    assert.match(calls.prompts[1].text, /task_update\(done/);
    // The reminder's whole behavioural contract is prose: closing only.
    assert.match(calls.prompts[1].text, /do not start any new work/i);
    assert.doesNotMatch(calls.prompts[1].text, /obligation id/i);

    // The successful reminder event is recorded only after the bridge accepts.
    assert.equal(
      store
        .getEvents("child")
        .some(
          (event) =>
            event.type === "system_message" &&
            JSON.parse(event.data).kind === "handoff_reminder",
        ),
      false,
    );
    calls.prompts[1].resolve();
    await flushTimers();
    const reminder = store
      .getEvents("child")
      .find(
        (event) =>
          event.type === "system_message" &&
          JSON.parse(event.data).kind === "handoff_reminder",
      );
    assert.ok(reminder, "an accepted reminder must be recorded");
    const payload = JSON.parse(reminder.data) as {
      sourceTaskId: string;
      targetTaskId: string;
      openingMessageId: string;
      openingDeliveryId: string;
    };
    assert.equal(payload.sourceTaskId, "parent");
    assert.equal(payload.targetTaskId, "child");
    assert.ok(payload.openingMessageId);
    assert.ok(payload.openingDeliveryId);
  });

  it("settles the record from an active current turn and routes to the stored source", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    await armDirectDispatch(store, tasks, bridge, "parent", "child");
    endTurn(bridge, "child", calls.prompts[0].promptId);
    calls.prompts[0].resolve();
    await flushTimers();
    assert.equal(calls.prompts.length, 2);

    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => bridge,
    });
    await host.update("child", "done", "Everything is verified.");

    assert.equal(store.getTask("child")?.workflow_status, "done");
    // Mutation evidence: not retiring on settle leaves a non-terminal record.
    assert.equal(tasks.getObligation("parent", "child")?.state, "settled");
    assert.ok(
      store
        .getEvents("parent")
        .some(
          (event) =>
            event.type === "system_message" &&
            event.data.includes("Everything is verified."),
        ),
      "the account must reach the stored source",
    );

    calls.prompts[1].resolve();
    await flushTimers();
    assert.equal(
      calls.prompts.filter((prompt) => prompt.taskId === "child").length,
      2,
    );
  });

  it("settles the account from the same dispatch turn through the real delivery path", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    await armDirectDispatch(store, tasks, bridge, "parent", "child");
    await flushTimers();
    assert.equal(calls.prompts.length, 1);

    // The record opens when the dispatch is handed to the target's session, so
    // the dispatch turn's own account settles it while the prompt is still in
    // flight. Mutation evidence: opening on prompt resolution instead leaves
    // the record awaiting_delivery here and refuses the account. Do not
    // replace this with a synthetic turn: a constructed turn can satisfy
    // guards that the real delivery turn cannot.
    const obligation = tasks.getObligation("parent", "child");
    assert.notEqual(obligation?.state, "awaiting_delivery");
    assert.ok(tasks.getActiveAgentTurn("child"));

    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => bridge,
    });
    await host.update("child", "done", "Settled from the dispatch turn.");

    assert.equal(tasks.getObligation("parent", "child")?.state, "settled");
    assert.ok(
      store
        .getEvents("parent")
        .some(
          (event) =>
            event.type === "system_message" &&
            event.data.includes("Settled from the dispatch turn."),
        ),
      "the account must reach the stored source",
    );
    // No reminder turn is issued for this edge.
    await flushTimers();
    assert.equal(
      calls.prompts.filter((prompt) =>
        prompt.text.includes("Task Handoff Required"),
      ).length,
      0,
    );
    calls.prompts[0].resolve();
    await flushTimers();
  });

  it("does not settle while the record is queued awaiting delivery", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    // A live turn on the target keeps the dispatch queued: the record is armed
    // but nothing has been handed to the target's session, so it stays
    // awaiting_delivery and the state gate must refuse settlement.
    tasks.activePrompts.add("child");
    tasks.syncBusy("child");

    await armDirectDispatch(store, tasks, bridge, "parent", "child");
    await flushTimers();
    assert.equal(calls.prompts.length, 0);
    assert.equal(
      tasks.getObligation("parent", "child")?.state,
      "awaiting_delivery",
    );

    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => bridge,
    });
    await host.update("child", "done", "Early report.");

    // Mutation evidence: dropping the awaiting_delivery state gate settles here.
    assert.equal(
      tasks.getObligation("parent", "child")?.state,
      "awaiting_delivery",
    );
    assert.ok(
      store
        .getEvents("parent")
        .some(
          (event) =>
            event.type === "system_message" &&
            event.data.includes("Early report."),
        ),
      "a report with an existing record still reaches the stored source",
    );

    // Release the busy turn so the queued dispatch can be handed over.
    tasks.activePrompts.delete("child");
    tasks.syncBusy("child");
    await flushTimers();
    assert.notEqual(
      tasks.getObligation("parent", "child")?.state,
      "awaiting_delivery",
    );
    for (const prompt of calls.prompts) prompt.resolve();
    await flushTimers();
  });

  it("routes an account to the stored source after a tree change", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    await armDirectDispatch(store, tasks, bridge, "parent", "child");
    endTurn(bridge, "child", calls.prompts[0].promptId);
    calls.prompts[0].resolve();
    await flushTimers();
    // The tree changes after arming: child is reparented under a sibling.
    store["db"]
      .prepare("UPDATE tasks SET parent_id = ? WHERE id = ?")
      .run("sibling", "child");

    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => bridge,
    });
    await host.update("child", "done", "Stored-source account.");

    // Mutation evidence: routing to the current parent_id sends this to
    // "sibling" instead, leaving the originally accountable source unaware.
    assert.ok(
      store
        .getEvents("parent")
        .some(
          (event) =>
            event.type === "system_message" &&
            event.data.includes("Stored-source account."),
        ),
      "the account must reach the stored source",
    );
    assert.equal(
      store
        .getEvents("sibling")
        .some(
          (event) =>
            event.type === "system_message" &&
            event.data.includes("Stored-source account."),
        ),
      false,
    );
    calls.prompts[1].resolve();
    await flushTimers();
  });

  it("lets a queued sibling delivery claim the next turn without erasing the record", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    await armDirectDispatch(store, tasks, bridge, "parent", "child");
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => bridge,
    });
    // The sibling delivery queues behind the live dispatch turn.
    await host.send("sibling", "child", "A sibling note that settles nothing.");

    endTurn(bridge, "child", calls.prompts[0].promptId);
    calls.prompts[0].resolve();
    await flushTimers();

    // The drain microtask wins the turn over the reminder timer.
    assert.equal(calls.prompts.length, 2);
    assert.match(calls.prompts[1].text, /sibling note that settles nothing/);
    assert.doesNotMatch(calls.prompts[1].text, /Task Handoff Required/);
    assert.ok(tasks.getObligation("parent", "child"));

    endTurn(bridge, "child", calls.prompts[1].promptId);
    calls.prompts[1].resolve();
    await flushTimers();
    assert.equal(calls.prompts.length, 3);
    assert.match(calls.prompts[2].text, /Task Handoff Required/);
    calls.prompts[2].resolve();
    await flushTimers();
  });

  it("keeps queued collaboration blocked by an active ACP prompt", async () => {
    store.createTask("root", "/tmp", "root", "agent-root");
    store.createTask("source", "/tmp", "agent", "agent-source", "root");
    store.createTask("target", "/tmp", "agent", "agent-target", "root");
    tasks.liveTasks.add("target");
    store.createCollaborationMessage({
      id: "active-message",
      deliveryId: "active-delivery",
      sourceTaskId: "source",
      directTargetTaskId: "target",
      sourceActor: "agent",
      body: "Wait for the active ACP prompt.",
      createdAt: Date.now(),
    });
    const { bridge, calls } = createMockBridge();
    tasks.activePrompts.add("target");

    const drained = await tasks.drainCollaborationDeliveries(bridge, "target");

    assert.equal(drained, false);
    assert.equal(calls.prompts.length, 0);
    assert.equal(
      store.getCollaborationDelivery("active-delivery")?.status,
      "queued",
    );
  });

  it("does not remind for a user-started turn", async () => {
    store.createTask("manual", "/tmp", "auto", "agent-manual");
    const { bridge, calls } = createMockBridge();
    tasks.activePrompts.add("manual");
    tasks.syncBusy("manual");
    const promptId =
      tasks.state.getState("manual").runtime.busy?.promptId ?? undefined;

    endTurn(bridge, "manual", promptId);
    await flushTimers();

    // Mutation evidence: arming on a user prompt produces a reminder here.
    assert.equal(calls.prompts.length, 0);
  });

  it("still reminds when the dispatch turn was cancelled", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    await armDirectDispatch(store, tasks, bridge, "parent", "child");
    endTurn(bridge, "child", calls.prompts[0].promptId, "cancelled");
    calls.prompts[0].resolve();
    await flushTimers();

    assert.equal(calls.prompts.length, 2);
    assert.match(calls.prompts[1].text, /do not start any new work/i);
    calls.prompts[1].resolve();
    await flushTimers();
  });

  it("resumes a non-live session before submitting the reminder", async () => {
    seedFamily();
    tasks.liveTasks.delete("child");
    let resumed = false;
    const calls = {
      loadSession: 0,
      prompts: [] as Array<{
        taskId: string;
        text: string;
        promptId?: string;
        resolve: () => void;
        reject: (error: Error) => void;
      }>,
    };
    const bridge = {
      async newSession() {
        return { sessionId: "", configOptions: [] };
      },
      async setConfigOption() {
        return [];
      },
      async loadSession(taskId: string) {
        calls.loadSession += 1;
        resumed = true;
        return { taskId, configOptions: [] };
      },
      prompt(
        taskId: string,
        text: string,
        _attachments?: unknown,
        promptId?: string,
      ) {
        if (!resumed) return Promise.reject(new Error("session not live"));
        return new Promise<void>((resolve, reject) => {
          calls.prompts.push({ taskId, text, promptId, resolve, reject });
        });
      },
    };
    await armDirectDispatch(store, tasks, bridge, "parent", "child");
    await flushTimers();
    assert.equal(resumed, true);
    assert.equal(calls.prompts.length, 1);

    endTurn(bridge, "child", calls.prompts[0].promptId);
    calls.prompts[0].resolve();
    await flushTimers();

    assert.equal(calls.loadSession, 1);
    assert.equal(calls.prompts.length, 2);
    assert.match(calls.prompts[1].text, /do not start any new work/i);
    calls.prompts[1].resolve();
  });

  it("records no successful reminder when the bridge rejects it", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    await armDirectDispatch(store, tasks, bridge, "parent", "child");
    endTurn(bridge, "child", calls.prompts[0].promptId);
    calls.prompts[0].resolve();
    await flushTimers();
    assert.equal(calls.prompts.length, 2);

    calls.prompts[1].reject(new Error("bridge unavailable"));
    await flushTimers();

    // Mutation evidence: writing the reminder event before submission records
    // a delivery the target never saw.
    assert.equal(
      store
        .getEvents("child")
        .some(
          (event) =>
            event.type === "system_message" &&
            JSON.parse(event.data).kind === "handoff_reminder",
        ),
      false,
    );
    assert.equal(tasks.activePrompts.has("child"), false);
    assert.equal(tasks.getBusyKind("child"), null);
    assert.ok(tasks.getObligation("parent", "child"));

    // Settle to cancel the bounded retry budget before the test ends.
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => bridge,
    });
    await host.update("child", "done", "done");
    await flushTimers();
    calls.prompts.at(-1)?.resolve();
    await flushTimers();
  });

  it("logs obligation lifecycle decisions at debug level", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    const lines: string[] = [];
    const previousLevel = getLogLevel();
    setLogLevel("debug");
    setLogSink((_stream, line) => lines.push(line));
    try {
      await armDirectDispatch(store, tasks, bridge, "parent", "child");
      endTurn(bridge, "child", calls.prompts[0].promptId);
      calls.prompts[0].resolve();
      await flushTimers();
      calls.prompts[1].resolve();
      await flushTimers();
    } finally {
      setLogSink(null);
      setLogLevel(previousLevel);
    }
    assert.ok(
      lines.some((line) => line.includes("obligation armed")),
      "the arm decision must be diagnosable",
    );
    assert.ok(
      lines.some((line) => line.includes("obligation reminder delivered")),
      "the delivered reminder must be diagnosable",
    );
  });

  it("stores the turn a completion ends", () => {
    // Replay has to make the same judgement the live path does. If the stored
    // event drops its identity, a refresh replays the interleaving with no way
    // to tell a superseded terminator from the live turn's own.
    store.createTask("s1", "/tmp");
    tasks.activePrompts.add("s1");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      {
        type: "prompt_done",
        taskId: "s1",
        stopReason: "end_turn",
        promptId: "prompt-7",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    const done = store.getEvents("s1").find((e) => e.type === "prompt_done");
    assert.ok(done, "the completion must be stored");
    assert.equal(
      (JSON.parse(done.data) as { promptId?: string }).promptId,
      "prompt-7",
    );
  });

  it("keeps the live turn busy when a superseded turn completes", () => {
    // Cancelling a turn and immediately sending another interleaves them: the
    // abandoned turn finishes late, and clearing busy here would strand the
    // replacement turn's spinner and let a second prompt through.
    store.createTask("s1", "/tmp");
    tasks.activePrompts.add("s1");
    tasks.syncBusy("s1");
    const livePromptId =
      tasks.state.getState("s1").runtime.busy?.promptId ?? null;
    assert.ok(livePromptId, "precondition: the live turn has an identity");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      {
        type: "prompt_done",
        taskId: "s1",
        stopReason: "end_turn",
        promptId: "prompt-superseded",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.equal(
      tasks.activePrompts.has("s1"),
      true,
      "the live turn must stay active",
    );
    assert.equal(tasks.state.getState("s1").runtime.busy?.kind, "agent");
  });

  it("keeps the live turn busy when a superseded turn errors out", () => {
    // `error` is the other terminal event a prompt can end with, and it takes
    // the same interleaving as a completion: the abandoned turn fails late and
    // must not clear the busy state of the turn that replaced it, or the
    // spinner dies mid-turn and the task accepts a concurrent prompt.
    store.createTask("s1", "/tmp");
    tasks.activePrompts.add("s1");
    tasks.syncBusy("s1");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      {
        type: "error",
        taskId: "s1",
        message: "agent blew up",
        promptId: "prompt-superseded",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.equal(
      tasks.activePrompts.has("s1"),
      true,
      "the live turn must stay active",
    );
    assert.equal(tasks.state.getState("s1").runtime.busy?.kind, "agent");
  });

  it("still clears busy when the live turn errors out", () => {
    // Control: an error for the current turn must end it, or the UI hangs.
    store.createTask("s1", "/tmp");
    tasks.activePrompts.add("s1");
    tasks.syncBusy("s1");
    const livePromptId =
      tasks.state.getState("s1").runtime.busy?.promptId ?? undefined;
    assert.ok(livePromptId, "precondition: the live turn has an identity");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      {
        type: "error",
        taskId: "s1",
        message: "agent blew up",
        promptId: livePromptId,
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.equal(tasks.activePrompts.has("s1"), false);
  });

  it("keeps runtime plan across prompt_done for cross-turn work", () => {
    store.createTask("s1", "/tmp");
    const plan = [{ content: "Continue later", status: "in_progress" }];
    tasks.state.patch("s1", { runtime: { plan } });
    tasks.activePrompts.add("s1");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      { type: "prompt_done", taskId: "s1", stopReason: "end_turn" } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.deepEqual(tasks.state.getState("s1").runtime.plan, plan);
  });

  it("clears runtime plans when the agent disconnects", () => {
    store.createTask("s1", "/tmp");
    tasks.state.patch("s1", {
      runtime: {
        plan: [{ content: "Interrupted work", status: "in_progress" }],
      },
    });
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      { type: "agent_disconnected", error: "agent exited" } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.equal(tasks.state.getState("s1").runtime.plan, null);
  });

  it("clears context usage when the agent disconnects", () => {
    store.createTask("s1", "/tmp");
    tasks.state.patch("s1", {
      runtime: { contextUsage: { used: 61_234, size: 272_000 } },
    });
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      { type: "agent_disconnected" } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.equal(tasks.state.getState("s1").runtime.contextUsage, null);
  });

  it("clears streaming state when the agent disconnects", () => {
    store.createTask("s1", "/tmp");
    tasks.state.patch("s1", {
      runtime: {
        streaming: { assistant: true, thinking: true },
      },
    });
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      { type: "agent_disconnected", error: "agent exited" } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.deepEqual(tasks.state.getState("s1").runtime.streaming, {
      assistant: false,
      thinking: false,
    });
  });

  it("caches config options from task_created", () => {
    store.createTask("s1", "/tmp");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();
    const configOptions = [
      { id: "model", name: "Model", currentValue: "gpt-4", options: [] },
    ];

    handleAgentEvent(
      { type: "task_created", taskId: "s1", configOptions } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.deepEqual(tasks.cachedConfigOptions, configOptions);
    assert.equal(store.getTask("s1")?.model, "gpt-4");
  });

  it("skips events for restoring tasks", () => {
    store.createTask("s1", "/tmp");
    tasks.restoringTasks.add("s1");
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      { type: "message_chunk", taskId: "s1", text: "hidden" } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.equal(broadcasted.length, 0);
    assert.equal(tasks.assistantBuffers.has("s1"), false);
  });

  it("captures context usage during restore", () => {
    store.createTask("s1", "/tmp");
    tasks.restoringTasks.add("s1");
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      {
        type: "usage_update",
        taskId: "s1",
        used: 61_234,
        size: 272_000,
      },
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.deepEqual(tasks.state.getState("s1").runtime.contextUsage, {
      used: 61_234,
      size: 272_000,
    });
    assert.equal(broadcasted.length, 0);
  });

  it("caches available commands during restore without broadcasting", () => {
    store.createTask("s1", "/tmp");
    tasks.restoringTasks.add("s1");
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      {
        type: "available_commands_update",
        taskId: "s1",
        commands: [
          {
            name: "compact",
            description: "Compact conversation",
            input: { hint: "focus instructions" },
          },
        ],
      },
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    const snapshot = tasks.getAgentCommands("s1");
    assert.deepEqual(snapshot, {
      epoch: snapshot.epoch,
      revision: 1,
      commands: [
        {
          name: "compact",
          description: "Compact conversation",
          input: { hint: "focus instructions" },
        },
      ],
    });
    assert.deepEqual(broadcasted, []);
  });

  it("broadcasts available commands with the server revision", () => {
    store.createTask("s1", "/tmp");
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      {
        type: "available_commands_update",
        taskId: "s1",
        commands: [{ name: "context", description: "Show context usage" }],
      },
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    const epoch = tasks.getAgentCommands("s1").epoch;
    assert.deepEqual(broadcasted, [
      {
        type: "available_commands_update",
        taskId: "s1",
        epoch,
        revision: 1,
        commands: [{ name: "context", description: "Show context usage" }],
      },
    ]);
    assert.deepEqual(store.getEvents("s1"), []);
  });

  it("clears and broadcasts command snapshots when the agent disconnects", () => {
    store.createTask("s1", "/tmp");
    tasks.updateAgentCommands("s1", [
      { name: "context", description: "Show context usage" },
    ]);
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      { type: "agent_disconnected" },
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    const epoch = tasks.getAgentCommands("s1").epoch;
    assert.deepEqual(broadcasted, [
      {
        type: "available_commands_update",
        taskId: "s1",
        epoch,
        revision: 2,
        commands: [],
      },
      { type: "agent_disconnected" },
    ]);
  });

  it("persists error events with their turn identity", () => {
    store.createTask("s1", "/tmp");
    tasks.activePrompts.add("s1");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      {
        type: "error",
        taskId: "s1",
        message: "provider failed",
        promptId: "prompt-7",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    const error = store.getEvents("s1").find((event) => event.type === "error");
    assert.ok(error);
    assert.deepEqual(JSON.parse(error.data), {
      message: "provider failed",
      promptId: "prompt-7",
    });
  });

  it("removes active prompt on error events", () => {
    store.createTask("s1", "/tmp");
    tasks.activePrompts.add("s1");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      { type: "error", taskId: "s1", message: "something failed" } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.equal(tasks.activePrompts.has("s1"), false);
  });

  it("flushes content and clears streaming state on error events", () => {
    store.createTask("s1", "/tmp");
    tasks.appendAssistant("s1", "partial answer");
    tasks.state.patch("s1", {
      runtime: {
        streaming: { assistant: true, thinking: false },
      },
    });
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      { type: "error", taskId: "s1", message: "something failed" } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.equal(tasks.assistantBuffers.has("s1"), false);
    assert.ok(
      store.getEvents("s1").some((event) => event.type === "assistant_message"),
    );
    assert.deepEqual(tasks.state.getState("s1").runtime.streaming, {
      assistant: false,
      thinking: false,
    });
  });

  // --- Autopilot auto-approval ---

  it("auto-approves permission in autopilot mode with allow_once", () => {
    store.createTask("s1", "/tmp");
    store.updateTaskConfig("s1", "mode", "agent#autopilot");
    const { bridge, calls } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      {
        type: "permission_request",
        taskId: "s1",
        requestId: "req1",
        title: "Run command",
        options: [
          { optionId: "allow_once", kind: "allow_once", label: "Allow once" },
          { optionId: "deny", kind: "deny", label: "Deny" },
        ],
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    // Bridge should resolve with allow_once
    assert.deepEqual(calls.resolvePermission, [
      { requestId: "req1", optionId: "allow_once" },
    ]);

    // Should broadcast permission_request then permission_response via SSE
    assert.equal(broadcasted.length, 2);
    assert.equal(broadcasted[0].type, "permission_request");
    assert.equal((broadcasted[0] as any).requestId, "req1");
    assert.equal(broadcasted[1].type, "permission_response");
    assert.equal((broadcasted[1] as any).requestId, "req1");
    assert.equal((broadcasted[1] as any).denied, false);
    assert.equal((broadcasted[1] as any).optionName, "Allow once");

    // Should save both permission_request and permission_response to store
    const events = store.getEvents("s1");
    assert.ok(events.some((e) => e.type === "permission_request"));
    assert.ok(events.some((e) => e.type === "permission_response"));
  });

  it("auto-approves permission for Claude bypassPermissions mode (bare string)", () => {
    store.createTask("s1", "/tmp");
    store.updateTaskConfig("s1", "mode", "bypassPermissions");
    const { bridge, calls } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      {
        type: "permission_request",
        taskId: "s1",
        requestId: "req1",
        title: "Run command",
        options: [
          { optionId: "allow_once", kind: "allow_once", label: "Allow once" },
          { optionId: "deny", kind: "deny", label: "Deny" },
        ],
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.deepEqual(calls.resolvePermission, [
      { requestId: "req1", optionId: "allow_once" },
    ]);
    assert.equal(broadcasted.length, 2);
    assert.equal(broadcasted[1].type, "permission_response");
  });

  it("does NOT auto-approve for Claude acceptEdits / dontAsk", () => {
    // These are agent-internal modes — the agent decides what to skip.
    // Webagent should forward permission_requests it does receive.
    for (const mode of ["acceptEdits", "dontAsk", "auto"]) {
      store.createTask("s_" + mode, "/tmp");
      store.updateTaskConfig("s_" + mode, "mode", mode);
      const { bridge, calls } = createMockBridge();
      const { sseManager, broadcasted } = createMockSseManager();

      handleAgentEvent(
        {
          type: "permission_request",
          taskId: "s_" + mode,
          requestId: "req_" + mode,
          title: "Run command",
          options: [
            { optionId: "allow_once", kind: "allow_once", label: "Allow once" },
            { optionId: "deny", kind: "deny", label: "Deny" },
          ],
        } as any,
        tasks,
        store,
        bridge,
        makeEventHandlerConfig(),
        sseManager as any,
      );

      assert.deepEqual(
        calls.resolvePermission,
        [],
        `mode=${mode} should not auto-resolve`,
      );
      assert.equal(
        broadcasted.length,
        1,
        `mode=${mode} should only broadcast request`,
      );
      assert.equal(broadcasted[0].type, "permission_request");
    }
  });

  it("broadcasts permission_request normally when not in autopilot mode", () => {
    store.createTask("s1", "/tmp");
    store.updateTaskConfig("s1", "mode", "agent");
    const { bridge, calls } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      {
        type: "permission_request",
        taskId: "s1",
        requestId: "req1",
        title: "Run command",
        options: [
          { optionId: "allow_once", kind: "allow_once", label: "Allow once" },
          { optionId: "deny", kind: "deny", label: "Deny" },
        ],
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    // Bridge should NOT be called
    assert.equal(calls.resolvePermission.length, 0);

    // Should broadcast permission_request (not resolved)
    assert.equal(broadcasted.length, 1);
    assert.equal(broadcasted[0].type, "permission_request");
  });

  it("falls back to broadcasting permission_request when no allow_once option exists in autopilot", () => {
    store.createTask("s1", "/tmp");
    store.updateTaskConfig("s1", "mode", "agent#autopilot");
    const { bridge, calls } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      {
        type: "permission_request",
        taskId: "s1",
        requestId: "req1",
        title: "Dangerous action",
        options: [
          {
            optionId: "allow_always",
            kind: "allow_always",
            label: "Allow always",
          },
          { optionId: "deny", kind: "deny", label: "Deny" },
        ],
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    // Should NOT auto-approve (no allow_once option)
    assert.equal(calls.resolvePermission.length, 0);

    // Should broadcast permission_request for manual handling
    assert.equal(broadcasted[0].type, "permission_request");
  });
});
