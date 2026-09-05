import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

/* eslint-disable @typescript-eslint/no-unsafe-function-type -- Promise resolver pattern uses generic Function type */

describe("events", () => {
  let state: any;
  let dom: any;
  let render: any;
  let events: any;
  let stateMod: any;
  let fetchCalls: Array<{ url: string; init?: any }>;

  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  function setFetch(handler: (url: string, init?: any) => Promise<any> | any) {
    (globalThis as any).fetch = async (url: string, init?: any) => {
      fetchCalls.push({ url, init });
      return handler(url, init);
    };
  }

  function applyPlanSnapshot(
    plan: Array<{ content: string; status: string }> | null,
    seq = 1,
  ) {
    stateMod.applySnapshot({
      version: 1,
      seq,
      task: {
        id: "s1",
        title: null,
        cwd: "/tmp",
        model: null,
        mode: null,
        createdAt: null,
        lastEventSeq: 0,
      },
      runtime: { busy: null, plan },
    });
  }

  before(async () => {
    setupDOM();
    stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    render = await import("../public/js/render.ts");
    events = await import("../public/js/events.ts");
  });
  after(() => {
    teardownDOM();
  });
  beforeEach(() => {
    stateMod.resetTaskUI();
    resetState(state, dom);
    fetchCalls = [];
    setFetch(() => ({
      ok: true,
      json: async () => ({}),
      text: async () => "{}",
    }));
  });

  describe("handleEvent", () => {
    it("renders a sequenced live assistant summary only once", () => {
      state.taskId = "s1";
      state.lastEventSeq = 10;
      const summary = {
        type: "assistant_message" as const,
        taskId: "s1",
        text: "handoff summary",
        seq: 11,
      };

      events.handleEvent(summary);
      events.handleEvent(summary);

      assert.equal(dom.messages.querySelectorAll(".msg.assistant").length, 1);
      assert.equal(dom.messages.textContent, "handoff summary");
      assert.equal(state.lastEventSeq, 11);
    });

    describe("task_created", () => {
      it("lets a new-task request supersede a pending navigation", () => {
        state.pendingNavigationTaskId = "old-target";
        state.awaitingNewTask = true;
        stateMod.resetTaskUI();

        events.handleEvent({
          type: "task_created",
          taskId: "new-task",
          cwd: "/tmp",
          configOptions: [],
        });

        assert.equal(state.pendingNavigationTaskId, null);
        assert.equal(state.taskId, "new-task");
      });

      it("sets task state when awaiting", () => {
        state.awaitingNewTask = true;
        events.handleEvent({
          type: "task_created",
          taskId: "s1",
          cwd: "/home",
          title: "Test Task",
          configOptions: [
            { id: "model", name: "Model", currentValue: "x", options: [] },
          ],
        });
        assert.equal(state.taskId, "s1");
        assert.equal(state.taskCwd, "/home");
        assert.equal(state.taskTitle, "Test Task");
        assert.equal(state.awaitingNewTask, false);
        assert.equal(dom.status.dataset.state, "connected");
        assert.equal(dom.status.getAttribute("aria-label"), "connected");
      });

      it("recovers a committed create when its HTTP response is interrupted", async () => {
        let rejectCreate!: (reason: Error) => void;
        let clientOpId = "";
        setFetch((_url: string, init?: RequestInit) => {
          clientOpId = new Headers(init?.headers).get("X-Client-Op-Id") ?? "";
          return new Promise((_resolve, reject) => {
            rejectCreate = reject;
          });
        });

        stateMod.requestNewTask();
        assert.ok(clientOpId);
        events.handleEvent({
          type: "task_created",
          taskId: "committed-task",
          cwd: "/committed",
          configOptions: [],
          clientOpId,
        });
        rejectCreate(new Error("response interrupted"));
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(state.taskId, "committed-task");
        assert.equal(state.awaitingNewTask, false);
        assert.equal(state.pendingNewTaskOpId, null);
      });

      it("rejects unrelated creates during interrupted-response recovery", async () => {
        let rejectCreate!: (reason: Error) => void;
        let clientOpId = "";
        setFetch((_url: string, init?: RequestInit) => {
          clientOpId = new Headers(init?.headers).get("X-Client-Op-Id") ?? "";
          return new Promise((_resolve, reject) => {
            rejectCreate = reject;
          });
        });

        stateMod.requestNewTask();
        rejectCreate(new Error("response interrupted"));
        await new Promise((resolve) => setImmediate(resolve));
        events.handleEvent({
          type: "task_created",
          taskId: "unrelated-task",
          cwd: "/other",
          configOptions: [],
          clientOpId: "other-op",
        });
        assert.equal(state.taskId, null);

        events.handleEvent({
          type: "task_created",
          taskId: "committed-task",
          cwd: "/committed",
          configOptions: [],
          clientOpId,
        });
        assert.equal(state.taskId, "committed-task");
        assert.equal(state.pendingNewTaskOpId, null);
      });

      it("rearms visible history sentinel after task activation", async () => {
        const observers: Array<{
          callback: (entries: Array<{ isIntersecting: boolean }>) => void;
        }> = [];
        const originalIntersectionObserver = (globalThis as any)
          .IntersectionObserver;
        (globalThis as any).IntersectionObserver =
          class MockIntersectionObserver {
            callback: (entries: Array<{ isIntersecting: boolean }>) => void;
            constructor(
              callback: (entries: Array<{ isIntersecting: boolean }>) => void,
            ) {
              this.callback = callback;
              observers.push(this);
            }
            observe() {}
            disconnect() {}
          };

        setFetch((url: string) => {
          if (url.includes("before=5")) {
            return Promise.resolve({ ok: false, status: 503 });
          }
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                events: [
                  {
                    seq: 5,
                    type: "user_message",
                    data: JSON.stringify({ text: "latest" }),
                  },
                ],
                hasMore: true,
              }),
          });
        });

        try {
          await events.loadHistory("s1");
          assert.equal(state.taskId, null);
          assert.equal(observers.length, 1);

          observers[0].callback([{ isIntersecting: true }]);
          await Promise.resolve();
          assert.equal(fetchCalls.length, 1);

          state.pendingNavigationTaskId = "s1";
          events.handleEvent({
            type: "task_created",
            taskId: "s1",
            configOptions: [],
          });

          assert.equal(observers.length, 2);
          observers[1].callback([{ isIntersecting: true }]);
          await Promise.resolve();
          await Promise.resolve();
          assert.equal(fetchCalls.length, 2);
          assert.ok(fetchCalls[1].url.includes("before=5"));
        } finally {
          (globalThis as any).IntersectionObserver =
            originalIntersectionObserver;
        }
      });

      it("does not rearm history sentinel for an active-task reconnect", async () => {
        state.taskId = "s1";
        state.oldestLoadedSeq = 5;
        state.hasMoreHistory = true;
        const sentinel = document.createElement("div");
        sentinel.id = "history-sentinel";
        dom.messages.prepend(sentinel);

        const observers: Array<{
          callback: (entries: Array<{ isIntersecting: boolean }>) => void;
        }> = [];
        const originalIntersectionObserver = (globalThis as any)
          .IntersectionObserver;
        (globalThis as any).IntersectionObserver =
          class MockIntersectionObserver {
            callback: (entries: Array<{ isIntersecting: boolean }>) => void;
            constructor(
              callback: (entries: Array<{ isIntersecting: boolean }>) => void,
            ) {
              this.callback = callback;
              observers.push(this);
            }
            observe() {}
            disconnect() {}
          };
        setFetch(() => Promise.resolve({ ok: false, status: 503 }));

        try {
          await events.loadOlderEvents("s1");
          assert.equal(observers.length, 1);

          events.handleEvent({
            type: "task_created",
            taskId: "s1",
            configOptions: [],
          });

          assert.equal(observers.length, 1);
        } finally {
          (globalThis as any).IntersectionObserver =
            originalIntersectionObserver;
        }
      });

      it("ignores task_created from other clients when not awaiting", () => {
        state.taskId = "existing";
        state.awaitingNewTask = false;
        events.handleEvent({
          type: "task_created",
          taskId: "other",
        });
        assert.equal(state.taskId, "existing");
      });

      it("adds system message when messages area is empty", () => {
        state.awaitingNewTask = true;
        events.handleEvent({
          type: "task_created",
          taskId: "s1",
          title: "New Task",
        });
        assert.equal(dom.messages.children.length, 1);
        assert.ok(
          dom.messages.children[0].textContent.includes("Task created"),
        );
      });

      it("reattaches a running bash block after replay", () => {
        events.replayEvent("bash_command", { command: "ls" }, [], 0);
        state.awaitingNewTask = true;
        events.handleEvent({
          type: "task_created",
          taskId: "s1",
          configOptions: [],
        });
        assert.ok(state.currentBashEl);
        assert.ok(
          state.currentBashEl
            .querySelector(".bash-cmd")
            .classList.contains("running"),
        );
      });

      it("applies plan-mode class from snapshot fallback when configOptions is empty", () => {
        // Simulate: snapshot arrived first and set taskMode; then task_created
        // arrived with empty configOptions (typical after `svc webagent reload`).
        stateMod.setFallbackFromSnapshot({
          task: { mode: "#plan", model: "gpt-5.4" },
        });
        state.awaitingNewTask = true;
        events.handleEvent({
          type: "task_created",
          taskId: "s1",
          cwd: "/home",
          configOptions: [],
        });
        assert.ok(
          dom.inputArea.classList.contains("plan-mode"),
          "input-area should have plan-mode class from fallback",
        );
      });

      it("clears fallback and uses configOptions when they arrive non-empty", () => {
        stateMod.setFallbackFromSnapshot({
          task: { mode: "#plan", model: "gpt-5.4" },
        });
        state.awaitingNewTask = true;
        events.handleEvent({
          type: "task_created",
          taskId: "s1",
          configOptions: [
            {
              id: "mode",
              name: "Mode",
              currentValue: "#autopilot",
              options: [{ value: "#autopilot", name: "auto" }],
            },
          ],
        });
        assert.ok(dom.inputArea.classList.contains("autopilot-mode"));
        assert.ok(!dom.inputArea.classList.contains("plan-mode"));
        // Fallback should be cleared now that configOptions is authoritative
        assert.equal(stateMod.getFallback("mode"), null);
      });
    });

    describe("user_message", () => {
      it("adds user message from broadcast", () => {
        state.taskId = "s1";
        events.handleEvent({
          type: "user_message",
          taskId: "s1",
          text: "hello",
        });
        assert.equal(dom.messages.children.length, 1);
        assert.ok(dom.messages.children[0].classList.contains("user"));
      });

      it("ignores messages from other tasks", () => {
        state.taskId = "s1";
        events.handleEvent({
          type: "user_message",
          taskId: "s2",
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

      it("renders unsolicited Main output after the foreground turn ends", () => {
        state.busy = true;
        events.handleEvent({ type: "prompt_done", stopReason: "end_turn" });
        assert.equal(state.turnEnded, true);
        assert.equal(state.busy, false);

        events.handleEvent({
          type: "message_chunk",
          text: "background agent completed",
        });

        assert.equal(state.currentAssistantText, "background agent completed");
        assert.ok(state.currentAssistantEl);
        assert.equal(dom.messages.children.length, 1);
        assert.equal(
          state.turnEnded,
          true,
          "background output must not reopen the foreground turn",
        );
        assert.equal(state.busy, false);
      });

      it("appends to existing assistant element", () => {
        events.handleEvent({ type: "message_chunk", text: "hello " });
        events.handleEvent({ type: "message_chunk", text: "world" });
        assert.equal(state.currentAssistantText, "hello world");
        assert.equal(dom.messages.children.length, 1);
      });

      it("folds a completed-wrapper echo before releasing its parent suffix", () => {
        state.taskId = "s1";
        const toolText =
          "<final_answer>\nCommands run:\n- `git status --short`\nResult: clean";
        const parentText = "状态符合 push gate；现在推送 feature branch。";
        events.handleEvent({
          type: "tool_call",
          taskId: "s1",
          id: "call_wrapper",
          kind: "other",
          title: "Verify branch before push",
        });
        events.handleEvent({
          type: "tool_call_update",
          taskId: "s1",
          id: "call_wrapper",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: toolText },
            },
          ],
        });
        events.handleEvent({
          type: "message_chunk",
          taskId: "s1",
          text: toolText.slice(0, 24),
        });
        render.flushStreamingRender();

        const assistant = dom.messages.querySelector(".msg.assistant");
        const earlyFold = assistant?.querySelector("details.subagent-result");
        assert.ok(earlyFold, "matching chunks enter a fold immediately");
        assert.equal(earlyFold.hasAttribute("open"), false);
        assert.equal(
          assistant?.querySelector(".assistant-continuation"),
          null,
          "nothing enters the normal flow before the verified boundary",
        );

        events.handleEvent({
          type: "message_chunk",
          taskId: "s1",
          text: `${toolText.slice(24)}${parentText}`,
        });
        render.flushStreamingRender();

        assert.ok(assistant?.querySelector("details.subagent-result"));
        assert.equal(
          assistant?.querySelector(".assistant-continuation")?.textContent,
          parentText,
        );
      });

      it("folds the latest chunks when prompt_done wins the animation-frame race", () => {
        state.taskId = "s1";
        const toolText =
          "<final_answer>\nCommands run:\n- `npm test`\nResult: passed";
        events.handleEvent({
          type: "tool_call_update",
          taskId: "s1",
          id: "call_wrapper",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: toolText },
            },
          ],
        });
        events.handleEvent({
          type: "message_chunk",
          taskId: "s1",
          text: toolText,
        });
        events.handleEvent({
          type: "prompt_done",
          taskId: "s1",
          stopReason: "end_turn",
        });

        const assistant = dom.messages.querySelector(".msg.assistant");
        assert.ok(assistant?.querySelector("details.subagent-result"));
        assert.equal(
          assistant?.getAttribute("data-raw"),
          null,
          "live content must not overwrite the persisted replay baseline",
        );
      });

      it("restores the full stream when it diverges before the verified boundary", () => {
        state.taskId = "s1";
        const toolText = "<final_answer>\nExpected sub-agent result";
        events.handleEvent({
          type: "tool_call_update",
          taskId: "s1",
          id: "call_wrapper",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: toolText },
            },
          ],
        });
        events.handleEvent({
          type: "message_chunk",
          taskId: "s1",
          text: "<final_answer>\nExp",
        });
        render.flushStreamingRender();
        const assistant = dom.messages.querySelector(".msg.assistant");
        assert.ok(assistant?.querySelector("details.subagent-result"));

        events.handleEvent({
          type: "message_chunk",
          taskId: "s1",
          text: "X",
        });
        render.flushStreamingRender();

        assert.equal(assistant?.querySelector(".subagent-result"), null);
        assert.equal(
          assistant?.getAttribute("data-raw"),
          null,
          "divergent live content remains volatile until persisted replay",
        );
        assert.match(assistant?.textContent ?? "", /ExpX/);
      });

      it("folds provisionally when tagged chunks arrive before wrapper completion", () => {
        state.taskId = "s1";
        const toolText =
          "<final_answer>\nCommands run:\n- `npm test`\nResult: passed";
        const split = 24;
        events.handleEvent({
          type: "message_chunk",
          taskId: "s1",
          text: toolText.slice(0, split),
        });
        render.flushStreamingRender();
        const assistant = dom.messages.querySelector(".msg.assistant");
        assert.ok(assistant?.querySelector("details.subagent-result"));

        events.handleEvent({
          type: "tool_call_update",
          taskId: "s1",
          id: "call_wrapper",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: toolText },
            },
          ],
        });
        events.handleEvent({
          type: "message_chunk",
          taskId: "s1",
          text: `${toolText.slice(split)}Parent narration.`,
        });
        render.flushStreamingRender();

        assert.equal(
          assistant?.querySelector(".assistant-continuation")?.textContent,
          "Parent narration.",
        );
      });

      it("restores an unverified provisional fold when the turn ends", () => {
        state.taskId = "s1";
        const text = "<final_answer>\nStandalone parent response";
        events.handleEvent({
          type: "message_chunk",
          taskId: "s1",
          text,
        });
        render.flushStreamingRender();
        const assistant = dom.messages.querySelector(".msg.assistant");
        assert.ok(assistant?.querySelector("details.subagent-result"));

        events.handleEvent({
          type: "prompt_done",
          taskId: "s1",
          stopReason: "end_turn",
        });

        assert.equal(assistant?.querySelector(".subagent-result"), null);
        assert.match(
          assistant?.textContent ?? "",
          /Standalone parent response/,
        );
      });

      it("enhances streamed code blocks when the stream finishes", async () => {
        events.handleEvent({ type: "message_chunk", text: "```js\nconst " });
        events.handleEvent({ type: "message_chunk", text: "x = 1;\n```" });

        assert.equal(
          dom.messages.querySelector(".code-block-wrapper"),
          null,
          "streaming chunks should not keep rebuilding code wrappers",
        );

        events.handleEvent({ type: "prompt_done", stopReason: "end_turn" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const wrapper = dom.messages.querySelector(".code-block-wrapper");
        assert.ok(
          wrapper,
          "expected streamed code block to be wrapped when streaming finishes",
        );
        const code = wrapper.querySelector("code");
        assert.ok(code, "expected wrapped code element");
        // hljs is now bundled (eager), so highlightElement runs synchronously
        // inside enhanceCodeBlocks and stamps dataset.highlighted on the node.
        assert.equal(
          (code as HTMLElement).dataset.highlighted,
          "yes",
          "expected hljs to highlight the streamed code block",
        );
      });

      it("removes unverified user attribution from split live chunks", () => {
        events.handleEvent({
          type: "message_chunk",
          text: "Info: Operation cancelled by ",
        });
        events.handleEvent({
          type: "message_chunk",
          text: "usernext response",
        });
        events.handleEvent({ type: "prompt_done", stopReason: "end_turn" });

        assert.equal(
          dom.messages.querySelector(".msg.assistant")?.textContent,
          "Info: Operation cancelled — next response",
        );
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

      it("preserves unsolicited assistant → thought → assistant order after prompt_done", () => {
        state.busy = true;
        events.handleEvent({ type: "prompt_done", stopReason: "end_turn" });

        events.handleEvent({ type: "message_chunk", text: "before" });
        events.handleEvent({ type: "thought_chunk", text: "reasoning" });
        events.handleEvent({ type: "message_chunk", text: "after" });
        render.flushStreamingRender();

        assert.equal(dom.messages.children.length, 3);
        assert.ok(dom.messages.children[0].classList.contains("assistant"));
        assert.ok(dom.messages.children[1].classList.contains("thinking"));
        assert.ok(dom.messages.children[2].classList.contains("assistant"));
        assert.equal(dom.messages.children[0].textContent, "before");
        assert.ok(dom.messages.children[1].textContent.includes("reasoning"));
        assert.equal(dom.messages.children[2].textContent, "after");
        assert.equal(state.turnEnded, true);
        assert.equal(state.busy, false);
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
        const el = globalThis.document.getElementById("tc-tc1")!;
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
        const el = globalThis.document.getElementById("tc-tc3")!;
        assert.ok(el.textContent.includes("npm test"));
      });
    });

    describe("tool_call_update", () => {
      it("applies a merged diff update when the tool call host appears later", async () => {
        events.handleEvent({
          type: "tool_call_update",
          id: "tc-late-diff",
          status: "in_progress",
          content: [
            {
              type: "diff",
              path: "src/late.ts",
              oldText: "const n = 1;\n",
              newText: "const n = 2;\n",
            },
          ],
        });
        events.handleEvent({
          type: "tool_call_update",
          id: "tc-late-diff",
          status: "completed",
        });
        events.handleEvent({
          type: "tool_call",
          id: "tc-late-diff",
          kind: "edit",
          title: "Late diff",
          rawInput: {},
        });

        await new Promise((resolve) => setTimeout(resolve, 20));

        const tool = document.getElementById("tc-tc-late-diff");
        assert.ok(tool?.classList.contains("completed"));
        assert.match(
          tool?.querySelector(".diff-view")?.textContent ?? "",
          /src\/late\.ts/,
        );
      });

      it("applies an orphan diff when replay recreates the tool host", async () => {
        events.handleEvent({
          type: "tool_call_update",
          id: "tc-replayed-diff",
          status: "completed",
          content: [
            {
              type: "diff",
              path: "src/replayed.ts",
              oldText: "const n = 1;\n",
              newText: "const n = 2;\n",
            },
          ],
        });

        events.replayEvent(
          "tool_call",
          {
            id: "tc-replayed-diff",
            kind: "edit",
            title: "Replayed diff",
            rawInput: {},
          },
          [],
          0,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.match(
          document.querySelector("#tc-tc-replayed-diff .diff-view")
            ?.textContent ?? "",
          /src\/replayed\.ts/,
        );
      });

      it("clears orphan updates on task reset", () => {
        events.handleEvent({
          type: "tool_call_update",
          id: "tc-old-task",
          status: "completed",
          content: [
            {
              type: "diff",
              path: "src/old.ts",
              oldText: "old\n",
              newText: "new\n",
            },
          ],
        });
        stateMod.resetTaskUI();

        events.handleEvent({
          type: "tool_call",
          id: "tc-old-task",
          kind: "edit",
          title: "New task tool",
          rawInput: {},
        });

        assert.equal(document.querySelector(".tc-diff"), null);
      });

      it("updates tool call status to completed", () => {
        events.handleEvent({
          type: "tool_call",
          id: "tc1",
          kind: "read",
          title: "Read",
          rawInput: {},
        });
        events.handleEvent({
          type: "tool_call_update",
          id: "tc1",
          status: "completed",
        });
        const el = globalThis.document.getElementById("tc-tc1")!;
        assert.ok(el.classList.contains("completed"));
        assert.equal(el.querySelector(".icon")!.textContent, "✓");
      });

      it("updates tool call status to failed", () => {
        events.handleEvent({
          type: "tool_call",
          id: "tc2",
          kind: "read",
          title: "Read",
          rawInput: {},
        });
        events.handleEvent({
          type: "tool_call_update",
          id: "tc2",
          status: "failed",
        });
        const el = globalThis.document.getElementById("tc-tc2")!;
        assert.ok(el.classList.contains("failed"));
        assert.equal(el.querySelector(".icon")!.textContent, "✗");
      });

      it("shows task_complete summary directly without collapsed details", () => {
        events.handleEvent({
          type: "tool_call",
          id: "tc-done",
          kind: "task_complete",
          title: "Task complete",
          rawInput: { summary: "Fixed the login bug" },
        });
        events.handleEvent({
          type: "tool_call_update",
          id: "tc-done",
          status: "completed",
          content: [{ type: "text", content: { text: "Fixed the login bug" } }],
        });
        const el = globalThis.document.getElementById("tc-tc-done")!;
        assert.ok(el.classList.contains("completed"));
        // Summary should be visible directly, not inside a collapsed <details>
        assert.ok(
          !el.querySelector("details"),
          "task_complete should not use collapsed details",
        );
        const summary = el.querySelector(".tc-summary")!;
        assert.ok(summary, "should have a .tc-summary element");
        assert.ok(summary.textContent.includes("Fixed the login bug"));
      });

      it("uses ✔ icon for task_complete kind", () => {
        events.handleEvent({
          type: "tool_call",
          id: "tc-done2",
          kind: "task_complete",
          title: "Task complete",
          rawInput: {},
        });
        const el = globalThis.document.getElementById("tc-tc-done2")!;
        assert.equal(el.querySelector(".icon")!.textContent, "✔");
      });
    });

    describe("plan", () => {
      function patchPlan(
        entries: Array<{ content: string; status: string }> | null,
      ) {
        state.taskId = "s1";
        events.handleEvent({
          type: "state_patch",
          taskId: "s1",
          seq: state.lastStateSeq + 1,
          patch: { runtime: { plan: entries } },
        });
      }

      it("renders plan with entries", () => {
        state.currentAssistantEl = globalThis.document.createElement("div");
        const entries = [
          { content: "Step 1", status: "completed" },
          { content: "Step 2", status: "in_progress" },
          { content: "Step 3", status: "pending" },
        ];
        events.handleEvent({
          type: "plan",
          entries,
        });
        assert.equal(state.currentAssistantEl, null); // finishAssistant called
        const plan = dom.messages.querySelector(".plan") as HTMLDetailsElement;
        assert.ok(plan);
        assert.equal(plan.open, false);
        assert.equal(
          plan.querySelector(".plan-counts")?.textContent,
          "[ ] 1  [~] 1  [x] 1",
        );
        assert.equal(plan.querySelectorAll(".plan-entry").length, 3);
        assert.ok(plan.textContent.includes("[x]")); // completed
        assert.ok(plan.textContent.includes("[~]")); // in_progress
        assert.ok(plan.textContent.includes("[ ]")); // pending

        const panel = document.querySelector(
          "#plan-panel",
        ) as HTMLDetailsElement;
        assert.equal(panel.hidden, true);

        patchPlan(entries);

        assert.equal(panel.hidden, false);
        assert.equal(panel.open, false);
        assert.equal(
          panel.querySelector(".plan-counts")?.textContent,
          "[ ] 1  [~] 1  [x] 1",
        );
        assert.equal(panel.querySelectorAll(".plan-entry").length, 3);
      });

      it("keeps transcript plans collapsed and updates one pinned panel", () => {
        events.handleEvent({
          type: "plan",
          entries: [{ content: "Old", status: "pending" }],
        });
        patchPlan([{ content: "Old", status: "pending" }]);
        events.handleEvent({
          type: "plan",
          entries: [{ content: "New", status: "in_progress" }],
        });
        patchPlan([{ content: "New", status: "in_progress" }]);

        const plans = Array.from(
          (dom.messages as HTMLElement).querySelectorAll<HTMLDetailsElement>(
            ".plan",
          ),
        );
        assert.equal(plans.length, 2);
        assert.equal(plans[0].open, false);
        assert.equal(plans[1].open, false);
        assert.equal(
          document.querySelector("#plan-panel .plan-entry")?.textContent,
          "[~] New",
        );
      });

      it("preserves the pinned panel's expanded state across updates", () => {
        events.handleEvent({
          type: "plan",
          entries: [{ content: "First", status: "in_progress" }],
        });
        patchPlan([{ content: "First", status: "in_progress" }]);
        const panel = document.querySelector(
          "#plan-panel",
        ) as HTMLDetailsElement;
        panel.querySelector<HTMLElement>(".plan-summary")?.click();
        assert.equal(panel.open, true);

        events.handleEvent({
          type: "plan",
          entries: [{ content: "Second", status: "in_progress" }],
        });
        patchPlan([{ content: "Second", status: "in_progress" }]);

        assert.equal(panel.open, true);
        assert.equal(
          panel.querySelector(".plan-entry")?.textContent,
          "[~] Second",
        );
      });

      it("removes the pinned panel when every entry is completed", () => {
        events.handleEvent({
          type: "plan",
          entries: [{ content: "Working", status: "in_progress" }],
        });
        patchPlan([{ content: "Working", status: "in_progress" }]);
        events.handleEvent({
          type: "plan",
          entries: [{ content: "Working", status: "completed" }],
        });
        assert.equal(
          document.querySelector("#plan-panel .plan-entry")?.textContent,
          "[~] Working",
        );
        patchPlan(null);

        const panel = document.querySelector(
          "#plan-panel",
        ) as HTMLDetailsElement;
        assert.equal(panel.hidden, true);
        assert.equal(panel.textContent, "");
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
        state.taskId = "s1";
        events.handleEvent({
          type: "permission_request",
          requestId: "perm2",
          title: "Allow?",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        });
        const btn = dom.messages.querySelector(".permission button");
        btn.click();
        const call = fetchCalls.find(
          (c) =>
            c.url.includes("/api/v1/tasks/s1/permissions/perm2") &&
            c.init?.method === "POST",
        );
        assert.ok(
          call,
          "expected a POST to /api/v1/tasks/s1/permissions/perm2",
        );
        const body = JSON.parse(call.init.body);
        assert.equal(body.optionId, "allow");
      });

      it("clears local pending permission state after the user responds", () => {
        state.taskId = "s1";
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

        assert.equal(
          state.pendingPermissionRequestIds.has("perm-local"),
          false,
        );
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
        const perms = dom.messages.querySelectorAll(
          '.permission[data-request-id="perm-dup"]',
        );
        assert.equal(
          perms.length,
          1,
          "should not create duplicate permission element",
        );
      });

      it("skips duplicate permission_request even if already resolved", () => {
        state.taskId = "s1";
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
        const perms = dom.messages.querySelectorAll(
          '.permission[data-request-id="perm-dup2"]',
        );
        assert.equal(
          perms.length,
          1,
          "should not create duplicate after resolution",
        );
        assert.equal(
          perms[0].querySelectorAll("button").length,
          0,
          "should stay resolved",
        );
      });

      it("preserves title after user clicks a permission button", () => {
        state.taskId = "s1";
        events.handleEvent({
          type: "permission_request",
          requestId: "perm-click",
          title: "Execute npm install",
          options: [
            { optionId: "allow", kind: "allow_once", name: "Allow once" },
          ],
        });
        dom.messages.querySelector(".permission button").click();
        const perm = dom.messages.querySelector(".permission");
        assert.ok(perm.textContent.includes("Execute npm install"));
        assert.ok(perm.textContent.includes("Allow once"));
      });
    });

    describe("permission_response (live)", () => {
      it("dismisses permission buttons from another client", () => {
        state.taskId = "s1";
        events.handleEvent({
          type: "permission_request",
          requestId: "perm3",
          title: "Allow?",
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        });
        events.handleEvent({
          type: "permission_response",
          taskId: "s1",
          requestId: "perm3",
          optionName: "Allow",
          denied: false,
        });
        const perm = dom.messages.querySelector(".permission");
        assert.equal(perm.querySelectorAll("button").length, 0);
        assert.ok(perm.textContent.includes("Allow"));
      });

      it("preserves original title after permission_response", () => {
        state.taskId = "s1";
        events.handleEvent({
          type: "permission_request",
          requestId: "perm-title",
          title: "Run dangerous command",
          options: [
            { optionId: "allow", kind: "allow_once", name: "Allow once" },
          ],
        });
        events.handleEvent({
          type: "permission_response",
          taskId: "s1",
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
        state.taskId = "s1";
        events.handleEvent({
          type: "bash_command",
          taskId: "s1",
          command: "ls",
        });
        assert.ok(state.currentBashEl);
        assert.equal(state.busy, true);
      });

      it("handles bash_output", () => {
        state.taskId = "s1";
        events.handleEvent({
          type: "bash_command",
          taskId: "s1",
          command: "ls",
        });
        events.handleEvent({
          type: "bash_output",
          taskId: "s1",
          text: "file.txt\n",
          stream: "stdout",
        });
        const out = state.currentBashEl.querySelector(".bash-output");
        assert.ok(out.textContent.includes("file.txt"));
      });

      it("handles bash_output stderr", () => {
        state.taskId = "s1";
        events.handleEvent({
          type: "bash_command",
          taskId: "s1",
          command: "fail",
        });
        events.handleEvent({
          type: "bash_output",
          taskId: "s1",
          text: "error!",
          stream: "stderr",
        });
        const stderr = state.currentBashEl.querySelector(
          ".bash-output .stderr",
        );
        assert.ok(stderr);
        assert.equal(stderr.textContent, "error!");
      });

      it("handles bash_done", () => {
        state.taskId = "s1";
        events.handleEvent({
          type: "bash_command",
          taskId: "s1",
          command: "ls",
        });
        events.handleEvent({ type: "bash_done", taskId: "s1", code: 0 });
        assert.equal(state.currentBashEl, null);
        assert.equal(state.busy, false);
      });

      it("keeps busy when bash finishes during an agent prompt", () => {
        state.busy = true;
        state.busyKind = "agent";
        events.handleEvent({
          type: "bash_done",
          taskId: "s1",
          code: 0,
          signal: null,
        });
        assert.equal(state.busy, true);
        assert.equal(state.busyKind, "agent");
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

      it("keeps the pinned plan across prompt_done for cross-turn work", () => {
        state.taskId = "s1";
        events.handleEvent({
          type: "plan",
          entries: [{ content: "Still shown", status: "in_progress" }],
        });
        events.handleEvent({
          type: "state_patch",
          taskId: "s1",
          seq: 1,
          patch: {
            runtime: {
              plan: [{ content: "Still shown", status: "in_progress" }],
            },
          },
        });
        const panel = document.querySelector(
          "#plan-panel",
        ) as HTMLDetailsElement;
        assert.equal(panel.hidden, false);

        events.handleEvent({ type: "prompt_done" });

        assert.equal(panel.hidden, false);
        assert.equal(
          panel.querySelector(".plan-entry")?.textContent,
          "[~] Still shown",
        );
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
        events.handleEvent({
          type: "tool_call_update",
          id: "tc-pending",
          status: "completed",
        });
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
        state.taskId = "s1";
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

      for (const [stopReason, expected] of [
        ["cancelled", "Generation cancelled."],
        ["max_tokens", "Response stopped after reaching the token limit."],
        [
          "max_turn_requests",
          "Agent stopped after reaching the turn request limit.",
        ],
        [
          "refusal",
          "Agent refused to continue. This prompt will not be included in the next turn.",
        ],
      ] as const) {
        it(`shows a system message for ${stopReason}`, () => {
          state.busy = true;
          events.handleEvent({ type: "prompt_done", stopReason });

          const messages = Array.from(
            document.querySelectorAll(".system-msg"),
          ).map((element) => element.textContent);
          assert.ok(messages.includes(expected));
          assert.equal(state.busy, false);
        });
      }

      it("does not add a stop message for a normal end_turn", () => {
        state.busy = true;
        events.handleEvent({ type: "prompt_done", stopReason: "end_turn" });

        const messages = Array.from(
          document.querySelectorAll(".system-msg"),
        ).map((element) => element.textContent);
        assert.equal(messages.includes("Agent stopped: end_turn."), false);
      });

      it("keeps busy when the prompt finishes during local bash", () => {
        state.busy = true;
        state.busyKind = "bash";
        events.handleEvent({
          type: "prompt_done",
          stopReason: "end_turn",
        });
        assert.equal(state.busy, true);
        assert.equal(state.busyKind, "bash");
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

      it("renders an unsolicited tool call after prompt_done without reopening busy", () => {
        state.taskId = "s1";
        state.busy = true;
        events.handleEvent({ type: "prompt_done", stopReason: "end_turn" });
        assert.equal(state.busy, false);
        // Reconnect resets turnEnded, while a remote-turn hint can remain
        // stale; the authoritative idle snapshot must still win ownership.
        state.turnEnded = false;
        state.newTurnStarted = true;

        events.handleEvent({
          type: "tool_call",
          id: "tc-background",
          kind: "task",
          title: "Background task",
          rawInput: {},
        });
        events.handleEvent({
          type: "tool_call_update",
          id: "tc-background",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: "done" } },
          ],
          rawOutput: { status: "completed" },
        });

        const tool = document.getElementById("tc-tc-background");
        assert.ok(tool, "unsolicited tool call should be rendered");
        assert.equal(
          tool.querySelector(".tc-output")?.textContent,
          "outputdone",
        );
        assert.match(
          tool.querySelector(".tc-raw-output")?.textContent ?? "",
          /completed/,
        );
        assert.equal(state.busy, false);
        assert.equal(state.pendingToolCallIds.size, 0);
      });

      it("ignores permission_request arriving after prompt_done", () => {
        state.taskId = "s1";
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
        state.taskId = "s1";
        events.handleEvent({
          type: "user_message",
          taskId: "s1",
          text: "hello",
        });

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
        state.taskId = "s1";
        state.busy = true;
        events.handleEvent({ type: "prompt_done", stopReason: "end_turn" });
        assert.equal(state.turnEnded, true);

        // User sends a new prompt via input.js (setBusy + WS send).
        // input.js:104 sets turnEnded = false before any agent events arrive.
        // The server does NOT echo user_message back to the sender —
        // only to other clients.
        state.turnEnded = false; // input.js:104
        state.busy = true; // input.js:105 (setBusy(true))

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

        assert.equal(
          state.pendingToolCallIds.has("tc-new"),
          true,
          "tool_call should not be dropped",
        );
        assert.ok(
          document.getElementById("tc-tc-new"),
          "tool_call element should exist",
        );

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

    describe("state_patch", () => {
      it("applies an in-order patch from SSE", () => {
        state.taskId = "s1";
        state.lastStateSeq = 0;
        events.handleEvent({
          type: "state_patch",
          taskId: "s1",
          seq: 1,
          patch: {
            runtime: { busy: { kind: "agent", since: "", promptId: null } },
          },
        });
        assert.equal(state.busy, true);
        assert.equal(state.lastStateSeq, 1);
      });

      it("drops out-of-order patches (seq gap) and triggers snapshot reload", async () => {
        state.taskId = "s1";
        state.lastStateSeq = 0;
        let snapshotFetched = false;
        (globalThis as any).fetch = async (url: string) => {
          if (url.endsWith("/snapshot")) {
            snapshotFetched = true;
            const body = JSON.stringify({
              version: 1,
              seq: 5,
              task: {
                id: "s1",
                title: null,
                cwd: "/",
                model: null,
                mode: null,
                createdAt: null,
                lastEventSeq: 0,
              },
              runtime: { busy: null },
            });
            return {
              ok: true,
              status: 200,
              json: async () => JSON.parse(body),
              text: async () => body,
            };
          }
          return { ok: true, json: async () => ({}), text: async () => "{}" };
        };
        events.handleEvent({
          type: "state_patch",
          taskId: "s1",
          seq: 3,
          patch: {
            runtime: { busy: { kind: "agent", since: "", promptId: null } },
          },
        });
        assert.equal(state.lastStateSeq, 0);
        await new Promise((r) => setTimeout(r, 5));
        assert.ok(snapshotFetched, "expected snapshot reload on seq gap");
      });

      it("drops a seq-gap snapshot after abandoning its task", async () => {
        state.taskId = "s1";
        state.lastStateSeq = 0;
        let releaseSnapshot!: () => void;
        const snapshotReady = new Promise<void>((resolve) => {
          releaseSnapshot = resolve;
        });
        (globalThis as any).fetch = async (url: string) => {
          if (url.endsWith("/snapshot")) {
            await snapshotReady;
            const body = JSON.stringify({
              version: 1,
              seq: 3,
              task: {
                id: "s1",
                title: null,
                cwd: "/",
                model: null,
                mode: null,
                createdAt: null,
                lastEventSeq: 0,
              },
              runtime: {
                busy: null,
                plan: [{ content: "Abandoned", status: "in_progress" }],
              },
            });
            return {
              ok: true,
              status: 200,
              text: async () => body,
            };
          }
          return { ok: true, text: async () => "{}" };
        };

        events.handleEvent({
          type: "state_patch",
          taskId: "s1",
          seq: 3,
          patch: { runtime: { plan: null } },
        });
        state.taskId = null;
        releaseSnapshot();
        for (let i = 0; i < 10; i++) await Promise.resolve();

        assert.equal(state.plan, null);
        assert.equal(state.lastStateSeq, 0);
      });

      it("shows recovery guidance when cancel is unconfirmed", () => {
        state.taskId = "s1";
        state.lastStateSeq = 0;
        state.busy = true;
        state.cancelStatus = "requested";

        events.handleEvent({
          type: "state_patch",
          taskId: "s1",
          seq: 1,
          patch: {
            runtime: {
              busy: {
                kind: "agent",
                since: "t0",
                promptId: "p1",
                cancelStatus: "unconfirmed",
              },
            },
          },
        });

        assert.match(dom.messages.textContent, /retry.*\/reload/i);
      });
    });

    describe("task_deleted", () => {
      it("auto-switches to next task when current is deleted", async () => {
        state.taskId = "s1";
        const nextTask = {
          id: "s2",
          cwd: "/tmp",
          title: "Next",
          configOptions: [],
          busyKind: null,
        };
        setFetch(async (url: string, init?: any) => {
          if (
            url === "/api/v1/tasks" &&
            (!init?.method || init.method === "GET")
          )
            return {
              ok: true,
              text: async () => JSON.stringify([{ id: "s2" }]),
            };
          if (url === "/api/v1/tasks/s2")
            return { ok: true, text: async () => JSON.stringify(nextTask) };
          if (url.startsWith("/api/v1/tasks/s2/events"))
            return { ok: true, text: async () => "[]" };
          if (url === "/api/v1/tasks/s2/snapshot")
            return {
              ok: true,
              text: async () =>
                JSON.stringify({
                  version: 1,
                  seq: 1,
                  task: {
                    id: "s2",
                    title: null,
                    cwd: "/next",
                    model: null,
                    mode: null,
                    createdAt: null,
                    lastEventSeq: 0,
                  },
                  runtime: {
                    busy: null,
                    plan: [
                      {
                        content: "Restored fallback work",
                        status: "in_progress",
                      },
                    ],
                  },
                }),
            };
          return { ok: true, text: async () => "{}" };
        });

        events.handleEvent({ type: "task_deleted", taskId: "s1" });
        for (let i = 0; i < 30; i++) await Promise.resolve();
        assert.equal(state.taskId, "s2");
        assert.equal(dom.input.disabled, false);
        assert.equal(
          dom.planPanel.querySelector(".plan-entry")?.textContent,
          "[~] Restored fallback work",
        );
      });

      it("deduplicates the HTTP exit navigation and its SSE echo", async () => {
        state.taskId = "child";
        let listCalls = 0;
        const parentTask = {
          id: "parent-dedupe",
          cwd: "/tmp",
          title: "Parent",
          configOptions: [],
          busyKind: null,
        };
        setFetch(async (url: string, init?: any) => {
          if (
            url === "/api/v1/tasks" &&
            (!init?.method || init.method === "GET")
          ) {
            listCalls++;
            return {
              ok: true,
              text: async () => JSON.stringify([{ id: "parent-dedupe" }]),
            };
          }
          if (url === "/api/v1/tasks/parent-dedupe")
            return { ok: true, text: async () => JSON.stringify(parentTask) };
          if (url.startsWith("/api/v1/tasks/parent-dedupe/events"))
            return { ok: true, text: async () => "[]" };
          if (url === "/api/v1/tasks/parent-dedupe/snapshot")
            return {
              ok: true,
              text: async () =>
                JSON.stringify({
                  version: 1,
                  seq: 0,
                  task: {},
                  runtime: { busy: null },
                }),
            };
          return { ok: true, text: async () => "{}" };
        });

        const httpNavigation = events.fallbackToNextTask(
          "child",
          "/tmp",
          "parent-dedupe",
          "exit-op-1",
        );
        const sseNavigation = events.fallbackToNextTask(
          "child",
          "/tmp",
          "parent-dedupe",
          "exit-op-1",
        );
        await Promise.all([httpNavigation, sseNavigation]);

        assert.equal(listCalls, 1);
        assert.equal(state.taskId, "parent-dedupe");
      });

      it("prefers the deleted task's server-provided parent", async () => {
        state.taskId = "child";
        const parentTask = {
          id: "parent",
          cwd: "/tmp",
          title: "Parent",
          configOptions: [],
          busyKind: null,
        };
        setFetch(async (url: string, init?: any) => {
          if (
            url === "/api/v1/tasks" &&
            (!init?.method || init.method === "GET")
          )
            return {
              ok: true,
              text: async () =>
                JSON.stringify([{ id: "mru" }, { id: "parent" }]),
            };
          if (url === "/api/v1/tasks/parent")
            return { ok: true, text: async () => JSON.stringify(parentTask) };
          if (url.startsWith("/api/v1/tasks/parent/events"))
            return { ok: true, text: async () => "[]" };
          if (url === "/api/v1/tasks/parent/snapshot")
            return {
              ok: true,
              text: async () =>
                JSON.stringify({
                  version: 1,
                  seq: 0,
                  task: {},
                  runtime: { busy: null },
                }),
            };
          return { ok: true, text: async () => "{}" };
        });

        events.handleEvent({
          type: "task_deleted",
          taskId: "child",
          parentId: "parent",
        });
        for (let i = 0; i < 30; i++) await Promise.resolve();

        assert.equal(state.taskId, "parent");
      });

      it("reloads the preserved Root task after a reset event", async () => {
        state.taskId = "root";
        const rootTask = {
          id: "root",
          cwd: "/tmp",
          title: "root",
          configOptions: [],
          busyKind: null,
        };
        setFetch(async (url: string, init?: any) => {
          if (
            url === "/api/v1/tasks" &&
            (!init?.method || init.method === "GET")
          )
            return {
              ok: true,
              text: async () => JSON.stringify([{ id: "root" }]),
            };
          if (url === "/api/v1/tasks/root")
            return { ok: true, text: async () => JSON.stringify(rootTask) };
          if (url.startsWith("/api/v1/tasks/root/events"))
            return { ok: true, text: async () => "[]" };
          if (url === "/api/v1/tasks/root/snapshot")
            return {
              ok: true,
              text: async () =>
                JSON.stringify({
                  version: 1,
                  seq: 0,
                  task: {},
                  runtime: { busy: null },
                }),
            };
          return { ok: true, text: async () => "{}" };
        });

        events.handleEvent({ type: "task_reset", taskId: "root" });
        for (let i = 0; i < 30; i++) await Promise.resolve();

        assert.equal(state.taskId, "root");
      });

      it("creates new task when current is deleted and no others exist", async () => {
        state.taskId = "s1";
        setFetch(async (url: string, init?: any) => {
          if (
            url === "/api/v1/tasks" &&
            (!init?.method || init.method === "GET")
          )
            return { ok: true, text: async () => "[]" };
          if (url === "/api/v1/tasks/bootstrap" && init?.method === "POST")
            return {
              ok: true,
              text: async () =>
                JSON.stringify({
                  id: "new-1",
                  cwd: "/tmp",
                  title: null,
                  configOptions: [],
                }),
            };
          return { ok: true, text: async () => "{}" };
        });

        events.handleEvent({ type: "task_deleted", taskId: "s1" });
        for (let i = 0; i < 30; i++) await Promise.resolve();
        assert.equal(state.awaitingNewTask, false);
        assert.equal(state.taskId, "new-1");
      });

      it("keeps a newer target-task patch over an in-flight fallback snapshot", async () => {
        state.taskId = "s1";
        const nextTask = {
          id: "s2",
          cwd: "/next",
          title: null,
          configOptions: [],
          busyKind: null,
        };
        let resolveSnapshot!: () => void;
        let snapshotCalls = 0;
        const snapshotReady = new Promise<void>((resolve) => {
          resolveSnapshot = resolve;
        });
        setFetch(async (url: string, init?: any) => {
          if (
            url === "/api/v1/tasks" &&
            (!init?.method || init.method === "GET")
          )
            return {
              ok: true,
              text: async () => JSON.stringify([{ id: "s2" }]),
            };
          if (url === "/api/v1/tasks/s2")
            return { ok: true, text: async () => JSON.stringify(nextTask) };
          if (url.startsWith("/api/v1/tasks/s2/events"))
            return { ok: true, text: async () => "[]" };
          if (url === "/api/v1/tasks/s2/snapshot") {
            snapshotCalls++;
            await snapshotReady;
            return {
              ok: true,
              text: async () =>
                JSON.stringify({
                  version: 1,
                  seq: snapshotCalls === 1 ? 0 : 1,
                  task: {
                    id: "s2",
                    title: null,
                    cwd: "/next",
                    model: null,
                    mode: null,
                    createdAt: null,
                    lastEventSeq: 0,
                  },
                  runtime: {
                    busy: null,
                    plan: [
                      {
                        content:
                          snapshotCalls === 1 ? "Old snapshot" : "New patch",
                        status: "in_progress",
                      },
                    ],
                  },
                }),
            };
          }
          return { ok: true, text: async () => "{}" };
        });

        const fallback = events.fallbackToNextTask("s1");
        for (let i = 0; i < 20; i++) await Promise.resolve();
        assert.equal(state.taskId, "s2");
        events.handleEvent({
          type: "state_patch",
          taskId: "s2",
          seq: 1,
          patch: {
            runtime: {
              plan: [{ content: "New patch", status: "in_progress" }],
            },
          },
        });
        resolveSnapshot();
        await fallback;

        assert.equal(
          dom.planPanel.querySelector(".plan-entry")?.textContent,
          "[~] New patch",
        );
      });

      it("ignores deletion of other tasks", () => {
        state.taskId = "s1";
        events.handleEvent({ type: "task_deleted", taskId: "s2" });
        assert.equal(dom.input.disabled, false);
      });
    });

    describe("config_set", () => {
      it("updates config value and shows system message", () => {
        state.configOptions = [
          {
            id: "model",
            name: "Model",
            currentValue: "old",
            options: [{ value: "new", name: "New Model" }],
          },
        ];
        events.handleEvent({
          type: "config_set",
          configId: "model",
          value: "new",
        });
        assert.equal(stateMod.getConfigValue("model"), "new");
        assert.ok(
          dom.messages
            .querySelector(".system-msg")
            .textContent.includes("Model"),
        );
      });
    });

    describe("task_title_updated", () => {
      it("updates title for current task", () => {
        state.taskId = "s1";
        events.handleEvent({
          type: "task_title_updated",
          taskId: "s1",
          title: "New Title",
        });
        assert.equal(state.taskTitle, "New Title");
        assert.equal(dom.taskInfo.textContent, "New Title");
      });

      it("ignores title update for other tasks", () => {
        state.taskId = "s1";
        state.taskTitle = "Old";
        events.handleEvent({
          type: "task_title_updated",
          taskId: "s2",
          title: "Other",
        });
        assert.equal(state.taskTitle, "Old");
      });
    });

    describe("error", () => {
      it("shows error message and clears busy", () => {
        state.busy = true;
        events.handleEvent({ type: "error", message: "Something broke" });
        assert.equal(state.busy, false);
        assert.ok(
          dom.messages
            .querySelector(".system-msg")
            .textContent.includes("Something broke"),
        );
      });

      it("clears awaitingNewTask so the UI is not stuck", () => {
        state.awaitingNewTask = true;
        events.handleEvent({
          type: "error",
          message: "Directory does not exist: /bad",
        });
        assert.equal(state.awaitingNewTask, false);
      });

      it("keeps busy when an agent error arrives during local bash", () => {
        state.busy = true;
        state.busyKind = "bash";

        events.handleEvent({ type: "error", message: "agent failed" });

        assert.equal(state.busy, true);
        assert.equal(state.busyKind, "bash");
      });
    });

    describe("cross-client turn boundary (cancel + new prompt)", () => {
      // NOTE: Use assert.ok(x === null) instead of assert.equal(x, null) when x might
      // be a DOM element — assert.equal tries to serialize DOM nodes for error messages,
      // which can hang happy-dom's event loop.

      it("user_message finalises in-progress assistant streaming (message ordering)", () => {
        state.taskId = "s1";

        // Old prompt is streaming assistant text
        events.handleEvent({ type: "message_chunk", text: "old response " });
        assert.ok(
          state.currentAssistantEl,
          "should have an active assistant element",
        );

        // Another client sends a new message (broadcast arrives)
        events.handleEvent({
          type: "user_message",
          taskId: "s1",
          text: "new question",
        });

        // The old assistant element should be finalised
        assert.ok(
          state.currentAssistantEl === null,
          "currentAssistantEl should be null after user_message",
        );
        assert.equal(
          state.currentAssistantText,
          "",
          "currentAssistantText should be cleared",
        );

        // New message_chunk should create a fresh element BELOW the user message
        events.handleEvent({ type: "message_chunk", text: "new response" });

        // DOM order: old assistant, user bubble, new assistant
        const children = [...dom.messages.children];
        assert.equal(children.length, 3);
        assert.ok(
          children[0].classList.contains("assistant"),
          "first child should be old assistant",
        );
        assert.ok(
          children[1].classList.contains("user"),
          "second child should be user message",
        );
        assert.ok(
          children[2].classList.contains("assistant"),
          "third child should be new assistant",
        );
      });

      it("user_message finalises in-progress thinking element", () => {
        state.taskId = "s1";

        // Old prompt is streaming thinking
        events.handleEvent({ type: "thought_chunk", text: "thinking..." });
        assert.ok(
          state.currentThinkingEl,
          "should have an active thinking element",
        );

        // Another client sends a new message
        events.handleEvent({
          type: "user_message",
          taskId: "s1",
          text: "new question",
        });

        // Thinking element should be finalised
        assert.ok(
          state.currentThinkingEl === null,
          "currentThinkingEl should be null",
        );
        assert.equal(
          state.currentThinkingText,
          "",
          "currentThinkingText should be cleared",
        );
      });

      it("stale prompt_done(cancelled) does not clobber new turn state (stuck busy)", () => {
        state.taskId = "s1";

        // New turn starts: another client sent a message
        events.handleEvent({
          type: "user_message",
          taskId: "s1",
          text: "new question",
        });
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
        assert.ok(
          state.pendingToolCallIds.has("tc-new"),
          "stale cancel should not clear new turn pending tool calls",
        );
        assert.equal(
          state.busy,
          true,
          "stale cancel should not clear busy for the new turn",
        );
      });

      it("stale prompt_done(cancelled) does not prevent new prompt_done from clearing busy", () => {
        state.taskId = "s1";

        // New turn starts
        events.handleEvent({
          type: "user_message",
          taskId: "s1",
          text: "question",
        });
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
        events.handleEvent({
          type: "tool_call_update",
          id: "tc-a",
          status: "completed",
        });

        // The real prompt_done for the new turn arrives
        events.handleEvent({ type: "prompt_done", stopReason: "end_turn" });

        // Busy should be cleared
        assert.equal(
          state.busy,
          false,
          "new prompt_done should clear busy even after a stale cancel",
        );
        assert.equal(state.pendingPromptDone, false);
      });

      it("reconciles DB-only terminal output after the optimistic user echo", async () => {
        state.taskId = "s1";
        state.lastEventSeq = 1;
        const baselineEvents = [
          {
            seq: 1,
            type: "assistant_message",
            data: JSON.stringify({ text: "old response" }),
          },
        ] as any;
        events.replayEvent(
          "assistant_message",
          { text: "old response" },
          baselineEvents,
          0,
        );
        const boundary = dom.messages.lastElementChild as HTMLElement;
        boundary.dataset.syncBoundary = "";
        state.awaitingOwnUserEcho = true;
        state.sentMessageForTask = "s1";
        state.sentMessageOpId = "op-new";
        const optimistic = render.addMessage("user", "new question");
        optimistic.dataset.clientOpId = "op-new";

        let fetches = 0;
        globalThis.fetch = (() => {
          fetches++;
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                events: [
                  {
                    seq: 2,
                    type: "user_message",
                    task_id: "s1",
                    data: JSON.stringify({
                      text: "new question",
                      clientOpId: "op-new",
                    }),
                  },
                  {
                    seq: 3,
                    type: "assistant_message",
                    task_id: "s1",
                    data: JSON.stringify({ text: "late terminal output" }),
                  },
                  {
                    seq: 4,
                    type: "prompt_done",
                    task_id: "s1",
                    data: JSON.stringify({ stopReason: "cancelled" }),
                  },
                ],
                streaming: { thinking: false, assistant: false },
              }),
          });
        }) as any;

        events.handleEvent({
          type: "prompt_done",
          taskId: "s1",
          stopReason: "cancelled",
        });
        assert.equal(fetches, 0, "wait for the own echo to reach SQLite");

        events.handleEvent({
          type: "user_message",
          taskId: "s1",
          text: "new question",
          clientOpId: "op-new",
        });
        await events.waitForTerminalReconciliation();

        assert.equal(fetches, 1);
        assert.equal(
          dom.messages.querySelectorAll('.msg.user[data-client-op-id="op-new"]')
            .length,
          1,
        );
        assert.match(dom.messages.textContent ?? "", /late terminal output/);
      });

      it("reconciles a fresh task whose persisted frontier is zero", async () => {
        state.taskId = "s1";
        state.lastEventSeq = 0;
        state.awaitingOwnUserEcho = true;
        state.sentMessageForTask = "s1";
        state.sentMessageOpId = "op-fresh";
        const optimistic = render.addMessage("user", "first question");
        optimistic.dataset.clientOpId = "op-fresh";

        globalThis.fetch = (() =>
          Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                events: [
                  {
                    seq: 1,
                    type: "user_message",
                    task_id: "s1",
                    data: JSON.stringify({
                      text: "first question",
                      clientOpId: "op-fresh",
                    }),
                  },
                  {
                    seq: 2,
                    type: "assistant_message",
                    task_id: "s1",
                    data: JSON.stringify({ text: "late first output" }),
                  },
                ],
                streaming: { thinking: false, assistant: false },
              }),
          })) as any;

        events.handleEvent({
          type: "prompt_done",
          taskId: "s1",
          stopReason: "cancelled",
        });
        events.handleEvent({
          type: "user_message",
          taskId: "s1",
          text: "first question",
          clientOpId: "op-fresh",
        });
        await events.waitForTerminalReconciliation();

        assert.equal(
          dom.messages.querySelectorAll(
            '.msg.user[data-client-op-id="op-fresh"]',
          ).length,
          1,
        );
        assert.match(dom.messages.textContent ?? "", /late first output/);
      });

      it("valid cancel on current turn still works normally", () => {
        state.taskId = "s1";

        // Turn starts locally: sendPrompt sets busy before sending, and the
        // sender does not receive its own user_message event.
        state.busy = true;
        state.currentPromptId = "prompt-current";
        // A stale reconnect hint must not override explicit turn identity.
        state.newTurnStarted = true;
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
        events.handleEvent({
          type: "prompt_done",
          stopReason: "cancelled",
          promptId: "prompt-current",
        });

        // Should clear pending state and busy (valid cancel for current turn)
        assert.equal(state.pendingToolCallIds.size, 0);
        assert.equal(state.busy, false);
      });
    });

    describe("event filtering", () => {
      it("updates inbox count without adding conversation rows", () => {
        events.handleEvent({ type: "inbox_count_changed", pendingCount: 4 });
        assert.equal(state.inboxCount, 4);
        assert.equal(dom.inboxCount.textContent, "(4)");
        assert.equal(dom.messages.children.length, 0);
      });

      it("applies inbox count immediately during history replay", () => {
        state.replayInProgress = true;

        events.handleEvent({ type: "inbox_count_changed", pendingCount: 4 });
        stateMod.resetTaskUI();

        assert.equal(state.inboxCount, 4);
        assert.equal(dom.inboxCount.textContent, "(4)");
        assert.deepEqual(state.replayQueue, []);
      });

      it("does not add conversation rows for inbox lifecycle events", () => {
        state.taskId = "s1";
        events.handleEvent({ type: "message_created", messageId: "m1" });
        events.handleEvent({
          type: "message_consumed",
          messageId: "m1",
          taskId: "s1",
        });
        events.handleEvent({ type: "message_acked", messageId: "m2" });
        assert.equal(dom.messages.children.length, 0);
      });

      it("renders collaboration messages as system rows only in their projected task", () => {
        state.taskId = "s1";
        events.handleEvent({
          type: "collaboration_message",
          taskId: "s1",
          messageId: "m1",
          sourceTaskId: "s0",
          sourceLabel: "what",
          targetTaskId: "s1",
          targetLabel: "child-a",
          role: "target",
          body: "please review",
        });
        events.handleEvent({
          type: "collaboration_message",
          taskId: "s2",
          messageId: "m1",
          sourceTaskId: "s0",
          sourceLabel: "what",
          targetTaskId: "s1",
          targetLabel: "child-a",
          role: "supervisor",
          body: "please review",
        });
        assert.equal(dom.messages.children.length, 1);
        assert.match(
          dom.messages.textContent ?? "",
          /@what sent @child-a: please review/,
        );
      });

      it("falls back to short ids when labels are missing", () => {
        state.taskId = "s1";
        events.handleEvent({
          type: "collaboration_message",
          taskId: "s1",
          messageId: "m1",
          sourceTaskId: "s0",
          targetTaskId: "s1",
          role: "target",
          body: "please review",
        });
        assert.match(
          dom.messages.textContent ?? "",
          /@s0 sent @s1: please review/,
        );
      });

      it("replays a persisted collaboration system row", () => {
        events.replayEvent(
          "system_message",
          {
            kind: "collaboration",
            messageId: "m1",
            sourceTaskId: "s0",
            sourceLabel: "what",
            targetTaskId: "s1",
            targetLabel: "child-a",
            role: "target",
            body: "please review",
          },
          [],
          0,
        );
        assert.match(
          dom.messages.textContent ?? "",
          /@what sent @child-a: please review/,
        );
      });

      it("replays legacy collaboration rows without labels via short ids", () => {
        events.replayEvent(
          "system_message",
          {
            kind: "collaboration",
            messageId: "m1",
            sourceTaskId: "s0",
            targetTaskId: "s1",
            role: "target",
            body: "please review",
          },
          [],
          0,
        );
        assert.match(
          dom.messages.textContent ?? "",
          /@s0 sent @s1: please review/,
        );
      });

      it("ignores events from other tasks", () => {
        state.taskId = "s1";
        events.handleEvent({
          type: "message_chunk",
          taskId: "s2",
          text: "hello",
        });
        assert.equal(state.currentAssistantEl, null);
        assert.equal(dom.messages.children.length, 0);
      });

      it("processes events matching current task", () => {
        state.taskId = "s1";
        events.handleEvent({
          type: "message_chunk",
          taskId: "s1",
          text: "hello",
        });
        assert.ok(state.currentAssistantEl);
      });

      it("always processes task_created regardless of task filter", () => {
        state.taskId = "s1";
        state.awaitingNewTask = true;
        events.handleEvent({ type: "task_created", taskId: "s2" });
        assert.equal(state.taskId, "s2");
      });

      it("drops non-lifecycle events when taskId is null (mid-switch)", () => {
        state.taskId = null;
        events.handleEvent({
          type: "user_message",
          taskId: "s1",
          text: "leaked",
        });
        events.handleEvent({
          type: "message_chunk",
          taskId: "s1",
          text: "leaked",
        });
        assert.equal(dom.messages.children.length, 0);
        assert.equal(state.currentAssistantEl, null);
      });

      it("allows task_created when taskId is null (mid-switch)", () => {
        state.taskId = null;
        state.awaitingNewTask = true;
        events.handleEvent({ type: "task_created", taskId: "new-s" });
        assert.equal(state.taskId, "new-s");
      });
    });
  });

  describe("status_bar", () => {
    it("shows model and cwd after task_created", () => {
      state.awaitingNewTask = true;
      events.handleEvent({
        type: "task_created",
        taskId: "s1",
        cwd: "/home/user/project",
        configOptions: [
          {
            id: "model",
            name: "Model",
            currentValue: "claude-sonnet",
            options: [],
          },
        ],
      });
      const text = dom.statusBar.textContent;
      assert.ok(text.includes("claude-sonnet"), "should show model");
      assert.ok(text.includes("/home/user/project"), "should show cwd");
    });

    it("renders full cwd in a dedicated span with CSS truncation class", () => {
      state.awaitingNewTask = true;
      events.handleEvent({
        type: "task_created",
        taskId: "s1",
        cwd: "/Users/lelouch/mine/code/webagent",
        configOptions: [],
      });
      const cwdSpan = dom.statusBar.querySelector(".status-cwd");
      assert.ok(cwdSpan, "should have a .status-cwd span");
      assert.equal(cwdSpan.textContent, "/Users/lelouch/mine/code/webagent");
    });

    it("shows cwdDisplay without replacing the canonical cwd", () => {
      state.awaitingNewTask = true;
      events.handleEvent({
        type: "task_created",
        taskId: "s1",
        cwd: "/Users/lelouch/mine/code/webagent",
        cwdDisplay: "~/mine/code/webagent",
        configOptions: [],
      });

      assert.equal(state.taskCwd, "/Users/lelouch/mine/code/webagent");
      assert.equal(state.taskCwdDisplay, "~/mine/code/webagent");
      assert.equal(
        dom.statusBar.querySelector(".status-cwd")?.textContent,
        "~/mine/code/webagent",
      );
    });

    it("shows short cwd without truncation", () => {
      state.awaitingNewTask = true;
      events.handleEvent({
        type: "task_created",
        taskId: "s1",
        cwd: "/home/user",
        configOptions: [],
      });
      assert.ok(dom.statusBar.textContent.includes("/home/user"));
    });

    it("updates when config_set changes model", () => {
      state.taskId = "s1";
      state.configOptions = [
        {
          id: "model",
          name: "Model",
          currentValue: "old-model",
          options: [{ value: "new-model", name: "New" }],
        },
      ];
      events.handleEvent({
        type: "config_set",
        configId: "model",
        value: "new-model",
      });
      assert.ok(dom.statusBar.textContent.includes("new-model"));
    });

    it("updates on config_option_update", () => {
      state.taskId = "s1";
      events.handleEvent({
        type: "config_option_update",
        configOptions: [
          {
            id: "model",
            name: "Model",
            currentValue: "new-model",
            options: [],
          },
        ],
      });
      assert.ok(dom.statusBar.textContent.includes("new-model"));
    });

    it("cleared by resetTaskUI", () => {
      state.awaitingNewTask = true;
      events.handleEvent({
        type: "task_created",
        taskId: "s1",
        cwd: "/home",
        configOptions: [
          { id: "model", name: "Model", currentValue: "test", options: [] },
        ],
      });
      assert.ok(
        dom.statusBar.textContent.length > 0,
        "precondition: not empty",
      );
      stateMod.resetTaskUI();
      assert.equal(dom.statusBar.textContent, "");
    });
  });

  describe("replayEvent", () => {
    it("replays user_message", () => {
      events.replayEvent("user_message", { text: "hello" }, [], 0);
      assert.equal(dom.messages.children.length, 1);
      assert.ok(dom.messages.children[0].classList.contains("user"));
    });

    it("reconciles an optimistic user echo from replay", () => {
      state.awaitingOwnUserEcho = true;
      state.taskId = "s1";
      state.sentMessageForTask = "s1";
      state.sentMessageOpId = "op-1";
      const storedEvents = [
        {
          seq: 1,
          task_id: "s1",
          type: "user_message",
          data: JSON.stringify({ text: "hello" }),
        },
      ] as any;

      events.replayEvent(
        "user_message",
        { text: "hello", clientOpId: "op-1" },
        storedEvents,
        0,
      );

      assert.equal(state.awaitingOwnUserEcho, true);
      assert.equal(state.replayedOwnUserEcho, true);
      assert.equal(state.sentMessageForTask, "s1");
      assert.equal(state.sentMessageOpId, "op-1");

      events.handleEvent({
        type: "user_message",
        taskId: "s1",
        text: "hello",
        clientOpId: "op-1",
      });
      assert.equal(dom.messages.querySelectorAll(".msg.user").length, 1);
      assert.equal(state.awaitingOwnUserEcho, false);
      assert.equal(state.sentMessageOpId, null);
    });

    it("does not reconcile an optimistic echo from another operation", () => {
      state.awaitingOwnUserEcho = true;
      state.sentMessageForTask = "s1";
      state.sentMessageOpId = "op-new";
      const storedEvents = [
        {
          seq: 5,
          task_id: "s1",
          type: "user_message",
          data: JSON.stringify({ text: "old" }),
        },
      ] as any;

      events.replayEvent(
        "user_message",
        { text: "old", clientOpId: "op-old" },
        storedEvents,
        0,
      );

      assert.equal(state.awaitingOwnUserEcho, true);
      assert.equal(state.sentMessageOpId, "op-new");
    });

    it("does not let replayed prompt_done clear authoritative busy state", () => {
      state.busy = true;
      state.busyKind = "agent";

      events.replayEvent(
        "prompt_done",
        { stopReason: "end_turn" },
        [
          {
            seq: 10,
            task_id: "s1",
            type: "prompt_done",
            data: JSON.stringify({ stopReason: "end_turn" }),
          },
        ] as any,
        0,
      );

      assert.equal(state.busy, true);
      assert.equal(state.busyKind, "agent");
    });

    it("replays a non-success prompt stop as a system notice without changing runtime state", () => {
      state.busy = true;
      state.busyKind = "agent";

      events.replayEvent("prompt_done", { stopReason: "max_tokens" }, [], 0);

      assert.equal(
        dom.messages.querySelector(".system-msg")?.textContent,
        "Response stopped after reaching the token limit.",
      );
      assert.equal(state.busy, true);
      assert.equal(state.busyKind, "agent");
    });

    it("replays a persisted prompt error as a system message", () => {
      events.replayEvent(
        "error",
        { message: "provider request failed" },
        [],
        0,
      );

      assert.equal(
        dom.messages.querySelector(".system-msg")?.textContent,
        "err: provider request failed",
      );
    });

    it("ignores replayed prior prompt_done until the own user echo", () => {
      state.busy = true;
      state.awaitingOwnUserEcho = true;
      state.sentMessageForTask = "s1";
      state.sentMessageOpId = "op-new";
      const storedEvents = [
        {
          seq: 10,
          task_id: "s1",
          type: "prompt_done",
          data: JSON.stringify({ stopReason: "end_turn" }),
        },
        {
          seq: 11,
          task_id: "s1",
          type: "user_message",
          data: JSON.stringify({ text: "new" }),
        },
      ] as any;

      events.replayEvent(
        "prompt_done",
        { stopReason: "end_turn" },
        storedEvents,
        0,
      );
      assert.equal(state.busy, true);
      events.replayEvent(
        "user_message",
        { text: "new", clientOpId: "op-new" },
        storedEvents,
        1,
      );
      assert.equal(state.awaitingOwnUserEcho, true);
      assert.equal(state.replayedOwnUserEcho, true);
    });

    it("replays assistant_message", () => {
      events.replayEvent("assistant_message", { text: "response" }, [], 0);
      assert.equal(dom.messages.children.length, 1);
      assert.ok(dom.messages.children[0].classList.contains("assistant"));
    });

    it("replays a real completed-wrapper echo without folding parent narration", () => {
      const toolText =
        "<final_answer>\nCommands run:\n- `git status --short`\nResult: clean";
      const parentText = "状态符合 push gate；现在推送 feature branch。";
      const storedEvents = [
        {
          seq: 1,
          type: "tool_call",
          data: JSON.stringify({
            id: "call_wrapper",
            kind: "other",
            title: "Verify branch before push",
          }),
        },
        {
          seq: 2,
          type: "tool_call_update",
          data: JSON.stringify({
            id: "call_wrapper",
            status: "completed",
            content: [
              {
                type: "content",
                content: { type: "text", text: toolText },
              },
            ],
          }),
        },
        {
          seq: 3,
          type: "assistant_message",
          data: JSON.stringify({ text: `${toolText}${parentText}` }),
        },
      ] as any;

      storedEvents.forEach((event: any, index: number) => {
        events.replayEvent(
          event.type,
          JSON.parse(event.data),
          storedEvents,
          index,
        );
      });

      const assistant = dom.messages.querySelector(".msg.assistant");
      assert.ok(assistant);
      assert.ok(assistant.querySelector("details.subagent-result"));
      assert.equal(
        assistant.querySelector(".assistant-continuation")?.textContent,
        parentText,
      );
    });

    it("merges consecutive assistant_messages into one bubble", () => {
      const storedEvents = [
        {
          seq: 1,
          type: "assistant_message",
          data: JSON.stringify({ text: "Hello " }),
        },
        {
          seq: 2,
          type: "assistant_message",
          data: JSON.stringify({ text: "world" }),
        },
      ] as any;
      events.replayEvent(
        "assistant_message",
        { text: "Hello " },
        storedEvents,
        0,
      );
      events.replayEvent(
        "assistant_message",
        { text: "world" },
        storedEvents,
        1,
      );
      const msgs = dom.messages.querySelectorAll(".msg.assistant");
      assert.equal(msgs.length, 1, "should merge into a single bubble");
      assert.ok(msgs[0].innerHTML.includes("Hello"));
      assert.ok(msgs[0].innerHTML.includes("world"));
    });

    it("does not merge assistant_messages across prompt_done", () => {
      const first = "```text\nanimation.key\n```";
      const second = "next turn";
      const storedEvents = [
        {
          seq: 1,
          type: "assistant_message",
          data: JSON.stringify({ text: first }),
        },
        {
          seq: 2,
          type: "prompt_done",
          data: JSON.stringify({ stopReason: "end_turn" }),
        },
        {
          seq: 3,
          type: "assistant_message",
          data: JSON.stringify({ text: second }),
        },
      ] as any;

      events.replayEvent("assistant_message", { text: first }, storedEvents, 0);
      events.replayEvent(
        "prompt_done",
        { stopReason: "end_turn" },
        storedEvents,
        1,
      );
      events.replayEvent(
        "assistant_message",
        { text: second },
        storedEvents,
        2,
      );

      const msgs = dom.messages.querySelectorAll(".msg.assistant");
      assert.equal(msgs.length, 2, "turn boundary must start a new bubble");
      assert.equal(
        msgs[0].querySelector("code")?.textContent,
        "animation.key\n",
      );
      assert.equal(msgs[1].textContent, second);
    });

    it("does not merge neighboring assistant events across a seq gap", () => {
      const storedEvents = [
        {
          seq: 1,
          type: "assistant_message",
          data: JSON.stringify({ text: "first turn" }),
        },
        {
          seq: 3,
          type: "assistant_message",
          data: JSON.stringify({ text: "second turn" }),
        },
      ] as any;

      events.replayEvent(
        "assistant_message",
        { text: "first turn" },
        storedEvents,
        0,
      );
      events.replayEvent(
        "assistant_message",
        { text: "second turn" },
        storedEvents,
        1,
      );

      assert.equal(dom.messages.querySelectorAll(".msg.assistant").length, 2);
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
      const storedEvents = [
        {
          seq: 1,
          type: "thinking",
          data: JSON.stringify({ text: "part one" }),
        },
        {
          seq: 2,
          type: "thinking",
          data: JSON.stringify({ text: "part two" }),
        },
      ] as any;
      events.replayEvent("thinking", { text: "part one" }, storedEvents, 0);
      events.replayEvent("thinking", { text: "part two" }, storedEvents, 1);
      const thinkings = dom.messages.querySelectorAll(".thinking");
      assert.equal(
        thinkings.length,
        1,
        "should merge into a single thinking block",
      );
      const content =
        thinkings[0].querySelector(".thinking-content").textContent;
      assert.ok(content.includes("part one"));
      assert.ok(content.includes("part two"));
    });

    it("stores data-raw on thinking elements", () => {
      events.replayEvent("thinking", { text: "my thought" }, [], 0);
      const thinking = dom.messages.querySelector(".thinking");
      assert.equal(thinking.getAttribute("data-raw"), "my thought");
    });

    it("updates data-raw when consecutive thinking blocks merge", () => {
      const storedEvents = [
        {
          seq: 1,
          type: "thinking",
          data: JSON.stringify({ text: "part one" }),
        },
        {
          seq: 2,
          type: "thinking",
          data: JSON.stringify({ text: "part two" }),
        },
      ] as any;
      events.replayEvent("thinking", { text: "part one" }, storedEvents, 0);
      events.replayEvent("thinking", { text: "part two" }, storedEvents, 1);
      const thinking = dom.messages.querySelector(".thinking");
      assert.equal(thinking.getAttribute("data-raw"), "part onepart two");
    });

    it("replays tool_call and tool_call_update", () => {
      events.replayEvent(
        "tool_call",
        { id: "t1", kind: "read", title: "Read", rawInput: {} },
        [],
        0,
      );
      events.replayEvent(
        "tool_call_update",
        { id: "t1", status: "completed" },
        [],
        1,
      );
      const el = globalThis.document.getElementById("tc-t1")!;
      assert.ok(el.classList.contains("completed"));
    });

    it("keeps replayed plans collapsed in the transcript", () => {
      events.replayEvent(
        "plan",
        { entries: [{ content: "Old", status: "pending" }] },
        [],
        0,
      );
      events.replayEvent(
        "plan",
        { entries: [{ content: "New", status: "in_progress" }] },
        [],
        1,
      );

      const plans = Array.from(
        (dom.messages as HTMLElement).querySelectorAll<HTMLDetailsElement>(
          ".plan",
        ),
      );
      assert.equal(plans.length, 2);
      assert.equal(plans[0].open, false);
      assert.equal(plans[1].open, false);
    });

    it("replays task_complete with visible summary", () => {
      events.replayEvent(
        "tool_call",
        {
          id: "t-tc",
          kind: "task_complete",
          title: "Task complete",
          rawInput: {},
        },
        [],
        0,
      );
      events.replayEvent(
        "tool_call_update",
        {
          id: "t-tc",
          status: "completed",
          content: [{ type: "text", content: { text: "Deployed to prod" } }],
        },
        [],
        1,
      );
      const el = globalThis.document.getElementById("tc-t-tc")!;
      assert.ok(el.classList.contains("completed"));
      assert.ok(
        !el.querySelector("details"),
        "task_complete should not use collapsed details during replay",
      );
      const summary = el.querySelector(".tc-summary")!;
      assert.ok(summary, "should have visible .tc-summary during replay");
      assert.ok(summary.textContent.includes("Deployed to prod"));
    });

    it("replays bash_command and bash_result", () => {
      events.replayEvent("bash_command", { command: "echo hi" }, [], 0);
      const pending = globalThis.document.getElementById("bash-replay-pending");
      assert.ok(pending);
      events.replayEvent("bash_result", { output: "hi\n", code: 0 }, [], 1);
      assert.equal(
        globalThis.document.getElementById("bash-replay-pending"),
        null,
      );
    });

    it("replays permission_request with resolved state", () => {
      const evts = [
        {
          type: "permission_request",
          data: JSON.stringify({
            requestId: "p1",
            title: "Allow?",
            options: [{ optionId: "a", kind: "allow", name: "Allow" }],
          }),
        },
        {
          type: "permission_response",
          data: JSON.stringify({
            requestId: "p1",
            denied: false,
            optionName: "Allow",
          }),
        },
      ];
      events.replayEvent(
        "permission_request",
        JSON.parse(evts[0].data),
        evts,
        0,
      );
      const perm = dom.messages.querySelector(".permission");
      // Already resolved — no buttons should be present
      assert.equal(perm.querySelectorAll("button").length, 0);
    });

    it("preserves permission title through full replay cycle", () => {
      const evts = [
        {
          type: "permission_request",
          data: JSON.stringify({
            requestId: "p2",
            title: "Run rm -rf",
            options: [{ optionId: "a", kind: "allow", name: "Allow once" }],
          }),
        },
        {
          type: "permission_response",
          data: JSON.stringify({
            requestId: "p2",
            denied: false,
            optionName: "Allow once",
          }),
        },
      ];
      events.replayEvent(
        "permission_request",
        JSON.parse(evts[0].data),
        evts,
        0,
      );
      events.replayEvent(
        "permission_response",
        JSON.parse(evts[1].data),
        evts,
        1,
      );
      const perm = dom.messages.querySelector(".permission");
      assert.ok(
        perm.textContent.includes("Run rm -rf"),
        "title should be preserved",
      );
      assert.ok(
        perm.textContent.includes("Allow once"),
        "action should be shown",
      );
    });
  });

  describe("loadHistory", () => {
    it("does not commit after the task UI is reset", async () => {
      let resolveResponse!: (value: Response) => void;
      globalThis.fetch = () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        });

      const pending = events.loadHistory("failed");
      stateMod.resetTaskUI();
      resolveResponse({
        ok: true,
        async json() {
          return [
            {
              seq: 1,
              type: "user_message",
              data: JSON.stringify({ text: "stale history" }),
            },
          ];
        },
      } as Response);

      assert.equal(await pending, false);
      assert.equal(dom.messages.textContent, "");
      assert.equal(state.lastEventSeq, 0);
    });

    it("ignores a stale history response after a newer load starts", async () => {
      let resolveFirst!: (value: Response) => void;
      const firstResponse = new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
      let requestCount = 0;
      globalThis.fetch = async () => {
        requestCount++;
        if (requestCount === 1) return firstResponse;
        return {
          ok: true,
          async json() {
            return [
              {
                seq: 2,
                type: "user_message",
                data: JSON.stringify({ text: "new task" }),
              },
            ];
          },
        } as Response;
      };

      const staleLoad = events.loadHistory("old");
      const currentLoad = events.loadHistory("new");
      await currentLoad;
      resolveFirst({
        ok: true,
        async json() {
          return [
            {
              seq: 1,
              type: "user_message",
              data: JSON.stringify({ text: "old task" }),
            },
          ];
        },
      } as Response);
      const staleResult = await staleLoad;

      assert.equal(staleResult, false);
      assert.equal(dom.messages.textContent, "new task");
      assert.equal(state.lastEventSeq, 2);
    });

    it("sets lastEventSeq and sync boundary from loaded events", async () => {
      const fakeEvents = [
        { seq: 1, type: "user_message", data: JSON.stringify({ text: "hi" }) },
        {
          seq: 2,
          type: "assistant_message",
          data: JSON.stringify({ text: "hello" }),
        },
      ];
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(fakeEvents),
        })) as any;

      const loaded = await events.loadHistory("s1");
      assert.equal(loaded, true);
      assert.equal(state.lastEventSeq, 2);
      assert.equal(dom.messages.children.length, 2);
      assert.ok(
        dom.messages.lastElementChild.hasAttribute("data-sync-boundary"),
      );
    });

    it("keeps history plans transcript-only until snapshot hydration", async () => {
      const fakeEvents = [
        {
          seq: 1,
          type: "plan",
          data: JSON.stringify({
            entries: [{ content: "Reconnect work", status: "in_progress" }],
          }),
        },
      ];
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(fakeEvents),
        })) as any;

      assert.equal(await events.loadHistory("s1"), true);
      assert.equal(dom.planPanel.hidden, true);
      assert.ok(dom.messages.textContent.includes("Reconnect work"));
    });

    it("does not restore a plan that completed before history ended", async () => {
      const fakeEvents = [
        {
          seq: 1,
          type: "plan",
          data: JSON.stringify({
            entries: [{ content: "Old work", status: "in_progress" }],
          }),
        },
        {
          seq: 2,
          type: "prompt_done",
          data: JSON.stringify({ stopReason: "end_turn" }),
        },
      ];
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(fakeEvents),
        })) as any;

      assert.equal(await events.loadHistory("s1"), true);
      assert.equal(dom.planPanel.hidden, true);
      assert.equal(dom.planPanel.textContent, "");
    });

    it("restores a plan from snapshot when history starts mid-turn", async () => {
      const fakeEvents = [
        {
          seq: 3,
          type: "user_message",
          data: JSON.stringify({ text: "new turn" }),
        },
        {
          seq: 4,
          type: "plan",
          data: JSON.stringify({
            entries: [{ content: "New work", status: "in_progress" }],
          }),
        },
        {
          seq: 5,
          type: "prompt_done",
          data: JSON.stringify({ stopReason: "cancelled" }),
        },
      ];
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(fakeEvents),
        })) as any;

      assert.equal(await events.loadHistory("s1"), true);
      applyPlanSnapshot([{ content: "New work", status: "in_progress" }]);
      assert.equal(dom.planPanel.hidden, false);
      assert.equal(
        dom.planPanel.querySelector(".plan-entry")?.textContent,
        "[~] New work",
      );
    });

    it("does not let live history events bypass runtime plan state", async () => {
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                seq: 1,
                type: "plan",
                data: JSON.stringify({
                  entries: [{ content: "Replay work", status: "in_progress" }],
                }),
              },
            ]),
        })) as any;
      await events.loadHistory("s1");
      applyPlanSnapshot([{ content: "Snapshot work", status: "in_progress" }]);

      events.handleEvent({
        type: "plan",
        entries: [{ content: "New live work", status: "in_progress" }],
      });
      state.taskId = "s1";

      assert.equal(
        dom.planPanel.querySelector(".plan-entry")?.textContent,
        "[~] Snapshot work",
      );

      events.handleEvent({
        type: "state_patch",
        taskId: "s1",
        seq: 2,
        patch: {
          runtime: {
            plan: [{ content: "New live work", status: "in_progress" }],
          },
        },
      });
      assert.equal(
        dom.planPanel.querySelector(".plan-entry")?.textContent,
        "[~] New live work",
      );
    });

    it("does not let another task's state patch clear this panel", () => {
      state.taskId = "current";
      applyPlanSnapshot([{ content: "Current work", status: "in_progress" }]);
      state.taskId = "current";

      events.handleEvent({
        type: "state_patch",
        taskId: "stale",
        seq: 2,
        patch: { runtime: { plan: null } },
      });

      assert.equal(dom.planPanel.hidden, false);
      assert.equal(
        dom.planPanel.querySelector(".plan-entry")?.textContent,
        "[~] Current work",
      );
    });

    it("sends limit parameter in fetch URL", async () => {
      let capturedUrl = "";
      globalThis.fetch = ((url: string) => {
        capturedUrl = url;
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [],
              streaming: { thinking: false, assistant: false },
            }),
        });
      }) as any;

      await events.loadHistory("s1");
      assert.ok(capturedUrl.includes("limit="), "should include limit param");
    });

    it("sets pagination state from paginated response", async () => {
      const fakeEvents = [
        { seq: 50, type: "user_message", data: JSON.stringify({ text: "hi" }) },
        {
          seq: 51,
          type: "assistant_message",
          data: JSON.stringify({ text: "hello" }),
        },
      ];
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
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
      assert.equal(state.replayInProgress, false);
    });

    it("sets hasMoreHistory=false when all events fit in one page", async () => {
      const fakeEvents = [
        {
          seq: 1,
          type: "user_message",
          data: JSON.stringify({ text: "only" }),
        },
      ];
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
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
    it("reconciles a newer terminal update after an older page creates its tool host", async () => {
      state.taskId = "s1";
      let request = 0;
      setFetch(() => {
        request++;
        if (request === 1) {
          return {
            ok: true,
            json: async () => ({
              events: [
                {
                  seq: 301,
                  task_id: "s1",
                  type: "tool_call_update",
                  data: JSON.stringify({
                    id: "tc-cross-page",
                    status: "completed",
                    content: [
                      {
                        type: "content",
                        content: { text: "final output" },
                      },
                    ],
                  }),
                },
              ],
              hasMore: true,
              streaming: {},
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            events: [
              {
                seq: 100,
                task_id: "s1",
                type: "tool_call",
                data: JSON.stringify({
                  id: "tc-cross-page",
                  kind: "task",
                  title: "Cross-page tool",
                  rawInput: {},
                }),
              },
              {
                seq: 200,
                task_id: "s1",
                type: "tool_call_update",
                data: JSON.stringify({
                  id: "tc-cross-page",
                  status: "in_progress",
                  content: [
                    {
                      type: "content",
                      content: { text: "old progress" },
                    },
                  ],
                }),
              },
            ],
            hasMore: false,
            streaming: {},
          }),
        };
      });

      assert.equal(await events.loadHistory("s1"), true);
      assert.equal(document.getElementById("tc-tc-cross-page"), null);
      assert.equal(await events.loadOlderEvents("s1"), true);

      const tool = document.getElementById("tc-tc-cross-page");
      assert.ok(tool);
      assert.ok(tool.classList.contains("completed"));
      assert.equal(tool.querySelector(".icon")?.textContent, "✓");
      assert.match(
        tool.querySelector(".tc-output")?.textContent ?? "",
        /final output/,
      );
      assert.doesNotMatch(
        tool.querySelector(".tc-output")?.textContent ?? "",
        /old progress/,
      );
    });

    it("prepends older events and updates pagination state", async () => {
      // Set up initial state as if loadHistory loaded events 5-6
      state.oldestLoadedSeq = 5;
      state.hasMoreHistory = true;
      state.taskId = "s1";
      events.replayEvent("user_message", { text: "msg-5" }, [], 0);
      events.replayEvent("assistant_message", { text: "msg-6" }, [], 0);

      const olderEvents = [
        {
          seq: 3,
          type: "user_message",
          data: JSON.stringify({ text: "msg-3" }),
        },
        {
          seq: 4,
          type: "assistant_message",
          data: JSON.stringify({ text: "msg-4" }),
        },
      ];
      globalThis.fetch = ((url: string) => {
        assert.ok(url.includes("before=5"), "should use before cursor");
        assert.ok(url.includes("limit="), "should include limit");
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
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

    it("does not make historical tool calls foreground-pending", async () => {
      state.oldestLoadedSeq = 5;
      state.hasMoreHistory = true;
      state.taskId = "s1";
      events.replayEvent("user_message", { text: "current" }, [], 0);

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  seq: 4,
                  type: "tool_call",
                  data: JSON.stringify({
                    id: "tc-historical",
                    kind: "read",
                    title: "Historical tool",
                    rawInput: {},
                  }),
                },
              ],
              hasMore: false,
            }),
        })) as any;

      assert.equal(await events.loadOlderEvents("s1"), true);
      assert.ok(document.getElementById("tc-tc-historical"));
      assert.equal(state.pendingToolCallIds.size, 0);
    });

    it("merges adjacent assistant fragments across older-history pagination", async () => {
      state.oldestLoadedSeq = 201;
      state.hasMoreHistory = true;
      state.taskId = "s1";
      const currentEvents = [
        {
          seq: 201,
          type: "assistant_message",
          data: JSON.stringify({ text: ": 3 }" }),
        },
        {
          seq: 202,
          type: "user_message",
          data: JSON.stringify({ text: "anchor" }),
        },
      ] as any;
      events.replayEvent(
        "assistant_message",
        { text: ": 3 }" },
        currentEvents,
        0,
      );
      events.replayEvent("user_message", { text: "anchor" }, currentEvents, 1);

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  seq: 200,
                  type: "assistant_message",
                  data: JSON.stringify({ text: "reconnect { id" }),
                },
              ],
              hasMore: false,
            }),
        })) as any;

      assert.equal(await events.loadOlderEvents("s1"), true);
      const msgs = dom.messages.querySelectorAll(".msg.assistant");
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].getAttribute("data-raw"), "reconnect { id: 3 }");
      assert.equal((msgs[0] as HTMLElement).dataset.firstEventSeq, "200");
      assert.equal((msgs[0] as HTMLElement).dataset.lastEventSeq, "201");
    });

    it("preserves a final-answer boundary across older-history pagination", async () => {
      state.oldestLoadedSeq = 203;
      state.hasMoreHistory = true;
      state.taskId = "s1";
      const toolText = "<final_answer>\nResult body";
      const currentEvents = [
        {
          seq: 203,
          type: "assistant_message",
          data: JSON.stringify({ text: "Parent continuation" }),
        },
      ] as any;
      events.replayEvent(
        "assistant_message",
        { text: "Parent continuation" },
        currentEvents,
        0,
      );

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  seq: 200,
                  type: "tool_call",
                  data: JSON.stringify({
                    id: "wrapper",
                    kind: "other",
                    title: "Run task",
                  }),
                },
                {
                  seq: 201,
                  type: "tool_call_update",
                  data: JSON.stringify({
                    id: "wrapper",
                    status: "completed",
                    content: [
                      {
                        type: "content",
                        content: { type: "text", text: toolText },
                      },
                    ],
                  }),
                },
                {
                  seq: 202,
                  type: "assistant_message",
                  data: JSON.stringify({ text: toolText }),
                },
              ],
              hasMore: false,
            }),
        })) as any;

      assert.equal(await events.loadOlderEvents("s1"), true);
      const assistant = dom.messages.querySelector(".msg.assistant");
      assert.ok(assistant?.querySelector(".subagent-result"));
      assert.equal(
        assistant?.querySelector(".assistant-continuation")?.textContent,
        "Parent continuation",
      );
    });

    it("preserves scroll position when the sole child merges with older history", async () => {
      state.oldestLoadedSeq = 201;
      state.hasMoreHistory = true;
      state.taskId = "s1";
      const currentEvents = [
        {
          seq: 201,
          type: "assistant_message",
          data: JSON.stringify({ text: ": 3 }" }),
        },
      ] as any;
      events.replayEvent(
        "assistant_message",
        { text: ": 3 }" },
        currentEvents,
        0,
      );
      const originalScrollHeight = Object.getOwnPropertyDescriptor(
        dom.messages,
        "scrollHeight",
      );
      Object.defineProperty(dom.messages, "scrollHeight", {
        configurable: true,
        get() {
          const raw = dom.messages
            .querySelector(".msg.assistant")
            ?.getAttribute("data-raw");
          return raw === "reconnect { id: 3 }" ? 200 : 100;
        },
      });
      dom.messages.scrollTop = 10;

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  seq: 200,
                  type: "assistant_message",
                  data: JSON.stringify({ text: "reconnect { id" }),
                },
              ],
              hasMore: false,
            }),
        })) as any;

      try {
        assert.equal(await events.loadOlderEvents("s1"), true);
        assert.equal(dom.messages.querySelectorAll(".msg.assistant").length, 1);
        assert.ok(
          dom.messages.scrollTop > 10,
          "scrollTop must compensate for the merged prefix height",
        );
      } finally {
        if (originalScrollHeight) {
          Object.defineProperty(
            dom.messages,
            "scrollHeight",
            originalScrollHeight,
          );
        } else {
          delete dom.messages.scrollHeight;
        }
      }
    });

    it("does not merge older replay into an active assistant stream", async () => {
      state.oldestLoadedSeq = 201;
      state.hasMoreHistory = true;
      state.taskId = "s1";
      const currentEvents = [
        {
          seq: 201,
          type: "assistant_message",
          data: JSON.stringify({ text: ": 3 }" }),
        },
        {
          seq: 202,
          type: "user_message",
          data: JSON.stringify({ text: "anchor" }),
        },
      ] as any;
      events.replayEvent(
        "assistant_message",
        { text: ": 3 }" },
        currentEvents,
        0,
      );
      events.replayEvent("user_message", { text: "anchor" }, currentEvents, 1);
      const active = dom.messages.querySelector(".msg.assistant");
      assert.ok(active);
      active.setAttribute("data-primed", "");
      state.currentAssistantEl = active;
      state.currentAssistantText = ": 3 } live tail";

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  seq: 200,
                  type: "assistant_message",
                  data: JSON.stringify({ text: "reconnect { id" }),
                },
              ],
              hasMore: false,
            }),
        })) as any;

      assert.equal(await events.loadOlderEvents("s1"), true);
      const msgs = dom.messages.querySelectorAll(".msg.assistant");
      assert.equal(msgs.length, 2);
      assert.equal(active.getAttribute("data-raw"), ": 3 }");
      assert.equal(state.currentAssistantText, ": 3 } live tail");
    });

    it("does not let older plan history replace the current pinned plan", async () => {
      applyPlanSnapshot([{ content: "Current work", status: "in_progress" }]);
      state.oldestLoadedSeq = 5;
      state.hasMoreHistory = true;
      state.taskId = "s1";
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  seq: 4,
                  type: "plan",
                  data: JSON.stringify({
                    entries: [{ content: "Old work", status: "pending" }],
                  }),
                },
              ],
              hasMore: false,
            }),
        })) as any;

      assert.equal(await events.loadOlderEvents("s1"), true);
      assert.equal(
        dom.planPanel.querySelector(".plan-entry")?.textContent,
        "[~] Current work",
      );
    });

    it("preserves the current visual anchor when prepending older events", async () => {
      state.oldestLoadedSeq = 5;
      state.hasMoreHistory = true;
      state.taskId = "s1";
      events.replayEvent("user_message", { text: "msg-5" }, [], 0);
      events.replayEvent("assistant_message", { text: "msg-6" }, [], 0);
      await new Promise((resolve) =>
        requestAnimationFrame(() => {
          resolve(null);
        }),
      );

      let scrollTop = 100;
      Object.defineProperties(dom.messages, {
        scrollTop: {
          get: () => scrollTop,
          set: (v: number) => {
            scrollTop = v;
          },
          configurable: true,
        },
        clientHeight: { value: 544, configurable: true },
        scrollHeight: { value: 6000, configurable: true },
      });
      dom.messages.getBoundingClientRect = () =>
        ({
          top: 0,
          bottom: 544,
        }) as DOMRect;

      const anchor = dom.messages.children[0] as HTMLElement;
      const anchorTops = [120, 920, 120];
      anchor.getBoundingClientRect = () => {
        const top = anchorTops.shift() ?? 120;
        return { top, bottom: top + 40 } as DOMRect;
      };

      setFetch(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  seq: 3,
                  type: "user_message",
                  data: JSON.stringify({ text: "msg-3" }),
                },
                {
                  seq: 4,
                  type: "assistant_message",
                  data: JSON.stringify({ text: "msg-4" }),
                },
              ],
              hasMore: true,
            }),
        }),
      );

      await events.loadOlderEvents("s1");

      assert.equal(scrollTop, 900);
    });

    it("does not fight user-sized scroll movement during anchor stabilization", async () => {
      state.oldestLoadedSeq = 5;
      state.hasMoreHistory = true;
      state.taskId = "s1";
      events.replayEvent("user_message", { text: "msg-5" }, [], 0);
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(null);
        });
      });

      let scrollTop = 100;
      Object.defineProperties(dom.messages, {
        scrollTop: {
          get: () => scrollTop,
          set: (v: number) => {
            scrollTop = v;
          },
          configurable: true,
        },
        clientHeight: { value: 544, configurable: true },
        scrollHeight: { value: 6000, configurable: true },
      });
      dom.messages.getBoundingClientRect = () =>
        ({ top: 0, bottom: 544 }) as DOMRect;

      const anchor = dom.messages.children[0] as HTMLElement;
      const anchorTops = [120, 920, 220];
      anchor.getBoundingClientRect = () => {
        const top = anchorTops.shift() ?? 220;
        return { top, bottom: top + 40 } as DOMRect;
      };

      setFetch(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  seq: 4,
                  type: "assistant_message",
                  data: JSON.stringify({ text: "msg-4" }),
                },
              ],
              hasMore: true,
            }),
        }),
      );

      await events.loadOlderEvents("s1");

      assert.equal(scrollTop, 900);
    });

    it("waits for iOS top rubber-band before prepending older events", async () => {
      state.oldestLoadedSeq = 5;
      state.hasMoreHistory = true;
      state.taskId = "s1";
      events.replayEvent("user_message", { text: "msg-5" }, [], 0);
      await new Promise((resolve) =>
        requestAnimationFrame(() => {
          resolve(null);
        }),
      );

      let scrollTop = -50;
      Object.defineProperties(dom.messages, {
        scrollTop: {
          get: () => scrollTop,
          set: (v: number) => {
            scrollTop = v;
          },
          configurable: true,
        },
        clientHeight: { value: 544, configurable: true },
        scrollHeight: { value: 6000, configurable: true },
      });
      dom.messages.getBoundingClientRect = () =>
        ({ top: 0, bottom: 544 }) as DOMRect;

      const anchor = dom.messages.children[0] as HTMLElement;
      const anchorTops = [100, 100, 100, 100, 100, 900, 100];
      anchor.getBoundingClientRect = () => {
        const top = anchorTops.shift() ?? 100;
        return { top, bottom: top + 40 } as DOMRect;
      };

      const originalRaf = globalThis.requestAnimationFrame;
      globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
        scrollTop = Math.max(scrollTop, 0);
        cb(0);
        return 1;
      };

      setFetch(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  seq: 4,
                  type: "assistant_message",
                  data: JSON.stringify({ text: "msg-4" }),
                },
              ],
              hasMore: true,
            }),
        }),
      );

      try {
        await events.loadOlderEvents("s1");
      } finally {
        globalThis.requestAnimationFrame = originalRaf;
      }

      assert.equal(scrollTop, 800);
    });

    it("removes sentinel and sets hasMoreHistory=false when no more events", async () => {
      state.oldestLoadedSeq = 3;
      state.hasMoreHistory = true;
      state.taskId = "s1";
      events.replayEvent("user_message", { text: "existing" }, [], 0);

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  seq: 1,
                  type: "user_message",
                  data: JSON.stringify({ text: "first" }),
                },
              ],
              streaming: { thinking: false, assistant: false },
              hasMore: false,
            }),
        })) as any;

      await events.loadOlderEvents("s1");
      assert.equal(state.hasMoreHistory, false);
      assert.equal(state.oldestLoadedSeq, 1);
    });

    it("does not immediately retry a failed older-history load while sentinel remains visible", async () => {
      state.oldestLoadedSeq = 5;
      state.hasMoreHistory = true;
      state.taskId = "s1";
      const sentinel = document.createElement("div");
      sentinel.id = "history-sentinel";
      dom.messages.prepend(sentinel);

      const observers: Array<{
        callback: (entries: Array<{ isIntersecting: boolean }>) => void;
      }> = [];
      const originalIntersectionObserver = (globalThis as any)
        .IntersectionObserver;
      (globalThis as any).IntersectionObserver =
        class MockIntersectionObserver {
          callback: (entries: Array<{ isIntersecting: boolean }>) => void;
          constructor(
            callback: (entries: Array<{ isIntersecting: boolean }>) => void,
          ) {
            this.callback = callback;
            observers.push(this);
          }
          observe() {}
          disconnect() {}
        };

      let fetchCount = 0;
      setFetch(() => {
        fetchCount++;
        return Promise.resolve({ ok: false, status: 503 });
      });

      try {
        const result = await events.loadOlderEvents("s1");
        assert.equal(result, false);
        assert.equal(fetchCount, 1);

        observers[0].callback([{ isIntersecting: true }]);
        await Promise.resolve();
        assert.equal(fetchCount, 1);

        observers[0].callback([{ isIntersecting: false }]);
        observers[1].callback([{ isIntersecting: true }]);
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(fetchCount, 2);
      } finally {
        (globalThis as any).IntersectionObserver = originalIntersectionObserver;
      }
    });

    it("preserves the current visual anchor when failed load shows and hides loading row", async () => {
      state.oldestLoadedSeq = 5;
      state.hasMoreHistory = true;
      state.taskId = "s1";
      events.replayEvent("user_message", { text: "msg-5" }, [], 0);
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(null);
        });
      });

      let scrollTop = 100;
      Object.defineProperties(dom.messages, {
        scrollTop: {
          get: () => scrollTop,
          set: (v: number) => {
            scrollTop = v;
          },
          configurable: true,
        },
        clientHeight: { value: 544, configurable: true },
        scrollHeight: { value: 6000, configurable: true },
      });
      dom.messages.getBoundingClientRect = () =>
        ({ top: 0, bottom: 544 }) as DOMRect;

      const anchor = dom.messages.children[0] as HTMLElement;
      const anchorTops = [100, 124, 124, 100];
      anchor.getBoundingClientRect = () => {
        const top = anchorTops.shift() ?? 100;
        return { top, bottom: top + 40 } as DOMRect;
      };

      setFetch(() => Promise.resolve({ ok: false, status: 503 }));

      const result = await events.loadOlderEvents("s1");

      assert.equal(result, false);
      assert.equal(scrollTop, 100);
      assert.equal(document.getElementById("history-loading"), null);
    });

    it("ignores stale older-history cleanup after switching tasks", async () => {
      const responses: Array<(res: { ok: boolean; status?: number }) => void> =
        [];
      setFetch(
        () =>
          new Promise((resolve) => {
            responses.push(resolve);
          }),
      );

      state.oldestLoadedSeq = 5;
      state.hasMoreHistory = true;
      state.taskId = "s1";
      events.replayEvent("user_message", { text: "old" }, [], 0);
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(null);
        });
      });

      const oldLoad = events.loadOlderEvents("s1");
      assert.equal(document.getElementById("history-loading") != null, true);

      dom.messages.innerHTML = "";
      state.taskId = "s2";
      state.oldestLoadedSeq = 10;
      state.hasMoreHistory = true;
      state.loadingOlderEvents = false;
      events.replayEvent("user_message", { text: "new" }, [], 0);
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(null);
        });
      });

      const newLoad = events.loadOlderEvents("s2");
      assert.equal(responses.length, 2);

      responses[0]({ ok: false, status: 503 });
      await oldLoad;

      assert.equal(state.loadingOlderEvents, true);
      assert.equal(document.getElementById("history-loading") != null, true);

      responses[1]({ ok: false, status: 503 });
      await newLoad;

      assert.equal(state.loadingOlderEvents, false);
      assert.equal(document.getElementById("history-loading"), null);
    });

    it("ignores stale same-task older-history response after task reset", async () => {
      const responses: Array<
        (res: { ok: boolean; json: () => unknown }) => void
      > = [];
      setFetch(
        () =>
          new Promise((resolve) => {
            responses.push(resolve);
          }),
      );

      state.oldestLoadedSeq = 5;
      state.hasMoreHistory = true;
      state.taskId = "s1";
      events.replayEvent("user_message", { text: "old-visible" }, [], 0);
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(null);
        });
      });

      const oldLoad = events.loadOlderEvents("s1");

      stateMod.resetTaskUI();
      state.taskId = "s1";
      state.oldestLoadedSeq = 50;
      state.hasMoreHistory = true;
      events.replayEvent("user_message", { text: "fresh-visible" }, [], 0);

      responses[0]({
        ok: true,
        json: () =>
          Promise.resolve({
            events: [
              {
                seq: 3,
                type: "user_message",
                data: JSON.stringify({ text: "stale-prepend" }),
              },
            ],
            hasMore: false,
          }),
      });

      const result = await oldLoad;

      assert.equal(result, false);
      assert.equal(state.oldestLoadedSeq, 50);
      assert.equal(dom.messages.textContent.includes("fresh-visible"), true);
      assert.equal(dom.messages.textContent.includes("stale-prepend"), false);
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
    it("cannot overwrite a newer full-history load during a task switch", async () => {
      let resolveIncremental!: (value: Response) => void;
      const incrementalResponse = new Promise<Response>((resolve) => {
        resolveIncremental = resolve;
      });
      globalThis.fetch = async (input) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.includes("/old/events?after=")) return incrementalResponse;
        return {
          ok: true,
          async json() {
            return [
              {
                seq: 2,
                type: "user_message",
                data: JSON.stringify({ text: "new task" }),
              },
            ];
          },
        } as Response;
      };
      state.taskId = "old";

      const staleLoad = events.loadNewEvents("old");
      state.taskId = null;
      const currentLoad = events.loadHistory("new");
      await currentLoad;
      resolveIncremental({
        ok: true,
        async json() {
          return [
            {
              seq: 3,
              type: "user_message",
              data: JSON.stringify({ text: "stale incremental" }),
            },
          ];
        },
      } as Response);
      const staleResult = await staleLoad;

      assert.equal(staleResult, false);
      assert.equal(dom.messages.textContent, "new task");
      assert.equal(state.lastEventSeq, 2);
      assert.equal(state.replayInProgress, false);
    });

    it("appends new events without clearing existing DOM", async () => {
      // Simulate existing DOM from loadHistory
      events.replayEvent("user_message", { text: "old" }, [], 0);
      state.lastEventSeq = 1;
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");

      const newEvents = [
        {
          seq: 2,
          type: "assistant_message",
          data: JSON.stringify({ text: "new reply" }),
        },
      ];
      globalThis.fetch = ((url: string) => {
        assert.ok(url.includes("after=1"));
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(newEvents),
        });
      }) as any;

      const result = await events.loadNewEvents("s1");
      assert.equal(result, true);
      assert.equal(state.lastEventSeq, 2);
      // Old message preserved + new message appended
      assert.equal(dom.messages.children.length, 2);
      assert.ok(dom.messages.children[0].textContent.includes("old"));
      assert.ok(dom.messages.children[1].textContent.includes("new reply"));
      // Boundary moved to last element
      assert.ok(
        dom.messages.lastElementChild.hasAttribute("data-sync-boundary"),
      );
    });

    it("keeps live DOM when a frontier-zero catch-up returns no events", async () => {
      // A /new task sits at frontier 0 with no [data-sync-boundary], so the
      // catch-up takes the `replaceChildren()` branch that wipes the whole
      // pane. That wipe must not happen when the server has nothing to replace
      // the content with: the pane holds client-only rows (addSystem banners,
      // slash-command output) that are never persisted, plus any optimistic
      // user bubble whose POST has not been flushed to the DB yet.
      state.taskId = "s1";
      state.lastEventSeq = 0;
      render.addSystem("Task created: fresh");
      render.addMessage("user", "optimistic, not yet persisted");
      assert.equal(
        dom.messages.querySelector("[data-sync-boundary]"),
        null,
        "precondition: no sync boundary on a never-replayed task",
      );
      const liveContent = dom.messages.textContent;
      assert.ok(liveContent.includes("optimistic, not yet persisted"));

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        })) as any;

      assert.equal(await events.loadNewEvents("s1"), true);
      assert.equal(
        dom.messages.textContent,
        liveContent,
        "empty catch-up must leave the pane untouched",
      );
    });

    it("still replaces live DOM when a frontier-zero catch-up returns events", async () => {
      // Control for the test above: proves the wipe is still reachable, so the
      // preservation assertion is not vacuously true.
      state.taskId = "s1";
      state.lastEventSeq = 0;
      render.addSystem("Task created: fresh");
      render.addMessage("user", "optimistic, not yet persisted");

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                seq: 1,
                type: "user_message",
                data: JSON.stringify({ text: "authoritative copy" }),
              },
            ]),
        })) as any;

      assert.equal(await events.loadNewEvents("s1"), true);
      assert.ok(dom.messages.textContent.includes("authoritative copy"));
      assert.ok(
        !dom.messages.textContent.includes("Task created: fresh"),
        "authoritative transcript replaces the live pane",
      );
      assert.equal(state.lastEventSeq, 1);
    });

    it("carries an unpersisted optimistic bubble across the frontier-zero wipe", async () => {
      // An in-flight prompt (e.g. still uploading attachments) exists only in
      // the DOM: it is not in the transcript we are about to fetch, and the
      // server's eventual user_message broadcast is suppressed as this
      // client's own echo. Wiping it would make the message unrecoverable
      // without a manual reload.
      state.taskId = "s1";
      state.lastEventSeq = 0;
      render.addMessage("assistant", "earlier reply");
      const optimistic = render.addMessage("user", "still uploading");
      optimistic.dataset.optimisticOpId = "op-42";
      state.awaitingOwnUserEcho = true;
      state.sentMessageOpId = "op-42";

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                seq: 1,
                type: "assistant_message",
                data: JSON.stringify({ text: "authoritative earlier reply" }),
              },
            ]),
        })) as any;

      assert.equal(await events.loadNewEvents("s1"), true);
      assert.ok(
        dom.messages.textContent.includes("authoritative earlier reply"),
        "authoritative transcript must be applied",
      );
      assert.ok(
        dom.messages.textContent.includes("still uploading"),
        "in-flight bubble must survive",
      );
      assert.equal(
        dom.messages.lastElementChild,
        optimistic,
        "it must stay at the tail, after the replayed transcript",
      );
      assert.ok(
        !optimistic.hasAttribute("data-sync-boundary"),
        "an unpersisted bubble must not become the persistence boundary",
      );
    });

    it("drops the optimistic bubble once its own echo is no longer awaited", async () => {
      // Control: once the POST is confirmed the bubble is redundant with the
      // persisted copy, so the wipe must still remove it. Without this the
      // preservation above could be keeping stale duplicates alive forever.
      state.taskId = "s1";
      state.lastEventSeq = 0;
      const stale = render.addMessage("user", "already persisted");
      stale.dataset.optimisticOpId = "op-41";
      state.awaitingOwnUserEcho = false;
      state.sentMessageOpId = null;

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                seq: 1,
                type: "user_message",
                data: JSON.stringify({ text: "already persisted" }),
              },
            ]),
        })) as any;

      assert.equal(await events.loadNewEvents("s1"), true);
      assert.equal(
        dom.messages.querySelectorAll(".msg.user").length,
        1,
        "only the persisted copy remains",
      );
      assert.equal(dom.messages.querySelector("[data-optimistic-op-id]"), null);
    });

    it("drops the optimistic bubble when the catch-up already contains it", async () => {
      // awaitingOwnUserEcho means "this client hasn't seen its own echo", not
      // "the message is unpersisted". They diverge precisely here: the POST
      // landed and was persisted, but the SSE echo never arrived (stalled
      // stream). The fetched transcript then carries the authoritative copy,
      // so re-attaching the optimistic node would duplicate the message —
      // and place the copy below the reply that answered it.
      state.taskId = "s1";
      state.lastEventSeq = 0;
      const optimistic = render.addMessage("user", "carry me");
      optimistic.dataset.optimisticOpId = "op-42";
      state.awaitingOwnUserEcho = true;
      state.sentMessageOpId = "op-42";

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                seq: 1,
                type: "user_message",
                data: JSON.stringify({ text: "carry me", clientOpId: "op-42" }),
              },
              {
                seq: 2,
                type: "assistant_message",
                data: JSON.stringify({ text: "reply" }),
              },
            ]),
        })) as any;

      assert.equal(await events.loadNewEvents("s1"), true);
      assert.equal(
        dom.messages.querySelectorAll(".msg.user").length,
        1,
        "the persisted copy must not be duplicated by the optimistic node",
      );
      assert.equal(dom.messages.querySelector("[data-optimistic-op-id]"), null);
      assert.ok(dom.messages.textContent.includes("reply"));
    });

    it("leaves an undetached optimistic bubble in place", async () => {
      // With no boundary and an empty response nothing removes the bubble, so
      // re-appending would move it past siblings mounted after it (the waiting
      // cursor) and show the reply spinner above the message it belongs to.
      state.taskId = "s1";
      state.lastEventSeq = 0;
      const optimistic = render.addMessage("user", "still uploading");
      optimistic.dataset.optimisticOpId = "op-42";
      const trailing = globalThis.document.createElement("div");
      trailing.id = "waiting";
      dom.messages.appendChild(trailing);
      state.awaitingOwnUserEcho = true;
      state.sentMessageOpId = "op-42";

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        })) as any;

      assert.equal(await events.loadNewEvents("s1"), true);
      assert.equal(
        dom.messages.lastElementChild,
        trailing,
        "the waiting cursor must stay below the message it waits on",
      );
      assert.equal(optimistic.nextElementSibling, trailing);
    });

    it("recovers from a catch-up whose request never responds", async () => {
      // A stalled request (mobile handoff, suspended runtime) used to leave
      // replayInProgress latched true forever, so every later live event was
      // queued and never rendered. Worse, the inflight entry is only cleared
      // in the promise's finally, so the dead promise was handed to every
      // subsequent caller — SSE reconnect included. Only a reload escaped.
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        globalThis.fetch = ((_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          })) as any;

        const stalled = events.loadNewEvents("s1");
        assert.equal(state.replayInProgress, true, "replay gate is armed");

        for (let i = 0; i < 10; i++) {
          mock.timers.tick(10_000);
          await new Promise((r) => setImmediate(r));
        }
        assert.equal(await stalled, false, "the stalled load must settle");
        assert.equal(
          state.replayInProgress,
          false,
          "the replay gate must be released",
        );

        // The poisoned entry must be gone: a fresh call gets a fresh request.
        globalThis.fetch = (() =>
          Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve([
                {
                  seq: 1,
                  type: "assistant_message",
                  data: JSON.stringify({ text: "after recovery" }),
                },
              ]),
          })) as any;
        assert.equal(await events.loadNewEvents("s1"), true);
        assert.ok(dom.messages.textContent.includes("after recovery"));
      } finally {
        mock.timers.reset();
      }
    });

    it("keeps rendering a new turn when the previous turn's completion lands late", async () => {
      // Pressing ^C and immediately sending a new message interleaves the two
      // turns: the server persists the new user_message first, then flushes the
      // cancelled turn's buffered text and its prompt_done. That terminator
      // carries stopReason "end_turn" — a cancelled Copilot turn exits
      // gracefully — and arrives after this client's own echo has already
      // cleared the own-echo shield. Applying it to the live turn sets
      // turnEnded, which silently gates message_chunk / thought_chunk /
      // tool_call / permission_request until the *next* user message.
      state.taskId = "s1";
      state.currentPromptId = "prompt-2"; // the turn the user just started
      state.turnEnded = false;

      events.handleEvent({
        type: "prompt_done",
        taskId: "s1",
        stopReason: "end_turn",
        promptId: "prompt-1", // the superseded turn
      });

      assert.equal(
        state.turnEnded,
        false,
        "a superseded terminator must not end the live turn",
      );

      events.handleEvent({
        type: "message_chunk",
        taskId: "s1",
        text: "reply to the new message",
      });
      assert.equal(
        state.currentAssistantText,
        "reply to the new message",
        "the new turn's content must be accepted, not gated",
      );
    });

    it("keeps the live turn intact when a superseded turn errors out", async () => {
      // An error ends a prompt just as a completion does, and the server now
      // keeps the live turn busy for a superseded one. Without the same
      // judgement here the two sides disagree: the client would go idle while
      // the server stays busy, and nothing re-syncs — the error carries no
      // busy patch, so the next send is rejected as "Task is busy".
      state.taskId = "s1";
      state.currentPromptId = "prompt-2";
      state.pendingToolCallIds.add("tc-live");
      state.busy = true;
      state.busyKind = "agent";

      events.handleEvent({
        type: "error",
        taskId: "s1",
        message: "superseded turn blew up",
        promptId: "prompt-1",
      });

      assert.equal(
        state.pendingToolCallIds.has("tc-live"),
        true,
        "the live turn's pending work must survive",
      );
      assert.equal(state.busy, true, "the live turn must stay busy");
    });

    it("clears the turn when its own error arrives", async () => {
      // Control: the live turn's own failure must still end it.
      state.taskId = "s1";
      state.currentPromptId = "prompt-2";
      state.pendingToolCallIds.add("tc-live");
      state.busy = true;
      state.busyKind = "agent";

      events.handleEvent({
        type: "error",
        taskId: "s1",
        message: "live turn blew up",
        promptId: "prompt-2",
      });

      assert.equal(state.pendingToolCallIds.has("tc-live"), false);
      assert.equal(state.busy, false);
    });

    it("forgets turn identity when the task is reset", async () => {
      // Ids come from one per-process counter, so an id left over from another
      // task can never match the new one's — every terminator would be
      // dropped and its spinners stranded.
      state.currentPromptId = "prompt-5";

      stateMod.resetTaskUI();

      assert.equal(state.currentPromptId, null);
    });

    it("still ends the turn its own completion belongs to", async () => {
      // Control: the guard must not swallow the live turn's real terminator,
      // or the spinner would never stop.
      state.taskId = "s1";
      state.currentPromptId = "prompt-2";
      state.turnEnded = false;

      events.handleEvent({
        type: "prompt_done",
        taskId: "s1",
        stopReason: "end_turn",
        promptId: "prompt-2",
      });

      assert.equal(state.turnEnded, true, "the matching terminator must apply");
    });

    it("does not treat missing replay seq metadata as sequence zero", async () => {
      events.replayEvent("assistant_message", { text: "legacy" }, [], 0);
      const existing = dom.messages.lastElementChild as HTMLElement;
      existing.dataset.lastEventSeq = "";
      existing.setAttribute("data-sync-boundary", "");
      state.lastEventSeq = 0;

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                seq: 1,
                type: "assistant_message",
                data: JSON.stringify({ text: "new" }),
              },
            ]),
        })) as any;

      assert.equal(await events.loadNewEvents("s1"), true);
      assert.equal(dom.messages.querySelectorAll(".msg.assistant").length, 2);
    });

    it("does not merge incremental assistant replay across prompt_done", async () => {
      const historyEvents = [
        {
          seq: 1,
          type: "assistant_message",
          data: JSON.stringify({ text: "```text\nanimation.key\n```" }),
        },
        {
          seq: 2,
          type: "prompt_done",
          data: JSON.stringify({ stopReason: "end_turn" }),
        },
      ] as any;
      events.replayEvent(
        "assistant_message",
        { text: "```text\nanimation.key\n```" },
        historyEvents,
        0,
      );
      events.replayEvent(
        "prompt_done",
        { stopReason: "end_turn" },
        historyEvents,
        1,
      );
      state.lastEventSeq = 2;
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                seq: 3,
                type: "assistant_message",
                data: JSON.stringify({ text: "next turn" }),
              },
            ]),
        })) as any;

      assert.equal(await events.loadNewEvents("s1"), true);
      const msgs = dom.messages.querySelectorAll(".msg.assistant");
      assert.equal(msgs.length, 2);
      assert.equal(
        msgs[0].querySelector("code")?.textContent,
        "animation.key\n",
      );
      assert.equal(msgs[1].textContent, "next turn");
    });

    it("merges adjacent assistant fragments across incremental replay", async () => {
      const historyEvents = [
        {
          seq: 1,
          type: "assistant_message",
          data: JSON.stringify({ text: "reconnect { id" }),
        },
      ] as any;
      events.replayEvent(
        "assistant_message",
        { text: "reconnect { id" },
        historyEvents,
        0,
      );
      state.lastEventSeq = 1;
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                seq: 2,
                type: "assistant_message",
                data: JSON.stringify({ text: ": 3 }" }),
              },
            ]),
        })) as any;

      assert.equal(await events.loadNewEvents("s1"), true);
      const msgs = dom.messages.querySelectorAll(".msg.assistant");
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].getAttribute("data-raw"), "reconnect { id: 3 }");
    });

    it("does not duplicate a live tail when its persisted fragment is reconciled", async () => {
      state.taskId = "s1";
      const historyEvents = [
        {
          seq: 1,
          type: "assistant_message",
          data: JSON.stringify({ text: "persisted " }),
        },
      ] as any;
      events.replayEvent(
        "assistant_message",
        { text: "persisted " },
        historyEvents,
        0,
      );
      const assistant = dom.messages.querySelector(
        ".msg.assistant",
      ) as HTMLElement;
      assistant.dataset.primed = "";
      assistant.dataset.lastEventSeq = "1";
      assistant.dataset.firstEventSeq = "1";
      assistant.dataset.syncBoundary = "";
      state.currentAssistantEl = assistant;
      state.currentAssistantText = "persisted live tail";
      state.lastEventSeq = 1;
      render.updateAssistantDisplay(assistant, state.currentAssistantText);

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  seq: 2,
                  type: "assistant_message",
                  data: JSON.stringify({ text: "live tail" }),
                },
              ],
              streaming: { thinking: false, assistant: false },
            }),
        })) as any;

      assert.equal(await events.loadNewEvents("s1"), true);
      const messages = dom.messages.querySelectorAll(".msg.assistant");
      assert.equal(messages.length, 1);
      assert.equal(messages[0].textContent, "persisted live tail");
      assert.equal(messages[0].textContent?.match(/live tail/g)?.length, 1);
    });

    it("keeps runtime plan when reconnect history reaches prompt_done", async () => {
      applyPlanSnapshot([{ content: "Live work", status: "in_progress" }]);
      state.lastEventSeq = 1;
      events.replayEvent("user_message", { text: "old" }, [], 0);
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                seq: 2,
                type: "prompt_done",
                data: JSON.stringify({ stopReason: "end_turn" }),
              },
            ]),
        })) as any;

      assert.equal(await events.loadNewEvents("s1"), true);
      assert.equal(dom.planPanel.hidden, false);
      assert.equal(
        dom.planPanel.querySelector(".plan-entry")?.textContent,
        "[~] Live work",
      );
    });

    it("keeps reconnect plan history separate from snapshot state", async () => {
      state.busy = true;
      state.lastEventSeq = 1;
      events.replayEvent("user_message", { text: "old turn" }, [], 0);
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                seq: 2,
                type: "user_message",
                data: JSON.stringify({ text: "new turn" }),
              },
              {
                seq: 3,
                type: "plan",
                data: JSON.stringify({
                  entries: [{ content: "New work", status: "in_progress" }],
                }),
              },
              {
                seq: 4,
                type: "prompt_done",
                data: JSON.stringify({ stopReason: "cancelled" }),
              },
            ]),
        })) as any;

      assert.equal(await events.loadNewEvents("s1"), true);
      assert.equal(dom.planPanel.hidden, true);

      applyPlanSnapshot([{ content: "New work", status: "in_progress" }]);

      assert.equal(dom.planPanel.hidden, false);
      assert.equal(
        dom.planPanel.querySelector(".plan-entry")?.textContent,
        "[~] New work",
      );
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
        {
          seq: 2,
          type: "assistant_message",
          data: JSON.stringify({ text: "full reply" }),
        },
        {
          seq: 3,
          type: "user_message",
          data: JSON.stringify({ text: "follow up" }),
        },
      ];
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(newEvents),
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

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        })) as any;

      const result = await events.loadNewEvents("s1");
      assert.equal(result, true);
      assert.equal(dom.messages.children.length, 1);
      assert.equal(state.lastEventSeq, 1);
    });

    it("clears replayInProgress even when returning early for empty events", async () => {
      state.lastEventSeq = 1;
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
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
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
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
        {
          seq: 2,
          type: "assistant_message",
          data: JSON.stringify({ text: "hello" }),
        },
      ];
      const response = {
        events: fakeEvents,
        streaming: { thinking: false, assistant: true },
      };
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(response),
        })) as any;

      await events.loadHistory("s1");
      const el = dom.messages.querySelector(".msg.assistant");
      assert.ok(
        el.hasAttribute("data-primed"),
        "primed element should have data-primed",
      );
      assert.ok(state.currentAssistantEl === el);
    });

    it("preserves the verified final-answer boundary while a replayed stream resumes", async () => {
      state.taskId = "s1";
      const toolText = "<final_answer>\nResult body";
      const response = {
        events: [
          {
            seq: 1,
            type: "tool_call",
            data: JSON.stringify({
              id: "wrapper",
              kind: "other",
              title: "Run task",
            }),
          },
          {
            seq: 2,
            type: "tool_call_update",
            data: JSON.stringify({
              id: "wrapper",
              status: "completed",
              content: [
                {
                  type: "content",
                  content: { type: "text", text: toolText },
                },
              ],
            }),
          },
          {
            seq: 3,
            type: "assistant_message",
            data: JSON.stringify({ text: "<final_answer>\nResult" }),
          },
        ],
        streaming: { thinking: false, assistant: true },
      };
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(response),
        })) as any;

      await events.loadHistory("s1");
      events.handleEvent({
        type: "message_chunk",
        taskId: "s1",
        text: " bodyParent continuation",
      });
      render.flushStreamingRender();

      const assistant = dom.messages.querySelector(".msg.assistant");
      assert.ok(assistant?.querySelector(".subagent-result"));
      assert.equal(
        assistant?.querySelector(".assistant-continuation")?.textContent,
        "Parent continuation",
      );
    });

    it("primeStreamingState sets data-primed on adopted thinking element", async () => {
      const fakeEvents = [
        { seq: 1, type: "user_message", data: JSON.stringify({ text: "hi" }) },
        { seq: 2, type: "thinking", data: JSON.stringify({ text: "hmm" }) },
      ];
      const response = {
        events: fakeEvents,
        streaming: { thinking: true, assistant: false },
      };
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(response),
        })) as any;

      await events.loadHistory("s1");
      const el = dom.messages.querySelector(".thinking");
      assert.ok(
        el.hasAttribute("data-primed"),
        "primed thinking should have data-primed",
      );
      assert.ok(state.currentThinkingEl === el);
    });

    it("primeStreamingState reads data-raw for currentAssistantText (merged content)", async () => {
      // Two consecutive assistant_messages get merged; data-raw holds combined text
      const fakeEvents = [
        {
          seq: 1,
          type: "assistant_message",
          data: JSON.stringify({ text: "Hello " }),
        },
        {
          seq: 2,
          type: "assistant_message",
          data: JSON.stringify({ text: "world" }),
        },
      ];
      const response = {
        events: fakeEvents,
        streaming: { thinking: false, assistant: true },
      };
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(response),
        })) as any;

      await events.loadHistory("s1");
      // data-raw should be combined, and currentAssistantText should match
      assert.equal(state.currentAssistantText, "Hello world");
    });

    it("primeStreamingState reads data-raw for currentThinkingText (merged content)", async () => {
      const fakeEvents = [
        {
          seq: 1,
          type: "thinking",
          data: JSON.stringify({ text: "part one" }),
        },
        {
          seq: 2,
          type: "thinking",
          data: JSON.stringify({ text: "part two" }),
        },
      ];
      const response = {
        events: fakeEvents,
        streaming: { thinking: true, assistant: false },
      };
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(response),
        })) as any;

      await events.loadHistory("s1");
      assert.equal(state.currentThinkingText, "part onepart two");
    });

    it("loadNewEvents reverts primed assistant element before replaying", async () => {
      // Setup: loadHistory primes an assistant element
      const historyEvents = [
        {
          seq: 1,
          type: "assistant_message",
          data: JSON.stringify({ text: "original" }),
        },
      ];
      const histResponse = {
        events: historyEvents,
        streaming: { thinking: false, assistant: true },
      };
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(histResponse),
        })) as any;
      await events.loadHistory("s1");

      // Simulate live streaming that grew the element beyond DB content
      state.currentAssistantText = "original plus more streamed text";
      state.currentAssistantEl.innerHTML =
        "<p>original plus more streamed text</p>";

      // Now loadNewEvents — server flushed buffer, returns tail as new event
      const newEvents = [
        {
          seq: 2,
          type: "assistant_message",
          data: JSON.stringify({ text: " plus more streamed text" }),
        },
      ];
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(newEvents),
        })) as any;
      await events.loadNewEvents("s1");

      // Should have exactly ONE assistant element with merged content (no duplication)
      const assistants = dom.messages.querySelectorAll(".msg.assistant");
      assert.equal(
        assistants.length,
        1,
        "should not duplicate assistant message",
      );
      assert.ok(assistants[0].textContent.includes("original"));
      assert.ok(assistants[0].textContent.includes("plus more streamed text"));
    });

    it("loadNewEvents reverts primed thinking element before replaying", async () => {
      const historyEvents = [
        {
          seq: 1,
          type: "thinking",
          data: JSON.stringify({ text: "initial thought" }),
        },
      ];
      const histResponse = {
        events: historyEvents,
        streaming: { thinking: true, assistant: false },
      };
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(histResponse),
        })) as any;
      await events.loadHistory("s1");

      // Simulate live streaming that grew the thinking element
      state.currentThinkingText = "initial thought\nmore thinking";
      const content =
        state.currentThinkingEl.querySelector(".thinking-content");
      content.textContent = "initial thought\nmore thinking";

      // Server returns flushed tail
      const newEvents = [
        {
          seq: 2,
          type: "thinking",
          data: JSON.stringify({ text: "more thinking" }),
        },
      ];
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(newEvents),
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
        {
          seq: 1,
          type: "assistant_message",
          data: JSON.stringify({ text: "before tool" }),
        },
        {
          seq: 2,
          type: "tool_call",
          data: JSON.stringify({
            id: "tc1",
            kind: "read",
            title: "Read",
            rawInput: {},
          }),
        },
      ];
      const histResponse = {
        events: historyEvents,
        streaming: { thinking: false, assistant: true },
      };
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(histResponse),
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
        {
          seq: 3,
          type: "assistant_message",
          data: JSON.stringify({ text: " and more" }),
        },
      ];
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(newEvents),
        })) as any;
      await events.loadNewEvents("s1");

      // The primed assistant should be reverted to "before tool" (its data-raw)
      // The new event creates a separate assistant after the tool_call (non-adjacent, M6)
      const assistants = dom.messages.querySelectorAll(".msg.assistant");
      assert.equal(
        assistants.length,
        2,
        "non-adjacent: reverted original + new after tool_call",
      );
      assert.ok(assistants[0].textContent.includes("before tool"));
      assert.ok(
        !assistants[0].textContent.includes("and more"),
        "reverted element should not contain streamed tail",
      );
      assert.ok(assistants[1].textContent.includes("and more"));
    });

    it("finishAssistant clears data-primed attribute", async () => {
      const fakeEvents = [
        {
          seq: 1,
          type: "assistant_message",
          data: JSON.stringify({ text: "hello" }),
        },
      ];
      const response = {
        events: fakeEvents,
        streaming: { thinking: false, assistant: true },
      };
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(response),
        })) as any;
      await events.loadHistory("s1");

      const el = dom.messages.querySelector(".msg.assistant");
      assert.ok(el.hasAttribute("data-primed"));

      // Simulate stream finishing
      render.finishAssistant();
      assert.ok(
        !el.hasAttribute("data-primed"),
        "data-primed should be cleared on finish",
      );
    });

    it("finishThinking clears data-primed attribute", async () => {
      const fakeEvents = [
        { seq: 1, type: "thinking", data: JSON.stringify({ text: "hmm" }) },
      ];
      const response = {
        events: fakeEvents,
        streaming: { thinking: true, assistant: false },
      };
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(response),
        })) as any;
      await events.loadHistory("s1");

      const el = dom.messages.querySelector(".thinking");
      assert.ok(el.hasAttribute("data-primed"));

      render.finishThinking();
      assert.ok(
        !el.hasAttribute("data-primed"),
        "data-primed should be cleared on finish",
      );
    });

    it("loadNewEvents with empty events and streaming re-primes from boundary", async () => {
      // Setup: loadHistory with streaming assistant
      const historyEvents = [
        {
          seq: 1,
          type: "assistant_message",
          data: JSON.stringify({ text: "hello" }),
        },
      ];
      const histResponse = {
        events: historyEvents,
        streaming: { thinking: false, assistant: true },
      };
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(histResponse),
        })) as any;
      await events.loadHistory("s1");
      assert.ok(state.currentAssistantEl);

      // Simulate streaming grew the element
      state.currentAssistantText = "hello world";
      state.currentAssistantEl.innerHTML = "<p>hello world</p>";

      // loadNewEvents returns no new events but streaming is still true
      const response = {
        events: [],
        streaming: { thinking: false, assistant: true },
      };
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(response),
        })) as any;
      await events.loadNewEvents("s1");

      // Should still have the assistant element primed for continued streaming
      assert.ok(
        state.currentAssistantEl,
        "should re-prime assistant from boundary",
      );
      assert.equal(dom.messages.querySelectorAll(".msg.assistant").length, 1);
    });

    it("per-task coalesce returns same promise for concurrent calls", async () => {
      events.replayEvent("user_message", { text: "msg" }, [], 0);
      state.lastEventSeq = 1;
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");

      let resolveFirst: Function;
      let fetchCount = 0;
      globalThis.fetch = (() => {
        fetchCount++;
        return new Promise((r) => {
          resolveFirst = r;
        });
      }) as any;

      // Two concurrent calls for same task
      const p1 = events.loadNewEvents("s1");
      const p2 = events.loadNewEvents("s1");

      // Should be the same promise (coalesced)
      assert.equal(p1, p2, "concurrent calls for same task should coalesce");
      assert.equal(fetchCount, 1, "should only fetch once");

      resolveFirst!({ ok: true, json: () => Promise.resolve([]) });
      await p1;
    });

    it("upgrades an in-flight empty replay to preserve optimistic DOM", async () => {
      state.taskId = "s1";
      state.lastEventSeq = 1;
      events.replayEvent("assistant_message", { text: "baseline" }, [], 0);
      (dom.messages.lastElementChild as HTMLElement).dataset.syncBoundary = "";
      render.addMessage("user", "optimistic");

      let resolveFetch!: (response: unknown) => void;
      globalThis.fetch = (() =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })) as any;

      const normalLoad = events.loadNewEvents("s1");
      const terminalLoad = events.loadNewEvents("s1", {
        preserveLiveOnEmpty: true,
      });
      assert.equal(normalLoad, terminalLoad);
      resolveFetch({
        ok: true,
        json: () =>
          Promise.resolve({
            events: [],
            streaming: { thinking: false, assistant: false },
          }),
      });
      await normalLoad;

      assert.match(dom.messages.textContent ?? "", /optimistic/);
    });

    it("preserves the latest pending assistant frame on an empty replay", async () => {
      state.taskId = "s1";
      state.lastEventSeq = 1;
      events.replayEvent("assistant_message", { text: "baseline " }, [], 0);
      const assistant = dom.messages.lastElementChild as HTMLElement;
      assistant.dataset.syncBoundary = "";
      state.currentAssistantEl = assistant;
      state.currentAssistantText = "baseline latest tail";
      state.assistantRafToken = requestAnimationFrame(() => {});

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [],
              streaming: { thinking: false, assistant: true },
            }),
        })) as any;

      await events.loadNewEvents("s1", { preserveLiveOnEmpty: true });

      assert.equal(assistant.textContent, "baseline latest tail");
      assert.equal(state.currentAssistantText, "baseline latest tail");
      assert.equal(state.assistantRafToken, null);
    });

    it("does not let stale cleanup remove a newer same-task load", async () => {
      state.taskId = "s1";
      state.lastEventSeq = 1;
      let resolveFirst!: (response: unknown) => void;
      let resolveSecond!: (response: unknown) => void;
      let fetches = 0;
      globalThis.fetch = (() => {
        fetches++;
        return new Promise((resolve) => {
          if (fetches === 1) resolveFirst = resolve;
          else resolveSecond = resolve;
        });
      }) as any;

      const first = events.loadNewEvents("s1");
      stateMod.resetTaskUI();
      state.taskId = "s1";
      state.lastEventSeq = 1;
      const second = events.loadNewEvents("s1");
      resolveFirst({
        ok: true,
        json: () => Promise.resolve({ events: [] }),
      });
      await first;

      const third = events.loadNewEvents("s1");
      assert.equal(third, second);
      assert.equal(fetches, 2);
      resolveSecond({
        ok: true,
        json: () => Promise.resolve({ events: [] }),
      });
      await second;
    });

    it("per-task coalesce allows independent tasks", async () => {
      events.replayEvent("user_message", { text: "msg" }, [], 0);
      state.lastEventSeq = 1;
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");

      let fetchCount = 0;
      globalThis.fetch = (() => {
        fetchCount++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }) as any;

      // Calls for different tasks should NOT coalesce
      const p1 = events.loadNewEvents("s1");
      const p2 = events.loadNewEvents("s2");

      assert.notEqual(p1, p2, "different tasks should not coalesce");
      assert.equal(fetchCount, 2, "should fetch for each task");

      await Promise.all([p1, p2]);
    });

    it("reverts both thinking and assistant when both are primed simultaneously", async () => {
      const historyEvents = [
        { seq: 1, type: "thinking", data: JSON.stringify({ text: "thought" }) },
        {
          seq: 2,
          type: "assistant_message",
          data: JSON.stringify({ text: "reply" }),
        },
      ];
      const histResponse = {
        events: historyEvents,
        streaming: { thinking: true, assistant: true },
      };
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(histResponse),
        })) as any;
      await events.loadHistory("s1");

      assert.ok(state.currentThinkingEl, "thinking should be primed");
      assert.ok(state.currentAssistantEl, "assistant should be primed");
      assert.ok(
        dom.messages.querySelector(".thinking").hasAttribute("data-primed"),
      );
      assert.ok(
        dom.messages
          .querySelector(".msg.assistant")
          .hasAttribute("data-primed"),
      );

      // Simulate live streaming grew both elements
      state.currentThinkingText = "thought extended";
      state.currentThinkingEl.querySelector(".thinking-content").textContent =
        "thought extended";
      state.currentAssistantText = "reply extended";
      state.currentAssistantEl.innerHTML = "<p>reply extended</p>";

      // Server returns flushed tail for assistant only (thinking → assistant → tail)
      const newEvents = [
        {
          seq: 3,
          type: "assistant_message",
          data: JSON.stringify({ text: " extended" }),
        },
      ];
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(newEvents),
        })) as any;
      state.taskId = "s1";
      await events.loadNewEvents("s1");

      // Both primed elements should have been reverted to DB content
      const thinkings = dom.messages.querySelectorAll(".thinking");
      const assistants = dom.messages.querySelectorAll(".msg.assistant");
      assert.equal(thinkings.length, 1, "should not duplicate thinking");
      assert.equal(assistants.length, 1, "should not duplicate assistant");
      // Thinking reverted to original DB content
      assert.equal(
        thinkings[0].querySelector(".thinking-content").textContent,
        "thought",
      );
      // Assistant merged: reverted "reply" + new " extended"
      assert.ok(assistants[0].textContent.includes("reply"));
      assert.ok(assistants[0].textContent.includes("extended"));
    });

    it("loadNewEvents discards results when task switched during fetch", async () => {
      events.replayEvent("user_message", { text: "msg" }, [], 0);
      state.lastEventSeq = 1;
      state.taskId = "s1";
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");

      let resolveFetch: Function;
      globalThis.fetch = (() =>
        new Promise((r) => {
          resolveFetch = r;
        })) as any;

      const promise = events.loadNewEvents("s1");

      // Task switches while fetch is in-flight
      state.taskId = "s2";

      resolveFetch!({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              seq: 2,
              type: "assistant_message",
              data: JSON.stringify({ text: "stale" }),
            },
          ]),
      });

      const result = await promise;
      assert.equal(result, false, "should return false when task switched");
      // DOM should not have the stale event
      assert.equal(dom.messages.querySelectorAll(".msg.assistant").length, 0);
    });
  });

  describe("loadNewEvents clears pending state from replayed events", () => {
    it("restores pending ownership so prompt_done completes a replayed tool", async () => {
      events.replayEvent("user_message", { text: "hi" }, [], 0);
      state.lastEventSeq = 1;
      state.taskId = "s1";
      state.busy = true;
      state.busyKind = "agent";
      dom.messages.lastElementChild?.setAttribute("data-sync-boundary", "");

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                seq: 2,
                type: "tool_call",
                data: JSON.stringify({
                  id: "tc-restored",
                  kind: "read",
                  title: "Restored tool",
                  rawInput: {},
                }),
              },
            ]),
        })) as any;

      await events.loadNewEvents("s1");
      assert.equal(state.pendingToolCallIds.has("tc-restored"), true);

      events.handleEvent({ type: "prompt_done", stopReason: "end_turn" });

      const tool = document.getElementById("tc-tc-restored");
      assert.ok(tool?.classList.contains("completed"));
      assert.equal(state.pendingToolCallIds.size, 0);
      assert.equal(state.busy, false);
    });

    it("defers replayed pending-tool completion to authoritative runtime state", async () => {
      events.replayEvent("user_message", { text: "old" }, [], 0);
      state.lastEventSeq = 1;
      state.taskId = "s1";
      state.busy = true;
      state.busyKind = "agent";
      dom.messages.lastElementChild?.setAttribute("data-sync-boundary", "");

      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                seq: 2,
                type: "user_message",
                data: JSON.stringify({ text: "new turn" }),
              },
              {
                seq: 3,
                type: "tool_call",
                data: JSON.stringify({
                  id: "tc-current",
                  kind: "read",
                  title: "Current tool",
                  rawInput: {},
                }),
              },
              {
                seq: 4,
                type: "prompt_done",
                data: JSON.stringify({
                  stopReason: "cancelled",
                  promptId: "superseded-prompt",
                }),
              },
            ]),
        })) as any;

      await events.loadNewEvents("s1");
      const tool = document.getElementById("tc-tc-current");
      assert.ok(tool);
      assert.equal(tool.classList.contains("completed"), false);
      assert.equal(state.pendingToolCallIds.has("tc-current"), true);

      events.reconcileReplayedPendingTools();
      assert.equal(tool.classList.contains("completed"), false);

      state.busy = false;
      state.busyKind = null;
      events.reconcileReplayedPendingTools();
      assert.ok(tool.classList.contains("completed"));
      assert.equal(state.pendingToolCallIds.size, 0);
    });

    it("clears pendingToolCallIds for tool_call_updates replayed from DB", async () => {
      // Simulate: live task had a tool_call that was added to pendingToolCallIds
      events.replayEvent("user_message", { text: "hi" }, [], 0);
      state.lastEventSeq = 1;
      dom.messages.lastElementChild.setAttribute("data-sync-boundary", "");

      // Simulate a tool_call received via live WS before disconnect
      state.taskId = "s1";
      state.pendingToolCallIds.add("tc-live");
      const tcEl = globalThis.document.createElement("div");
      tcEl.className = "tool-call";
      tcEl.id = "tc-tc-live";
      tcEl.innerHTML = '<span class="icon">run</span> Do something';
      dom.messages.appendChild(tcEl);

      // Now reconnect — loadNewEvents replays tool_call_update from DB
      const newEvents = [
        {
          seq: 2,
          type: "tool_call_update",
          data: JSON.stringify({ id: "tc-live", status: "completed" }),
        },
        {
          seq: 3,
          type: "prompt_done",
          data: JSON.stringify({ stopReason: "end_turn" }),
        },
      ];
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(newEvents),
        })) as any;

      await events.loadNewEvents("s1");

      // The pending tool call should be cleared so prompt_done can finish
      assert.equal(state.pendingToolCallIds.size, 0);
      // busy should be false (prompt_done could call finishPromptIfIdle)
      assert.equal(state.busy, false);
    });
  });

  describe("replay queue (dedup on reconnect)", () => {
    it("reruns reconciliation when terminal output flushes during replay", async () => {
      state.taskId = "s1";
      state.lastEventSeq = 1;
      const baselineEvents = [
        {
          seq: 1,
          type: "assistant_message",
          data: JSON.stringify({ text: "old" }),
        },
      ] as any;
      events.replayEvent(
        "assistant_message",
        { text: "old" },
        baselineEvents,
        0,
      );
      (dom.messages.lastElementChild as HTMLElement).dataset.syncBoundary = "";
      state.awaitingOwnUserEcho = true;
      state.sentMessageForTask = "s1";
      state.sentMessageOpId = "op-race";
      state.reconcileAfterOwnUserEcho = true;

      let resolveFirst!: (response: unknown) => void;
      let fetches = 0;
      globalThis.fetch = (() => {
        fetches++;
        if (fetches === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  seq: 3,
                  type: "assistant_message",
                  data: JSON.stringify({ text: "flushed after snapshot" }),
                },
              ],
              streaming: { thinking: false, assistant: false },
            }),
        });
      }) as any;

      const firstLoad = events.loadNewEvents("s1");
      events.handleEvent({
        type: "prompt_done",
        taskId: "s1",
        stopReason: "cancelled",
      });
      resolveFirst({
        ok: true,
        json: () =>
          Promise.resolve({
            events: [
              {
                seq: 2,
                type: "user_message",
                task_id: "s1",
                data: JSON.stringify({
                  text: "new",
                  clientOpId: "op-race",
                }),
              },
            ],
            streaming: { thinking: false, assistant: false },
          }),
      });
      await firstLoad;
      await events.waitForTerminalReconciliation();

      assert.equal(fetches, 2);
      assert.match(dom.messages.textContent ?? "", /flushed after snapshot/);
    });

    it("queues WS events arriving during loadHistory and drains after", async () => {
      const fakeEvents = [
        { seq: 1, type: "user_message", data: JSON.stringify({ text: "hi" }) },
      ];

      let resolveFetch: Function;
      globalThis.fetch = (() =>
        new Promise((r) => {
          resolveFetch = r;
        })) as any;

      state.taskId = "s1";
      const historyPromise = events.loadHistory("s1");

      // While fetch is in-flight, simulate a WS event arriving
      assert.equal(state.replayInProgress, true);
      events.handleEvent({
        type: "message_chunk",
        taskId: "s1",
        text: "hello",
      });
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

    it("keeps stale queued completion guarded until replay drain finishes", async () => {
      const fakeEvents = [
        {
          seq: 11,
          task_id: "s1",
          type: "user_message",
          data: JSON.stringify({
            text: "new",
            clientOpId: "op-new",
          }),
        },
      ];
      let resolveFetch: Function;
      globalThis.fetch = (() =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })) as any;
      state.taskId = "s1";
      state.busy = true;
      state.awaitingOwnUserEcho = true;
      state.sentMessageForTask = "s1";
      state.sentMessageOpId = "op-new";

      const historyPromise = events.loadHistory("s1");
      events.handleEvent({
        type: "prompt_done",
        taskId: "s1",
        stopReason: "end_turn",
      });
      resolveFetch!({ ok: true, json: () => Promise.resolve(fakeEvents) });
      await historyPromise;

      assert.equal(state.busy, true);
      assert.equal(state.turnEnded, false);
      assert.equal(state.awaitingOwnUserEcho, false);
    });

    it("deduplicates tool_call events that were both replayed and queued", async () => {
      const fakeEvents = [
        {
          seq: 1,
          type: "tool_call",
          data: JSON.stringify({
            id: "tc1",
            title: "Read file",
            kind: "read",
            rawInput: {},
          }),
        },
      ];

      let resolveFetch: Function;
      globalThis.fetch = (() =>
        new Promise((r) => {
          resolveFetch = r;
        })) as any;

      state.taskId = "s1";
      const historyPromise = events.loadHistory("s1");

      // Simulate the same tool_call arriving via WS while replay is in-flight
      events.handleEvent({
        type: "tool_call",
        taskId: "s1",
        id: "tc1",
        title: "Read file",
        kind: "read",
        rawInput: {},
      });
      assert.equal(state.replayQueue.length, 1);

      resolveFetch!({ ok: true, json: () => Promise.resolve(fakeEvents) });
      await historyPromise;

      // Only one tool_call element should exist (deduped)
      const toolCalls = dom.messages.querySelectorAll("#tc-tc1");
      assert.equal(toolCalls.length, 1);
    });

    it("deduplicates a foreign user message replayed before its queued SSE copy", async () => {
      const fakeEvents = [
        {
          seq: 1,
          task_id: "s1",
          type: "user_message",
          data: JSON.stringify({
            text: "new question",
            clientOpId: "op-foreign",
          }),
        },
        {
          seq: 2,
          task_id: "s1",
          type: "assistant_message",
          data: JSON.stringify({ text: "new answer" }),
        },
      ];

      let resolveFetch: Function;
      globalThis.fetch = (() =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })) as any;

      state.taskId = "s1";
      const historyPromise = events.loadHistory("s1");

      events.handleEvent({
        type: "user_message",
        taskId: "s1",
        text: "new question",
        clientOpId: "op-foreign",
      });

      resolveFetch!({ ok: true, json: () => Promise.resolve(fakeEvents) });
      await historyPromise;

      const rows = [...dom.messages.children];
      assert.equal(rows.length, 2);
      assert.ok(rows[0].classList.contains("user"));
      assert.ok(rows[0].textContent.includes("new question"));
      assert.ok(rows[1].classList.contains("assistant"));
      assert.ok(rows[1].textContent.includes("new answer"));
    });

    it("starts the replayed foreign turn before draining its queued answer", async () => {
      const fakeEvents = [
        {
          seq: 1,
          task_id: "s1",
          type: "user_message",
          data: JSON.stringify({
            text: "new question",
            clientOpId: "op-foreign",
          }),
        },
      ];

      let resolveFetch: Function;
      globalThis.fetch = (() =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })) as any;

      state.taskId = "s1";
      state.turnEnded = true;
      const historyPromise = events.loadHistory("s1");

      events.handleEvent({
        type: "user_message",
        taskId: "s1",
        text: "new question",
        clientOpId: "op-foreign",
      });
      events.handleEvent({
        type: "message_chunk",
        taskId: "s1",
        text: "new answer",
      });

      resolveFetch!({ ok: true, json: () => Promise.resolve(fakeEvents) });
      await historyPromise;
      render.finishAssistant();

      const rows = [...dom.messages.children];
      assert.equal(rows.length, 2);
      assert.ok(rows[0].classList.contains("user"));
      assert.ok(rows[1].classList.contains("assistant"));
      assert.ok(rows[1].textContent.includes("new answer"));
      assert.equal(state.turnEnded, false);
      assert.equal(state.newTurnStarted, true);
    });

    it("does not deduplicate another task by client operation id", async () => {
      const fakeEvents = [
        {
          seq: 1,
          task_id: "s1",
          type: "user_message",
          data: JSON.stringify({
            text: "active question",
            clientOpId: "op-shared",
          }),
        },
      ];

      let resolveFetch: Function;
      globalThis.fetch = (() =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })) as any;

      state.taskId = "s1";
      state.turnEnded = true;
      const historyPromise = events.loadHistory("s1");

      events.handleEvent({
        type: "user_message",
        taskId: "s2",
        text: "other question",
        clientOpId: "op-shared",
      });

      resolveFetch!({ ok: true, json: () => Promise.resolve(fakeEvents) });
      await historyPromise;

      assert.equal(dom.messages.querySelectorAll(".msg.user").length, 1);
      assert.equal(state.turnEnded, true);
      assert.equal(state.newTurnStarted, false);
    });

    it("preserves a replayed turn boundary through full-load activation", async () => {
      const fakeEvents = [
        {
          seq: 1,
          task_id: "s1",
          type: "user_message",
          data: JSON.stringify({
            text: "new question",
            clientOpId: "op-foreign",
          }),
        },
      ];

      let resolveFetch: Function;
      globalThis.fetch = (() =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })) as any;

      state.taskId = null;
      state.pendingNavigationTaskId = "s1";
      state.turnEnded = true;
      const historyPromise = events.loadHistory("s1");

      events.handleEvent({
        type: "user_message",
        taskId: "s1",
        text: "new question",
        clientOpId: "op-foreign",
      });
      events.handleEvent({
        type: "prompt_done",
        taskId: "s1",
        stopReason: "cancelled",
      });

      resolveFetch!({ ok: true, json: () => Promise.resolve(fakeEvents) });
      await historyPromise;
      events.handleEvent({
        type: "task_created",
        taskId: "s1",
        configOptions: [],
      });
      events.drainNavigationEvents("s1");

      assert.equal(state.turnEnded, false);
      assert.equal(state.newTurnStarted, false);
    });

    it("preserves a replayed turn boundary when refreshing the active task", async () => {
      const fakeEvents = [
        {
          seq: 1,
          task_id: "s1",
          type: "user_message",
          data: JSON.stringify({
            text: "new question",
            clientOpId: "op-foreign",
          }),
        },
      ];

      let resolveFetch: Function;
      globalThis.fetch = (() =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })) as any;

      state.taskId = "s1";
      state.turnEnded = true;
      const historyPromise = events.loadHistory("s1");
      events.handleEvent({
        type: "user_message",
        taskId: "s1",
        text: "new question",
        clientOpId: "op-foreign",
      });

      resolveFetch!({ ok: true, json: () => Promise.resolve(fakeEvents) });
      await historyPromise;
      events.handleEvent({
        type: "task_created",
        taskId: "s1",
        configOptions: [],
      });
      events.handleEvent({
        type: "prompt_done",
        taskId: "s1",
        stopReason: "cancelled",
      });

      assert.equal(state.turnEnded, false);
      assert.equal(state.newTurnStarted, false);
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
          data: JSON.stringify({
            requestId: "perm1",
            optionName: "Allow",
            denied: false,
          }),
        },
      ];

      let resolveFetch: Function;
      globalThis.fetch = (() =>
        new Promise((r) => {
          resolveFetch = r;
        })) as any;

      state.taskId = "s1";
      const historyPromise = events.loadHistory("s1");

      // Same permission_request arrives via WS
      events.handleEvent({
        type: "permission_request",
        taskId: "s1",
        requestId: "perm1",
        title: "Run command",
        options: [{ optionId: "o1", name: "Allow", kind: "allow_once" }],
      });

      resolveFetch!({ ok: true, json: () => Promise.resolve(fakeEvents) });
      await historyPromise;

      const perms = dom.messages.querySelectorAll(
        '.permission[data-request-id="perm1"]',
      );
      assert.equal(perms.length, 1);
    });

    it("lets non-duplicate queued events through after replay", async () => {
      const fakeEvents = [
        { seq: 1, type: "user_message", data: JSON.stringify({ text: "hi" }) },
      ];

      let resolveFetch: Function;
      globalThis.fetch = (() =>
        new Promise((r) => {
          resolveFetch = r;
        })) as any;

      state.taskId = "s1";
      const historyPromise = events.loadHistory("s1");

      // A tool_call for a NEW id that isn't in the history
      events.handleEvent({
        type: "tool_call",
        taskId: "s1",
        id: "tc-new",
        title: "New tool",
        kind: "execute",
        rawInput: {},
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
        {
          seq: 2,
          type: "tool_call",
          data: JSON.stringify({
            id: "tc2",
            title: "Edit",
            kind: "edit",
            rawInput: {},
          }),
        },
      ];

      let resolveFetch: Function;
      globalThis.fetch = (() =>
        new Promise((r) => {
          resolveFetch = r;
        })) as any;

      state.taskId = "s1";
      const promise = events.loadNewEvents("s1");

      // Duplicate tool_call arrives via WS
      events.handleEvent({
        type: "tool_call",
        taskId: "s1",
        id: "tc2",
        title: "Edit",
        kind: "edit",
        rawInput: {},
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
        {
          seq: 2,
          type: "thinking",
          data: JSON.stringify({ text: "partial thought" }),
        },
      ];
      const response = {
        events: fakeEvents,
        streaming: { thinking: true, assistant: false },
      };

      let resolveFetch: Function;
      globalThis.fetch = (() =>
        new Promise((r) => {
          resolveFetch = r;
        })) as any;

      state.taskId = "s1";
      const historyPromise = events.loadHistory("s1");

      // thought_chunk arrives via SSE while replay is in-flight (duplicate content)
      events.handleEvent({
        type: "thought_chunk",
        taskId: "s1",
        text: "partial thought",
      });
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
        {
          seq: 2,
          type: "assistant_message",
          data: JSON.stringify({ text: "hello" }),
        },
      ];
      const response = {
        events: fakeEvents,
        streaming: { thinking: false, assistant: true },
      };

      let resolveFetch: Function;
      globalThis.fetch = (() =>
        new Promise((r) => {
          resolveFetch = r;
        })) as any;

      state.taskId = "s1";
      const historyPromise = events.loadHistory("s1");

      events.handleEvent({
        type: "message_chunk",
        taskId: "s1",
        text: "hello",
      });

      resolveFetch!({ ok: true, json: () => Promise.resolve(response) });
      await historyPromise;

      // One user message + one assistant message (not duplicated)
      const assistantEls = dom.messages.querySelectorAll(".msg.assistant");
      assert.equal(assistantEls.length, 1);
      assert.ok(
        state.currentAssistantEl,
        "currentAssistantEl should be primed",
      );
    });

    it("does not prime an assistant that precedes the latest user message", async () => {
      const fakeEvents = [
        {
          seq: 1,
          type: "assistant_message",
          data: JSON.stringify({ text: "old answer" }),
        },
        {
          seq: 2,
          type: "user_message",
          data: JSON.stringify({
            text: "new question",
            clientOpId: "op-new",
          }),
        },
      ];
      const response = {
        events: fakeEvents,
        streaming: { thinking: false, assistant: true },
      };
      state.taskId = "s1";
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(response),
        })) as any;

      await events.loadHistory("s1");
      events.handleEvent({
        type: "message_chunk",
        taskId: "s1",
        text: "new answer",
      });
      render.finishAssistant();

      const rows = [...dom.messages.children];
      assert.equal(rows.length, 3);
      assert.ok(rows[0].classList.contains("assistant"));
      assert.ok(rows[0].textContent.includes("old answer"));
      assert.ok(rows[1].classList.contains("user"));
      assert.ok(rows[2].classList.contains("assistant"));
      assert.ok(rows[2].textContent.includes("new answer"));
    });

    it("allows new thought_chunk through when no streaming was signaled", async () => {
      // Non-streaming case: agent starts thinking AFTER replay finishes
      const fakeEvents = [
        { seq: 1, type: "user_message", data: JSON.stringify({ text: "hi" }) },
      ];

      let resolveFetch: Function;
      globalThis.fetch = (() =>
        new Promise((r) => {
          resolveFetch = r;
        })) as any;

      state.taskId = "s1";
      const historyPromise = events.loadHistory("s1");

      events.handleEvent({
        type: "thought_chunk",
        taskId: "s1",
        text: "new thought",
      });

      resolveFetch!({ ok: true, json: () => Promise.resolve(fakeEvents) });
      await historyPromise;

      // No streaming signal → thought_chunk should create a new thinking element
      const thinkingEls = dom.messages.querySelectorAll(".thinking");
      assert.equal(thinkingEls.length, 1);
      assert.ok(state.currentThinkingEl);
      assert.equal(state.currentThinkingText, "new thought");
    });
  });

  describe("agent reload events", () => {
    it("agent_reloading sets busy and shows system message", () => {
      state.taskId = "s1";
      events.handleEvent({ type: "agent_reloading" });

      assert.equal(state.busy, true);
      assert.equal(state.agentReloading, true);
      const msgs = [...dom.messages.children].map((el: any) => el.textContent);
      assert.ok(msgs.some((m) => m.includes("reloading")));
    });

    it("connected after agent_reloading shows reloaded message and clears busy", () => {
      state.taskId = "s1";
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
      assert.ok(msgs.some((m) => m.includes("reloaded")));
    });

    it("agent_reloading_failed shows error and clears busy", () => {
      state.taskId = "s1";
      state.agentReloading = true;
      state.busy = true;

      events.handleEvent({
        type: "agent_reloading_failed",
        error: "broken binary",
      });

      assert.equal(state.busy, false);
      const msgs = [...dom.messages.children].map((el: any) => el.textContent);
      assert.ok(msgs.some((m) => m.includes("broken binary")));
    });
  });
});
