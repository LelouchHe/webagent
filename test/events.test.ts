import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("events", () => {
  let state: any;
  let dom: any;
  let render: any;
  let events: any;
  let stateMod: any;
  let fetchCalls: Array<{ url: string; init?: any }>;

  function setFetch(handler: (url: string, init?: any) => Promise<any> | any) {
    (globalThis as any).fetch = async (url: string, init?: any) => {
      fetchCalls.push({ url, init });
      return handler(url, init);
    };
  }

  before(async () => {
    setupDOM();
    stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    render = await import("../public/js/render.ts");
    events = await import("../public/js/events.ts");
  });
  after(() => teardownDOM());
  beforeEach(() => {
    resetState(state, dom);
    fetchCalls = [];
    setFetch(() => ({ ok: true, json: async () => ({}), text: async () => '{}' }));
  });

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
        assert.equal(dom.sendBtn.textContent, "^C");
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

      it("enhances streamed code blocks when the stream finishes", async () => {
        const originalParse = globalThis.marked.parse;
        const originalAppendChild = document.head.appendChild.bind(document.head);
        let sawHljsScript = false;

        globalThis.marked.parse = () => '<pre><code class="language-js">const x = 1;</code></pre>';
        (globalThis as any).hljs = undefined;

        document.head.appendChild = ((node: Node) => {
          const result = originalAppendChild(node);
          if ((node as Element).nodeName === "SCRIPT") {
            sawHljsScript = true;
            queueMicrotask(() => {
              (globalThis as any).hljs = {
                highlightElement(code: HTMLElement) {
                  code.dataset.highlighted = "yes";
                },
              };
              (node as HTMLScriptElement).onload?.(new Event("load"));
            });
          }
          return result;
        }) as typeof document.head.appendChild;

        try {
          events.handleEvent({ type: "message_chunk", text: "```js\nconst " });
          events.handleEvent({ type: "message_chunk", text: "x = 1;\n```" });

          assert.equal(
            dom.messages.querySelector(".code-block-wrapper"),
            null,
            "streaming chunks should not keep rebuilding code wrappers",
          );

          events.handleEvent({ type: "prompt_done", stopReason: "end_turn" });
          await new Promise(resolve => setTimeout(resolve, 0));

          const wrapper = dom.messages.querySelector(".code-block-wrapper");
          assert.ok(wrapper, "expected streamed code block to be wrapped when streaming finishes");
          assert.equal(sawHljsScript, true, "expected completed streamed code block to trigger hljs lazy load");
        } finally {
          globalThis.marked.parse = originalParse;
          document.head.appendChild = originalAppendChild;
        }
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

      it("shows task_complete summary directly without collapsed details", () => {
        events.handleEvent({ type: "tool_call", id: "tc-done", kind: "task_complete", title: "Task complete", rawInput: { summary: "Fixed the login bug" } });
        events.handleEvent({
          type: "tool_call_update", id: "tc-done", status: "completed",
          content: [{ type: "text", content: { text: "Fixed the login bug" } }],
        });
        const el = globalThis.document.getElementById("tc-tc-done");
        assert.ok(el.classList.contains("completed"));
        // Summary should be visible directly, not inside a collapsed <details>
        assert.ok(!el.querySelector("details"), "task_complete should not use collapsed details");
        const summary = el.querySelector(".tc-summary");
        assert.ok(summary, "should have a .tc-summary element");
        assert.ok(summary.textContent.includes("Fixed the login bug"));
      });

      it("uses ✔ icon for task_complete kind", () => {
        events.handleEvent({ type: "tool_call", id: "tc-done2", kind: "task_complete", title: "Task complete", rawInput: {} });
        const el = globalThis.document.getElementById("tc-tc-done2");
        assert.equal(el.querySelector(".icon").textContent, "✔");
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
        state.sessionId = "s1";
        events.handleEvent({
          type: "permission_request",
          requestId: "perm2",
          title: "Allow?",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        });
        const btn = dom.messages.querySelector(".permission button");
        btn.click();
        const call = fetchCalls.find(c => c.url.includes("/api/v1/sessions/s1/permissions/perm2") && c.init?.method === "POST");
        assert.ok(call, "expected a POST to /api/v1/sessions/s1/permissions/perm2");
        const body = JSON.parse(call!.init.body);
        assert.equal(body.optionId, "allow");
      });

      it("clears local pending permission state after the user responds", () => {
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

      it("skips duplicate permission_request with same requestId", () => {
        events.handleEvent({
          type: "permission_request",
          requestId: "perm-dup",
          title: "Allow file write?",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        });
        // Send a second permission_request with the same requestId
        events.handleEvent({
          type: "permission_request",
          requestId: "perm-dup",
          title: "Allow file write?",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        });
        const perms = dom.messages.querySelectorAll('.permission[data-request-id="perm-dup"]');
        assert.equal(perms.length, 1, "should not create duplicate permission element");
      });

      it("skips duplicate permission_request even if already resolved", () => {
        state.sessionId = "s1";
        events.handleEvent({
          type: "permission_request",
          requestId: "perm-dup2",
          title: "Allow?",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        });
        // User clicks Allow (optimistic update)
        dom.messages.querySelector(".permission button").click();
        // A duplicate permission_request arrives (e.g. from bridge restore)
        events.handleEvent({
          type: "permission_request",
          requestId: "perm-dup2",
          title: "Allow?",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        });
        const perms = dom.messages.querySelectorAll('.permission[data-request-id="perm-dup2"]');
        assert.equal(perms.length, 1, "should not create duplicate after resolution");
        assert.equal(perms[0].querySelectorAll("button").length, 0, "should stay resolved");
      });

      it("tracks unconfirmed permission response after Allow click", () => {
        state.sessionId = "s1";
        events.handleEvent({
          type: "permission_request",
          requestId: "perm-track",
          title: "Allow?",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        });
        dom.messages.querySelector(".permission button").click();
        assert.ok(state.unconfirmedPermissions instanceof Map);
        assert.ok(state.unconfirmedPermissions.has("perm-track"), "should track unconfirmed response");
        const entry = state.unconfirmedPermissions.get("perm-track");
        assert.equal(entry.optionId, "allow");
        assert.equal(entry.optionName, "Allow");
      });

      it("preserves title after user clicks a permission button", () => {
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

    describe("permission_response (live)", () => {
      it("dismisses permission buttons from another client", () => {
        state.sessionId = "s1";
        events.handleEvent({
          type: "permission_request",
          requestId: "perm3",
          title: "Allow?",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        });
        events.handleEvent({
          type: "permission_response",
          sessionId: "s1",
          requestId: "perm3",
          optionName: "Allow",
          denied: false,
        });
        const perm = dom.messages.querySelector(".permission");
        assert.equal(perm.querySelectorAll("button").length, 0);
        assert.ok(perm.textContent.includes("Allow"));
      });

      it("preserves original title after permission_response", () => {
        state.sessionId = "s1";
        events.handleEvent({
          type: "permission_request",
          requestId: "perm-title",
          title: "Run dangerous command",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow once" }],
        });
        events.handleEvent({
          type: "permission_response",
          sessionId: "s1",
          requestId: "perm-title",
          optionName: "Allow once",
          denied: false,
        });
        const perm = dom.messages.querySelector(".permission");
        assert.ok(perm.textContent.includes("Run dangerous command"));
        assert.ok(perm.textContent.includes("Allow once"));
      });

      it("clears unconfirmed permission on permission_response", () => {
        state.sessionId = "s1";
        events.handleEvent({
          type: "permission_request",
          requestId: "perm-conf",
          title: "Allow?",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        });
        dom.messages.querySelector(".permission button").click();
        assert.ok(state.unconfirmedPermissions.has("perm-conf"));
        events.handleEvent({
          type: "permission_response",
          sessionId: "s1",
          requestId: "perm-conf",
          optionName: "Allow",
          denied: false,
        });
        assert.equal(state.unconfirmedPermissions.has("perm-conf"), false,
          "should clear unconfirmed after server confirms");
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

      it("clears busy on prompt_done even with in-flight tool calls", () => {
        state.busy = true;
        events.handleEvent({
          type: "tool_call",
          id: "tc-pending",
          kind: "execute",
          title: "Run tests",
          rawInput: { command: "npm test" },
        });

        // prompt_done is authoritative — clears pending sets and stops spinner
        events.handleEvent({ type: "prompt_done" });
        assert.equal(state.busy, false);
        assert.equal(state.pendingToolCallIds.size, 0);

        // Late tool_call_update is harmless
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

      it("does not drop new-turn events when sender never receives user_message echo", () => {
        // Simulate: turn 1 ends normally
        state.sessionId = "s1";
        state.busy = true;
        events.handleEvent({ type: "prompt_done", stopReason: "end_turn" });
        assert.equal(state.turnEnded, true);

        // User sends a new prompt via input.js (setBusy + WS send).
        // input.js:104 sets turnEnded = false before any agent events arrive.
        // The server does NOT echo user_message back to the sender —
        // only to other clients.
        state.turnEnded = false; // input.js:104
        state.busy = true;      // input.js:105 (setBusy(true))

        // Agent responds with message_chunk first (normal flow):
        events.handleEvent({ type: "message_chunk", text: "Let me " });

        // Then agent sends tool_call
        events.handleEvent({
          type: "tool_call",
          id: "tc-new",
          kind: "execute",
          title: "Run",
          rawInput: { command: "ls" },
        });

        assert.equal(state.pendingToolCallIds.has("tc-new"), true, "tool_call should not be dropped");
        assert.ok(document.getElementById("tc-tc-new"), "tool_call element should exist");

        // Same for permission_request
        events.handleEvent({
          type: "permission_request",
          requestId: "perm-new",
          title: "Allow?",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        });
        assert.ok(
          document.querySelector('.permission[data-request-id="perm-new"]'),
          "permission_request should not be dropped",
        );
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
          state.sessionId = "s1";
          state.busy = true;
          state.cancelTimeout = 0;

          stateMod.sendCancel();

          assert.equal(timeoutFns.length, 0, "should not schedule a timeout when disabled");
        });
      });

      it("agent events after cancel timeout do not re-set busy", () => {
        withMockTimers(({ timeoutFns }) => {
          state.sessionId = "s1";
          state.busy = true;
          state.cancelTimeout = 10_000;

          stateMod.sendCancel();

          // Fire the cancel timeout
          timeoutFns[0]();
          assert.equal(state.busy, false, "cancel timeout should clear busy");
          assert.equal(state.turnEnded, true, "cancel timeout should set turnEnded");

          // Agent keeps streaming (didn't acknowledge cancel)
          events.handleEvent({ type: "message_chunk", text: "still going " });
          assert.equal(state.turnEnded, true, "message_chunk should NOT reset turnEnded after cancel timeout");
          assert.equal(state.busy, false, "message_chunk should not set busy");

          events.handleEvent({ type: "thought_chunk", text: "thinking..." });
          assert.equal(state.turnEnded, true, "thought_chunk should NOT reset turnEnded after cancel timeout");

          // tool_call should be blocked by turnEnded guard
          events.handleEvent({
            type: "tool_call",
            id: "tc-stale",
            kind: "execute",
            title: "Run",
            rawInput: { command: "ls" },
          });
          assert.equal(state.busy, false, "tool_call should not re-set busy after cancel timeout");
          assert.equal(state.pendingToolCallIds.size, 0, "tool_call should be dropped");

          // permission_request should also be blocked
          events.handleEvent({
            type: "permission_request",
            requestId: "perm-stale",
            title: "Allow?",
            options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
          });
          assert.equal(state.busy, false, "permission_request should not re-set busy after cancel timeout");
        });
      });
    });

    describe("session_deleted", () => {
      it("auto-switches to next session when current is deleted", async () => {
        state.sessionId = "s1";
        const nextSession = { id: "s2", cwd: "/tmp", title: "Next", configOptions: [], busyKind: null };
        setFetch(async (url: string, init?: any) => {
          if (url === "/api/v1/sessions" && (!init?.method || init.method === "GET"))
            return { ok: true, text: async () => JSON.stringify([{ id: "s2" }]) };
          if (url === "/api/v1/sessions/s2")
            return { ok: true, text: async () => JSON.stringify(nextSession) };
          if (url.startsWith("/api/v1/sessions/s2/events"))
            return { ok: true, text: async () => '[]' };
          return { ok: true, text: async () => '{}' };
        });

        events.handleEvent({ type: "session_deleted", sessionId: "s1" });
        for (let i = 0; i < 30; i++) await Promise.resolve();
        assert.equal(state.sessionId, "s2");
        assert.equal(dom.input.disabled, false);
      });

      it("creates new session when current is deleted and no others exist", async () => {
        state.sessionId = "s1";
        setFetch(async (url: string, init?: any) => {
          if (url === "/api/v1/sessions" && (!init?.method || init.method === "GET"))
            return { ok: true, text: async () => '[]' };
          if (url === "/api/v1/sessions" && init?.method === "POST")
            return { ok: true, text: async () => JSON.stringify({ id: "new-1" }) };
          return { ok: true, text: async () => '{}' };
        });

        events.handleEvent({ type: "session_deleted", sessionId: "s1" });
        for (let i = 0; i < 30; i++) await Promise.resolve();
        assert.equal(state.awaitingNewSession, true);
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

    describe("cross-client turn boundary (cancel + new prompt)", () => {
      // NOTE: Use assert.ok(x === null) instead of assert.equal(x, null) when x might
      // be a DOM element — assert.equal tries to serialize DOM nodes for error messages,
      // which can hang happy-dom's event loop.

      it("user_message finalises in-progress assistant streaming (message ordering)", () => {
        state.sessionId = "s1";

        // Old prompt is streaming assistant text
        events.handleEvent({ type: "message_chunk", text: "old response " });
        assert.ok(state.currentAssistantEl, "should have an active assistant element");

        // Another client sends a new message (broadcast arrives)
        events.handleEvent({ type: "user_message", sessionId: "s1", text: "new question" });

        // The old assistant element should be finalised
        assert.ok(state.currentAssistantEl === null, "currentAssistantEl should be null after user_message");
        assert.equal(state.currentAssistantText, "", "currentAssistantText should be cleared");

        // New message_chunk should create a fresh element BELOW the user message
        events.handleEvent({ type: "message_chunk", text: "new response" });

        // DOM order: old assistant, user bubble, new assistant
        const children = [...dom.messages.children];
        assert.equal(children.length, 3);
        assert.ok(children[0].classList.contains("assistant"), "first child should be old assistant");
        assert.ok(children[1].classList.contains("user"), "second child should be user message");
        assert.ok(children[2].classList.contains("assistant"), "third child should be new assistant");
      });

      it("user_message finalises in-progress thinking element", () => {
        state.sessionId = "s1";

        // Old prompt is streaming thinking
        events.handleEvent({ type: "thought_chunk", text: "thinking..." });
        assert.ok(state.currentThinkingEl, "should have an active thinking element");

        // Another client sends a new message
        events.handleEvent({ type: "user_message", sessionId: "s1", text: "new question" });

        // Thinking element should be finalised
        assert.ok(state.currentThinkingEl === null, "currentThinkingEl should be null");
        assert.equal(state.currentThinkingText, "", "currentThinkingText should be cleared");
      });

      it("stale prompt_done(cancelled) does not clobber new turn state (stuck busy)", () => {
        state.sessionId = "s1";

        // New turn starts: another client sent a message
        events.handleEvent({ type: "user_message", sessionId: "s1", text: "new question" });
        assert.equal(state.turnEnded, false);

        // Agent starts responding to the new prompt
        events.handleEvent({ type: "message_chunk", text: "response " });

        // Agent sends a tool_call for the new prompt
        events.handleEvent({
          type: "tool_call",
          id: "tc-new",
          kind: "execute",
          title: "Run",
          rawInput: { command: "ls" },
        });
        assert.equal(state.busy, true);
        assert.equal(state.pendingToolCallIds.size, 1);

        // Stale prompt_done(cancelled) from the old prompt arrives late
        events.handleEvent({ type: "prompt_done", stopReason: "cancelled" });

        // The new turn's tool call should NOT be cleared
        assert.ok(state.pendingToolCallIds.has("tc-new"),
          "stale cancel should not clear new turn pending tool calls");
        assert.equal(state.busy, true,
          "stale cancel should not clear busy for the new turn");
      });

      it("stale prompt_done(cancelled) does not prevent new prompt_done from clearing busy", () => {
        state.sessionId = "s1";

        // New turn starts
        events.handleEvent({ type: "user_message", sessionId: "s1", text: "question" });
        events.handleEvent({
          type: "tool_call",
          id: "tc-a",
          kind: "execute",
          title: "Run",
          rawInput: { command: "ls" },
        });

        // Stale prompt_done(cancelled) from old turn arrives
        events.handleEvent({ type: "prompt_done", stopReason: "cancelled" });

        // Tool call completes
        events.handleEvent({ type: "tool_call_update", id: "tc-a", status: "completed" });

        // The real prompt_done for the new turn arrives
        events.handleEvent({ type: "prompt_done", stopReason: "end_turn" });

        // Busy should be cleared
        assert.equal(state.busy, false,
          "new prompt_done should clear busy even after a stale cancel");
        assert.equal(state.pendingPromptDone, false);
      });

      it("valid cancel on current turn still works normally", () => {
        state.sessionId = "s1";

        // Turn starts (user sent message locally, no user_message event on sender)
        events.handleEvent({ type: "message_chunk", text: "response" });
        events.handleEvent({
          type: "tool_call",
          id: "tc-x",
          kind: "execute",
          title: "Run",
          rawInput: { command: "ls" },
        });
        assert.equal(state.busy, true);

        // User cancels the current turn
        events.handleEvent({ type: "prompt_done", stopReason: "cancelled" });

        // Should clear pending state and busy (valid cancel for current turn)
        assert.equal(state.pendingToolCallIds.size, 0);
        assert.equal(state.busy, false);
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

      it("drops non-lifecycle events when sessionId is null (mid-switch)", () => {
        state.sessionId = null;
        events.handleEvent({ type: "user_message", sessionId: "s1", text: "leaked" });
        events.handleEvent({ type: "message_chunk", sessionId: "s1", text: "leaked" });
        assert.equal(dom.messages.children.length, 0);
        assert.equal(state.currentAssistantEl, null);
      });

      it("allows session_created when sessionId is null (mid-switch)", () => {
        state.sessionId = null;
        state.awaitingNewSession = true;
        events.handleEvent({ type: "session_created", sessionId: "new-s" });
        assert.equal(state.sessionId, "new-s");
      });
    });
  });

    describe("status_bar", () => {
      it("shows model and cwd after session_created", () => {
        state.awaitingNewSession = true;
        events.handleEvent({
          type: "session_created",
          sessionId: "s1",
          cwd: "/home/user/project",
          configOptions: [
            { id: "model", name: "Model", currentValue: "claude-sonnet", options: [] },
          ],
        });
        const text = dom.statusBar.textContent;
        assert.ok(text.includes("claude-sonnet"), "should show model");
        assert.ok(text.includes("/home/user/project"), "should show cwd");
      });

      it("renders full cwd in a dedicated span with CSS truncation class", () => {
        state.awaitingNewSession = true;
        events.handleEvent({
          type: "session_created",
          sessionId: "s1",
          cwd: "/Users/lelouch/mine/code/webagent",
          configOptions: [],
        });
        const cwdSpan = dom.statusBar.querySelector(".status-cwd");
        assert.ok(cwdSpan, "should have a .status-cwd span");
        assert.equal(cwdSpan.textContent, "/Users/lelouch/mine/code/webagent");
      });

      it("shows short cwd without truncation", () => {
        state.awaitingNewSession = true;
        events.handleEvent({
          type: "session_created",
          sessionId: "s1",
          cwd: "/home/user",
          configOptions: [],
        });
        assert.ok(dom.statusBar.textContent.includes("/home/user"));
      });

      it("updates when config_set changes model", () => {
        state.sessionId = "s1";
        state.configOptions = [
          { id: "model", name: "Model", currentValue: "old-model", options: [{ value: "new-model", name: "New" }] },
        ];
        events.handleEvent({ type: "config_set", configId: "model", value: "new-model" });
        assert.ok(dom.statusBar.textContent.includes("new-model"));
      });

      it("updates on config_option_update", () => {
        state.sessionId = "s1";
        events.handleEvent({
          type: "config_option_update",
          configOptions: [
            { id: "model", name: "Model", currentValue: "new-model", options: [] },
          ],
        });
        assert.ok(dom.statusBar.textContent.includes("new-model"));
      });

      it("cleared by resetSessionUI", () => {
        state.awaitingNewSession = true;
        events.handleEvent({
          type: "session_created",
          sessionId: "s1",
          cwd: "/home",
          configOptions: [{ id: "model", name: "Model", currentValue: "test", options: [] }],
        });
        assert.ok(dom.statusBar.textContent.length > 0, "precondition: not empty");
        stateMod.resetSessionUI();
        assert.equal(dom.statusBar.textContent, "");
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

    it("merges consecutive assistant_messages into one bubble", () => {
      events.replayEvent("assistant_message", { text: "Hello " }, [], 0);
      events.replayEvent("assistant_message", { text: "world" }, [], 1);
      const msgs = dom.messages.querySelectorAll(".msg.assistant");
      assert.equal(msgs.length, 1, "should merge into a single bubble");
      assert.ok(msgs[0].innerHTML.includes("Hello"));
      assert.ok(msgs[0].innerHTML.includes("world"));
    });

    it("does not merge assistant_messages separated by other events", () => {
      events.replayEvent("assistant_message", { text: "first" }, [], 0);
      events.replayEvent("thinking", { text: "hmm" }, [], 1);
      events.replayEvent("assistant_message", { text: "second" }, [], 2);
      const msgs = dom.messages.querySelectorAll(".msg.assistant");
      assert.equal(msgs.length, 2, "should remain separate bubbles");
    });

    it("replays thinking", () => {
      events.replayEvent("thinking", { text: "thoughts" }, [], 0);
      const thinking = dom.messages.querySelector(".thinking");
      assert.ok(thinking);
      assert.equal(thinking.querySelector("summary").textContent, "⠿ thought");
    });

    it("merges consecutive thinking blocks into one", () => {
      events.replayEvent("thinking", { text: "part one" }, [], 0);
      events.replayEvent("thinking", { text: "part two" }, [], 1);
      const thinkings = dom.messages.querySelectorAll(".thinking");
      assert.equal(thinkings.length, 1, "should merge into a single thinking block");
      const content = thinkings[0].querySelector(".thinking-content").textContent;
      assert.ok(content.includes("part one"));
      assert.ok(content.includes("part two"));
    });

    it("stores data-raw on thinking elements", () => {
      events.replayEvent("thinking", { text: "my thought" }, [], 0);
      const thinking = dom.messages.querySelector(".thinking");
      assert.equal(thinking.getAttribute("data-raw"), "my thought");
    });

    it("updates data-raw when consecutive thinking blocks merge", () => {
      events.replayEvent("thinking", { text: "part one" }, [], 0);
      events.replayEvent("thinking", { text: "part two" }, [], 1);
      const thinking = dom.messages.querySelector(".thinking");
      assert.equal(thinking.getAttribute("data-raw"), "part one\npart two");
    });

    it("replays tool_call and tool_call_update", () => {
      events.replayEvent("tool_call", { id: "t1", kind: "read", title: "Read", rawInput: {} }, [], 0);
      events.replayEvent("tool_call_update", { id: "t1", status: "completed" }, [], 1);
      const el = globalThis.document.getElementById("tc-t1");
      assert.ok(el.classList.contains("completed"));
    });

    it("replays task_complete with visible summary", () => {
      events.replayEvent("tool_call", { id: "t-tc", kind: "task_complete", title: "Task complete", rawInput: {} }, [], 0);
      events.replayEvent("tool_call_update", {
        id: "t-tc", status: "completed",
        content: [{ type: "text", content: { text: "Deployed to prod" } }],
      }, [], 1);
      const el = globalThis.document.getElementById("tc-t-tc");
      assert.ok(el.classList.contains("completed"));
      assert.ok(!el.querySelector("details"), "task_complete should not use collapsed details during replay");
      const summary = el.querySelector(".tc-summary");
      assert.ok(summary, "should have visible .tc-summary during replay");
      assert.ok(summary.textContent.includes("Deployed to prod"));
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

    it("sends limit parameter in fetch URL", async () => {
      let capturedUrl = "";
      globalThis.fetch = ((url: string) => {
        capturedUrl = url;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ events: [], streaming: { thinking: false, assistant: false } }),
        });
      }) as any;

      await events.loadHistory("s1");
      assert.ok(capturedUrl.includes("limit="), "should include limit param");
    });

    it("sets pagination state from paginated response", async () => {
      const fakeEvents = [
        { seq: 50, type: "user_message", data: JSON.stringify({ text: "hi" }) },
        { seq: 51, type: "assistant_message", data: JSON.stringify({ text: "hello" }) },
      ];
      globalThis.fetch = (() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          events: fakeEvents,
          streaming: { thinking: false, assistant: false },
          total: 100,
          hasMore: true,
        }),
      })) as any;

      await events.loadHistory("s1");
      assert.equal(state.lastEventSeq, 51);
      assert.equal(state.oldestLoadedSeq, 50);
      assert.equal(state.hasMoreHistory, true);
    });

    it("sets hasMoreHistory=false when all events fit in one page", async () => {
      const fakeEvents = [
        { seq: 1, type: "user_message", data: JSON.stringify({ text: "only" }) },
      ];
      globalThis.fetch = (() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          events: fakeEvents,
          streaming: { thinking: false, assistant: false },
          total: 1,
          hasMore: false,
        }),
      })) as any;

      await events.loadHistory("s1");
      assert.equal(state.hasMoreHistory, false);
      assert.equal(state.oldestLoadedSeq, 1);
    });
  });

  describe("loadOlderEvents", () => {
    it("prepends older events and updates pagination state", async () => {
      // Set up initial state as if loadHistory loaded events 5-6
      state.oldestLoadedSeq = 5;
      state.hasMoreHistory = true;
      state.sessionId = "s1";
      events.replayEvent("user_message", { text: "msg-5" }, [], 0);
      events.replayEvent("assistant_message", { text: "msg-6" }, [], 0);

      const olderEvents = [
        { seq: 3, type: "user_message", data: JSON.stringify({ text: "msg-3" }) },
        { seq: 4, type: "assistant_message", data: JSON.stringify({ text: "msg-4" }) },
      ];
      globalThis.fetch = ((url: string) => {
        assert.ok(url.includes("before=5"), "should use before cursor");
        assert.ok(url.includes("limit="), "should include limit");
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            events: olderEvents,
            streaming: { thinking: false, assistant: false },
            total: 6,
            hasMore: true,
          }),
        });
      }) as any;

      const result = await events.loadOlderEvents("s1");
      assert.equal(result, true);
      assert.equal(state.oldestLoadedSeq, 3);
      assert.equal(state.hasMoreHistory, true);
      // Should have 4 children: 2 prepended + 2 original
      assert.equal(dom.messages.children.length, 4);
    });

    it("removes sentinel and sets hasMoreHistory=false when no more events", async () => {
      state.oldestLoadedSeq = 3;
      state.hasMoreHistory = true;
      state.sessionId = "s1";
      events.replayEvent("user_message", { text: "existing" }, [], 0);

      globalThis.fetch = (() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          events: [{ seq: 1, type: "user_message", data: JSON.stringify({ text: "first" }) }],
          streaming: { thinking: false, assistant: false },
          hasMore: false,
        }),
      })) as any;

      await events.loadOlderEvents("s1");
      assert.equal(state.hasMoreHistory, false);
      assert.equal(state.oldestLoadedSeq, 1);
    });

    it("returns false when no more history", async () => {
      state.hasMoreHistory = false;
      const result = await events.loadOlderEvents("s1");
      assert.equal(result, false);
    });

    it("prevents concurrent loads", async () => {
      state.oldestLoadedSeq = 10;
      state.hasMoreHistory = true;
      state.loadingOlderEvents = true;
      const result = await events.loadOlderEvents("s1");
      assert.equal(result, false);
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
        assert.ok(url.includes("after=1"));
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

    it("clears replayInProgress even when returning early for empty events", async () => {
      state.lastEventSeq = 1;
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve([]),
      })) as any;

      await events.loadNewEvents("s1");
      assert.equal(state.replayInProgress, false);
      assert.deepEqual(state.replayQueue, []);
    });

    it("removes orphaned post-boundary elements even when no new events exist", async () => {
      // Simulate: loadHistory rendered 1 event, then live streaming added an element
      events.replayEvent("user_message", { text: "from-db" }, [], 0);
      state.lastEventSeq = 1;
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");

      // Simulate a live-streamed assistant element (added after boundary during streaming)
      const liveEl = globalThis.document.createElement("div");
      liveEl.className = "msg assistant";
      liveEl.textContent = "partial stream content";
      dom.messages.appendChild(liveEl);
      assert.equal(dom.messages.children.length, 2);

      // Simulate disconnect: finishAssistant clears state but not DOM
      state.currentAssistantEl = null;
      state.currentAssistantText = "";

      // Reconnect: loadNewEvents returns empty (buffer not flushed yet)
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve([]),
      })) as any;

      await events.loadNewEvents("s1");

      // The orphaned post-boundary element should have been removed
      assert.equal(dom.messages.children.length, 1);
      assert.ok(dom.messages.children[0].textContent.includes("from-db"));
    });
  });

  describe("primeStreamingState and revert (duplicate message fix)", () => {
    it("primeStreamingState sets data-primed on adopted assistant element", async () => {
      const fakeEvents = [
        { seq: 1, type: "user_message", data: JSON.stringify({ text: "hi" }) },
        { seq: 2, type: "assistant_message", data: JSON.stringify({ text: "hello" }) },
      ];
      const response = { events: fakeEvents, streaming: { thinking: false, assistant: true } };
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(response),
      })) as any;

      await events.loadHistory("s1");
      const el = dom.messages.querySelector(".msg.assistant");
      assert.ok(el.hasAttribute("data-primed"), "primed element should have data-primed");
      assert.ok(state.currentAssistantEl === el);
    });

    it("primeStreamingState sets data-primed on adopted thinking element", async () => {
      const fakeEvents = [
        { seq: 1, type: "user_message", data: JSON.stringify({ text: "hi" }) },
        { seq: 2, type: "thinking", data: JSON.stringify({ text: "hmm" }) },
      ];
      const response = { events: fakeEvents, streaming: { thinking: true, assistant: false } };
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(response),
      })) as any;

      await events.loadHistory("s1");
      const el = dom.messages.querySelector(".thinking");
      assert.ok(el.hasAttribute("data-primed"), "primed thinking should have data-primed");
      assert.ok(state.currentThinkingEl === el);
    });

    it("primeStreamingState reads data-raw for currentAssistantText (merged content)", async () => {
      // Two consecutive assistant_messages get merged; data-raw holds combined text
      const fakeEvents = [
        { seq: 1, type: "assistant_message", data: JSON.stringify({ text: "Hello " }) },
        { seq: 2, type: "assistant_message", data: JSON.stringify({ text: "world" }) },
      ];
      const response = { events: fakeEvents, streaming: { thinking: false, assistant: true } };
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(response),
      })) as any;

      await events.loadHistory("s1");
      // data-raw should be combined, and currentAssistantText should match
      assert.equal(state.currentAssistantText, "Hello world");
    });

    it("primeStreamingState reads data-raw for currentThinkingText (merged content)", async () => {
      const fakeEvents = [
        { seq: 1, type: "thinking", data: JSON.stringify({ text: "part one" }) },
        { seq: 2, type: "thinking", data: JSON.stringify({ text: "part two" }) },
      ];
      const response = { events: fakeEvents, streaming: { thinking: true, assistant: false } };
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(response),
      })) as any;

      await events.loadHistory("s1");
      assert.equal(state.currentThinkingText, "part one\npart two");
    });

    it("loadNewEvents reverts primed assistant element before replaying", async () => {
      // Setup: loadHistory primes an assistant element
      const historyEvents = [
        { seq: 1, type: "assistant_message", data: JSON.stringify({ text: "original" }) },
      ];
      const histResponse = { events: historyEvents, streaming: { thinking: false, assistant: true } };
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(histResponse),
      })) as any;
      await events.loadHistory("s1");

      // Simulate live streaming that grew the element beyond DB content
      state.currentAssistantText = "original plus more streamed text";
      state.currentAssistantEl.innerHTML = "<p>original plus more streamed text</p>";

      // Now loadNewEvents — server flushed buffer, returns tail as new event
      const newEvents = [
        { seq: 2, type: "assistant_message", data: JSON.stringify({ text: " plus more streamed text" }) },
      ];
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(newEvents),
      })) as any;
      await events.loadNewEvents("s1");

      // Should have exactly ONE assistant element with merged content (no duplication)
      const assistants = dom.messages.querySelectorAll(".msg.assistant");
      assert.equal(assistants.length, 1, "should not duplicate assistant message");
      assert.ok(assistants[0].textContent.includes("original"));
      assert.ok(assistants[0].textContent.includes("plus more streamed text"));
    });

    it("loadNewEvents reverts primed thinking element before replaying", async () => {
      const historyEvents = [
        { seq: 1, type: "thinking", data: JSON.stringify({ text: "initial thought" }) },
      ];
      const histResponse = { events: historyEvents, streaming: { thinking: true, assistant: false } };
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(histResponse),
      })) as any;
      await events.loadHistory("s1");

      // Simulate live streaming that grew the thinking element
      state.currentThinkingText = "initial thought\nmore thinking";
      const content = state.currentThinkingEl.querySelector(".thinking-content");
      content.textContent = "initial thought\nmore thinking";

      // Server returns flushed tail
      const newEvents = [
        { seq: 2, type: "thinking", data: JSON.stringify({ text: "more thinking" }) },
      ];
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(newEvents),
      })) as any;
      await events.loadNewEvents("s1");

      const thinkings = dom.messages.querySelectorAll(".thinking");
      assert.equal(thinkings.length, 1, "should not duplicate thinking block");
      const text = thinkings[0].querySelector(".thinking-content").textContent;
      assert.ok(text.includes("initial thought"));
      assert.ok(text.includes("more thinking"));
    });

    it("loadNewEvents handles primed element when boundary is not the primed element", async () => {
      // Boundary is a tool_call, primed element is the earlier assistant
      const historyEvents = [
        { seq: 1, type: "assistant_message", data: JSON.stringify({ text: "before tool" }) },
        { seq: 2, type: "tool_call", data: JSON.stringify({ id: "tc1", kind: "read", title: "Read", rawInput: {} }) },
      ];
      const histResponse = { events: historyEvents, streaming: { thinking: false, assistant: true } };
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(histResponse),
      })) as any;
      await events.loadHistory("s1");

      // The primed element should be the assistant (not the tool_call boundary)
      assert.ok(state.currentAssistantEl);
      assert.ok(state.currentAssistantEl.classList.contains("assistant"));

      // Simulate streaming that grew the assistant element
      state.currentAssistantText = "before tool and more";
      state.currentAssistantEl.innerHTML = "<p>before tool and more</p>";

      // Server returns the streamed tail as a new assistant_message
      const newEvents = [
        { seq: 3, type: "assistant_message", data: JSON.stringify({ text: " and more" }) },
      ];
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(newEvents),
      })) as any;
      await events.loadNewEvents("s1");

      // The primed assistant should be reverted to "before tool" (its data-raw)
      // The new event creates a separate assistant after the tool_call (non-adjacent, M6)
      const assistants = dom.messages.querySelectorAll(".msg.assistant");
      assert.equal(assistants.length, 2, "non-adjacent: reverted original + new after tool_call");
      assert.ok(assistants[0].textContent.includes("before tool"));
      assert.ok(!assistants[0].textContent.includes("and more"), "reverted element should not contain streamed tail");
      assert.ok(assistants[1].textContent.includes("and more"));
    });

    it("finishAssistant clears data-primed attribute", async () => {
      const fakeEvents = [
        { seq: 1, type: "assistant_message", data: JSON.stringify({ text: "hello" }) },
      ];
      const response = { events: fakeEvents, streaming: { thinking: false, assistant: true } };
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(response),
      })) as any;
      await events.loadHistory("s1");

      const el = dom.messages.querySelector(".msg.assistant");
      assert.ok(el.hasAttribute("data-primed"));

      // Simulate stream finishing
      render.finishAssistant();
      assert.ok(!el.hasAttribute("data-primed"), "data-primed should be cleared on finish");
    });

    it("finishThinking clears data-primed attribute", async () => {
      const fakeEvents = [
        { seq: 1, type: "thinking", data: JSON.stringify({ text: "hmm" }) },
      ];
      const response = { events: fakeEvents, streaming: { thinking: true, assistant: false } };
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(response),
      })) as any;
      await events.loadHistory("s1");

      const el = dom.messages.querySelector(".thinking");
      assert.ok(el.hasAttribute("data-primed"));

      render.finishThinking();
      assert.ok(!el.hasAttribute("data-primed"), "data-primed should be cleared on finish");
    });

    it("loadNewEvents with empty events and streaming re-primes from boundary", async () => {
      // Setup: loadHistory with streaming assistant
      const historyEvents = [
        { seq: 1, type: "assistant_message", data: JSON.stringify({ text: "hello" }) },
      ];
      const histResponse = { events: historyEvents, streaming: { thinking: false, assistant: true } };
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(histResponse),
      })) as any;
      await events.loadHistory("s1");
      assert.ok(state.currentAssistantEl);

      // Simulate streaming grew the element
      state.currentAssistantText = "hello world";
      state.currentAssistantEl.innerHTML = "<p>hello world</p>";

      // loadNewEvents returns no new events but streaming is still true
      const response = { events: [], streaming: { thinking: false, assistant: true } };
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(response),
      })) as any;
      await events.loadNewEvents("s1");

      // Should still have the assistant element primed for continued streaming
      assert.ok(state.currentAssistantEl, "should re-prime assistant from boundary");
      assert.equal(dom.messages.querySelectorAll(".msg.assistant").length, 1);
    });

    it("per-session coalesce returns same promise for concurrent calls", async () => {
      events.replayEvent("user_message", { text: "msg" }, [], 0);
      state.lastEventSeq = 1;
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");

      let resolveFirst: Function;
      let fetchCount = 0;
      globalThis.fetch = (() => {
        fetchCount++;
        return new Promise(r => { resolveFirst = r; });
      }) as any;

      // Two concurrent calls for same session
      const p1 = events.loadNewEvents("s1");
      const p2 = events.loadNewEvents("s1");

      // Should be the same promise (coalesced)
      assert.equal(p1, p2, "concurrent calls for same session should coalesce");
      assert.equal(fetchCount, 1, "should only fetch once");

      resolveFirst!({ ok: true, json: () => Promise.resolve([]) });
      await p1;
    });

    it("per-session coalesce allows independent sessions", async () => {
      events.replayEvent("user_message", { text: "msg" }, [], 0);
      state.lastEventSeq = 1;
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");

      let fetchCount = 0;
      globalThis.fetch = (() => {
        fetchCount++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }) as any;

      // Calls for different sessions should NOT coalesce
      const p1 = events.loadNewEvents("s1");
      const p2 = events.loadNewEvents("s2");

      assert.notEqual(p1, p2, "different sessions should not coalesce");
      assert.equal(fetchCount, 2, "should fetch for each session");

      await Promise.all([p1, p2]);
    });

    it("reverts both thinking and assistant when both are primed simultaneously", async () => {
      const historyEvents = [
        { seq: 1, type: "thinking", data: JSON.stringify({ text: "thought" }) },
        { seq: 2, type: "assistant_message", data: JSON.stringify({ text: "reply" }) },
      ];
      const histResponse = { events: historyEvents, streaming: { thinking: true, assistant: true } };
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(histResponse),
      })) as any;
      await events.loadHistory("s1");

      assert.ok(state.currentThinkingEl, "thinking should be primed");
      assert.ok(state.currentAssistantEl, "assistant should be primed");
      assert.ok(dom.messages.querySelector(".thinking").hasAttribute("data-primed"));
      assert.ok(dom.messages.querySelector(".msg.assistant").hasAttribute("data-primed"));

      // Simulate live streaming grew both elements
      state.currentThinkingText = "thought extended";
      state.currentThinkingEl.querySelector(".thinking-content").textContent = "thought extended";
      state.currentAssistantText = "reply extended";
      state.currentAssistantEl.innerHTML = "<p>reply extended</p>";

      // Server returns flushed tail for assistant only (thinking → assistant → tail)
      const newEvents = [
        { seq: 3, type: "assistant_message", data: JSON.stringify({ text: " extended" }) },
      ];
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(newEvents),
      })) as any;
      state.sessionId = "s1";
      await events.loadNewEvents("s1");

      // Both primed elements should have been reverted to DB content
      const thinkings = dom.messages.querySelectorAll(".thinking");
      const assistants = dom.messages.querySelectorAll(".msg.assistant");
      assert.equal(thinkings.length, 1, "should not duplicate thinking");
      assert.equal(assistants.length, 1, "should not duplicate assistant");
      // Thinking reverted to original DB content
      assert.equal(thinkings[0].querySelector(".thinking-content").textContent, "thought");
      // Assistant merged: reverted "reply" + new " extended"
      assert.ok(assistants[0].textContent.includes("reply"));
      assert.ok(assistants[0].textContent.includes("extended"));
    });

    it("loadNewEvents discards results when session switched during fetch", async () => {
      events.replayEvent("user_message", { text: "msg" }, [], 0);
      state.lastEventSeq = 1;
      state.sessionId = "s1";
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");

      let resolveFetch: Function;
      globalThis.fetch = (() => new Promise(r => { resolveFetch = r; })) as any;

      const promise = events.loadNewEvents("s1");

      // Session switches while fetch is in-flight
      state.sessionId = "s2";

      resolveFetch!({ ok: true, json: () => Promise.resolve([
        { seq: 2, type: "assistant_message", data: JSON.stringify({ text: "stale" }) },
      ]) });

      const result = await promise;
      assert.equal(result, false, "should return false when session switched");
      // DOM should not have the stale event
      assert.equal(dom.messages.querySelectorAll(".msg.assistant").length, 0);
    });
  });

  describe("loadNewEvents clears pending state from replayed events", () => {
    it("clears pendingToolCallIds for tool_call_updates replayed from DB", async () => {
      // Simulate: live session had a tool_call that was added to pendingToolCallIds
      events.replayEvent("user_message", { text: "hi" }, [], 0);
      state.lastEventSeq = 1;
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");

      // Simulate a tool_call received via live WS before disconnect
      state.sessionId = "s1";
      state.pendingToolCallIds.add("tc-live");
      const tcEl = globalThis.document.createElement("div");
      tcEl.className = "tool-call";
      tcEl.id = "tc-tc-live";
      tcEl.innerHTML = '<span class="icon">run</span> Do something';
      dom.messages.appendChild(tcEl);

      // Now reconnect — loadNewEvents replays tool_call_update from DB
      const newEvents = [
        { seq: 2, type: "tool_call_update", data: JSON.stringify({ id: "tc-live", status: "completed" }) },
        { seq: 3, type: "prompt_done", data: JSON.stringify({ stopReason: "end_turn" }) },
      ];
      globalThis.fetch = (() => Promise.resolve({
        ok: true, json: () => Promise.resolve(newEvents),
      })) as any;

      await events.loadNewEvents("s1");

      // The pending tool call should be cleared so prompt_done can finish
      assert.equal(state.pendingToolCallIds.size, 0);
      // busy should be false (prompt_done could call finishPromptIfIdle)
      assert.equal(state.busy, false);
    });
  });

  describe("replay queue (dedup on reconnect)", () => {
    it("queues WS events arriving during loadHistory and drains after", async () => {
      const fakeEvents = [
        { seq: 1, type: "user_message", data: JSON.stringify({ text: "hi" }) },
      ];

      let resolveFetch: Function;
      globalThis.fetch = (() => new Promise(r => { resolveFetch = r; })) as any;

      state.sessionId = "s1";
      const historyPromise = events.loadHistory("s1");

      // While fetch is in-flight, simulate a WS event arriving
      assert.equal(state.replayInProgress, true);
      events.handleEvent({ type: "message_chunk", sessionId: "s1", text: "hello" });
      assert.equal(state.replayQueue.length, 1);
      // It should NOT have created a DOM element yet
      assert.equal(dom.messages.children.length, 0);

      // Now resolve the fetch
      resolveFetch!({ ok: true, json: () => Promise.resolve(fakeEvents) });
      await historyPromise;

      // After drain: history replay created user_message, queue drained message_chunk
      assert.equal(state.replayInProgress, false);
      assert.equal(dom.messages.children.length, 2);
      assert.ok(dom.messages.children[0].textContent.includes("hi"));
      // message_chunk creates an assistant element
      assert.ok(dom.messages.children[1].classList.contains("assistant"));
    });

    it("deduplicates tool_call events that were both replayed and queued", async () => {
      const fakeEvents = [
        { seq: 1, type: "tool_call", data: JSON.stringify({ id: "tc1", title: "Read file", kind: "read", rawInput: {} }) },
      ];

      let resolveFetch: Function;
      globalThis.fetch = (() => new Promise(r => { resolveFetch = r; })) as any;

      state.sessionId = "s1";
      const historyPromise = events.loadHistory("s1");

      // Simulate the same tool_call arriving via WS while replay is in-flight
      events.handleEvent({
        type: "tool_call", sessionId: "s1", id: "tc1", title: "Read file", kind: "read", rawInput: {},
      });
      assert.equal(state.replayQueue.length, 1);

      resolveFetch!({ ok: true, json: () => Promise.resolve(fakeEvents) });
      await historyPromise;

      // Only one tool_call element should exist (deduped)
      const toolCalls = dom.messages.querySelectorAll("#tc-tc1");
      assert.equal(toolCalls.length, 1);
    });

    it("deduplicates permission_request events that were both replayed and queued", async () => {
      const fakeEvents = [
        {
          seq: 1,
          type: "permission_request",
          data: JSON.stringify({
            requestId: "perm1",
            title: "Run command",
            options: [{ optionId: "o1", name: "Allow", kind: "allow_once" }],
          }),
        },
        {
          seq: 2,
          type: "permission_response",
          data: JSON.stringify({ requestId: "perm1", optionName: "Allow", denied: false }),
        },
      ];

      let resolveFetch: Function;
      globalThis.fetch = (() => new Promise(r => { resolveFetch = r; })) as any;

      state.sessionId = "s1";
      const historyPromise = events.loadHistory("s1");

      // Same permission_request arrives via WS
      events.handleEvent({
        type: "permission_request", sessionId: "s1", requestId: "perm1",
        title: "Run command", options: [{ optionId: "o1", name: "Allow", kind: "allow_once" }],
      });

      resolveFetch!({ ok: true, json: () => Promise.resolve(fakeEvents) });
      await historyPromise;

      const perms = dom.messages.querySelectorAll('.permission[data-request-id="perm1"]');
      assert.equal(perms.length, 1);
    });

    it("lets non-duplicate queued events through after replay", async () => {
      const fakeEvents = [
        { seq: 1, type: "user_message", data: JSON.stringify({ text: "hi" }) },
      ];

      let resolveFetch: Function;
      globalThis.fetch = (() => new Promise(r => { resolveFetch = r; })) as any;

      state.sessionId = "s1";
      const historyPromise = events.loadHistory("s1");

      // A tool_call for a NEW id that isn't in the history
      events.handleEvent({
        type: "tool_call", sessionId: "s1", id: "tc-new", title: "New tool", kind: "execute", rawInput: {},
      });

      resolveFetch!({ ok: true, json: () => Promise.resolve(fakeEvents) });
      await historyPromise;

      // user_message from history + new tool_call from queue
      assert.equal(dom.messages.children.length, 2);
      assert.ok(document.getElementById("tc-tc-new"));
    });

    it("queues events during loadNewEvents and drains after", async () => {
      // Set up existing DOM from a prior load
      events.replayEvent("user_message", { text: "old" }, [], 0);
      state.lastEventSeq = 1;
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");

      const newEvents = [
        { seq: 2, type: "tool_call", data: JSON.stringify({ id: "tc2", title: "Edit", kind: "edit", rawInput: {} }) },
      ];

      let resolveFetch: Function;
      globalThis.fetch = (() => new Promise(r => { resolveFetch = r; })) as any;

      state.sessionId = "s1";
      const promise = events.loadNewEvents("s1");

      // Duplicate tool_call arrives via WS
      events.handleEvent({
        type: "tool_call", sessionId: "s1", id: "tc2", title: "Edit", kind: "edit", rawInput: {},
      });

      resolveFetch!({ ok: true, json: () => Promise.resolve(newEvents) });
      await promise;

      // Only one tc-tc2 element
      assert.equal(dom.messages.querySelectorAll("#tc-tc2").length, 1);
      assert.equal(state.replayInProgress, false);
    });

    it("deduplicates thought_chunk events when streaming.thinking is signaled", async () => {
      // Simulate: agent is mid-thinking, events API flushed the buffer
      const fakeEvents = [
        { seq: 1, type: "user_message", data: JSON.stringify({ text: "hi" }) },
        { seq: 2, type: "thinking", data: JSON.stringify({ text: "partial thought" }) },
      ];
      const response = { events: fakeEvents, streaming: { thinking: true, assistant: false } };

      let resolveFetch: Function;
      globalThis.fetch = (() => new Promise(r => { resolveFetch = r; })) as any;

      state.sessionId = "s1";
      const historyPromise = events.loadHistory("s1");

      // thought_chunk arrives via SSE while replay is in-flight (duplicate content)
      events.handleEvent({ type: "thought_chunk", sessionId: "s1", text: "partial thought" });
      assert.equal(state.replayQueue.length, 1);

      resolveFetch!({ ok: true, json: () => Promise.resolve(response) });
      await historyPromise;

      // Should have exactly ONE thinking element (not two)
      const thinkingEls = dom.messages.querySelectorAll(".thinking");
      assert.equal(thinkingEls.length, 1);
      // The element should be primed for continued streaming
      assert.ok(state.currentThinkingEl, "currentThinkingEl should be primed");
      assert.equal(state.currentThinkingText, "partial thought");
    });

    it("deduplicates message_chunk events when streaming.assistant is signaled", async () => {
      const fakeEvents = [
        { seq: 1, type: "user_message", data: JSON.stringify({ text: "hi" }) },
        { seq: 2, type: "assistant_message", data: JSON.stringify({ text: "hello" }) },
      ];
      const response = { events: fakeEvents, streaming: { thinking: false, assistant: true } };

      let resolveFetch: Function;
      globalThis.fetch = (() => new Promise(r => { resolveFetch = r; })) as any;

      state.sessionId = "s1";
      const historyPromise = events.loadHistory("s1");

      events.handleEvent({ type: "message_chunk", sessionId: "s1", text: "hello" });

      resolveFetch!({ ok: true, json: () => Promise.resolve(response) });
      await historyPromise;

      // One user message + one assistant message (not duplicated)
      const assistantEls = dom.messages.querySelectorAll(".msg.assistant");
      assert.equal(assistantEls.length, 1);
      assert.ok(state.currentAssistantEl, "currentAssistantEl should be primed");
    });

    it("allows new thought_chunk through when no streaming was signaled", async () => {
      // Non-streaming case: agent starts thinking AFTER replay finishes
      const fakeEvents = [
        { seq: 1, type: "user_message", data: JSON.stringify({ text: "hi" }) },
      ];

      let resolveFetch: Function;
      globalThis.fetch = (() => new Promise(r => { resolveFetch = r; })) as any;

      state.sessionId = "s1";
      const historyPromise = events.loadHistory("s1");

      events.handleEvent({ type: "thought_chunk", sessionId: "s1", text: "new thought" });

      resolveFetch!({ ok: true, json: () => Promise.resolve(fakeEvents) });
      await historyPromise;

      // No streaming signal → thought_chunk should create a new thinking element
      const thinkingEls = dom.messages.querySelectorAll(".thinking");
      assert.equal(thinkingEls.length, 1);
      assert.ok(state.currentThinkingEl);
      assert.equal(state.currentThinkingText, "new thought");
    });
  });

  describe("retryUnconfirmedPermissions", () => {
    it("resends response for a still-pending permission after reconnect", () => {
      state.sessionId = "s1";

      // Simulate a permission that was responded to but never confirmed
      state.unconfirmedPermissions.set("perm-retry", {
        sessionId: "s1",
        optionId: "allow",
        optionName: "Allow Once",
        denied: false,
      });

      // Create a pending permission element in DOM (as if replayed from DB without response)
      const el = document.createElement("div");
      el.className = "permission";
      el.dataset.requestId = "perm-retry";
      el.dataset.title = "Execute ls";
      el.innerHTML = '<span class="title">⚿ Execute ls</span> ';
      const btn = document.createElement("button");
      btn.textContent = "Allow Once";
      el.appendChild(btn);
      dom.messages.appendChild(el);

      events.retryUnconfirmedPermissions();

      // Should have sent a REST call to resolve the permission
      const call = fetchCalls.find(c => c.url.includes("/api/v1/sessions/s1/permissions/perm-retry") && c.init?.method === "POST");
      assert.ok(call, "expected POST to /api/v1/sessions/s1/permissions/perm-retry");
      const body = JSON.parse(call!.init.body);
      assert.equal(body.optionId, "allow");
      // Should have optimistically resolved the UI
      assert.equal(el.querySelectorAll("button").length, 0);
      assert.ok(el.textContent!.includes("Execute ls"));
      assert.ok(el.textContent!.includes("Allow Once"));
      // Should have cleaned up
      assert.equal(state.unconfirmedPermissions.has("perm-retry"), false);
    });

    it("skips already-resolved permission", () => {
      state.sessionId = "s1";

      state.unconfirmedPermissions.set("perm-ok", {
        sessionId: "s1",
        optionId: "allow",
        optionName: "Allow",
        denied: false,
      });

      // Create a resolved permission element (no buttons)
      const el = document.createElement("div");
      el.className = "permission";
      el.dataset.requestId = "perm-ok";
      el.innerHTML = '<span style="opacity:0.5">⚿ Allow? — Allow</span>';
      dom.messages.appendChild(el);

      events.retryUnconfirmedPermissions();

      // No permission REST calls — already resolved
      const permCalls = fetchCalls.filter(c => c.url.includes("/api/v1/sessions/s1/permissions/"));
      assert.equal(permCalls.length, 0);
      assert.equal(state.unconfirmedPermissions.has("perm-ok"), false);
    });

    it("cleans up when permission element no longer exists", () => {
      state.sessionId = "s1";

      state.unconfirmedPermissions.set("perm-gone", {
        sessionId: "s1",
        optionId: "allow",
        optionName: "Allow",
        denied: false,
      });

      // No matching element in DOM
      events.retryUnconfirmedPermissions();

      const permCalls = fetchCalls.filter(c => c.url.includes("/api/v1/sessions/s1/permissions/"));
      assert.equal(permCalls.length, 0);
      assert.equal(state.unconfirmedPermissions.has("perm-gone"), false);
    });
  });

  describe("agent reload events", () => {
    it("agent_reloading sets busy and shows system message", () => {
      state.sessionId = "s1";
      events.handleEvent({ type: "agent_reloading" });

      assert.equal(state.busy, true);
      assert.equal(state.agentReloading, true);
      const msgs = [...dom.messages.children].map((el: any) => el.textContent);
      assert.ok(msgs.some(m => m.includes("reloading")));
    });

    it("connected after agent_reloading shows reloaded message and clears busy", () => {
      state.sessionId = "s1";
      state.agentReloading = true;
      state.busy = true;

      events.handleEvent({
        type: "connected",
        agent: { name: "mock-agent", version: "2.0" },
        configOptions: [],
      });

      assert.equal(state.agentReloading, false);
      assert.equal(state.busy, false);
      const msgs = [...dom.messages.children].map((el: any) => el.textContent);
      assert.ok(msgs.some(m => m.includes("reloaded")));
    });

    it("agent_reloading_failed shows error and clears busy", () => {
      state.sessionId = "s1";
      state.agentReloading = true;
      state.busy = true;

      events.handleEvent({ type: "agent_reloading_failed", error: "broken binary" });

      assert.equal(state.busy, false);
      const msgs = [...dom.messages.children].map((el: any) => el.textContent);
      assert.ok(msgs.some(m => m.includes("broken binary")));
    });
  });
});
