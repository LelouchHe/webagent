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
 * Bridge whose ACP session must be resumed before it can accept a prompt,
 * mirroring the real lazy-restore contract instead of silently accepting a
 * prompt for an unloaded session.
 */
function createLazySessionBridge() {
  let resumed = false;
  const calls = {
    loadSession: 0,
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
        calls.loadSession++;
        resumed = true;
        return { taskId, configOptions: [] };
      },
      async prompt(
        taskId: string,
        text: string,
        _attachments?: unknown,
        promptId?: string,
      ) {
        if (!resumed) throw new Error("session not live");
        calls.prompts.push({ taskId, text, promptId });
      },
    } as any,
    calls,
    isResumed: () => resumed,
  };
}

async function startCollaborationTurn(
  store: Store,
  tasks: TaskManager,
  bridge: Parameters<TaskManager["drainCollaborationDeliveries"]>[0],
  body = "Continue the assigned work.",
): Promise<string> {
  store.createTask("root", "/tmp", "root", "agent-root");
  store.createTask("source", "/tmp", "agent", "agent-source", "root");
  // `source` is deliberately `target`'s parent: a collaboration-caused turn
  // owes a handoff only when the claimed batch includes the Task's parent.
  store.createTask("target", "/tmp", "agent", "agent-target", "source");
  tasks.liveTasks.add("target");
  store.createCollaborationMessage({
    id: "message-1",
    deliveryId: "delivery-1",
    sourceTaskId: "source",
    directTargetTaskId: "target",
    sourceActor: "agent",
    body,
    createdAt: Date.now(),
  });
  assert.equal(
    await tasks.drainCollaborationDeliveries(bridge, "target"),
    true,
  );
  return "target";
}

/**
 * Start a turn the way the prompt route does: fix the handoff obligation before
 * the turn is marked busy. Returns the turn's prompt id.
 */
