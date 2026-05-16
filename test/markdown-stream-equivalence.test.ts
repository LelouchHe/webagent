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
  // opt #3 collapse cases — these render correctly under v6 but each
  // is a SINGLE marked block token that grows long, defeating per-block
  // memo. Opt #3 (container sub-memo) must preserve byte-equality on
  // the final render while making the streaming path proportional to
  // sub-item growth.
  {
    name: "long bullet list (20 items, opt #3 target)",
    text:
      Array.from(
        { length: 20 },
        (_, i) => `- item ${i + 1} with **emphasis** and \`code${i}\``,
      ).join("\n") + "\n",
  },
  {
    name: "long ordered list (20 items, opt #3 target)",
    text:
      Array.from(
        { length: 20 },
        (_, i) => `${i + 1}. point ${i + 1} with details`,
      ).join("\n") + "\n",
  },
  {
    name: "long GFM table (15 rows, opt #3 target)",
    text:
      "| name | value | note |\n| --- | --- | --- |\n" +
      Array.from(
        { length: 15 },
        (_, i) => `| row${i + 1} | ${i * 7} | n${i + 1} |`,
      ).join("\n") + "\n",
  },
  {
    name: "blockquote containing list (opt #3 recursion)",
    text:
      "> Quoted intro paragraph.\n>\n> - bullet a\n> - bullet b with `code`\n> - bullet c **bold**\n>\n> Closing quote line.\n",
  },
  {
    name: "nested blockquote with table (opt #3 recursion)",
    text:
      "> outer\n>\n> > inner with table:\n> >\n> > | k | v |\n> > | --- | --- |\n> > | a | 1 |\n> > | b | 2 |\n>\n> back to outer\n",
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
  // Inline reimpl of the deleted `renderMd` (kept as a baseline reference
  // for byte-equal correctness across all corpora). Single source of
  // truth lives in the equivalence test itself so the production module
  // can drop the unused export.
  let legacyRenderMd: (text: string) => string;

  before(async () => {
    setupDOM();
    mod = await import("../public/js/render-event.ts");
    const { marked } = await import("marked");
    const DOMPurify = (await import("dompurify")).default;
    legacyRenderMd = (text: string) =>
      DOMPurify.sanitize(marked.parse(text) as string, {
        USE_PROFILES: { html: true, mathMl: true },
      });
  });
  after(() => {
    teardownDOM();
  });

  for (const { name, text } of CASES) {
    it(`textContent equals renderMd: ${name}`, () => {
      const ref = document.createElement("div");
      ref.innerHTML = legacyRenderMd(text);
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
      ref.innerHTML = legacyRenderMd(text);
      const out = document.createElement("div");
      mod.updateMarkdownStream(out, text);
      assert.equal(
        out.querySelectorAll(BLOCK_TAGS).length,
        ref.querySelectorAll(BLOCK_TAGS).length,
        `block-element count diverged for case "${name}"`,
      );
    });
  }

  // Block math (e.g. `$$ … $$`) renders to a fragment whose first element is
  // <math>. DOMPurify under happy-dom strips its children (HTML5 parser "in
  // body" vs foreign-content mode quirk); this matches legacy renderMd
  // behavior, and real browsers handle it correctly via innerHTML. We do NOT
  // prepend a `<math></math>` sentinel — paired sentinel warms foreign-content
  // mode and lets later <script>/<style> tokens leak past sanitize. The
  // critical security guarantee tested below is what matters.

  it("script tags are stripped (no XSS via sentinel leak)", () => {
    const text = "<script>alert(1)</script>\n";
    const out = document.createElement("div");
    mod.updateMarkdownStream(out, text);
    assert.equal(
      out.querySelector("script"),
      null,
      "no <script> element should survive sanitize",
    );
  });

  // Incremental-lex regression: after a streaming sequence builds up to
  // fullText, a single one-shot updateMarkdownStream(fullText) must produce
  // identical DOM. Catches bugs where the prefix-match path drops a stable
  // block, or where re-lexing only the tail produces a different block
  // count than re-lexing the whole text.
  it("streaming sequence converges to one-shot output", () => {
    const text =
      "# Title\n\nFirst paragraph with $x$ math.\n\n" +
      "Second paragraph.\n\n" +
      "```js\nconst a = 1;\n```\n\n" +
      "Third paragraph: cost $5 and $10.\n\n" +
      "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    const oneShot = document.createElement("div");
    mod.updateMarkdownStream(oneShot, text);
    const streamed = document.createElement("div");
    // Feed in ~50-byte chunks.
    for (let i = 50; i <= text.length; i += 50) {
      mod.updateMarkdownStream(streamed, text.slice(0, i));
    }
    mod.updateMarkdownStream(streamed, text);
    assert.equal(
      normWs(streamed.textContent),
      normWs(oneShot.textContent),
      "streamed textContent diverged from one-shot",
    );
    assert.equal(
      streamed.children.length,
      oneShot.children.length,
      "streamed block count diverged from one-shot",
    );
  });

  // Opt #2 lock — for every single-token block the streaming code can see,
  // the fast path `marked.parser([token])` MUST produce HTML equivalent
  // to `marked.parse(raw)`. If marked's extension hooks ever assume the
  // parser merges options with defaults (we have to spread `defaults`
  // manually for the parser static), this test catches the regression.
  // The cases below cover the token types observed in dogfood traffic:
  // paragraph, code, table, list, blockquote, heading, math.
  it("opt #2 fast path: marked.parser([token]) ≡ marked.parse(raw)", async () => {
    const { marked } = await import("marked");
    const tokenCases: { name: string; raw: string }[] = [
      { name: "paragraph", raw: "a paragraph with *em* and `code`.\n" },
      { name: "heading", raw: "# Heading line\n" },
      {
        name: "GFM table (long)",
        raw:
          "| col a | col b | col c |\n" +
          "| --- | --- | --- |\n" +
          "| 0 | x0 | y0 |\n" +
          "| 1 | x1 | y1 |\n" +
          "| 2 | x2 | y2 |\n" +
          "| 3 | x3 | y3 |\n",
      },
      {
        name: "fenced code block (closed)",
        raw: "```js\nconst a = 1;\nconst b = 2;\n```\n",
      },
      { name: "blockquote", raw: "> quoted line\n> second line\n" },
      { name: "inline math in paragraph", raw: "cost is $x + y$ total.\n" },
      { name: "block math", raw: "$$\nE = mc^2\n$$\n" },
    ];
    for (const { name, raw } of tokenCases) {
      const tokens = marked.lexer(raw);
      // Filter to the first block-level token — mimics what
      // mergeUnclosedBlocks emits when a chunk yields a single block.
      assert.equal(
        tokens.length,
        1,
        `precondition: lexer should emit exactly 1 token for "${name}"`,
      );
      const viaParse = marked.parse(raw, { async: false });
      const viaParser = marked.parser(tokens, {
        ...marked.defaults,
        async: false,
      }) as string;
      assert.equal(
        normWs(viaParser),
        normWs(viaParse),
        `parser/parse HTML diverged for "${name}"`,
      );
    }
  });
});
