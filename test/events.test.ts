import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState, createMockWS } from "./frontend-setup.ts";

describe("events", () => {
  let state: any;
  let dom: any;
  let render: any;
  let events: any;
  let stateMod: any;

  before(async () => {
    setupDOM();
    stateMod = await import("../public/js/state.js");
    state = stateMod.state;
    dom = stateMod.dom;
    render = await import("../public/js/render.js");
    events = await import("../public/js/events.js");
  });
  after(() => teardownDOM());
  beforeEach(() => resetState(state, dom));

  describe("handleEvent", () => {
    describe("session_created", () => {
      it("sets session state when awaiting", () => {
        state.awaitingNewSession = true;
        events.handleEvent({
          type: "session_created",
          sessionId: "s1",
          cwd: "/home",
          title: "Test Session",
          configOptions: [{ id: "model", name: "Model", currentValue: "x", options: [] }],
        });
        assert.equal(state.sessionId, "s1");
        assert.equal(state.sessionCwd, "/home");
        assert.equal(state.sessionTitle, "Test Session");
        assert.equal(state.awaitingNewSession, false);
        assert.equal(dom.status.dataset.state, "connected");
        assert.equal(dom.status.getAttribute("aria-label"), "connected");
      });

      it("ignores session_created from other clients when not awaiting", () => {
        state.sessionId = "existing";
        state.awaitingNewSession = false;
        events.handleEvent({
          type: "session_created",
          sessionId: "other",
        });
        assert.equal(state.sessionId, "existing");
      });

      it("adds system message when messages area is empty", () => {
        state.awaitingNewSession = true;
        events.handleEvent({
          type: "session_created",
          sessionId: "s1",
          title: "New Session",
        });
        assert.equal(dom.messages.children.length, 1);
        assert.ok(dom.messages.children[0].textContent.includes("Session created"));
      });

      it("restores busy state for an active agent session", () => {
        state.awaitingNewSession = true;
        events.handleEvent({
          type: "session_created",
          sessionId: "s1",
          busyKind: "agent",
          configOptions: [],
        });
        assert.equal(state.busy, true);
        assert.equal(dom.sendBtn.textContent, "^X");
      });

      it("reattaches a running bash block for a busy bash session", () => {
        events.replayEvent("bash_command", { command: "ls" }, [], 0);
        state.awaitingNewSession = true;
        events.handleEvent({
          type: "session_created",
          sessionId: "s1",
          busyKind: "bash",
          configOptions: [],
        });
        assert.equal(state.busy, true);
        assert.ok(state.currentBashEl);
        assert.ok(state.currentBashEl.querySelector(".bash-cmd").classList.contains("running"));
      });
    });

    describe("user_message", () => {
      it("adds user message from broadcast", () => {
        state.sessionId = "s1";
        events.handleEvent({
          type: "user_message",
          sessionId: "s1",
          text: "hello",
        });
        assert.equal(dom.messages.children.length, 1);
        assert.ok(dom.messages.children[0].classList.contains("user"));
      });

      it("ignores messages from other sessions", () => {
        state.sessionId = "s1";
        events.handleEvent({
          type: "user_message",
          sessionId: "s2",
          text: "hello",
        });
        assert.equal(dom.messages.children.length, 0);
      });
    });

    describe("message_chunk", () => {
      it("creates assistant element on first chunk", () => {
        events.handleEvent({ type: "message_chunk", text: "hello " });
        assert.ok(state.currentAssistantEl);
        assert.equal(state.currentAssistantText, "hello ");
      });

      it("appends to existing assistant element", () => {
        events.handleEvent({ type: "message_chunk", text: "hello " });
        events.handleEvent({ type: "message_chunk", text: "world" });
        assert.equal(state.currentAssistantText, "hello world");
        assert.equal(dom.messages.children.length, 1);
      });
    });

    describe("thought_chunk", () => {
      it("creates thinking element on first chunk", () => {
        events.handleEvent({ type: "thought_chunk", text: "let me think" });
        assert.ok(state.currentThinkingEl);
        assert.equal(state.currentThinkingText, "let me think");
        assert.ok(state.currentThinkingEl.classList.contains("thinking"));
      });

      it("appends to existing thinking element", () => {
        events.handleEvent({ type: "thought_chunk", text: "let " });
        events.handleEvent({ type: "thought_chunk", text: "me think" });
        assert.equal(state.currentThinkingText, "let me think");
        assert.equal(dom.messages.querySelectorAll(".thinking").length, 1);
      });
    });

    describe("tool_call", () => {
      it("creates tool call element", () => {
        events.handleEvent({
          type: "tool_call",
          id: "tc1",
          kind: "read",
          title: "Read file.ts",
          rawInput: { path: "file.ts" },
        });
        const el = globalThis.document.getElementById("tc-tc1");
        assert.ok(el);
        assert.ok(el.classList.contains("tool-call"));
        assert.ok(el.textContent.includes("cat"));
        assert.ok(el.textContent.includes("Read file.ts"));
      });

      it("finishes thinking and assistant before tool_call", () => {
        state.currentAssistantEl = globalThis.document.createElement("div");
        state.currentAssistantText = "text";
        events.handleEvent({
          type: "tool_call",
          id: "tc2",
          kind: "execute",
          title: "Run cmd",
          rawInput: { command: "ls" },
        });
        assert.equal(state.currentAssistantEl, null);
      });

      it("shows command for execute kind", () => {
        events.handleEvent({
          type: "tool_call",
          id: "tc3",
          kind: "execute",
          title: "Run",
          rawInput: { command: "npm test" },
        });
        const el = globalThis.document.getElementById("tc-tc3");
        assert.ok(el.textContent.includes("npm test"));
      });
    });

    describe("tool_call_update", () => {
      it("updates tool call status to completed", () => {
        events.handleEvent({ type: "tool_call", id: "tc1", kind: "read", title: "Read", rawInput: {} });
        events.handleEvent({ type: "tool_call_update", id: "tc1", status: "completed" });
        const el = globalThis.document.getElementById("tc-tc1");
        assert.ok(el.classList.contains("completed"));
        assert.equal(el.querySelector(".icon").textContent, "✓");
      });

      it("updates tool call status to failed", () => {
        events.handleEvent({ type: "tool_call", id: "tc2", kind: "read", title: "Read", rawInput: {} });
        events.handleEvent({ type: "tool_call_update", id: "tc2", status: "failed" });
        const el = globalThis.document.getElementById("tc-tc2");
        assert.ok(el.classList.contains("failed"));
        assert.equal(el.querySelector(".icon").textContent, "✗");
      });
    });

    describe("plan", () => {
      it("renders plan with entries", () => {
        state.currentAssistantEl = globalThis.document.createElement("div");
        events.handleEvent({
          type: "plan",
          entries: [
            { content: "Step 1", status: "completed" },
            { content: "Step 2", status: "in_progress" },
            { content: "Step 3", status: "pending" },
          ],
        });
        assert.equal(state.currentAssistantEl, null); // finishAssistant called
        const plan = dom.messages.querySelector(".plan");
        assert.ok(plan);
        assert.equal(plan.querySelectorAll(".plan-entry").length, 3);
        assert.ok(plan.textContent.includes("●")); // completed
        assert.ok(plan.textContent.includes("◉")); // in_progress
        assert.ok(plan.textContent.includes("○")); // pending
      });
    });

    describe("permission_request", () => {
      it("renders permission with option buttons", () => {
        events.handleEvent({
          type: "permission_request",
          requestId: "perm1",
          title: "Allow file write?",
          options: [
            { optionId: "allow", kind: "allow_once", name: "Allow" },
            { optionId: "deny", kind: "reject", name: "Deny" },
          ],
        });
        const perm = dom.messages.querySelector(".permission");
        assert.ok(perm);
        const buttons = perm.querySelectorAll("button");
        assert.equal(buttons.length, 2);
        assert.ok(buttons[0].classList.contains("allow"));
        assert.ok(buttons[1].classList.contains("deny"));
      });

      it("sends permission response on button click", () => {
        const ws = createMockWS();
        state.ws = ws;
        state.sessionId = "s1";
        events.handleEvent({
          type: "permission_request",
          requestId: "perm2",
          title: "Allow?",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        });
        const btn = dom.messages.querySelector(".permission button");
        btn.click();
        assert.equal(ws.sent.length, 1);
        const msg = JSON.parse(ws.sent[0]);
        assert.equal(msg.type, "permission_response");
        assert.equal(msg.requestId, "perm2");
        assert.equal(msg.denied, false);
      });

      it("clears local pending permission state after the user responds", () => {
        const ws = createMockWS();
        state.ws = ws;
        state.sessionId = "s1";
        state.busy = true;
        events.handleEvent({
          type: "permission_request",
          requestId: "perm-local",
          title: "Allow?",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        });

        const btn = dom.messages.querySelector(".permission button");
        btn.click();
        events.handleEvent({ type: "prompt_done" });

        assert.equal(state.pendingPermissionRequestIds.has("perm-local"), false);
        assert.equal(state.busy, false);
      });

      it("preserves title after user clicks a permission button", () => {
        const ws = createMockWS();
        state.ws = ws;
        state.sessionId = "s1";
        events.handleEvent({
          type: "permission_request",
          requestId: "perm-click",
          title: "Execute npm install",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow once" }],
        });
        dom.messages.querySelector(".permission button").click();
        const perm = dom.messages.querySelector(".permission");
        assert.ok(perm.textContent.includes("Execute npm install"));
        assert.ok(perm.textContent.includes("Allow once"));
      });
    });

    describe("permission_resolved", () => {
      it("dismisses permission buttons from another client", () => {
        state.sessionId = "s1";
        events.handleEvent({
          type: "permission_request",
          requestId: "perm3",
          title: "Allow?",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        });
        events.handleEvent({
          type: "permission_resolved",
          sessionId: "s1",
          requestId: "perm3",
          optionName: "Allow",
          denied: false,
        });
        const perm = dom.messages.querySelector(".permission");
        assert.equal(perm.querySelectorAll("button").length, 0);
        assert.ok(perm.textContent.includes("Allow"));
      });

      it("preserves original title after permission_resolved", () => {
        state.sessionId = "s1";
        events.handleEvent({
          type: "permission_request",
          requestId: "perm-title",
          title: "Run dangerous command",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow once" }],
        });
        events.handleEvent({
          type: "permission_resolved",
          sessionId: "s1",
          requestId: "perm-title",
          optionName: "Allow once",
          denied: false,
        });
        const perm = dom.messages.querySelector(".permission");
        assert.ok(perm.textContent.includes("Run dangerous command"));
        assert.ok(perm.textContent.includes("Allow once"));
      });
    });

    describe("bash events", () => {
      it("handles bash_command from another client", () => {
        state.sessionId = "s1";
        events.handleEvent({ type: "bash_command", sessionId: "s1", command: "ls" });
        assert.ok(state.currentBashEl);
        assert.equal(state.busy, true);
      });

      it("handles bash_output", () => {
        state.sessionId = "s1";
        events.handleEvent({ type: "bash_command", sessionId: "s1", command: "ls" });
        events.handleEvent({ type: "bash_output", sessionId: "s1", text: "file.txt\n", stream: "stdout" });
        const out = state.currentBashEl.querySelector(".bash-output");
        assert.ok(out.textContent.includes("file.txt"));
      });

      it("handles bash_output stderr", () => {
        state.sessionId = "s1";
        events.handleEvent({ type: "bash_command", sessionId: "s1", command: "fail" });
        events.handleEvent({ type: "bash_output", sessionId: "s1", text: "error!", stream: "stderr" });
        const stderr = state.currentBashEl.querySelector(".bash-output .stderr");
        assert.ok(stderr);
        assert.equal(stderr.textContent, "error!");
      });

      it("handles bash_done", () => {
        state.sessionId = "s1";
        events.handleEvent({ type: "bash_command", sessionId: "s1", command: "ls" });
        events.handleEvent({ type: "bash_done", sessionId: "s1", code: 0 });
        assert.equal(state.currentBashEl, null);
        assert.equal(state.busy, false);
      });
    });

    describe("prompt_done", () => {
      it("clears all active states", () => {
        state.currentAssistantEl = globalThis.document.createElement("div");
        state.currentAssistantText = "text";
        state.busy = true;
        events.handleEvent({ type: "prompt_done" });
        assert.equal(state.currentAssistantEl, null);
        assert.equal(state.busy, false);
      });

      it("does not clear busy until in-flight tool calls are completed", () => {
        state.busy = true;
        events.handleEvent({
          type: "tool_call",
          id: "tc-pending",
          kind: "execute",
          title: "Run tests",
          rawInput: { command: "npm test" },
        });

        events.handleEvent({ type: "prompt_done" });
        assert.equal(state.busy, true);

        events.handleEvent({ type: "tool_call_update", id: "tc-pending", status: "completed" });
        assert.equal(state.busy, false);
      });

      it("clears pending tool calls when the prompt is cancelled", () => {
        state.busy = true;
        events.handleEvent({
          type: "tool_call",
          id: "tc-cancelled",
          kind: "execute",
          title: "Run tests",
          rawInput: { command: "npm test" },
        });

        events.handleEvent({ type: "prompt_done", stopReason: "cancelled" });

        assert.equal(state.pendingToolCallIds.size, 0);
        assert.equal(state.busy, false);
      });

      it("clears pending permissions when the prompt is cancelled", () => {
        const ws = createMockWS();
        state.ws = ws;
        state.sessionId = "s1";
        state.busy = true;
        events.handleEvent({
          type: "permission_request",
          requestId: "perm-cancelled",
          title: "Allow?",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        });

        events.handleEvent({ type: "prompt_done", stopReason: "cancelled" });

        assert.equal(state.pendingPermissionRequestIds.size, 0);
        assert.equal(state.busy, false);
      });
    });

    describe("late events after prompt_done", () => {
      it("ignores tool_call arriving after prompt_done (race condition)", () => {
        state.busy = true;
        events.handleEvent({
          type: "tool_call",
          id: "tc-early",
          kind: "execute",
          title: "Run cmd",
          rawInput: { command: "ls" },
        });

        // prompt_done with cancel clears pending and sets busy=false
        events.handleEvent({ type: "prompt_done", stopReason: "cancelled" });
        assert.equal(state.busy, false);

        // A late tool_call arrives after the turn has ended
        events.handleEvent({
          type: "tool_call",
          id: "tc-late",
          kind: "read",
          title: "Read file",
          rawInput: { path: "file.ts" },
        });

        // Should NOT re-set busy
        assert.equal(state.busy, false);
        assert.equal(state.pendingToolCallIds.size, 0);
      });

      it("ignores permission_request arriving after prompt_done", () => {
        const ws = createMockWS();
        state.ws = ws;
        state.sessionId = "s1";
        state.busy = true;

        events.handleEvent({ type: "prompt_done", stopReason: "cancelled" });
        assert.equal(state.busy, false);

        // A late permission_request arrives after the turn has ended
        events.handleEvent({
          type: "permission_request",
          requestId: "perm-late",
          title: "Allow?",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        });

        // Should NOT re-set busy
        assert.equal(state.busy, false);
        assert.equal(state.pendingPermissionRequestIds.size, 0);
      });

      it("resets turnEnded flag on next user_message", () => {
        state.busy = true;
        events.handleEvent({ type: "prompt_done" });
        assert.equal(state.busy, false);

        // New turn starts
        state.sessionId = "s1";
        events.handleEvent({ type: "user_message", sessionId: "s1", text: "hello" });

        // tool_call in the new turn should work normally
        events.handleEvent({
          type: "tool_call",
          id: "tc-new-turn",
          kind: "execute",
          title: "Run",
          rawInput: { command: "ls" },
        });
        assert.equal(state.busy, true);
        assert.equal(state.pendingToolCallIds.size, 1);
      });

      it("ignores late tool_call after normal (non-cancel) prompt_done", () => {
        state.busy = true;
        events.handleEvent({ type: "prompt_done", stopReason: "end_turn" });
        assert.equal(state.busy, false);

        events.handleEvent({
          type: "tool_call",
          id: "tc-stale",
          kind: "read",
          title: "Stale read",
          rawInput: { path: "x.ts" },
        });

        assert.equal(state.busy, false);
        assert.equal(state.pendingToolCallIds.size, 0);
      });
    });

    describe("cancel timeout", () => {
      function withMockTimers(fn: (ctx: { timeoutFns: Function[]; timeoutDelays: number[]; clearedIds: number[] }) => void) {
        const origSet = globalThis.setTimeout;
        const origClear = globalThis.clearTimeout;
        const timeoutFns: Function[] = [];
        const timeoutDelays: number[] = [];
        const clearedIds: number[] = [];
        let nextId = 100;
        globalThis.setTimeout = ((f: Function, ms?: number) => {
          timeoutFns.push(f);
          timeoutDelays.push(ms ?? 0);
          return nextId++ as any;
        }) as any;
        globalThis.clearTimeout = ((id: number) => {
          clearedIds.push(id);
        }) as any;
        try {
          fn({ timeoutFns, timeoutDelays, clearedIds });
        } finally {
          globalThis.setTimeout = origSet;
          globalThis.clearTimeout = origClear;
        }
      }

      it("starts a cancel timeout after sendCancel", () => {
        withMockTimers(({ timeoutFns, timeoutDelays }) => {
          const ws = createMockWS();
          state.ws = ws;
          state.sessionId = "s1";
          state.busy = true;
          state.cancelTimeout = 10_000;

          stateMod.sendCancel();

          assert.ok(timeoutFns.length > 0, "should have scheduled a timeout");
          assert.equal(timeoutDelays[0], 10_000);
        });
      });

      it("cancel timeout fires and resets busy with warning", () => {
        withMockTimers(({ timeoutFns }) => {
          const ws = createMockWS();
          state.ws = ws;
          state.sessionId = "s1";
          state.busy = true;
          state.cancelTimeout = 5000;
          state._onCancelTimeout = () => render.addSystem("warn: Agent not responding to cancel");

          stateMod.sendCancel();

          // Fire the timeout callback
          timeoutFns[0]();

          assert.equal(state.busy, false);
          assert.ok(dom.messages.textContent.includes("not responding"));
        });
      });

      it("prompt_done clears the cancel timeout", () => {
        withMockTimers(({ clearedIds }) => {
          const ws = createMockWS();
          state.ws = ws;
          state.sessionId = "s1";
          state.busy = true;
          state.cancelTimeout = 10_000;

          stateMod.sendCancel();

          // prompt_done arrives before timeout fires
          events.handleEvent({ type: "prompt_done", stopReason: "cancelled" });

          assert.ok(clearedIds.length > 0, "should have cleared the timeout");
        });
      });

      it("does not start timeout when cancelTimeout is 0", () => {
        withMockTimers(({ timeoutFns }) => {
          const ws = createMockWS();
          state.ws = ws;
          state.sessionId = "s1";
          state.busy = true;
          state.cancelTimeout = 0;

          stateMod.sendCancel();

          assert.equal(timeoutFns.length, 0, "should not schedule a timeout when disabled");
        });
      });
    });

    describe("session_deleted", () => {
      it("disables input for current session", () => {
        state.sessionId = "s1";
        events.handleEvent({ type: "session_deleted", sessionId: "s1" });
        assert.equal(dom.input.disabled, true);
        assert.equal(dom.sendBtn.disabled, true);
      });

      it("ignores deletion of other sessions", () => {
        state.sessionId = "s1";
        events.handleEvent({ type: "session_deleted", sessionId: "s2" });
        assert.equal(dom.input.disabled, false);
      });
    });

    describe("config_set", () => {
      it("updates config value and shows system message", () => {
        state.configOptions = [{ id: "model", name: "Model", currentValue: "old", options: [{ value: "new", name: "New Model" }] }];
        events.handleEvent({ type: "config_set", configId: "model", value: "new" });
        assert.equal(stateMod.getConfigValue("model"), "new");
        assert.ok(dom.messages.querySelector(".system-msg").textContent.includes("Model"));
      });
    });

    describe("session_title_updated", () => {
      it("updates title for current session", () => {
        state.sessionId = "s1";
        events.handleEvent({ type: "session_title_updated", sessionId: "s1", title: "New Title" });
        assert.equal(state.sessionTitle, "New Title");
        assert.equal(dom.sessionInfo.textContent, "New Title");
      });

      it("ignores title update for other sessions", () => {
        state.sessionId = "s1";
        state.sessionTitle = "Old";
        events.handleEvent({ type: "session_title_updated", sessionId: "s2", title: "Other" });
        assert.equal(state.sessionTitle, "Old");
      });
    });

    describe("error", () => {
      it("shows error message and clears busy", () => {
        state.busy = true;
        events.handleEvent({ type: "error", message: "Something broke" });
        assert.equal(state.busy, false);
        assert.ok(dom.messages.querySelector(".system-msg").textContent.includes("Something broke"));
      });

      it("clears awaitingNewSession so the UI is not stuck", () => {
        state.awaitingNewSession = true;
        events.handleEvent({ type: "error", message: "Directory does not exist: /bad" });
        assert.equal(state.awaitingNewSession, false);
      });
    });

    describe("event filtering", () => {
      it("ignores events from other sessions", () => {
        state.sessionId = "s1";
        events.handleEvent({ type: "message_chunk", sessionId: "s2", text: "hello" });
        assert.equal(state.currentAssistantEl, null);
        assert.equal(dom.messages.children.length, 0);
      });

      it("processes events matching current session", () => {
        state.sessionId = "s1";
        events.handleEvent({ type: "message_chunk", sessionId: "s1", text: "hello" });
        assert.ok(state.currentAssistantEl);
      });

      it("always processes session_created regardless of session filter", () => {
        state.sessionId = "s1";
        state.awaitingNewSession = true;
        events.handleEvent({ type: "session_created", sessionId: "s2" });
        assert.equal(state.sessionId, "s2");
      });
    });
  });

  describe("replayEvent", () => {
    it("replays user_message", () => {
      events.replayEvent("user_message", { text: "hello" }, [], 0);
      assert.equal(dom.messages.children.length, 1);
      assert.ok(dom.messages.children[0].classList.contains("user"));
    });

    it("replays assistant_message", () => {
      events.replayEvent("assistant_message", { text: "response" }, [], 0);
      assert.equal(dom.messages.children.length, 1);
      assert.ok(dom.messages.children[0].classList.contains("assistant"));
    });

    it("replays thinking", () => {
      events.replayEvent("thinking", { text: "thoughts" }, [], 0);
      const thinking = dom.messages.querySelector(".thinking");
      assert.ok(thinking);
      assert.equal(thinking.querySelector("summary").textContent, "⠿ thought");
    });

    it("replays tool_call and tool_call_update", () => {
      events.replayEvent("tool_call", { id: "t1", kind: "read", title: "Read", rawInput: {} }, [], 0);
      events.replayEvent("tool_call_update", { id: "t1", status: "completed" }, [], 1);
      const el = globalThis.document.getElementById("tc-t1");
      assert.ok(el.classList.contains("completed"));
    });

    it("replays bash_command and bash_result", () => {
      events.replayEvent("bash_command", { command: "echo hi" }, [], 0);
      const pending = globalThis.document.getElementById("bash-replay-pending");
      assert.ok(pending);
      events.replayEvent("bash_result", { output: "hi\n", code: 0 }, [], 1);
      assert.equal(globalThis.document.getElementById("bash-replay-pending"), null);
    });

    it("replays permission_request with resolved state", () => {
      const evts = [
        { type: "permission_request", data: JSON.stringify({ requestId: "p1", title: "Allow?", options: [{ optionId: "a", kind: "allow", name: "Allow" }] }) },
        { type: "permission_response", data: JSON.stringify({ requestId: "p1", denied: false, optionName: "Allow" }) },
      ];
      events.replayEvent("permission_request", JSON.parse(evts[0].data), evts, 0);
      const perm = dom.messages.querySelector(".permission");
      // Already resolved — no buttons should be present
      assert.equal(perm.querySelectorAll("button").length, 0);
    });

    it("preserves permission title through full replay cycle", () => {
      const evts = [
        { type: "permission_request", data: JSON.stringify({ requestId: "p2", title: "Run rm -rf", options: [{ optionId: "a", kind: "allow", name: "Allow once" }] }) },
        { type: "permission_response", data: JSON.stringify({ requestId: "p2", denied: false, optionName: "Allow once" }) },
      ];
      events.replayEvent("permission_request", JSON.parse(evts[0].data), evts, 0);
      events.replayEvent("permission_response", JSON.parse(evts[1].data), evts, 1);
      const perm = dom.messages.querySelector(".permission");
      assert.ok(perm.textContent.includes("Run rm -rf"), "title should be preserved");
      assert.ok(perm.textContent.includes("Allow once"), "action should be shown");
    });
  });

  describe("loadHistory", () => {
    it("sets lastEventSeq and sync boundary from loaded events", async () => {
      const fakeEvents = [
        { seq: 1, type: "user_message", data: JSON.stringify({ text: "hi" }) },
        { seq: 2, type: "assistant_message", data: JSON.stringify({ text: "hello" }) },
      ];
      globalThis.fetch = (() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(fakeEvents),
      })) as any;

      const loaded = await events.loadHistory("s1");
      assert.equal(loaded, true);
      assert.equal(state.lastEventSeq, 2);
      assert.equal(dom.messages.children.length, 2);
      assert.ok(dom.messages.lastElementChild.hasAttribute("data-sync-boundary"));
    });
  });

  describe("loadNewEvents", () => {
    it("appends new events without clearing existing DOM", async () => {
      // Simulate existing DOM from loadHistory
      events.replayEvent("user_message", { text: "old" }, [], 0);
      state.lastEventSeq = 1;
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");

      const newEvents = [
        { seq: 2, type: "assistant_message", data: JSON.stringify({ text: "new reply" }) },
      ];
      globalThis.fetch = ((url: string) => {
        assert.ok(url.includes("after_seq=1"));
        return Promise.resolve({ ok: true, json: () => Promise.resolve(newEvents) });
      }) as any;

      const result = await events.loadNewEvents("s1");
      assert.equal(result, true);
      assert.equal(state.lastEventSeq, 2);
      // Old message preserved + new message appended
      assert.equal(dom.messages.children.length, 2);
      assert.ok(dom.messages.children[0].textContent.includes("old"));
      assert.ok(dom.messages.children[1].textContent.includes("new reply"));
      // Boundary moved to last element
      assert.ok(dom.messages.lastElementChild.hasAttribute("data-sync-boundary"));
    });

    it("removes post-boundary live elements before replaying", async () => {
      // Simulate: loadHistory rendered 1 event, then live event added 1 more
      events.replayEvent("user_message", { text: "from-db" }, [], 0);
      state.lastEventSeq = 1;
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");

      // Simulate a live-added element (after the boundary)
      const liveEl = globalThis.document.createElement("div");
      liveEl.textContent = "live-streamed";
      dom.messages.appendChild(liveEl);
      assert.equal(dom.messages.children.length, 2);

      // New events from server include both the completed version of the live event
      // and a new event
      const newEvents = [
        { seq: 2, type: "assistant_message", data: JSON.stringify({ text: "full reply" }) },
        { seq: 3, type: "user_message", data: JSON.stringify({ text: "follow up" }) },
      ];
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(newEvents),
      })) as any;

      await events.loadNewEvents("s1");

      // from-db (preserved) + full reply + follow up
      assert.equal(dom.messages.children.length, 3);
      assert.ok(dom.messages.children[0].textContent.includes("from-db"));
      assert.ok(dom.messages.children[1].textContent.includes("full reply"));
      assert.equal(state.lastEventSeq, 3);
    });

    it("returns true with no DOM changes when there are no new events", async () => {
      events.replayEvent("user_message", { text: "msg" }, [], 0);
      state.lastEventSeq = 1;
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");

      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve([]),
      })) as any;

      const result = await events.loadNewEvents("s1");
      assert.equal(result, true);
      assert.equal(dom.messages.children.length, 1);
      assert.equal(state.lastEventSeq, 1);
    });
  });
});
