// Tests for the LaTeX math markdown extension.
//
// Two layers:
//   1. marked extension recognizes $...$ / $$...$$ and calls temml
//   2. DOMPurify (with USE_PROFILES.mathMl) preserves <math> in real browsers
//
// happy-dom's DOMParser does NOT preserve the MathML namespace — DOMPurify
// strips <math> regardless of profile config. We therefore test the marked
// extension output directly (bypassing DOMPurify) for tokenization correctness.
// The DOMPurify profile config is verified by source-string spot check below;
// real-browser preservation is covered by E2E.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";

describe("math rendering (Temml)", () => {
  let parse: (text: string) => string;

  before(async () => {
    setupDOM();
    // Side-effect import registers the marked extension.
    await import("../public/js/math.ts");
    const { marked } = await import("marked");
    parse = (text: string) => marked.parse(text) as string;
  });
  after(() => {
    teardownDOM();
  });

  it("renders inline math $x^2$ as <math> (not display)", () => {
    const html = parse("hello $x^2$ world");
    assert.match(html, /<math[^>]*>/);
    assert.doesNotMatch(html, /<math[^>]*display="block"/);
    assert.match(html, /<msup>/);
    assert.match(html, /hello /);
    assert.match(html, /world/);
  });

  it("renders display math $$...$$ as block <math> in math-block wrapper", () => {
    const html = parse("$$\\frac{1}{2}$$");
    assert.match(html, /<div class="math-block"><math[^>]*display="block"/);
    assert.match(html, /<mfrac>/);
  });

  it("renders block-form display math ($$ on own lines, newline-delimited)", () => {
    const html = parse("before\n\n$$\n\\frac{1}{2}\n$$\n\nafter");
    assert.match(html, /<div class="math-block"><math[^>]*display="block"/);
    assert.match(html, /before/);
    assert.match(html, /after/);
  });

  it("does NOT render glued-form $$...$$ with internal newlines (upstream behavior)", () => {
    // marked-katex-extension's block rule requires `$$\n...\n$$` (display
    // math on its own line). Agents that emit `$$\begin{aligned}...
    // \end{aligned}$$` glued on one line will fall through to the inline
    // rule, which rejects newlines in content → raw text output.
    // This is intentional: see math.ts header comment. Fix is at the agent
    // instruction layer, not here.
    const html = parse(
      "$$\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}$$",
    );
    assert.doesNotMatch(html, /<math/);
  });

  it("preserves surrounding markdown (paragraphs, bold)", () => {
    const html = parse("**bold** $a+b$ more");
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<math[^>]*>/);
  });

  it("does not blow up on malformed LaTeX (throwOnError: false)", () => {
    const html = parse("$\\frac{1}{$");
    assert.equal(typeof html, "string");
    assert.ok(html.length > 0);
  });

  it("ignores prices and other non-math dollar usage", () => {
    const html = parse("Cost is $5 and $10.");
    assert.doesNotMatch(html, /<math/);
  });

  it("renders multi-line aligned block when $$ are on own lines", () => {
    const html = parse(
      "$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$",
    );
    assert.match(html, /<div class="math-block"><math[^>]*display="block"/);
    assert.match(html, /<mtable/);
    assert.doesNotMatch(html, /\\begin\{aligned\}/);
  });

  it("handles multiple math blocks in one document", () => {
    const html = parse("First $a$ then $b$ and finally $$c$$.");
    const matches = html.match(/<math/g);
    assert.ok(
      matches?.length === 3,
      `expected 3 <math> tags, got ${matches?.length}`,
    );
  });

  it("renderMd configures DOMPurify with mathMl profile", () => {
    // Real-browser preservation check; happy-dom strips <math> at the
    // DOMParser level so we can't unit-test the actual output. Instead
    // assert that the source code passes USE_PROFILES.mathMl: true so
    // production browsers preserve <math> tags.
    const src = readFileSync(
      new URL("../public/js/render-event.ts", import.meta.url),
      "utf8",
    );
    assert.match(src, /USE_PROFILES:\s*\{[^}]*mathMl:\s*true/);
  });
});