function startUserTurn(tasks: TaskManager, taskId: string): string | undefined {
  tasks.recordHandoffObligation(taskId);
  tasks.activePrompts.add(taskId);
  tasks.syncBusy(taskId);
  return tasks.state.getState(taskId).runtime.busy?.promptId ?? undefined;
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

  it("reminds a running collaboration task to send a lifecycle handoff", async () => {
    const { bridge, calls } = createMockBridge();
    const taskId = await startCollaborationTurn(store, tasks, bridge);
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      {
        type: "prompt_done",
        taskId,
        promptId: calls.prompts[0].promptId,
        stopReason: "end_turn",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(store.getTask(taskId)?.workflow_status, "idle");
    assert.equal(calls.prompts.length, 2);
    assert.match(
      calls.prompts[1].text,
      /task_update\(done|task_update\(blocked/,
    );
    assert.ok(
      store
        .getEvents(taskId)
        .some(
          (event) =>
            event.type === "system_message" &&
            JSON.parse(event.data).kind === "handoff_reminder",
        ),
    );
  });

  it("does not remind again when the handoff reminder itself ends", async () => {
    const { bridge, calls } = createMockBridge();
    const taskId = await startCollaborationTurn(store, tasks, bridge);
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      {
        type: "prompt_done",
        taskId,
        promptId: calls.prompts[0].promptId,
        stopReason: "end_turn",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls.prompts.length, 2);

    handleAgentEvent(
      {
        type: "prompt_done",
        taskId,
        promptId: calls.prompts[1].promptId,
        stopReason: "end_turn",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(calls.prompts.length, 2);
  });

  it("cleans up the reminder turn when the bridge rejects it", async () => {
    const { bridge, calls } = createMockBridge([
      undefined,
      new Error("bridge unavailable"),
    ]);
    const taskId = await startCollaborationTurn(store, tasks, bridge);
    const { sseManager } = createMockSseManager();

    const lines: string[] = [];
    const previousLevel = getLogLevel();
    setLogLevel("debug");
    setLogSink((_stream, line) => lines.push(line));
    try {
      handleAgentEvent(
        {
          type: "prompt_done",
          taskId,
          promptId: calls.prompts[0].promptId,
          stopReason: "end_turn",
        } as any,
        tasks,
        store,
        bridge,
        makeEventHandlerConfig(),
        sseManager as any,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      setLogSink(null);
      setLogLevel(previousLevel);
    }

    assert.equal(calls.prompts.length, 2);
    assert.equal(tasks.activePrompts.has(taskId), false);
    assert.equal(tasks.getBusyKind(taskId), null);
    assert.equal(store.getTask(taskId)?.workflow_status, "idle");
    // A failed reminder retires the debt instead of restoring it: there is no
    // other trigger for a finished turn, and restoring would re-enter through
    // the error event as an async retry loop.
    assert.equal(tasks.owesHandoff(taskId), false);
    assert.ok(
      lines.some(
        (line) =>
          line.includes("handoff reminder failed") &&
          line.includes('"obligationRetired":true'),
      ),
      "the failed reminder must record that the debt is retired",
    );
  });

  it("does not remind a user-created task after collaboration input", async () => {
    store.createTask("root", "/tmp", "root", "agent-root");
    store.createTask("source", "/tmp", "agent", "agent-source", "root");
    store.createTask("manual", "/tmp", "auto", "agent-manual", "root");
    tasks.liveTasks.add("manual");
    store.createCollaborationMessage({
      id: "message-1",
      deliveryId: "delivery-1",
      sourceTaskId: "source",
      directTargetTaskId: "manual",
      sourceActor: "agent",
      body: "Important result for the user-owned task.",
      createdAt: Date.now(),
    });
    const { bridge, calls } = createMockBridge();
    const taskId = "manual";
    await tasks.drainCollaborationDeliveries(bridge, taskId);
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      {
        type: "prompt_done",
        taskId,
        promptId: calls.prompts[0].promptId,
        stopReason: "end_turn",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(calls.prompts.length, 1);
    assert.equal(store.getTask(taskId)?.workflow_status, "idle");
  });

  // Acceptance (a): the obligation comes from the Task, not from how the turn
  // started. A user-prompted turn on an agent-created Task owes a handoff.
  it("submits a reminder while a user bash command is still running", async () => {
    store.createTask("child", "/tmp", "agent", "agent-child");
    const { bridge, calls } = createMockBridge();
    const { sseManager } = createMockSseManager();
    const promptId = startUserTurn(tasks, "child");
    // The REST bash route permits this orthogonal user process alongside ACP
    // work. Keeping the fake process in the map proves the reminder is sent
    // while Bash remains active, not after it has finished.
    tasks.runningBashProcs.set("child", {} as any);
    const lines: string[] = [];
    const previousLevel = getLogLevel();
    setLogLevel("debug");
    setLogSink((_stream, line) => lines.push(line));
    try {
      handleAgentEvent(
        {
          type: "prompt_done",
          taskId: "child",
          promptId,
          stopReason: "end_turn",
        } as any,
        tasks,
        store,
        bridge,
        makeEventHandlerConfig(),
        sseManager as any,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      setLogSink(null);
      setLogLevel(previousLevel);
    }

    // This fails if the reminder gate still rejects every non-null
    // getBusyKind(), which is the regression this test protects.
    assert.equal(calls.prompts.length, 1);
    // This fails if the Bash exception is silent or is incorrectly logged as a
    // skipped busy reminder instead of recording the allowed overlap.
    assert.ok(
      lines.some((line) =>
        line.includes("handoff reminder allowed during bash"),
      ),
      "parallel Bash allowance must be diagnosable",
    );
    assert.equal(tasks.runningBashProcs.has("child"), true);

    tasks.runningBashProcs.delete("child");
  });

  it("keeps the reminder blocked by an active ACP prompt", async () => {
    store.createTask("child", "/tmp", "agent", "agent-child");
    const { bridge, calls } = createMockBridge();
    tasks.recordHandoffObligation("child");
    // A new ACP prompt is the busy condition the reminder must still reject.
    tasks.activePrompts.add("child");

    const submitted = await tasks.promptHandoffReminder(bridge, "child");

    // This fails if the narrowed gate accidentally permits all busy kinds.
    assert.equal(submitted, false);
    assert.equal(calls.prompts.length, 0);
  });

  it("reminds an agent task whose turn was started by a user prompt", async () => {
    store.createTask("child", "/tmp", "agent", "agent-child");
    const { bridge, calls } = createMockBridge();
    const { sseManager } = createMockSseManager();
    const promptId = startUserTurn(tasks, "child");

    handleAgentEvent(
      {
        type: "prompt_done",
        taskId: "child",
        promptId,
        stopReason: "end_turn",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(calls.prompts.length, 1);
    assert.match(calls.prompts[0].text, /Task Handoff Required/);
  });

  // Review F1: the reminder is the only prompt path that used to skip
  // ensureResumed. Without it a non-live session rejects the prompt while the
  // obligation is already retired, so the handoff is lost silently.
  it("resumes a non-live session before submitting the handoff reminder", async () => {
    store.createTask("child", "/tmp", "agent", "agent-child");
    const { bridge, calls, isResumed } = createLazySessionBridge();
    const { sseManager } = createMockSseManager();
    const promptId = startUserTurn(tasks, "child");
    assert.equal(tasks.liveTasks.has("child"), false);
    assert.equal(calls.loadSession, 0);

    handleAgentEvent(
      {
        type: "prompt_done",
        taskId: "child",
        promptId,
        stopReason: "end_turn",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(isResumed(), true);
    assert.equal(calls.loadSession, 1);
    assert.equal(tasks.liveTasks.has("child"), true);
    assert.equal(calls.prompts.length, 1);
    assert.match(calls.prompts[0].text, /Task Handoff Required/);
  });

  // Acceptance (b): cancellation no longer drops the handoff. It changes what
  // the reminder asks for, not whether the parent must learn the outcome.
  it("reminds a cancelled agent-task turn and forbids resuming work", async () => {
    store.createTask("child", "/tmp", "agent", "agent-child");
    const { bridge, calls } = createMockBridge();
    const { sseManager } = createMockSseManager();
    const promptId = startUserTurn(tasks, "child");

    handleAgentEvent(
      {
        type: "prompt_done",
        taskId: "child",
        promptId,
        stopReason: "cancelled",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(calls.prompts.length, 1);
    assert.match(calls.prompts[0].text, /Task Handoff Required/);
    assert.match(calls.prompts[0].text, /cancelled/);
    assert.doesNotMatch(calls.prompts[0].text, /Continue the work/);
  });

  // Acceptance (b) corollary: the old idle prerequisite silently dropped this
  // case too — a blocked child that is woken and ends without re-handing off
  // leaves the parent unaware unless the reminder fires while non-idle.
  it("reminds a woken blocked agent task that ends without a handoff", async () => {
    store.createTask("child", "/tmp", "agent", "agent-child");
    const { bridge, calls } = createMockBridge();
    const { sseManager } = createMockSseManager();
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => bridge,
    });
    await host.update("child", "blocked", "waiting on a decision");
    const promptId = startUserTurn(tasks, "child");

    handleAgentEvent(
      {
        type: "prompt_done",
        taskId: "child",
        promptId,
        stopReason: "end_turn",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(store.getTask("child")?.workflow_status, "blocked");
    assert.equal(calls.prompts.length, 1);
    assert.match(calls.prompts[0].text, /Task Handoff Required/);
  });

  // Acceptance (c): a user-created Task never owes, even though a user prompt
  // may start its turn.
  it("does not remind a user-created task whose user turn ends", async () => {
    store.createTask("manual", "/tmp", "auto", "agent-manual");
    const { bridge, calls } = createMockBridge();
    const { sseManager } = createMockSseManager();
    const promptId = startUserTurn(tasks, "manual");

    handleAgentEvent(
      {
        type: "prompt_done",
        taskId: "manual",
        promptId,
        stopReason: "end_turn",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(calls.prompts.length, 0);
  });

  // Decision 7: skips were invisible, which is why the miss needed manual
  // cross-task comparison. Every decision now names its gate inputs.
  it("logs each handoff decision with its gate inputs", async () => {
    store.createTask("manual", "/tmp", "auto", "agent-manual");
    store.createTask("child", "/tmp", "agent", "agent-child");
    const { bridge } = createMockBridge();
    const { sseManager } = createMockSseManager();
    const manualPromptId = startUserTurn(tasks, "manual");
    const childPromptId = startUserTurn(tasks, "child");
    const lines: string[] = [];
    const previousLevel = getLogLevel();
    setLogLevel("debug");
    setLogSink((_stream, line) => lines.push(line));
    try {
      for (const [taskId, promptId] of [
        ["manual", manualPromptId],
        ["child", childPromptId],
      ] as const) {
        handleAgentEvent(
          {
            type: "prompt_done",
            taskId,
            promptId,
            stopReason: "end_turn",
          } as any,
          tasks,
          store,
          bridge,
          makeEventHandlerConfig(),
          sseManager as any,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      setLogSink(null);
      setLogLevel(previousLevel);
    }

    const skipped = lines.find(
      (line) =>
        line.includes("handoff reminder skipped") &&
        line.includes('"taskId":"manual"'),
    );
    assert.ok(skipped, "the skip must be recorded");
    assert.match(skipped, /"owesHandoff":false/);
    assert.match(skipped, /"reason":"no_obligation"/);
    assert.ok(
      lines.some(
        (line) =>
          line.includes("handoff reminder issued") &&
          line.includes('"taskId":"child"'),
      ),
      "the reminder must be recorded",
    );
  });

  // Acceptance (e): a claimed delivery wins the turn, and the debt survives
  // into the next turn the drain itself starts.
  it("delivers queued collaboration before reminding while bash runs", async () => {
    store.createTask("root", "/tmp", "root", "agent-root");
    store.createTask("source", "/tmp", "agent", "agent-source", "root");
    store.createTask("target", "/tmp", "agent", "agent-target", "root");
    tasks.liveTasks.add("target");
    store.createCollaborationMessage({
      id: "bash-message",
      deliveryId: "bash-delivery",
      sourceTaskId: "source",
      directTargetTaskId: "target",
      sourceActor: "agent",
      body: "A delivery must win over the reminder.",
      createdAt: Date.now(),
    });
    const { bridge, calls } = createMockBridge();
    const { sseManager } = createMockSseManager();
    const promptId = startUserTurn(tasks, "target");
    tasks.runningBashProcs.set("target", {} as any);
    const lines: string[] = [];
    const previousLevel = getLogLevel();
    setLogLevel("debug");
    setLogSink((_stream, line) => lines.push(line));
    try {
      handleAgentEvent(
        {
          type: "prompt_done",
          taskId: "target",
          promptId,
          stopReason: "end_turn",
        } as any,
        tasks,
        store,
        bridge,
        makeEventHandlerConfig(),
        sseManager as any,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      setLogSink(null);
      setLogLevel(previousLevel);
    }

    // This fails if drain still rejects Bash as busy: the reminder then wins.
    assert.equal(calls.prompts.length, 1);
    // This fails if the drain loses priority to the reminder even after it
    // submits, or if the delivery is not submitted while Bash remains active.
    assert.match(
      calls.prompts[0].text,
      /A delivery must win over the reminder/,
    );
    assert.doesNotMatch(calls.prompts[0].text, /Task Handoff Required/);
    assert.equal(tasks.runningBashProcs.has("target"), true);
    // This fails if Bash coexistence is allowed without the diagnostic log.
    assert.ok(
      lines.some((line) =>
        line.includes("collaboration delivery allowed during bash"),
      ),
      "parallel Bash delivery must be diagnosable",
    );

    tasks.runningBashProcs.delete("target");
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

    // This fails if the narrowed guard permits all busy kinds, including ACP.
    assert.equal(drained, false);
    assert.equal(calls.prompts.length, 0);
    assert.equal(
      store.getCollaborationDelivery("active-delivery")?.status,
      "queued",
    );
  });

  // Scope: an agent-created Task owes a handoff on turns the user starts and
  // on collaboration turns whose claimed batch includes the Task's parent. A
  // batch mixing the parent with any other sender still owes (any-cause).
  it("owes a handoff for a collaboration turn whose batch includes the parent", async () => {
    store.createTask("root", "/tmp", "root", "agent-root");
    store.createTask("target", "/tmp", "agent", "agent-target", "root");
    tasks.liveTasks.add("target");
    store.createCollaborationMessage({
      id: "parent-message",
      deliveryId: "parent-delivery",
      sourceTaskId: "root",
      directTargetTaskId: "target",
      sourceActor: "agent",
      body: "A direct instruction from the parent.",
      createdAt: Date.now(),
    });
    const { bridge } = createMockBridge();

    assert.equal(
      await tasks.drainCollaborationDeliveries(bridge, "target"),
      true,
    );

    // Mutation evidence: an always-false rule fails here; the old wide rule
    // also passes, which is why this asserts the parent edge is not over-cut.
    assert.equal(tasks.owesHandoff("target"), true);
  });

  it("owes a handoff when one claimed batch mixes the parent with a sibling", async () => {
    store.createTask("root", "/tmp", "root", "agent-root");
    store.createTask("sibling", "/tmp", "agent", "agent-sibling", "root");
    store.createTask("target", "/tmp", "agent", "agent-target", "root");
    tasks.liveTasks.add("target");
    store.createCollaborationMessage({
      id: "mix-parent",
      deliveryId: "mix-parent-delivery",
      sourceTaskId: "root",
      directTargetTaskId: "target",
      sourceActor: "agent",
      body: "A parent instruction.",
      createdAt: Date.now(),
    });
    store.createCollaborationMessage({
      id: "mix-sibling",
      deliveryId: "mix-sibling-delivery",
      sourceTaskId: "sibling",
      directTargetTaskId: "target",
      sourceActor: "agent",
      body: "A sibling note.",
      createdAt: Date.now() + 1,
    });
    const { bridge, calls } = createMockBridge();

    assert.equal(
      await tasks.drainCollaborationDeliveries(bridge, "target"),
      true,
    );

    // Both senders were claimed into one turn.
    assert.match(calls.prompts[0].text, /A parent instruction/);
    assert.match(calls.prompts[0].text, /A sibling note/);
    // Mutation evidence: requiring the parent to be the *only* sender (an
    // `every`/single-cause rule) fails here, which is the conservative
    // any-cause reading this asserts.
    assert.equal(tasks.owesHandoff("target"), true);
  });

  it("does not owe a handoff for a turn caused only by a sibling", async () => {
    store.createTask("root", "/tmp", "root", "agent-root");
    store.createTask("sibling", "/tmp", "agent", "agent-sibling", "root");
    store.createTask("target", "/tmp", "agent", "agent-target", "root");
    tasks.liveTasks.add("target");
    store.createCollaborationMessage({
      id: "sibling-message",
      deliveryId: "sibling-delivery",
      sourceTaskId: "sibling",
      directTargetTaskId: "target",
      sourceActor: "agent",
      body: "A sibling note that must not demand a handoff.",
      createdAt: Date.now(),
    });
    const { bridge, calls } = createMockBridge();
    const { sseManager } = createMockSseManager();
    const lines: string[] = [];
    const previousLevel = getLogLevel();
    setLogLevel("debug");
    setLogSink((_stream, line) => lines.push(line));
    try {
      assert.equal(
        await tasks.drainCollaborationDeliveries(bridge, "target"),
        true,
      );
      // Fails on the pre-change wide rule, which owes on `source` alone.
      assert.equal(tasks.owesHandoff("target"), false);

      handleAgentEvent(
        {
          type: "prompt_done",
          taskId: "target",
          promptId: calls.prompts[0].promptId,
          stopReason: "end_turn",
        } as any,
        tasks,
        store,
        bridge,
        makeEventHandlerConfig(),
        sseManager as any,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      setLogSink(null);
      setLogLevel(previousLevel);
    }

    // Fails on the pre-change rule: the reminder would make this 2.
    assert.equal(calls.prompts.length, 1);
    assert.ok(
      lines.some(
        (line) =>
          line.includes("handoff reminder skipped") &&
          line.includes('"reason":"no_obligation"'),
      ),
      "the sibling-only skip must leave a trace",
    );
  });

  it("does not owe a handoff for a turn caused only by the task's own blocked child", async () => {
    store.createTask("root", "/tmp", "root", "agent-root");
    store.createTask("target", "/tmp", "agent", "agent-target", "root");
    store.createTask(
      "grandchild",
      "/tmp",
      "agent",
      "agent-grandchild",
      "target",
    );
    tasks.liveTasks.add("target");
    const { bridge, calls } = createMockBridge();
    const { sseManager } = createMockSseManager();
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => bridge,
    });

    // The child's typed blocked handoff is a collaboration message to its
    // parent, so the parent's resulting turn is child-caused, not parent-caused.
    await host.update("grandchild", "blocked", "waiting on a decision");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls.prompts.length, 1);
    // Fails on the pre-change wide rule, which owes on `source` alone.
    assert.equal(tasks.owesHandoff("target"), false);

    handleAgentEvent(
      {
        type: "prompt_done",
        taskId: "target",
        promptId: calls.prompts[0].promptId,
        stopReason: "end_turn",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Fails on the pre-change rule: the reminder would make this 2.
    assert.equal(calls.prompts.length, 1);
  });

  it("owes a handoff on a user-started turn of an agent-created task", () => {
    store.createTask("child", "/tmp", "agent", "agent-child");

    // No collaboration cause is passed for a user prompt, so the agent-created
    // obligation is kept. Mutation evidence: an always-false rule fails here.
    assert.equal(tasks.recordHandoffObligation("child"), true);
    assert.equal(tasks.owesHandoff("child"), true);
  });

  it("lets a queued parent delivery claim an agent turn, then reminds on the next idle turn", async () => {
    store.createTask("root", "/tmp", "root", "agent-root");
    store.createTask("source", "/tmp", "agent", "agent-source", "root");
    // `source` is `target`'s parent, so the claimed turn inherits the handoff
    // obligation and the successor turn still reminds.
    store.createTask("target", "/tmp", "agent", "agent-target", "source");
    tasks.liveTasks.add("target");
    const { bridge, calls } = createMockBridge();
    const { sseManager } = createMockSseManager();
    const promptId = startUserTurn(tasks, "target");
    store.createCollaborationMessage({
      id: "message-1",
      deliveryId: "delivery-1",
      sourceTaskId: "source",
      directTargetTaskId: "target",
      sourceActor: "agent",
      body: "A delivery that arrived mid-turn.",
      createdAt: Date.now(),
    });

    const lines: string[] = [];
    const previousLevel = getLogLevel();
    setLogLevel("debug");
    setLogSink((_stream, line) => lines.push(line));
    try {
      handleAgentEvent(
        {
          type: "prompt_done",
          taskId: "target",
          promptId,
          stopReason: "end_turn",
        } as any,
        tasks,
        store,
        bridge,
        makeEventHandlerConfig(),
        sseManager as any,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      setLogSink(null);
      setLogLevel(previousLevel);
    }

    assert.equal(calls.prompts.length, 1);
    assert.match(calls.prompts[0].text, /A delivery that arrived mid-turn/);
    assert.doesNotMatch(calls.prompts[0].text, /Task Handoff Required/);
    assert.ok(
      lines.some(
        (line) =>
          line.includes("handoff reminder skipped") &&
          line.includes('"reason":"delivery_claimed"'),
      ),
      "the claimed-delivery skip must be recorded",
    );

    handleAgentEvent(
      {
        type: "prompt_done",
        taskId: "target",
        promptId: calls.prompts[0].promptId,
        stopReason: "end_turn",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(calls.prompts.length, 2);
    assert.match(calls.prompts[1].text, /Task Handoff Required/);
  });

  it("reminds after a collaboration turn reports an agent error", async () => {
    const { bridge, calls } = createMockBridge();
    const taskId = await startCollaborationTurn(store, tasks, bridge);
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      {
        type: "error",
        taskId,
        promptId: calls.prompts[0].promptId,
        message: "agent failed",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(calls.prompts.length, 2);
    assert.match(calls.prompts[1].text, /Task Handoff Required/);
  });

  it("prefers a queued collaboration delivery over a handoff reminder", async () => {
    store.createTask("root", "/tmp", "root", "agent-root");
    store.createTask("source", "/tmp", "agent", "agent-source", "root");
    store.createTask("target", "/tmp", "agent", "agent-target", "root");
    tasks.liveTasks.add("target");
    store.createCollaborationMessage({
      id: "message-1",
      deliveryId: "delivery-1",
      sourceTaskId: "source",
      directTargetTaskId: "target",
      sourceActor: "agent",
      body: "Continue with the next check.",
      createdAt: Date.now(),
    });
    const promptId = startUserTurn(tasks, "target");
    const { bridge, calls } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      {
        type: "prompt_done",
        taskId: "target",
        promptId,
        stopReason: "end_turn",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(calls.prompts.length, 1);
    assert.match(calls.prompts[0].text, /Continue with the next check/);
    assert.doesNotMatch(calls.prompts[0].text, /Task Handoff Required/);
  });

  it("does not remind after an agent task records a done or blocked handoff", async () => {
    const { bridge, calls } = createMockBridge();
    const { sseManager } = createMockSseManager();
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => bridge,
    });
    for (const status of ["done", "blocked"] as const) {
      const taskId = `s1-${status}`;
      store.createTask(taskId, "/tmp", "agent", `agent-${taskId}`);
      const promptId = startUserTurn(tasks, taskId);
      await host.update(taskId, status, `${status} report`);

      handleAgentEvent(
        {
          type: "prompt_done",
          taskId,
          promptId,
          stopReason: "end_turn",
        } as any,
        tasks,
        store,
        bridge,
        makeEventHandlerConfig(),
        sseManager as any,
      );
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(calls.prompts.length, 0);
    assert.equal(store.getTask("s1-done")?.workflow_status, "done");
    assert.equal(store.getTask("s1-blocked")?.workflow_status, "blocked");
  });

  it("does not remind a user-created task whose turn is cancelled", async () => {
    store.createTask("s1", "/tmp", "auto", "agent-s1");
    const promptId = startUserTurn(tasks, "s1");
    const { bridge, calls } = createMockBridge();
    const { sseManager } = createMockSseManager();

    handleAgentEvent(
      {
        type: "prompt_done",
        taskId: "s1",
        promptId,
        stopReason: "cancelled",
      } as any,
      tasks,
      store,
      bridge,
      makeEventHandlerConfig(),
      sseManager as any,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(calls.prompts.length, 0);
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
