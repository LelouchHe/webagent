import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("render", () => {
  let state: any;
  let dom: any;
  let render: any;

  function setMessagesScrollMetrics({ scrollTop, scrollHeight, clientHeight }: { scrollTop: number; scrollHeight: number; clientHeight: number; }) {
    Object.defineProperties(dom.messages, {
      scrollTop: { value: scrollTop, writable: true, configurable: true },
      scrollHeight: { value: scrollHeight, configurable: true },
      clientHeight: { value: clientHeight, configurable: true },
    });
  }

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    render = await import("../public/js/render.ts");
  });
  after(() => teardownDOM());
  beforeEach(() => resetState(state, dom));

  describe("escHtml", () => {
    it("escapes HTML entities", () => {
      assert.equal(render.escHtml("<b>test</b>"), "&lt;b&gt;test&lt;/b&gt;");
    });

    it("escapes ampersands and quotes", () => {
      assert.equal(render.escHtml('a & "b"'), 'a &amp; "b"');
    });

    it("passes plain text through", () => {
      assert.equal(render.escHtml("hello world"), "hello world");
    });
  });

  describe("formatLocalTime", () => {
    it("returns empty string for falsy input", () => {
      assert.equal(render.formatLocalTime(""), "");
      assert.equal(render.formatLocalTime(null), "");
      assert.equal(render.formatLocalTime(undefined), "");
    });

    it("formats UTC timestamp", () => {
      const result = render.formatLocalTime("2024-06-15T08:30:00Z");
      // Just check format: YYYY-MM-DD HH:MM
      assert.match(result, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it("appends Z to timestamps without it", () => {
      const withZ = render.formatLocalTime("2024-01-01T00:00:00Z");
      const withoutZ = render.formatLocalTime("2024-01-01T00:00:00");
      assert.equal(withZ, withoutZ);
    });
  });

  describe("renderPatchDiff", () => {
    it("returns null for non-patch input", () => {
      assert.equal(render.renderPatchDiff("just text"), null);
      assert.equal(render.renderPatchDiff(null), null);
      assert.equal(render.renderPatchDiff(42), null);
    });

    it("renders patch string format", () => {
      const patch = `*** Begin Patch
*** Update File: src/app.ts
@@ -10,3 +10,3 @@
-old line
+new line
 context
*** End Patch`;
      const html = render.renderPatchDiff(patch);
      assert.ok(html.includes('class="diff-file"'));
      assert.ok(html.includes('class="diff-hunk"'));
      assert.ok(html.includes('class="diff-del"'));
      assert.ok(html.includes('class="diff-add"'));
      // Begin/End Patch lines should be stripped
      assert.ok(!html.includes("Begin Patch"));
      assert.ok(!html.includes("End Patch"));
    });

    it("renders object with old_str/new_str", () => {
      const ri = { path: "file.ts", old_str: "old", new_str: "new" };
      const html = render.renderPatchDiff(ri);
      assert.ok(html.includes('class="diff-file"'));
      assert.ok(html.includes("file.ts"));
      assert.ok(html.includes('class="diff-del"'));
      assert.ok(html.includes('class="diff-add"'));
    });

    it("renders object with file_text (new file) showing all lines", () => {
      const ri = { path: "new.ts", file_text: "line1\nline2\nline3" };
      const html = render.renderPatchDiff(ri);
      assert.ok(html!.includes('class="diff-add">+ line1</span>'));
      assert.ok(html!.includes('class="diff-add">+ line2</span>'));
      assert.ok(html!.includes('class="diff-add">+ line3</span>'));
    });

    it("returns null for object with only path", () => {
      assert.equal(render.renderPatchDiff({ path: "file.ts" }), null);
    });
  });

  describe("addMessage", () => {
    it("adds user message with escaped HTML", () => {
      const el = render.addMessage("user", "<script>alert(1)</script>");
      assert.ok(el.classList.contains("msg"));
      assert.ok(el.classList.contains("user"));
      assert.ok(!el.innerHTML.includes("<script>"));
      assert.equal(dom.messages.children.length, 1);
    });

    it("adds assistant message with markdown", () => {
      const el = render.addMessage("assistant", "hello **world**");
      assert.ok(el.classList.contains("assistant"));
      // marked mock wraps in <p>
      assert.ok(el.innerHTML.includes("<p>"));
    });
  });

  describe("addSystem", () => {
    it("adds system message", () => {
      render.addSystem("test message");
      assert.equal(dom.messages.children.length, 1);
      assert.ok(dom.messages.children[0].classList.contains("system-msg"));
      assert.equal(dom.messages.children[0].textContent, "test message");
    });
  });

  describe("finishAssistant", () => {
    it("clears assistant state", () => {
      state.currentAssistantEl = {};
      state.currentAssistantText = "some text";
      render.finishAssistant();
      assert.equal(state.currentAssistantEl, null);
      assert.equal(state.currentAssistantText, "");
    });
  });

  describe("finishThinking", () => {
    it("is a no-op when no thinking element", () => {
      state.currentThinkingEl = null;
      render.finishThinking();
      assert.equal(state.currentThinkingEl, null);
    });

    it("clears thinking state and updates summary", () => {
      const el = globalThis.document.createElement("details");
      el.innerHTML = '<summary class="active">⠿ thinking...</summary><div class="thinking-content">text</div>';
      dom.messages.appendChild(el);
      state.currentThinkingEl = el;
      state.currentThinkingText = "text";

      render.finishThinking();

      assert.equal(state.currentThinkingEl, null);
      assert.equal(state.currentThinkingText, "");
      assert.equal(el.querySelector("summary").textContent, "⠿ thought");
      assert.ok(!el.querySelector("summary").classList.contains("active"));
    });
  });

  describe("waiting indicator", () => {
    it("showWaiting adds waiting element", () => {
      render.showWaiting();
      const el = dom.messages.querySelector("#waiting");
      assert.ok(el);
      assert.ok(el.querySelector(".cursor"));
    });

    it("hideWaiting removes waiting element", () => {
      render.showWaiting();
      render.hideWaiting();
      assert.equal(dom.messages.querySelector("#waiting"), null);
    });

    it("showWaiting replaces existing waiting", () => {
      render.showWaiting();
      render.showWaiting();
      assert.equal(dom.messages.querySelectorAll("#waiting").length, 1);
    });
  });

  describe("detail panel interactions", () => {
    it("does not collapse an expanded panel when clicking its content", () => {
      const details = globalThis.document.createElement("details");
      details.open = true;
      details.innerHTML = '<summary>diff</summary><div class="diff-view">content</div>';
      dom.messages.appendChild(details);

      details.querySelector(".diff-view").dispatchEvent(new globalThis.window.MouseEvent("click", { bubbles: true }));

      assert.equal(details.open, true);
    });
  });

  describe("scrollToBottom", () => {
    it("keeps following when the user was already at the bottom", () => {
      setMessagesScrollMetrics({ scrollTop: 400, scrollHeight: 600, clientHeight: 200 });
      dom.messages.dispatchEvent(new globalThis.window.Event("scroll"));

      setMessagesScrollMetrics({ scrollTop: dom.messages.scrollTop, scrollHeight: 1400, clientHeight: 200 });
      render.scrollToBottom();

      assert.equal(dom.messages.scrollTop, 1400);
      assert.equal(state.followMessages, true);
    });

    it("does not move the viewport when the user scrolled up", () => {
      setMessagesScrollMetrics({ scrollTop: 120, scrollHeight: 600, clientHeight: 200 });
      dom.messages.dispatchEvent(new globalThis.window.Event("scroll"));

      setMessagesScrollMetrics({ scrollTop: dom.messages.scrollTop, scrollHeight: 1400, clientHeight: 200 });
      render.scrollToBottom();

      assert.equal(dom.messages.scrollTop, 120);
      assert.equal(state.followMessages, false);
    });

    it("always scrolls when forced", () => {
      setMessagesScrollMetrics({ scrollTop: 120, scrollHeight: 600, clientHeight: 200 });
      state.followMessages = false;

      render.scrollToBottom(true);

      assert.equal(dom.messages.scrollTop, 600);
      assert.equal(state.followMessages, true);
    });
  });

  describe("addBashBlock", () => {
    it("creates bash block with command", () => {
      const el = render.addBashBlock("ls -la", false);
      assert.ok(el.classList.contains("bash-block"));
      assert.ok(el.querySelector(".bash-cmd").textContent.includes("ls -la"));
      assert.ok(!el.querySelector(".bash-cmd").classList.contains("running"));
      assert.equal(state.currentBashEl, null);
    });

    it("sets running state when running=true", () => {
      const el = render.addBashBlock("npm test", true);
      assert.ok(el.querySelector(".bash-cmd").classList.contains("running"));
      assert.equal(state.currentBashEl, el);
    });

    it("recomputes follow state from the pre-append position", () => {
      state.followMessages = false;
      setMessagesScrollMetrics({ scrollTop: 400, scrollHeight: 600, clientHeight: 200 });

      render.addBashBlock("npm test", true);

      assert.equal(dom.messages.scrollTop, 600);
      assert.equal(state.followMessages, true);
    });
  });

  describe("finishBash", () => {
    it("removes running class", () => {
      const el = render.addBashBlock("cmd", true);
      render.finishBash(el, 0, null);
      assert.ok(!el.querySelector(".bash-cmd").classList.contains("running"));
      assert.equal(state.currentBashEl, null);
    });

    it("shows exit code for non-zero exit", () => {
      const el = render.addBashBlock("cmd", false);
      render.finishBash(el, 1, null);
      const exitEl = el.querySelector(".bash-exit");
      assert.ok(exitEl);
      assert.ok(exitEl.textContent.includes("exit: 1"));
      assert.ok(exitEl.classList.contains("fail"));
    });

    it("shows signal", () => {
      const el = render.addBashBlock("cmd", false);
      render.finishBash(el, null, "SIGTERM");
      const exitEl = el.querySelector(".bash-exit");
      assert.ok(exitEl.textContent.includes("SIGTERM"));
    });

    it("is a no-op for null element", () => {
      render.finishBash(null, 0, null);
      // No error thrown
    });
  });
});
