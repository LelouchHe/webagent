import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import type { TaskManager } from "../src/task-manager.ts";
import { createTaskManager } from "../src/task-manager.ts";
import { handleAgentEvent } from "../src/event-handler.ts";
import { setLogLevel, setLogSink } from "../src/log.ts";
import type { AgentEvent } from "../src/types.ts";
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
    assert.ok(broadcasted.some((event) => event.type === "task_created"));
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
