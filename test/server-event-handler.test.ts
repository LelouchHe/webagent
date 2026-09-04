import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { TaskManager } from "../src/task-manager.ts";
import { handleAgentEvent } from "../src/event-handler.ts";
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

function createMockBridge() {
  const calls = {
    resolvePermission: [] as Array<{ requestId: string; optionId: string }>,
  };
  return {
    bridge: {
      resolvePermission(requestId: string, optionId: string) {
        calls.resolvePermission.push({ requestId, optionId });
      },
    } as any,
    calls,
  };
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
