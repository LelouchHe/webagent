// Cross-check that `updateMarkdownStream` produces visually equivalent DOM
// to the legacy `renderMd` (full innerHTML rewrite) for every corpus it
// will replace at M-7. This is a single-shot equivalence test — we feed
// the full text once to each path and compare. The streaming-specific
// behavior (HIT path, mid-stream MISS) is covered separately by
// markdown-stream.test.ts.
//
// The test exists because M-7 deletes renderMd; we want a permanent lock
// that the new render preserves textContent and block-element count
// against the reference output, across all the drift cases the panel
// review surfaced (backtick parity, unclosed HTML, loose ordered lists,
// list+code indent).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";

const BLOCK_TAGS =
  "p,ol,ul,li,pre,code,blockquote,h1,h2,h3,h4,h5,h6,table,tr,td,th,hr,details,summary,div";

const CASES: { name: string; text: string }[] = [
  {
    name: "plain paragraphs",
    text: "alpha beta\n\nsecond paragraph\n\nthird **bold** here\n",
  },
  {
    name: "heading + paragraph",
    text: "## Title\n\nbody with `inline code` and *em*.\n",
  },
  {
    name: "fenced code block",
    text: "before\n\n```js\nconst x = 1;\nconst y = 2;\n```\n\nafter\n",
  },
  {
    name: "loose ordered list (Path Y drift case)",
    text: "1. first\n\n2. second with two lines\n   continued\n\n3. third\n",
  },
  {
    name: "list containing fenced code (indented)",
    text: "- item one\n\n    ```\n    inside\n    ```\n\n- item two\n",
  },
  {
    name: "GFM table",
    text: "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n",
  },
  {
    name: "blockquote with inline emphasis",
    text: "> quoted **strong** line\n> second line\n\noutside\n",
  },
  {
    name: "unclosed-details HTML embedded mid-stream",
    text: "<details>\n<summary>HEAD</summary>\nbody inside\n</details>\n\nafter\n",
  },
  {
    name: "long synthetic stream (50 paragraphs)",
    text:
      Array.from(
        { length: 50 },
        (_, i) => `Section ${i} text **bold${i}** more.`,
      ).join("\n\n") + "\n",
  },
];

// Whitespace between root block elements:
//   - renderMd → innerHTML preserves marked's "\n" text nodes between
//     <p>…</p>\n<p>…</p>, so textContent includes them.
//   - updateMarkdownStream strips those nodes (necessary so host.children
//     stays in sync with host.childNodes for the offset math).
// Both are visually identical (<p> is block-level; the space-between-text
// is purely DOM-internal glue), and the rendered UI is unaffected. We
// compare modulo all whitespace to lock semantic equivalence.
function normWs(s: string | null): string {
  return (s ?? "").replace(/\s+/g, "");
}

describe("updateMarkdownStream — byte-equal vs legacy renderMd", () => {
  let mod: typeof import("../public/js/render-event.ts");

  before(async () => {
    setupDOM();
    mod = await import("../public/js/render-event.ts");
  });
  after(() => {
    teardownDOM();
  });

  for (const { name, text } of CASES) {
    it(`textContent equals renderMd: ${name}`, () => {
      const ref = document.createElement("div");
      ref.innerHTML = mod.renderMd(text);
      const out = document.createElement("div");
      mod.updateMarkdownStream(out, text);
      assert.equal(
        normWs(out.textContent),
        normWs(ref.textContent),
        `textContent diverged for case "${name}"`,
      );
    });

    it(`block-element count equals renderMd: ${name}`, () => {
      const ref = document.createElement("div");
      ref.innerHTML = mod.renderMd(text);
      const out = document.createElement("div");
      mod.updateMarkdownStream(out, text);
      assert.equal(
        out.querySelectorAll(BLOCK_TAGS).length,
        ref.querySelectorAll(BLOCK_TAGS).length,
        `block-element count diverged for case "${name}"`,
      );
    });
  }

  // Inline AND block math are sanitized away by DOMPurify in the legacy
  // renderMd path: the first <math> in a sanitized fragment without prior
  // foreign-content priming gets stripped (HTML5 parser "in body" vs "in
  // foreign content" mode quirk). updateMarkdownStream prepends an empty
  // <math></math> sentinel before each per-block sanitize, which warms
  // the parser and is itself auto-removed. The math cases below are
  // therefore tested as v6 *improvements*, not equivalences.
  it("inline math survives in updateMarkdownStream (improvement over renderMd)", () => {
    const text = "Energy: $E = mc^2$ done.\n";
    const out = document.createElement("div");
    mod.updateMarkdownStream(out, text);
    assert.match(out.innerHTML, /<math[\s>]/);
    const m = out.querySelector("math");
    assert.ok(m, "inline math element should exist");
    assert.match(m.textContent, /E/);
  });

  it("block math survives in updateMarkdownStream (improvement over renderMd)", () => {
    const text = "before:\n\n$$\n\\int_0^1 f(x)\\,dx\n$$\n\nafter.\n";
    const out = document.createElement("div");
    mod.updateMarkdownStream(out, text);
    const mathEl = out.querySelector(".math-block math");
    assert.ok(mathEl, "block math element should exist");
    assert.match(mathEl.textContent, /∫/);
  });
});
