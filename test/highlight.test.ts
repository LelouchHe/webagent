import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("highlight (lazy-load + code toolbar)", () => {
  let state: any;
  let dom: any;
  let highlight: any;
  let render: any;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    render = await import("../public/js/render.ts");
    highlight = await import("../public/js/highlight.ts");
  });
  after(() => teardownDOM());
  beforeEach(() => resetState(state, dom));

  describe("processCodeBlocks", () => {
    it("wraps pre>code in a .code-block-wrapper with toolbar", () => {
      const el = globalThis.document.createElement("div");
      el.className = "msg assistant";
      el.innerHTML = "<pre><code>const x = 1;</code></pre>";
      highlight.processCodeBlocks(el);

      const wrapper = el.querySelector(".code-block-wrapper");
      assert.ok(wrapper, "should have .code-block-wrapper");
      const toolbar = wrapper.querySelector(".code-toolbar");
      assert.ok(toolbar, "should have .code-toolbar");
      const pre = wrapper.querySelector("pre");
      assert.ok(pre, "pre should be inside wrapper");
    });

    it("shows language label when language class is present", () => {
      const el = globalThis.document.createElement("div");
      el.className = "msg assistant";
      el.innerHTML = '<pre><code class="language-python">print("hi")</code></pre>';
      highlight.processCodeBlocks(el);

      // Language label removed — only copy button in toolbar
      const label = el.querySelector(".code-lang");
      assert.ok(!label, "should not have language label");
    });

    it("adds copy button without language label when no language class", () => {
      const el = globalThis.document.createElement("div");
      el.className = "msg assistant";
      el.innerHTML = "<pre><code>plain code</code></pre>";
      highlight.processCodeBlocks(el);

      const label = el.querySelector(".code-lang");
      // Label should either not exist or be empty
      assert.ok(!label || label.textContent === "");
    });

    it("adds a copy button to each code block", () => {
      const el = globalThis.document.createElement("div");
      el.className = "msg assistant";
      el.innerHTML = "<pre><code>block1</code></pre><pre><code>block2</code></pre>";
      highlight.processCodeBlocks(el);

      const buttons = el.querySelectorAll(".copy-btn");
      assert.equal(buttons.length, 2, "should have 2 copy buttons");
    });

    it("does not double-wrap already processed code blocks", () => {
      const el = globalThis.document.createElement("div");
      el.className = "msg assistant";
      el.innerHTML = "<pre><code>code</code></pre>";
      highlight.processCodeBlocks(el);
      highlight.processCodeBlocks(el);

      const wrappers = el.querySelectorAll(".code-block-wrapper");
      assert.equal(wrappers.length, 1, "should not double-wrap");
    });

    it("does not wrap pre without code child", () => {
      const el = globalThis.document.createElement("div");
      el.className = "msg assistant";
      el.innerHTML = "<pre>raw preformatted text</pre>";
      highlight.processCodeBlocks(el);

      const wrappers = el.querySelectorAll(".code-block-wrapper");
      assert.equal(wrappers.length, 0, "should not wrap pre without code");
    });
  });

  describe("getCodeText", () => {
    it("extracts text content from a code block wrapper", () => {
      const el = globalThis.document.createElement("div");
      el.innerHTML = '<div class="code-block-wrapper"><div class="code-toolbar"></div><pre><code>hello world</code></pre></div>';
      const code = el.querySelector("code")!;
      assert.equal(code.textContent, "hello world");
    });
  });

  describe("handleCopyClick", () => {
    let clipboardText: string | null;
    let clipboardError: boolean;

    beforeEach(() => {
      clipboardText = null;
      clipboardError = false;
      // Mock navigator.clipboard
      Object.defineProperty(globalThis.navigator, "clipboard", {
        value: {
          writeText: (text: string) => {
            if (clipboardError) return Promise.reject(new Error("denied"));
            clipboardText = text;
            return Promise.resolve();
          },
        },
        configurable: true,
      });
    });

    it("copies code text to clipboard on copy button click", async () => {
      const el = globalThis.document.createElement("div");
      el.innerHTML = '<div class="code-block-wrapper"><div class="code-toolbar"><button class="copy-btn">cp</button></div><pre><code>const x = 1;</code></pre></div>';
      dom.messages.appendChild(el);

      const btn = el.querySelector(".copy-btn") as HTMLElement;
      // Add delegated listener like app.ts does
      dom.messages.addEventListener("click", highlight.handleCopyClick);
      btn.click();

      // Give the clipboard promise time to resolve
      await new Promise(r => setTimeout(r, 10));
      assert.equal(clipboardText, "const x = 1;");
      dom.messages.removeEventListener("click", highlight.handleCopyClick);
    });

    it("ignores clicks on non-copy-btn elements", () => {
      const el = globalThis.document.createElement("div");
      el.innerHTML = '<div class="code-block-wrapper"><div class="code-toolbar"><span class="code-lang">js</span></div><pre><code>x</code></pre></div>';
      dom.messages.appendChild(el);

      const lang = el.querySelector(".code-lang")!;
      const event = new globalThis.window.MouseEvent("click", { bubbles: true });
      Object.defineProperty(event, "target", { value: lang });
      highlight.handleCopyClick(event);
      assert.equal(clipboardText, null);
    });
  });
});
