import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import type { TaskManager } from "../src/task-manager.ts";
import { createTaskManager } from "../src/task-manager.ts";
import { handleAgentEvent } from "../src/event-handler.ts";
import { createMcpTaskToolHost } from "../src/mcp/task-host.ts";
import { getLogLevel, setLogLevel, setLogSink } from "../src/log.ts";
import type { AgentEvent } from "../src/types.ts";
import type { DirectedObligation } from "../src/obligation-controller.ts";
import { createCounters } from "../src/attachment-interceptor.ts";
import { makeEventHandlerConfig, waitFor } from "./fixtures.ts";

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
    denyPermission: [] as string[],
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
      denyPermission(requestId: string) {
        calls.denyPermission.push(requestId);
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

/** A principal for a task the manager currently owns, with its generation. */
function principalFor(manager: TaskManager, taskId: string) {
  const lease = manager.authority.leaseFor(taskId);
  assert.ok(lease, `task ${taskId} must have a generation`);
  return {
    taskId,
    agentId: "test-agent",
    generation: lease.generation,
    initializing: false,
  };
}

/**
 * The machine payload of a runtime notice is its `task_outcome_notice` event.
 * The collaboration body is the readable prompt text, so machine fields are
 * asserted here instead of by parsing that body.
 */
function noticeEventData(store: Store, taskId: string) {
  const row = store
    .getEvents(taskId)
    .filter((event) => event.type === "task_outcome_notice")
    .at(-1);
  assert.ok(row, "the target must persist the notice payload");
  return JSON.parse(row.data) as {
    sourceTaskId: string;
    targetTaskId: string;
    openingMessageId: string;
    openingDeliveryId: string;
    reason: string;
    message: string;
    evidence: Record<string, unknown>;
  };
}

/** The persisted collaboration row that belongs to one broadcast message. */
function persistedCollaboration(
  store: Store,
  taskId: string,
  messageId: string,
): Record<string, unknown> {
  const row = store
    .getEvents(taskId)
    .filter((event) => event.type === "system_message")
    .map((event) => JSON.parse(event.data) as Record<string, unknown>)
    .find(
      (data) => data.kind === "collaboration" && data.messageId === messageId,
    );
  assert.ok(row, "the broadcast must have a persisted twin");
  return row;
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
  // The target's own transport drives the delivery, so the controllable bridge
  // must be the binding agent's transport.
  tasks.attachExecutionBridge(bridge);
  const host = createMcpTaskToolHost({ store, tasks });
  await host.send(principalFor(tasks, sourceTaskId), targetTaskId, body);
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

  /**
   * Stamp an event the way the bridge does: with the lease of the execution
   * that produced it. The entry boundary refuses an unstamped event once the
   * task has a current execution, so a fabricated event must name one.
   */
  function withLease<T extends object>(event: T): T {
    const taskId = (event as { taskId?: unknown }).taskId;
    if (typeof taskId !== "string") return event;
    const lease = tasks.authority.leaseFor(taskId);
    return lease ? Object.assign({}, event, { executionLease: lease }) : event;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-server-test-"));
    store = new Store(tmpDir);
    tasks = createTaskManager(store, tmpDir, tmpDir);
    // Every handler in this file drives one mock transport for the task's
    // binding agent; the runtime resolves it through the adapter.
    tasks.attachExecutionBridge({
      newSession: async () => ({ sessionId: "", configOptions: [] }),
      loadSession: async (taskId: string) => ({ taskId, configOptions: [] }),
      setConfigOption: async () => [],
      prompt: async () => {},
      cancel: async () => {},
      resolvePermission: () => {},
      denyPermission: () => {},
    });
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      withLease({ type: "message_chunk", taskId: "s1", text: "hello" }) as any,
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    // Start thinking
    handleAgentEvent(
      withLease({ type: "thought_chunk", taskId: "s1", text: "hmm" }) as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    assert.equal(tasks.thinkingBuffers.get("s1"), "hmm");

    // Switch to message — should flush thinking
    handleAgentEvent(
      withLease({ type: "message_chunk", taskId: "s1", text: "answer" }) as any,
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "tool_call",
        taskId: "s1",
        id: "tc1",
        title: "Read file",
        kind: "read",
        rawInput: "{}",
      }) as any,
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();
    const entries = [
      { content: "Implement state", status: "in_progress" },
      { content: "Verify clients", status: "pending" },
    ];

    handleAgentEvent(
      withLease({ type: "plan", taskId: "s1", entries }),
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    tasks.state.patch("s1", {
      runtime: {
        plan: [{ content: "Old work", status: "in_progress" }],
      },
    });
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "plan",
        taskId: "s1",
        entries: [{ content: "Old work", status: "completed" }],
      }),
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.equal(tasks.state.getState("s1").runtime.plan, null);
  });

  it("saves prompt_done and clears active prompt", () => {
    store.createTask("s1", "/tmp", "auto", "test-agent");
    tasks.activePrompts.add("s1");
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "prompt_done",
        taskId: "s1",
        stopReason: "end_turn",
      }) as any,
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
    store.createTask("grand", "/tmp", "root", "test-agent", "agent-grand");
    store.createTask(
      "parent",
      "/tmp",
      "agent",
      "test-agent",
      "agent-parent",
      "grand",
    );
    store.createTask(
      "child",
      "/tmp",
      "agent",
      "test-agent",
      "agent-child",
      "parent",
    );
    store.createTask(
      "sibling",
      "/tmp",
      "agent",
      "test-agent",
      "agent-sibling",
      "parent",
    );
    tasks.liveTasks.add("child");
  }

  function endTurn(
    bridge: object,
    taskId: string,
    promptId: string | undefined,
    stopReason = "end_turn",
  ) {
    const { sseManager } = createMockSseManager();
    handleAgentEvent(
      withLease({ type: "prompt_done", taskId, promptId, stopReason }) as any,
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
    });
    await host.send(principalFor(tasks, "sibling"), "child", "A sibling note.");
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
      withLease({
        type: "error",
        taskId: "child",
        promptId,
        message: "turn boom",
      }) as any,
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

  it("delivers even when the prompt audit write fails", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    const originalSaveEvent = store.saveEvent.bind(store);
    let auditAttempted = false;
    store.saveEvent = (taskId, type, data, meta) => {
      if (type === "collaboration_prompt") {
        auditAttempted = true;
        throw new Error("audit storage boom");
      }
      return originalSaveEvent(taskId, type, data, meta);
    };
    try {
      await armDirectDispatch(store, tasks, bridge, "parent", "child");
      await flushTimers();
    } finally {
      store.saveEvent = originalSaveEvent;
    }

    // Mutation evidence: letting the audit throw escape strands the claimed
    // dispatch: no prompt, record left awaiting_delivery.
    assert.equal(auditAttempted, true);
    assert.equal(calls.prompts.length, 1);
    assert.notEqual(
      tasks.getObligation("parent", "child")?.state,
      "awaiting_delivery",
    );
    assert.equal(store.countQueuedDeliveries("child"), 0);
    calls.prompts[0].resolve();
    await flushTimers();
  });

  it("persists a bounded audit copy of the drained prompt", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    await armDirectDispatch(
      store,
      tasks,
      bridge,
      "parent",
      "child",
      "Audit me.",
    );
    await flushTimers();

    const audit = store
      .getEvents("child")
      .find((event) => event.type === "collaboration_prompt");
    // Mutation evidence: without persisting the audit copy, a parent cannot
    // prove which text a child received.
    assert.ok(audit, "the drained prompt must be auditable");
    const data = JSON.parse(audit.data) as {
      messageIds: string[];
      text: string;
      truncated: boolean;
      rawSize: number;
    };
    assert.equal(data.messageIds.length, 1);
    assert.match(data.text, /From "/);
    assert.match(data.text, /Audit me\./);
    assert.equal(data.truncated, false);
    assert.ok(data.rawSize > 0);

    calls.prompts[0].resolve();
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
    const broadcasts: Array<{
      messageId: string;
      title: string;
      body: string;
    }> = [];
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

    // Mutation evidence: without resume-failure accounting the record waits
    // with no closure notice (the queued advisory is non-terminal).
    assert.equal(tasks.getObligation("parent", "child")?.state, "unresolved");
    assert.equal(broadcasts.length, 1);
    // The machine payload is the event; the collaboration body is readable
    // prose (it becomes the parent's prompt text).
    const notice = noticeEventData(store, "child");
    assert.equal(notice.reason, "delivery_failed");
    assert.equal(notice.evidence.deliveryUnavailable, true);
    assert.match(notice.message, /could not deliver/);
    assert.match(broadcasts[0].body, /^reason: delivery_failed$/m);
    assert.match(broadcasts[0].body, /^message: .*could not deliver/m);
    assert.match(broadcasts[0].body, /^openingMessageId: \S+$/m);
    assert.ok(
      broadcasts[0].body.includes(notice.openingMessageId),
      "the readable block names the same opening message as the payload",
    );
    assert.equal(
      broadcasts[0].body.includes('{"'),
      false,
      "a notice body is a readable block, not JSON",
    );
    // Live and replayed rows must agree: the broadcast title comes from the
    // same formatter the persisted twin uses.
    assert.equal(
      broadcasts[0].title,
      persistedCollaboration(store, "child", broadcasts[0].messageId).title,
    );
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

  it("emits one delivery_failed notice when initial delivery keeps failing", async () => {
    seedFamily();
    const broadcasts: Array<{
      messageId: string;
      sourceTaskId: string;
      targetTaskId: string;
      title: string;
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

    assert.equal(tasks.getObligation("parent", "child")?.state, "unresolved");
    // One notice, routed target->stored source with system actor.
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].sourceTaskId, "child");
    assert.equal(broadcasts[0].targetTaskId, "parent");
    // The durable machine fields live in the target's own notice event.
    const notice = noticeEventData(store, "child");
    assert.equal(notice.sourceTaskId, "parent");
    assert.equal(notice.targetTaskId, "child");
    assert.ok(notice.openingMessageId);
    assert.ok(notice.openingDeliveryId);
    assert.equal(notice.reason, "delivery_failed");
    assert.equal(notice.evidence.deliveryUnavailable, true);
    assert.match(notice.message, /could not deliver/);

    // The body is what the parent agent reads: the readable block, delivered
    // verbatim between the delivery's scissor lines.
    const parentPrompt = calls.prompts.find((call) => call.taskId === "parent");
    assert.ok(parentPrompt, "the notice must be delivered to the parent");
    assert.ok(
      parentPrompt.text.includes(broadcasts[0].body),
      "the parent receives the readable block, not the machine payload",
    );
    assert.match(broadcasts[0].body, /^reason: delivery_failed$/m);
    assert.match(broadcasts[0].body, /^message: .*/m);
    assert.equal(broadcasts[0].body.includes('{"'), false);
    assert.equal(
      broadcasts[0].title,
      persistedCollaboration(store, "parent", broadcasts[0].messageId).title,
    );
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
    // The prohibition is scoped to the runtime-injected closing turn, not to
    // the underlying work.
    assert.match(calls.prompts[1].text, /runtime-injected closing turn/i);
    assert.match(
      calls.prompts[1].text,
      /Do not begin new work as part of this closing turn\./,
    );
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

  it("does not remind when the turn carried our cancel request", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    await armDirectDispatch(store, tasks, bridge, "parent", "child");
    // A UI cancel marks the live turn, and the agent may still finish with an
    // ordinary stop reason; the marker is the fact, not the stop reason.
    tasks.state.markCancelRequested("child");
    endTurn(bridge, "child", calls.prompts[0].promptId);
    calls.prompts[0].resolve();
    await flushTimers();

    assert.equal(calls.prompts.length, 1, "a cancelled turn owes no reminder");
    assert.equal(tasks.getObligation("parent", "child")?.state, "open");
  });

  it("reminds again when a later dispatch after a cancellation goes unaccounted", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    await armDirectDispatch(store, tasks, bridge, "parent", "child", "First.");
    endTurn(bridge, "child", calls.prompts[0].promptId, "cancelled");
    calls.prompts[0].resolve();
    await flushTimers();
    assert.equal(calls.prompts.length, 1);

    await armDirectDispatch(store, tasks, bridge, "parent", "child", "Second.");
    // The cancelled intent died with the turn that carried it: the next turn on
    // the same task is a fresh one, not a silent no-reminder turn.
    assert.equal(tasks.getTurn("child")?.cancelRequested, false);
    // This turn ends without an account and was not cancelled: it must remind.
    endTurn(bridge, "child", calls.prompts[1].promptId);
    calls.prompts[1].resolve();
    await flushTimers();

    assert.equal(calls.prompts.length, 3);
    assert.match(calls.prompts[2].text, /task_update\(done/);
    calls.prompts[2].resolve();
    await flushTimers();
  });

  it("treats a turn that ends during the cancel round trip as cancelled", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    await armDirectDispatch(store, tasks, bridge, "parent", "child");

    // The agent finishes the turn with an ordinary stop reason while the cancel
    // request is still on the wire: the intent stamped before the await is the
    // only cancellation fact this boundary will ever see.
    const cancelBridge = {
      cancel: async () => {
        endTurn(bridge, "child", calls.prompts[0].promptId);
      },
    };
    const result = await tasks.cancelTaskExecution("child", cancelBridge, 0);
    calls.prompts[0].resolve();
    await flushTimers();

    assert.equal(result.status, "cancelled");
    assert.equal(
      calls.prompts.length,
      1,
      "a turn ending under a cancel owes no reminder",
    );
    assert.equal(tasks.getObligation("parent", "child")?.state, "open");
  });

  it("fences a reminder whose own turn was cancelled", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    await armDirectDispatch(store, tasks, bridge, "parent", "child");
    endTurn(bridge, "child", calls.prompts[0].promptId);
    calls.prompts[0].resolve();
    await flushTimers();
    // The first closing reminder is in flight.
    assert.equal(calls.prompts.length, 2);
    const reminderPromptId = calls.prompts[1].promptId;

    // Cancel the reminder's own turn, then let it end as a stopped turn does.
    await tasks.cancelTaskExecution("child", { cancel: async () => {} }, 0);
    endTurn(bridge, "child", reminderPromptId);
    calls.prompts[1].resolve();
    await flushTimers();

    const obligation = tasks.getObligation("parent", "child");
    assert.ok(obligation, "the record must still exist");
    assert.equal(obligation.state, "open");
    assert.equal(
      obligation.deliveredAttempts,
      0,
      "a cancelled reminder is not a delivered attempt",
    );
    assert.equal(
      calls.prompts.length,
      2,
      "a cancelled reminder does not re-arm another one",
    );
    const events = store.getEvents("child");
    assert.equal(
      events.some((event) => event.type === "task_outcome_notice"),
      false,
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "system_message" &&
          (JSON.parse(event.data) as { kind?: string }).kind ===
            "handoff_reminder",
      ),
      false,
      "a fenced reminder writes no delivered-attempt row",
    );

    // The debt is still live: a later dispatch that ends without an account
    // reminds again.
    await armDirectDispatch(store, tasks, bridge, "parent", "child", "Retry.");
    endTurn(bridge, "child", calls.prompts[2].promptId);
    calls.prompts[2].resolve();
    await flushTimers();
    assert.equal(calls.prompts.length, 4);
    assert.match(calls.prompts[3].text, /task_update\(done/);
    calls.prompts[3].resolve();
    await flushTimers();
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
    });
    await host.update(
      principalFor(tasks, "child"),
      "done",
      "Everything is verified.",
    );

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
    });
    await host.update(
      principalFor(tasks, "child"),
      "done",
      "Settled from the dispatch turn.",
    );

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
    });
    await host.update(principalFor(tasks, "child"), "done", "Early report.");

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
    });
    await host.update(
      principalFor(tasks, "child"),
      "done",
      "Stored-source account.",
    );

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
    });
    // The sibling delivery queues behind the live dispatch turn.
    await host.send(
      principalFor(tasks, "sibling"),
      "child",
      "A sibling note that settles nothing.",
    );

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
    store.attachAgentSession(
      store.ensureRootTask("/tmp").id,
      "test-agent",
      "agent-root",
    );
    store.createTask(
      "source",
      "/tmp",
      "agent",
      "test-agent",
      "agent-source",
      "root",
    );
    store.createTask(
      "target",
      "/tmp",
      "agent",
      "test-agent",
      "agent-target",
      "root",
    );
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

    const drained = await tasks.drainCollaborationDeliveries("target", bridge);

    assert.equal(drained, false);
    assert.equal(calls.prompts.length, 0);
    assert.equal(
      store.getCollaborationDelivery("active-delivery")?.status,
      "queued",
    );
  });

  it("does not remind for a user-started turn", async () => {
    store.createTask("manual", "/tmp", "auto", "test-agent", "agent-manual");
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

  it("does not remind when the dispatch turn was cancelled", async () => {
    seedFamily();
    const { bridge, calls } = createControllableBridge();
    await armDirectDispatch(store, tasks, bridge, "parent", "child");
    endTurn(bridge, "child", calls.prompts[0].promptId, "cancelled");
    calls.prompts[0].resolve();
    await flushTimers();

    // A turn stopped on purpose is not a missing account: no closing reminder,
    // no notice, and the record stays open for the next dispatch.
    assert.equal(calls.prompts.length, 1, "a cancelled turn owes no reminder");
    assert.equal(tasks.getObligation("parent", "child")?.state, "open");
    const events = store.getEvents("child");
    assert.equal(
      events.some((event) => event.type === "task_outcome_notice"),
      false,
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "system_message" &&
          (JSON.parse(event.data) as { kind?: string }).kind ===
            "handoff_reminder",
      ),
      false,
    );
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
    // The prohibition is scoped to the runtime-injected closing turn, not to
    // the underlying work.
    assert.match(calls.prompts[1].text, /runtime-injected closing turn/i);
    assert.match(
      calls.prompts[1].text,
      /Do not begin new work as part of this closing turn\./,
    );
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
    });
    await host.update(principalFor(tasks, "child"), "done", "done");
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    tasks.activePrompts.add("s1");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "prompt_done",
        taskId: "s1",
        stopReason: "end_turn",
        promptId: "prompt-7",
      }) as any,
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    tasks.activePrompts.add("s1");
    tasks.syncBusy("s1");
    const livePromptId =
      tasks.state.getState("s1").runtime.busy?.promptId ?? null;
    assert.ok(livePromptId, "precondition: the live turn has an identity");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "prompt_done",
        taskId: "s1",
        stopReason: "end_turn",
        promptId: "prompt-superseded",
      }) as any,
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    tasks.activePrompts.add("s1");
    tasks.syncBusy("s1");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "error",
        taskId: "s1",
        message: "agent blew up",
        promptId: "prompt-superseded",
      }) as any,
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    tasks.activePrompts.add("s1");
    tasks.syncBusy("s1");
    const livePromptId =
      tasks.state.getState("s1").runtime.busy?.promptId ?? undefined;
    assert.ok(livePromptId, "precondition: the live turn has an identity");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "error",
        taskId: "s1",
        message: "agent blew up",
        promptId: livePromptId,
      }) as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.equal(tasks.activePrompts.has("s1"), false);
  });

  it("keeps runtime plan across prompt_done for cross-turn work", () => {
    store.createTask("s1", "/tmp", "auto", "test-agent");
    const plan = [{ content: "Continue later", status: "in_progress" }];
    tasks.state.patch("s1", { runtime: { plan } });
    tasks.activePrompts.add("s1");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "prompt_done",
        taskId: "s1",
        stopReason: "end_turn",
      }) as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.deepEqual(tasks.state.getState("s1").runtime.plan, plan);
  });

  it("clears runtime plans when the agent disconnects", () => {
    store.createTask("s1", "/tmp", "auto", "test-agent");
    tasks.state.patch("s1", {
      runtime: {
        plan: [{ content: "Interrupted work", status: "in_progress" }],
      },
    });
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      withLease({ type: "agent_disconnected", error: "agent exited" }) as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.equal(tasks.state.getState("s1").runtime.plan, null);
  });

  it("clears context usage when the agent disconnects", () => {
    store.createTask("s1", "/tmp", "auto", "test-agent");
    tasks.state.patch("s1", {
      runtime: { contextUsage: { used: 61_234, size: 272_000 } },
    });
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      withLease({ type: "agent_disconnected", agentId: "test-agent" }) as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.equal(tasks.state.getState("s1").runtime.contextUsage, null);
  });

  it("clears streaming state when the agent disconnects", () => {
    store.createTask("s1", "/tmp", "auto", "test-agent");
    tasks.state.patch("s1", {
      runtime: {
        streaming: { assistant: true, thinking: true },
      },
    });
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      withLease({ type: "agent_disconnected", error: "agent exited" }) as any,
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();
    const configOptions = [
      { id: "model", name: "Model", currentValue: "gpt-4", options: [] },
    ];

    handleAgentEvent(
      withLease({ type: "task_created", taskId: "s1", configOptions }) as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.deepEqual(tasks.cachedConfigOptions, configOptions);
    assert.equal(store.getTask("s1")?.model, "gpt-4");
    const created = broadcasted.find((event) => event.type === "task_created");
    assert.equal(created?.rootTaskId, store.rootTaskId);
  });

  it("fills the parent binding on a task_created that omitted it", () => {
    store.ensureRootTask("/tmp");
    store.createTask("parent", "/tmp", "auto", "agent-a");
    store.createTask(
      "child",
      "/tmp",
      "auto",
      "agent-b",
      "child-session",
      "parent",
    );
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "task_created",
        taskId: "child",
        agentId: "agent-b",
        configOptions: [],
      }) as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    const created = broadcasted.find((event) => event.type === "task_created");
    assert.ok(created, "the event is broadcast");
    assert.equal(created.parentId, "parent");
    assert.equal(created.parentAgentId, "agent-a");
  });

  it("skips events for restoring tasks", () => {
    store.createTask("s1", "/tmp", "auto", "test-agent");
    tasks.restoringTasks.add("s1");
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      withLease({ type: "message_chunk", taskId: "s1", text: "hidden" }) as any,
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    tasks.restoringTasks.add("s1");
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "usage_update",
        taskId: "s1",
        used: 61_234,
        size: 272_000,
      }),
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    tasks.restoringTasks.add("s1");
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "available_commands_update",
        taskId: "s1",
        commands: [
          {
            name: "compact",
            description: "Compact conversation",
            input: { hint: "focus instructions" },
          },
        ],
      }),
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "available_commands_update",
        taskId: "s1",
        commands: [{ name: "context", description: "Show context usage" }],
      }),
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    tasks.updateAgentCommands("s1", [
      { name: "context", description: "Show context usage" },
    ]);
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();
    // The broadcast is emitted before the teardown resets process state, so it
    // carries the outgoing epoch; a fresh epoch is what lets the client accept
    // the next snapshot's lower revision.
    const epochBefore = tasks.getAgentCommands("s1").epoch;

    handleAgentEvent(
      withLease({ type: "agent_disconnected", agentId: "test-agent" }),
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.deepEqual(broadcasted, [
      {
        type: "available_commands_update",
        taskId: "s1",
        epoch: epochBefore,
        revision: 2,
        commands: [],
      },
      { type: "agent_disconnected", agentId: "test-agent" },
    ]);
    // After the teardown a new epoch starts a fresh revision space.
    assert.notEqual(tasks.getAgentCommands("s1").epoch, epochBefore);
  });

  it("persists error events with their turn identity", () => {
    store.createTask("s1", "/tmp", "auto", "test-agent");
    tasks.activePrompts.add("s1");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "error",
        taskId: "s1",
        message: "provider failed",
        promptId: "prompt-7",
      }) as any,
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    tasks.activePrompts.add("s1");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "error",
        taskId: "s1",
        message: "something failed",
      }) as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );

    assert.equal(tasks.activePrompts.has("s1"), false);
  });

  it("flushes content and clears streaming state on error events", () => {
    store.createTask("s1", "/tmp", "auto", "test-agent");
    tasks.appendAssistant("s1", "partial answer");
    tasks.state.patch("s1", {
      runtime: {
        streaming: { assistant: true, thinking: false },
      },
    });
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "error",
        taskId: "s1",
        message: "something failed",
      }) as any,
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    store.updateTaskConfig("s1", "mode", "agent#autopilot");
    const { bridge, calls } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "permission_request",
        taskId: "s1",
        requestId: "req1",
        title: "Run command",
        options: [
          { optionId: "allow_once", kind: "allow_once", label: "Allow once" },
          { optionId: "deny", kind: "deny", label: "Deny" },
        ],
      }) as any,
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    store.updateTaskConfig("s1", "mode", "bypassPermissions");
    const { bridge, calls } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "permission_request",
        taskId: "s1",
        requestId: "req1",
        title: "Run command",
        options: [
          { optionId: "allow_once", kind: "allow_once", label: "Allow once" },
          { optionId: "deny", kind: "deny", label: "Deny" },
        ],
      }) as any,
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
      store.createTask("s_" + mode, "/tmp", "auto", "test-agent");
      store.updateTaskConfig("s_" + mode, "mode", mode);
      const { bridge, calls } = createMockBridge();
      const { sseManager, broadcasted } = createMockSseManager();

      handleAgentEvent(
        withLease({
          type: "permission_request",
          taskId: "s_" + mode,
          requestId: "req_" + mode,
          title: "Run command",
          options: [
            { optionId: "allow_once", kind: "allow_once", label: "Allow once" },
            { optionId: "deny", kind: "deny", label: "Deny" },
          ],
        }) as any,
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    store.updateTaskConfig("s1", "mode", "agent");
    const { bridge, calls } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      withLease({
        type: "permission_request",
        taskId: "s1",
        requestId: "req1",
        title: "Run command",
        options: [
          { optionId: "allow_once", kind: "allow_once", label: "Allow once" },
          { optionId: "deny", kind: "deny", label: "Deny" },
        ],
      }) as any,
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
    store.createTask("s1", "/tmp", "auto", "test-agent");
    store.updateTaskConfig("s1", "mode", "agent#autopilot");
    const { bridge, calls } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      withLease({
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
      }) as any,
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

  // --- Turn-origin authorization (P5-b) ---

  /** Open a real turn so `getTurn` reports the origin the permission path reads. */
  function beginTurn(
    taskId: string,
    origin: "delegated" | "interactive",
  ): string {
    tasks.beginAgentTurn(taskId, { origin });
    const promptId = tasks.getTurn(taskId)?.promptId ?? null;
    assert.ok(promptId, "an open turn projects a prompt id");
    return promptId;
  }

  /** Drive one permission request through the real handler. */
  function emitPermission(
    event: Record<string, unknown>,
    config = makeEventHandlerConfig(),
  ) {
    const { bridge, calls } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();
    handleAgentEvent(
      withLease(event) as any,
      tasks,
      store,
      bridge,
      config,
      sseManager as any,
    );
    return { calls, broadcasted };
  }

  function storedPermissionResponses(taskId: string) {
    return store
      .getEvents(taskId)
      .filter((event) => event.type === "permission_response")
      .map((event) => ({
        from_ref: event.from_ref,
        data: JSON.parse(event.data) as Record<string, unknown>,
      }));
  }

  it("answers a delegated turn's request with allow_once", () => {
    store.createTask("s1", "/tmp", "auto", "test-agent");
    beginTurn("s1", "delegated");
    const { calls, broadcasted } = emitPermission({
      type: "permission_request",
      taskId: "s1",
      requestId: "req1",
      title: "Run command",
      options: [
        { optionId: "allow_once", kind: "allow_once", label: "Allow once" },
        {
          optionId: "allow_always",
          kind: "allow_always",
          label: "Allow always",
        },
      ],
    });

    assert.deepEqual(calls.resolvePermission, [
      { requestId: "req1", optionId: "allow_once" },
    ]);
    assert.deepEqual(calls.denyPermission, []);
    // Same shape as the mode gate: the request is visible, then collapsed.
    assert.deepEqual(
      broadcasted.map((event) => event.type),
      ["permission_request", "permission_response"],
    );
    assert.deepEqual(storedPermissionResponses("s1"), [
      {
        from_ref: "system",
        data: {
          requestId: "req1",
          optionName: "Allow once",
          denied: false,
        },
      },
    ]);
  });

  it("follows the delegated answer matrix and never picks a reject option", () => {
    store.createTask("s1", "/tmp", "auto", "test-agent");
    beginTurn("s1", "delegated");
    const rows: Array<{
      name: string;
      options: Array<{ optionId: string; kind: string; label: string }>;
      resolved: string | null;
      reason?: string;
      optionName: string;
    }> = [
      {
        name: "only allow_always",
        options: [
          {
            optionId: "allow_always",
            kind: "allow_always",
            label: "Allow always",
          },
          { optionId: "reject_once", kind: "reject_once", label: "Reject" },
        ],
        resolved: "allow_always",
        optionName: "Allow always",
      },
      {
        name: "reject options only",
        options: [
          { optionId: "reject_once", kind: "reject_once", label: "Reject" },
          {
            optionId: "reject_always",
            kind: "reject_always",
            label: "Reject always",
          },
        ],
        resolved: null,
        reason: "no_allow_option",
        optionName: "cancelled",
      },
      {
        name: "no options at all",
        options: [],
        resolved: null,
        reason: "no_options",
        optionName: "cancelled",
      },
    ];

    for (const [index, row] of rows.entries()) {
      const requestId = `req_${index}`;
      const { calls } = emitPermission({
        type: "permission_request",
        taskId: "s1",
        requestId,
        title: row.name,
        options: row.options,
      });

      assert.deepEqual(
        calls.resolvePermission.map((call) => call.optionId),
        row.resolved === null ? [] : [row.resolved],
        `${row.name}: a reject option must never be selected`,
      );
      assert.deepEqual(
        calls.denyPermission,
        row.resolved === null ? [requestId] : [],
        `${row.name}: no allow option cancels the ACP request`,
      );
      const stored = storedPermissionResponses("s1").at(-1);
      assert.ok(stored, `${row.name}: the answer must be recorded`);
      assert.equal(stored.from_ref, "system");
      assert.deepEqual(stored.data, {
        requestId,
        optionName: row.optionName,
        denied: row.resolved === null,
        ...(row.reason ? { reason: row.reason } : {}),
      });
    }
  });

  it("still prompts in a human turn's default mode", () => {
    store.createTask("s1", "/tmp", "auto", "test-agent");
    store.updateTaskConfig("s1", "mode", "agent");
    beginTurn("s1", "interactive");
    const { calls, broadcasted } = emitPermission({
      type: "permission_request",
      taskId: "s1",
      requestId: "req1",
      title: "Run command",
      options: [
        { optionId: "allow_once", kind: "allow_once", label: "Allow once" },
        {
          optionId: "allow_always",
          kind: "allow_always",
          label: "Allow always",
        },
      ],
    });

    assert.deepEqual(calls.resolvePermission, []);
    assert.deepEqual(calls.denyPermission, []);
    assert.deepEqual(
      broadcasted.map((event) => event.type),
      ["permission_request"],
    );
    assert.deepEqual(storedPermissionResponses("s1"), []);
  });

  it("gives our own MCP tools no privilege in a human turn", () => {
    store.createTask("s1", "/tmp", "auto", "test-agent");
    store.updateTaskConfig("s1", "mode", "agent");
    beginTurn("s1", "interactive");
    const { calls, broadcasted } = emitPermission({
      type: "permission_request",
      taskId: "s1",
      requestId: "req1",
      title: "mcp__lelouchhe_webagent__task_query",
      toolKind: "other",
      toolName: "mcp__lelouchhe_webagent__task_query",
      options: [
        { optionId: "allow_once", kind: "allow_once", label: "Allow once" },
      ],
    });

    // A tool we injected is a tool like any other: the human turn asks.
    assert.deepEqual(calls.resolvePermission, []);
    assert.deepEqual(calls.denyPermission, []);
    assert.deepEqual(
      broadcasted.map((event) => event.type),
      ["permission_request"],
    );
  });

  it("requires a live turn, not a delegated origin that already ended", () => {
    store.createTask("s1", "/tmp", "auto", "test-agent");
    const promptId = beginTurn("s1", "delegated");
    tasks.endTurn("s1", { promptId, recoveryOrigin: "prompt_done" });
    const { calls, broadcasted } = emitPermission({
      type: "permission_request",
      taskId: "s1",
      requestId: "req1",
      title: "Run command",
      options: [
        { optionId: "allow_once", kind: "allow_once", label: "Allow once" },
      ],
    });

    // Both halves of the condition are required: the slot is not live, so the
    // human-turn rules apply and the request waits for a person.
    assert.deepEqual(calls.resolvePermission, []);
    assert.deepEqual(calls.denyPermission, []);
    assert.deepEqual(
      broadcasted.map((event) => event.type),
      ["permission_request"],
    );
  });

  describe("attachment read same-turn guard", () => {
    function seedAttachmentRead() {
      store.createTask("s1", "/tmp", "auto", "test-agent");
      const path = join(tmpDir, "note.txt");
      writeFileSync(path, "hello");
      store.insertAttachment({
        id: "att1",
        taskId: "s1",
        kind: "file",
        name: "note.txt",
        mime: "text/plain",
        size: 5,
        realpath: realpathSync(path),
      });
      const counters = createCounters();
      const request = {
        type: "permission_request",
        taskId: "s1",
        requestId: "req1",
        title: "Read file",
        toolKind: "read",
        toolName: "view",
        locations: [{ path }],
        rawInput: { path },
        options: [
          { optionId: "allow_once", kind: "allow_once", label: "Allow once" },
        ],
      };
      return {
        counters,
        config: makeEventHandlerConfig({
          attachmentInterceptor: { counters },
        }),
        request,
      };
    }

    it("approves inside the turn it arrived in", async () => {
      const { counters, config, request } = seedAttachmentRead();
      beginTurn("s1", "interactive");
      const { calls } = emitPermission(request, config);

      await waitFor(() => calls.resolvePermission.length === 1);
      assert.deepEqual(calls.resolvePermission, [
        { requestId: "req1", optionId: "allow_once" },
      ]);
      assert.equal(counters.autoAllowed, 1);
      assert.equal(storedPermissionResponses("s1").length, 1);
    });

    it("refuses once the turn has ended", async () => {
      const { counters, config, request } = seedAttachmentRead();
      const promptId = beginTurn("s1", "interactive");
      const { calls } = emitPermission(request, config);

      // The realpath work is still in flight; the turn ends first.
      tasks.endTurn("s1", { promptId, recoveryOrigin: "prompt_done" });
      await waitFor(() => counters.autoAllowed === 1);
      await flushTimers();

      assert.deepEqual(calls.resolvePermission, []);
      assert.deepEqual(calls.denyPermission, []);
      assert.deepEqual(storedPermissionResponses("s1"), []);
    });

    it("refuses once the turn was superseded", async () => {
      const { counters, config, request } = seedAttachmentRead();
      const promptId = beginTurn("s1", "interactive");
      const { calls } = emitPermission(request, config);

      tasks.endTurn("s1", { promptId, recoveryOrigin: "prompt_done" });
      beginTurn("s1", "interactive");
      await waitFor(() => counters.autoAllowed === 1);
      await flushTimers();

      assert.deepEqual(calls.resolvePermission, []);
      assert.deepEqual(storedPermissionResponses("s1"), []);
    });

    it("leaves the request for a person when no turn is live at arrival", async () => {
      const { counters, config, request } = seedAttachmentRead();
      // The request arrives with the task idle: there is no turn identity to
      // re-check, and none appears before the realpath work finishes.
      assert.equal(tasks.getTurn("s1"), null);
      const { calls } = emitPermission(request, config);

      // The realpath work really ran and matched; only the turn guard holds
      // the answer back.
      await waitFor(() => counters.autoAllowed === 1);
      await flushTimers();

      assert.deepEqual(calls.resolvePermission, []);
      assert.deepEqual(calls.denyPermission, []);
      assert.deepEqual(storedPermissionResponses("s1"), []);
      assert.equal(
        tasks.pendingPermissions.has("req1"),
        true,
        "the pending request is left for a person",
      );
    });

    it("leaves the request for a person when the live turn has no prompt id", async () => {
      const { counters, config, request } = seedAttachmentRead();
      // Membership without a projected agent prompt: `getTurn` exists but
      // carries no identity that can be compared.
      tasks.activePrompts.add("s1");
      assert.equal(tasks.getTurn("s1")?.promptId, null);
      const { calls } = emitPermission(request, config);

      await waitFor(() => counters.autoAllowed === 1);
      await flushTimers();

      assert.deepEqual(calls.resolvePermission, []);
      assert.deepEqual(calls.denyPermission, []);
      assert.deepEqual(storedPermissionResponses("s1"), []);
      assert.equal(tasks.pendingPermissions.has("req1"), true);
    });
  });

  // --- Execution write lease ---
  describe("execution write lease", () => {
    function leaseFor(taskId: string) {
      const lease = tasks.authority.leaseFor(taskId);
      assert.ok(lease, "the task must have a current generation");
      return lease;
    }

    it("refuses an event stamped with a replaced generation", () => {
      store.createTask("s1", "/tmp", "auto", "test-agent");
      const stale = leaseFor("s1");
      // A rotation advances the task's generation; the old execution's writes
      // are no longer welcome.
      store.replaceAgentSession("s1", "test-agent", "agent-2");
      assert.equal(leaseFor("s1").generation, stale.generation + 1);

      const { bridge } = createMockBridge();
      const { sseManager, broadcasted } = createMockSseManager();
      handleAgentEvent(
        Object.assign(
          { type: "message_chunk", taskId: "s1", text: "late tail" },
          { executionLease: stale },
        ) as any,
        tasks,
        store,
        bridge,
        makeEventHandlerConfig(),
        sseManager as any,
      );

      assert.equal(broadcasted.length, 0);
      assert.equal(tasks.assistantBuffers.has("s1"), false);
      assert.equal(store.getEvents("s1").length, 0);
      assert.equal(tasks.getLastAgentActivityAt("s1"), null);
    });

    it("refuses an event with no lease once the task has a current execution", () => {
      store.createTask("s1", "/tmp", "auto", "test-agent");
      leaseFor("s1");
      const { bridge } = createMockBridge();
      const { sseManager, broadcasted } = createMockSseManager();

      handleAgentEvent(
        { type: "message_chunk", taskId: "s1", text: "unstamped" } as any,
        tasks,
        store,
        bridge,
        makeEventHandlerConfig(),
        sseManager as any,
      );

      assert.equal(broadcasted.length, 0);
      assert.equal(tasks.assistantBuffers.has("s1"), false);
    });

    it("refuses an unstamped event even when the task has no ledger entry", () => {
      store.createTask("s1", "/tmp", "auto", "test-agent");
      // A missing ledger entry is not evidence of permission: an unstamped
      // task-addressing event is refused either way.
      tasks.authority.clear("s1");
      assert.equal(tasks.authority.leaseFor("s1"), null);
      const { bridge } = createMockBridge();
      const { sseManager, broadcasted } = createMockSseManager();

      handleAgentEvent(
        { type: "message_chunk", taskId: "s1", text: "unstamped" } as any,
        tasks,
        store,
        bridge,
        makeEventHandlerConfig(),
        sseManager as any,
      );

      assert.equal(broadcasted.length, 0);
      assert.equal(tasks.assistantBuffers.has("s1"), false);
      assert.equal(store.getEvents("s1").length, 0);
    });

    it("refuses an unknown generation, never falling back to the current one", () => {
      store.createTask("s1", "/tmp", "auto", "test-agent");
      leaseFor("s1");
      const { bridge } = createMockBridge();
      const { sseManager, broadcasted } = createMockSseManager();

      handleAgentEvent(
        Object.assign(
          { type: "message_chunk", taskId: "s1", text: "unknown" },
          { executionLease: { taskId: "s1", generation: 999 } },
        ) as any,
        tasks,
        store,
        bridge,
        makeEventHandlerConfig(),
        sseManager as any,
      );

      assert.equal(broadcasted.length, 0);
      assert.equal(tasks.assistantBuffers.has("s1"), false);
    });

    it("refuses a lease that names another task", () => {
      store.createTask("s1", "/tmp", "auto", "test-agent");
      store.createTask("s2", "/tmp", "auto", "test-agent");
      const other = leaseFor("s2");
      const { bridge } = createMockBridge();
      const { sseManager, broadcasted } = createMockSseManager();

      handleAgentEvent(
        Object.assign(
          { type: "message_chunk", taskId: "s1", text: "crossed" },
          { executionLease: other },
        ) as any,
        tasks,
        store,
        bridge,
        makeEventHandlerConfig(),
        sseManager as any,
      );

      assert.equal(broadcasted.length, 0);
      assert.equal(tasks.assistantBuffers.has("s1"), false);
    });
  });
});
