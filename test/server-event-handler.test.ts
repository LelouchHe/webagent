import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { Store } from "../src/store.ts";
import { SessionManager } from "../src/session-manager.ts";
import { handleAgentEvent } from "../src/event-handler.ts";
import type { AgentEvent } from "../src/types.ts";

function createMockWss() {
  const sent: string[] = [];
  const client = {
    readyState: WebSocket.OPEN,
    send(d: string) { sent.push(d); },
  };
  return { wss: { clients: new Set([client]) } as any, sent };
}

function createMockSseManager() {
  const broadcasted: AgentEvent[] = [];
  return {
    sseManager: { broadcast(event: AgentEvent) { broadcasted.push(event); } },
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
  let sessions: SessionManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-server-test-"));
    store = new Store(tmpDir);
    sessions = new SessionManager(store, tmpDir, tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Event routing ---

  it("routes message_chunk through assistant buffer and broadcasts", () => {
    store.createSession("s1", "/tmp");
    const { wss, sent } = createMockWss();
    const { bridge } = createMockBridge();

    handleAgentEvent(
      { type: "message_chunk", sessionId: "s1", text: "hello" } as any,
      sessions, store, wss, bridge, { cancelTimeout: 10000 },
    );

    assert.equal(sent.length, 1);
    assert.deepEqual(JSON.parse(sent[0]), { type: "message_chunk", sessionId: "s1", text: "hello" });
    // Text is buffered, not yet flushed to store
    assert.equal(sessions.assistantBuffers.get("s1"), "hello");
  });

  it("flushes thinking buffer before appending assistant text", () => {
    store.createSession("s1", "/tmp");
    const { wss } = createMockWss();
    const { bridge } = createMockBridge();

    // Start thinking
    handleAgentEvent(
      { type: "thought_chunk", sessionId: "s1", text: "hmm" } as any,
      sessions, store, wss, bridge, { cancelTimeout: 10000 },
    );
    assert.equal(sessions.thinkingBuffers.get("s1"), "hmm");

    // Switch to message — should flush thinking
    handleAgentEvent(
      { type: "message_chunk", sessionId: "s1", text: "answer" } as any,
      sessions, store, wss, bridge, { cancelTimeout: 10000 },
    );
    assert.equal(sessions.thinkingBuffers.has("s1"), false);
    const events = store.getEvents("s1");
    assert.ok(events.some((e) => e.type === "thinking"));
  });

  it("saves tool_call events to store and broadcasts", () => {
    store.createSession("s1", "/tmp");
    const { wss, sent } = createMockWss();
    const { bridge } = createMockBridge();

    handleAgentEvent(
      { type: "tool_call", sessionId: "s1", id: "tc1", title: "Read file", kind: "read", rawInput: "{}" } as any,
      sessions, store, wss, bridge, { cancelTimeout: 10000 },
    );

    const events = store.getEvents("s1");
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "tool_call");
    assert.equal(sent.length, 1);
  });

  it("saves prompt_done and clears active prompt", () => {
    store.createSession("s1", "/tmp");
    sessions.activePrompts.add("s1");
    const { wss, sent } = createMockWss();
    const { bridge } = createMockBridge();

    handleAgentEvent(
      { type: "prompt_done", sessionId: "s1", stopReason: "end_turn" } as any,
      sessions, store, wss, bridge, { cancelTimeout: 10000 },
    );

    assert.equal(sessions.activePrompts.has("s1"), false);
    const events = store.getEvents("s1");
    assert.ok(events.some((e) => e.type === "prompt_done"));
    assert.equal(sent.length, 1);
  });

  it("caches config options from session_created", () => {
    store.createSession("s1", "/tmp");
    const { wss } = createMockWss();
    const { bridge } = createMockBridge();
    const configOptions = [{ id: "model", name: "Model", currentValue: "gpt-4", options: [] }];

    handleAgentEvent(
      { type: "session_created", sessionId: "s1", configOptions } as any,
      sessions, store, wss, bridge, { cancelTimeout: 10000 },
    );

    assert.deepEqual(sessions.cachedConfigOptions, configOptions);
    assert.equal(store.getSession("s1")?.model, "gpt-4");
  });

  it("skips events for restoring sessions", () => {
    store.createSession("s1", "/tmp");
    sessions.restoringSessions.add("s1");
    const { wss, sent } = createMockWss();
    const { bridge } = createMockBridge();

    handleAgentEvent(
      { type: "message_chunk", sessionId: "s1", text: "hidden" } as any,
      sessions, store, wss, bridge, { cancelTimeout: 10000 },
    );

    assert.equal(sent.length, 0);
    assert.equal(sessions.assistantBuffers.has("s1"), false);
  });

  it("removes active prompt on error events", () => {
    store.createSession("s1", "/tmp");
    sessions.activePrompts.add("s1");
    const { wss } = createMockWss();
    const { bridge } = createMockBridge();

    handleAgentEvent(
      { type: "error", sessionId: "s1", message: "something failed" } as any,
      sessions, store, wss, bridge, { cancelTimeout: 10000 },
    );

    assert.equal(sessions.activePrompts.has("s1"), false);
  });

  // --- Autopilot auto-approval ---

  it("auto-approves permission in autopilot mode with allow_once", () => {
    store.createSession("s1", "/tmp");
    store.updateSessionConfig("s1", "mode", "agent#autopilot");
    const { wss, sent } = createMockWss();
    const { bridge, calls } = createMockBridge();

    handleAgentEvent(
      {
        type: "permission_request",
        sessionId: "s1",
        requestId: "req1",
        title: "Run command",
        options: [
          { optionId: "allow_once", kind: "allow_once", label: "Allow once" },
          { optionId: "deny", kind: "deny", label: "Deny" },
        ],
      } as any,
      sessions, store, wss, bridge, { cancelTimeout: 10000 },
    );

    // Bridge should resolve with allow_once
    assert.deepEqual(calls.resolvePermission, [{ requestId: "req1", optionId: "allow_once" }]);

    // Should broadcast permission_request then permission_resolved
    assert.equal(sent.length, 2);
    const first = JSON.parse(sent[0]);
    assert.equal(first.type, "permission_request");
    assert.equal(first.requestId, "req1");
    const second = JSON.parse(sent[1]);
    assert.equal(second.type, "permission_resolved");
    assert.equal(second.requestId, "req1");
    assert.equal(second.denied, false);
    assert.equal(second.optionName, "Allow once");

    // Should save both permission_request and permission_response to store
    const events = store.getEvents("s1");
    assert.ok(events.some((e) => e.type === "permission_request"));
    assert.ok(events.some((e) => e.type === "permission_response"));
  });

  it("broadcasts permission_request normally when not in autopilot mode", () => {
    store.createSession("s1", "/tmp");
    store.updateSessionConfig("s1", "mode", "agent");
    const { wss, sent } = createMockWss();
    const { bridge, calls } = createMockBridge();

    handleAgentEvent(
      {
        type: "permission_request",
        sessionId: "s1",
        requestId: "req1",
        title: "Run command",
        options: [
          { optionId: "allow_once", kind: "allow_once", label: "Allow once" },
          { optionId: "deny", kind: "deny", label: "Deny" },
        ],
      } as any,
      sessions, store, wss, bridge, { cancelTimeout: 10000 },
    );

    // Bridge should NOT be called
    assert.equal(calls.resolvePermission.length, 0);

    // Should broadcast permission_request (not resolved)
    assert.equal(sent.length, 1);
    const msg = JSON.parse(sent[0]);
    assert.equal(msg.type, "permission_request");
  });

  it("falls back to broadcasting permission_request when no allow_once option exists in autopilot", () => {
    store.createSession("s1", "/tmp");
    store.updateSessionConfig("s1", "mode", "agent#autopilot");
    const { wss, sent } = createMockWss();
    const { bridge, calls } = createMockBridge();

    handleAgentEvent(
      {
        type: "permission_request",
        sessionId: "s1",
        requestId: "req1",
        title: "Dangerous action",
        options: [
          { optionId: "allow_always", kind: "allow_always", label: "Allow always" },
          { optionId: "deny", kind: "deny", label: "Deny" },
        ],
      } as any,
      sessions, store, wss, bridge, { cancelTimeout: 10000 },
    );

    // Should NOT auto-approve (no allow_once option)
    assert.equal(calls.resolvePermission.length, 0);

    // Should broadcast permission_request for manual handling
    const msg = JSON.parse(sent[0]);
    assert.equal(msg.type, "permission_request");
  });

  // --- SSE broadcast integration ---

  it("broadcasts events to SseManager when provided", () => {
    store.createSession("s1", "/tmp");
    const { wss, sent } = createMockWss();
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      { type: "message_chunk", sessionId: "s1", text: "hello" } as any,
      sessions, store, wss, bridge, { cancelTimeout: 10000 }, undefined, sseManager as any,
    );

    // Should broadcast to both WS and SSE
    assert.equal(sent.length, 1);
    assert.equal(broadcasted.length, 1);
    assert.deepEqual(broadcasted[0], { type: "message_chunk", sessionId: "s1", text: "hello" });
  });

  it("does not fail when SseManager is not provided", () => {
    store.createSession("s1", "/tmp");
    const { wss, sent } = createMockWss();
    const { bridge } = createMockBridge();

    // No sseManager arg — should work as before
    handleAgentEvent(
      { type: "message_chunk", sessionId: "s1", text: "hello" } as any,
      sessions, store, wss, bridge, { cancelTimeout: 10000 },
    );

    assert.equal(sent.length, 1);
  });

  it("broadcasts autopilot permission events to SSE", () => {
    store.createSession("s1", "/tmp");
    store.updateSessionConfig("s1", "mode", "agent#autopilot");
    const { wss } = createMockWss();
    const { bridge } = createMockBridge();
    const { sseManager, broadcasted } = createMockSseManager();

    handleAgentEvent(
      {
        type: "permission_request",
        sessionId: "s1",
        requestId: "req1",
        title: "Run command",
        options: [
          { optionId: "allow_once", kind: "allow_once", label: "Allow once" },
          { optionId: "deny", kind: "deny", label: "Deny" },
        ],
      } as any,
      sessions, store, wss, bridge, { cancelTimeout: 10000 }, undefined, sseManager as any,
    );

    // Autopilot: broadcasts permission_request + permission_resolved to SSE
    assert.equal(broadcasted.length, 2);
    assert.equal(broadcasted[0].type, "permission_request");
    assert.equal(broadcasted[1].type, "permission_resolved");
  });
});
