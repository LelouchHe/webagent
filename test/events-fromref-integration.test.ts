import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { SessionManager } from "../src/session-manager.ts";
import { handleAgentEvent } from "../src/event-handler.ts";
import type { AgentEvent } from "../src/types.ts";

/**
 * Every event row must persist a correct `from_ref`. These integration
 * tests exercise the backend writers end-to-end (Store + SessionManager
 * + event-handler) and assert the stored origin marker for each
 * category. Complements unit tests by pinning the cross-module contract.
 *
 * Categories:
 *   - agent : assistant_message, thinking, tool_call, tool_call_update,
 *             plan, permission_request, prompt_done
 *   - user  : user_message, bash_command (originate from POST /prompt
 *             and /bash user actions), permission_response (human click)
 *   - system: permission_response (autopilot auto-approve path),
 *             bash_result
 */
describe("event writers populate from_ref correctly", () => {
  let tmpDir: string;
  let store: Store;
  let sessions: SessionManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-fromref-"));
    store = new Store(tmpDir);
    sessions = new SessionManager(store, tmpDir, tmpDir);
    store.createSession("s1", "/tmp");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const bridge = {
    resolvePermission: () => {},
  } as unknown as Parameters<typeof handleAgentEvent>[3];
  const sseManager = { broadcast: () => {} } as unknown as Parameters<
    typeof handleAgentEvent
  >[5];
  const config = { cancelTimeout: 10000, recentPathsLimit: 10 };

  function emit(event: AgentEvent) {
    handleAgentEvent(event, sessions, store, bridge, config, sseManager);
  }

  it("assistant_message (flushed from buffer) is from_ref='agent'", () => {
    emit({ type: "message_chunk", sessionId: "s1", text: "hi" });
    // Boundary event forces flush
    emit({ type: "prompt_done", sessionId: "s1", stopReason: "end_turn" });

    const events = store.getEvents("s1");
    const asst = events.find((e) => e.type === "assistant_message");
    assert.ok(asst, "assistant_message should be stored");
    assert.equal(asst.from_ref, "agent");
    const done = events.find((e) => e.type === "prompt_done");
    assert.equal(done?.from_ref, "agent");
  });

  it("thinking (flushed from buffer) is from_ref='agent'", () => {
    emit({ type: "thought_chunk", sessionId: "s1", text: "hmm" });
    emit({
      type: "tool_call",
      sessionId: "s1",
      id: "t1",
      title: "read",
      kind: "read",
    });
    const events = store.getEvents("s1");
    const thinking = events.find((e) => e.type === "thinking");
    assert.ok(thinking);
    assert.equal(thinking.from_ref, "agent");
  });

  it("tool_call is from_ref='agent'", () => {
    emit({
      type: "tool_call",
      sessionId: "s1",
      id: "t1",
      title: "read",
      kind: "read",
    });
    const ev = store.getEvents("s1").find((e) => e.type === "tool_call");
    assert.ok(ev);
    assert.equal(ev.from_ref, "agent");
  });

  it("tool_call_update is from_ref='agent'", () => {
    emit({
      type: "tool_call_update",
      sessionId: "s1",
      id: "t1",
      status: "completed",
    });
    const ev = store.getEvents("s1").find((e) => e.type === "tool_call_update");
    assert.ok(ev);
    assert.equal(ev.from_ref, "agent");
  });

  it("plan is from_ref='agent'", () => {
    emit({
      type: "plan",
      sessionId: "s1",
      entries: [{ content: "do a thing", status: "pending" }],
    });
    const ev = store.getEvents("s1").find((e) => e.type === "plan");
    assert.ok(ev);
    assert.equal(ev.from_ref, "agent");
  });

  it("permission_request is from_ref='agent' (agent asked for permission)", () => {
    emit({
      type: "permission_request",
      sessionId: "s1",
      requestId: "p1",
      title: "Read file",
      options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
    });
    const ev = store
      .getEvents("s1")
      .find((e) => e.type === "permission_request");
    assert.ok(ev);
    assert.equal(ev.from_ref, "agent");
  });

  it("prompt_done is from_ref='agent'", () => {
    emit({ type: "prompt_done", sessionId: "s1", stopReason: "end_turn" });
    const ev = store.getEvents("s1").find((e) => e.type === "prompt_done");
    assert.ok(ev);
    assert.equal(ev.from_ref, "agent");
  });

  it("autopilot auto-approve writes permission_response with from_ref='system'", () => {
    // Put session in autopilot mode so the auto-approve branch fires.
    store.updateSessionConfig("s1", "mode", "agent#autopilot");
    emit({
      type: "permission_request",
      sessionId: "s1",
      requestId: "p2",
      title: "Read file",
      options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
    });
    const resp = store
      .getEvents("s1")
      .find((e) => e.type === "permission_response");
    assert.ok(resp, "auto-approve should persist a permission_response row");
    assert.equal(resp.from_ref, "system");
  });

  // --- routes.ts contracts: user_message / bash_command / bash_result /
  // permission_response (human click) are written by REST handlers, not
  // event-handler. We pin the contract via direct Store calls.

  it("direct saveEvent with from_ref='user' round-trips (routes.ts user_message contract)", () => {
    store.saveEvent("s1", "user_message", { text: "hi" }, { from_ref: "user" });
    const [ev] = store.getEvents("s1");
    assert.equal(ev.from_ref, "user");
  });

  it("bash_command='user' / bash_result='system' (routes.ts bash contract)", () => {
    store.saveEvent(
      "s1",
      "bash_command",
      { command: "ls" },
      { from_ref: "user" },
    );
    store.saveEvent(
      "s1",
      "bash_result",
      { output: "a.txt\n", code: 0, signal: null },
      { from_ref: "system" },
    );
    const events = store.getEvents("s1");
    assert.equal(events[0].from_ref, "user");
    assert.equal(events[1].from_ref, "system");
  });

  it("permission_response (human click) is from_ref='user'", () => {
    store.saveEvent(
      "s1",
      "permission_response",
      {
        requestId: "p1",
        optionName: "Allow",
        denied: false,
        optionId: "allow_once",
      },
      { from_ref: "user" },
    );
    const [ev] = store.getEvents("s1");
    assert.equal(ev.type, "permission_response");
    assert.equal(ev.from_ref, "user");
  });

  // Guard: missing from_ref is a programming error. Throws instead of
  // silently defaulting — any writer retrofit regression surfaces in tests.
  it("saveEvent without from_ref THROWS (guard is active)", () => {
    assert.throws(
      () => store.saveEvent("s1", "assistant_message", { text: "x" }),
      /from_ref/,
    );
  });
});
