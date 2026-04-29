// Tests for the shared content-event renderer (public/js/render-event.ts).
// Both the main app's events.ts (live + replay) and the share viewer
// consume this module. Asserts canonical class names that styles.css
// targets — drift here breaks both surfaces simultaneously, which the
// suite catches.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";

describe("render-event", () => {
  let mod: typeof import("../public/js/render-event.ts");
  let host: HTMLElement;

  before(async () => {
    setupDOM();
    mod = await import("../public/js/render-event.ts");
  });
  after(() => {
    teardownDOM();
  });
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  function makeHooks(
    overrides: Partial<import("../public/js/render-event.ts").RenderHooks> = {},
  ): import("../public/js/render-event.ts").RenderHooks {
    return {
      findToolCallEl: () => null,
      findPermissionEl: () => null,
      findBashEl: () => null,
      ...overrides,
    };
  }

  function append(el: HTMLElement | null) {
    if (el) host.appendChild(el);
    return el;
  }

  describe("CONTENT_EVENT_TYPES", () => {
    it("includes the canonical 10 event types", () => {
      const expected = [
        "user_message",
        "assistant_message",
        "thinking",
        "tool_call",
        "tool_call_update",
        "plan",
        "permission_request",
        "permission_response",
        "bash_command",
        "bash_result",
      ];
      assert.deepEqual([...mod.CONTENT_EVENT_TYPES].sort(), expected.sort());
    });

    it("isContentEventType narrows known types", () => {
      assert.equal(mod.isContentEventType("user_message"), true);
      assert.equal(mod.isContentEventType("message_chunk"), false);
      assert.equal(mod.isContentEventType("session_created"), false);
    });
  });

  describe("user_message", () => {
    it("renders div.msg.user with HTML-escaped + <br> text", () => {
      const el = append(
        mod.renderContentEvent(
          "user_message",
          { text: "<b>hi</b>\nworld" },
          makeHooks(),
        ),
      )!;
      assert.equal(el.tagName, "DIV");
      assert.ok(el.classList.contains("msg"));
      assert.ok(el.classList.contains("user"));
      assert.ok(el.innerHTML.includes("&lt;b&gt;hi&lt;/b&gt;"));
      assert.ok(el.innerHTML.includes("<br>"));
    });

    it("appends user-image children for images", () => {
      const el = append(
        mod.renderContentEvent(
          "user_message",
          { text: "see", images: [{ path: "/img/a.png" }] },
          makeHooks(),
        ),
      )!;
      const img = el.querySelector("img.user-image") as HTMLImageElement;
      assert.ok(img);
      assert.equal(img.getAttribute("src"), "/img/a.png");
    });

    it("rewrites image src via hook", () => {
      const el = append(
        mod.renderContentEvent(
          "user_message",
          { text: "x", images: [{ path: "/api/v1/sessions/S/images/a.png" }] },
          makeHooks({ rewriteImageSrc: () => "/s/T/images/a.png" }),
        ),
      )!;
      const img = el.querySelector("img.user-image") as HTMLImageElement;
      assert.equal(img.getAttribute("src"), "/s/T/images/a.png");
    });
  });

  describe("assistant_message", () => {
    it("renders div.msg.assistant with markdown HTML and data-raw", () => {
      const el = append(
        mod.renderContentEvent(
          "assistant_message",
          { text: "**bold** text" },
          makeHooks(),
        ),
      )!;
      assert.ok(el.classList.contains("msg"));
      assert.ok(el.classList.contains("assistant"));
      assert.equal(el.getAttribute("data-raw"), "**bold** text");
      assert.ok(el.querySelector("strong"));
    });

    it("calls enhanceMarkdown hook with the rendered element", () => {
      let hooked: HTMLElement | null = null;
      append(
        mod.renderContentEvent(
          "assistant_message",
          { text: "x" },
          makeHooks({
            enhanceMarkdown: (e) => {
              hooked = e;
            },
          }),
        ),
      );
      assert.ok(hooked, "enhanceMarkdown must be called");
    });
  });

  describe("thinking", () => {
    it("renders details.thinking with summary + .thinking-content", () => {
      const el = append(
        mod.renderContentEvent("thinking", { text: "ponder" }, makeHooks()),
      )!;
      assert.equal(el.tagName, "DETAILS");
      assert.ok(el.classList.contains("thinking"));
      assert.ok(el.querySelector("summary"));
      const content = el.querySelector(".thinking-content");
      assert.ok(content);
      assert.equal(content.textContent, "ponder");
      assert.equal(el.getAttribute("data-raw"), "ponder");
    });
  });

  describe("tool_call", () => {
    it("renders div.tool-call#tc-ID with .icon, title, and tc-detail", () => {
      const el = append(
        mod.renderContentEvent(
          "tool_call",
          { id: "x1", kind: "read", title: "Read foo.ts", rawInput: {} },
          makeHooks(),
        ),
      )!;
      assert.ok(el.classList.contains("tool-call"));
      assert.equal(el.id, "tc-x1");
      assert.equal(el.dataset.kind, "read");
      assert.ok(el.querySelector(".icon"));
    });
  });

  describe("tool_call_update", () => {
    it("mutates existing tool-call via findToolCallEl hook", () => {
      const existing = document.createElement("div");
      existing.className = "tool-call pending";
      existing.id = "tc-Y";
      existing.innerHTML = '<span class="icon">·</span>';
      host.appendChild(existing);

      const result = mod.renderContentEvent(
        "tool_call_update",
        { id: "Y", status: "completed", content: [] },
        makeHooks({ findToolCallEl: (id) => (id === "Y" ? existing : null) }),
      );
      assert.equal(result, null, "update returns null (mutation)");
      assert.ok(
        existing.classList.contains("tool-call"),
        "tool-call class preserved",
      );
      const icon = existing.querySelector(".icon");
      assert.ok(icon);
      assert.notEqual(icon.textContent, "·", "icon updated for completed");
    });

    it("appends details/output for non-task_complete with content", () => {
      const existing = document.createElement("div");
      existing.className = "tool-call pending";
      existing.id = "tc-Z";
      existing.innerHTML = '<span class="icon">·</span>';
      host.appendChild(existing);

      mod.renderContentEvent(
        "tool_call_update",
        {
          id: "Z",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "OK" } }],
        },
        makeHooks({ findToolCallEl: () => existing }),
      );
      const details = existing.querySelector("details");
      assert.ok(details, "details inserted");
      assert.ok(details.querySelector(".tc-content"));
    });
  });

  describe("plan", () => {
    it("renders div.plan with .plan-title and .plan-entry rows", () => {
      const el = append(
        mod.renderContentEvent(
          "plan",
          {
            entries: [
              { content: "step a", status: "pending", priority: "medium" },
              { content: "step b", status: "completed", priority: "medium" },
            ],
          },
          makeHooks(),
        ),
      )!;
      assert.ok(el.classList.contains("plan"));
      assert.ok(el.querySelector(".plan-title"));
      const rows = el.querySelectorAll(".plan-entry");
      assert.equal(rows.length, 2);
    });
  });

  describe("permission_request", () => {
    it("renders div.permission with buttons when not resolved", () => {
      const el = append(
        mod.renderContentEvent(
          "permission_request",
          {
            requestId: "r1",
            title: "run cmd",
            options: [
              { kind: "allow_once", name: "Allow", optionId: "o1" },
              { kind: "reject_once", name: "Deny", optionId: "o2" },
            ],
          },
          makeHooks({ isPermissionResolved: () => false }),
        ),
      )!;
      assert.ok(el.classList.contains("permission"));
      assert.equal(el.dataset.requestId, "r1");
      assert.equal(el.dataset.title, "run cmd");
      const btns = el.querySelectorAll("button");
      assert.equal(btns.length, 2);
    });

    it("does NOT bind onclick on rendered buttons (caller owns wiring)", () => {
      const el = append(
        mod.renderContentEvent(
          "permission_request",
          {
            requestId: "r2",
            title: "x",
            options: [{ kind: "allow_once", name: "Allow", optionId: "o" }],
          },
          makeHooks(),
        ),
      )!;
      const btn = el.querySelector("button") as HTMLButtonElement;
      assert.equal(btn.onclick, null, "onclick must be unset by renderer");
    });

    it("renders no buttons when resolved (hook returns true)", () => {
      const el = append(
        mod.renderContentEvent(
          "permission_request",
          {
            requestId: "r3",
            title: "x",
            options: [{ kind: "allow_once", name: "Allow", optionId: "o" }],
          },
          makeHooks({ isPermissionResolved: () => true }),
        ),
      )!;
      assert.equal(el.querySelectorAll("button").length, 0);
    });
  });

  describe("permission_response", () => {
    it("mutates the existing .permission via findPermissionEl", () => {
      const existing = document.createElement("div");
      existing.className = "permission";
      existing.dataset.requestId = "r4";
      existing.dataset.title = "do it";
      existing.innerHTML =
        '<span class="title">⚿ do it</span><button>x</button>';
      host.appendChild(existing);

      const result = mod.renderContentEvent(
        "permission_response",
        { requestId: "r4", optionName: "Allow", denied: false },
        makeHooks({
          findPermissionEl: (id) => (id === "r4" ? existing : null),
        }),
      );
      assert.equal(result, null);
      assert.equal(existing.querySelectorAll("button").length, 0);
      assert.ok(existing.innerHTML.includes("dim"));
    });
  });

  describe("bash_command", () => {
    it("renders div.bash-block with .bash-cmd and .bash-output", () => {
      const el = append(
        mod.renderContentEvent(
          "bash_command",
          { command: "ls -la" },
          makeHooks(),
        ),
      )!;
      assert.ok(el.classList.contains("bash-block"));
      const cmd = el.querySelector(".bash-cmd");
      assert.ok(cmd);
      assert.equal(cmd.textContent, "ls -la");
      // running class is set by caller for live (not by renderer)
      assert.ok(!cmd.classList.contains("running"));
      assert.ok(el.querySelector(".bash-output"));
    });
  });

  describe("bash_result", () => {
    it("populates output text and exit span via findBashEl hook", () => {
      const bashEl = document.createElement("div");
      bashEl.className = "bash-block";
      bashEl.innerHTML =
        '<span class="bash-cmd running">ls</span><div class="bash-output"></div>';
      host.appendChild(bashEl);

      const result = mod.renderContentEvent(
        "bash_result",
        { output: "hello\n", code: 0, signal: null },
        makeHooks({ findBashEl: () => bashEl }),
      );
      assert.equal(result, null);
      const out = bashEl.querySelector(".bash-output");
      assert.ok(out);
      assert.equal(out.textContent, "hello\n");
      assert.ok(out.classList.contains("has-content"));
      const cmd = bashEl.querySelector(".bash-cmd")!;
      assert.ok(
        !cmd.classList.contains("running"),
        "running cleared on result",
      );
    });

    it("adds bash-exit span for non-zero exit", () => {
      const bashEl = document.createElement("div");
      bashEl.className = "bash-block";
      bashEl.innerHTML =
        '<span class="bash-cmd">x</span><div class="bash-output"></div>';
      host.appendChild(bashEl);
      mod.renderContentEvent(
        "bash_result",
        { output: "", code: 1, signal: null },
        makeHooks({ findBashEl: () => bashEl }),
      );
      const exit = bashEl.querySelector(".bash-exit");
      assert.ok(exit);
      assert.ok(exit.classList.contains("fail"));
      assert.ok(exit.textContent.includes("1"));
    });
  });
});
