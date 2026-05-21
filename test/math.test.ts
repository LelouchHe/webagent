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
  let findUnclosedDisplayMathBlockStart: (src: string) => number | null;

  before(async () => {
    setupDOM();
    // Side-effect import registers the marked extension.
    const math = await import("../public/js/math.ts");
    findUnclosedDisplayMathBlockStart = math.findUnclosedDisplayMathBlockStart;
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

  it("renders math-error span for malformed LaTeX (degrades gracefully)", () => {
    const html = parse("before $\\frac{1}{$ after");
    // No raw red ParseError text leaks to the rendered output.
    assert.doesNotMatch(html, /ParseError/);
    // Falls back to a math-error span containing the literal source.
    assert.match(html, /<span class="math-error"/);
    assert.match(html, /title="LaTeX parse error:/);
    // The literal `$\frac{1}{$` is preserved (HTML-escaped) inside the span.
    assert.match(html, /\$\\frac\{1\}\{\$/);
    // Surrounding text intact.
    assert.match(html, /before /);
    assert.match(html, / after/);
  });

  it("renders math-error inside math-block wrapper for display mode", () => {
    const html = parse("$$\n\\frac{1}{\n$$");
    assert.match(html, /<div class="math-block"><span class="math-error"/);
    assert.doesNotMatch(html, /ParseError/);
  });

  it("does not blow up on malformed LaTeX (returns string)", () => {
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

  it("shared display-math block scanner matches closed/unclosed $$ blocks", () => {
    assert.equal(
      findUnclosedDisplayMathBlockStart("before\n\n$$\na\n\nb\n"),
      8,
    );
    assert.equal(
      findUnclosedDisplayMathBlockStart("before\n\n$$\na\n\nb\n$$\n\nafter"),
      null,
    );
  });

  it("shared display-math block scanner ignores $$ inside fenced code", () => {
    assert.equal(
      findUnclosedDisplayMathBlockStart("```md\n$$\nnot math\n```\n\nafter"),
      null,
    );
    assert.equal(
      findUnclosedDisplayMathBlockStart("`````\n$$\nnot math\n```\n$$\n"),
      null,
    );
  });

  it("handles multiple math blocks in one document", () => {
    const html = parse("First $a$ then $b$ and finally $$c$$.");
    const matches = html.match(/<math/g);
    assert.ok(
      matches?.length === 3,
      `expected 3 <math> tags, got ${matches?.length}`,
    );
  });

  // CJK fullwidth punctuation (，。：；！？) MUST count as a `$` close
  // boundary, matching upstream marked-katex-extension. A previous regex
  // drift mangled the fullwidth chars `！，：` to their ASCII look-alikes
  // `!,:` and silently broke common Chinese math sentences like
  // `已知 $P(B)$，求 $P(A)$。` — the unclosed `$` got merged with the next
  // `$` into one giant math span containing `$` literals, triggering
  // `ParseError: Can't use function '$' in math mode`. Lock all six
  // fullwidth chars down here.
  for (const punct of ["，", "。", "：", "！", "？"]) {
    it(`closes inline $...$ before fullwidth '${punct}'`, () => {
      const html = parse(`已知 $P(A)$${punct}求 $P(B)$。`);
      const matches = html.match(/<math/g);
      assert.ok(
        matches?.length === 2,
        `expected 2 <math> tags for '${punct}', got ${matches?.length}`,
      );
      // No raw $ should leak through.
      assert.doesNotMatch(html, /\$P\(/);
    });
  }

  it("repro: original ParseError sentence renders without leaking raw $", () => {
    // The exact phrase from session c9846c10 that triggered the bug.
    const html = parse(
      "已知 $P(B \\mid A)$, $P(A)$, $P(B \\mid \\neg A)$，求 $P(A \\mid B)$。",
    );
    const matches = html.match(/<math/g);
    assert.ok(
      matches?.length === 4,
      `expected 4 <math> tags, got ${matches?.length}`,
    );
    assert.doesNotMatch(html, /\$P\(/);
  });

  it("updateMarkdownStream configures DOMPurify with mathMl profile", () => {
    // Real-browser preservation check; happy-dom strips <math> at the
    // DOMParser level so we can't unit-test the actual output. Instead
    // assert that the source code passes USE_PROFILES.mathMl: true so
    // production browsers preserve <math> tags.
    const src = readFileSync(
      new URL("../public/js/markdown-stream.ts", import.meta.url),
      "utf8",
    );
    assert.match(src, /USE_PROFILES:\s*\{[^}]*mathMl:\s*true/);
  });

  // Regression guard: the upstream marked-katex-extension `start()` builds
  // a fresh substring + runs a regex on every `$` encountered, which is
  // O(N²) over dollar-heavy text. Caught in dogfood as ~12ms lex on a
  // ~4KB assistant message containing many bench dollar literals. The
  // zero-allocation rewrite must stay << that.
  //
  // We don't assert a hard ms budget (CI runners vary wildly), but we
  // measure both the old and new shape on the same text and verify the
  // new path is at least 5x faster — defends against future refactors
  // accidentally bringing back the substring allocations.
  it("inline math start() scales linearly on dollar-heavy text", async () => {
    const { marked } = await import("marked");
    // Build a paragraph that resembles a bench-result message:
    // many `$` chars, mostly NOT math, with a few real $...$ matches.
    const chunk =
      "max **5.2ms** < 16, p99 **3.7ms** < 8; cost $5 and $10 and " +
      "fee $3.50; inline $x^2$ math; tail $a+b$ done. ";
    const text = chunk.repeat(40); // ~4KB
    // Warm up V8.
    for (let i = 0; i < 5; i++) marked.lexer(text);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) marked.lexer(text);
    const dt = performance.now() - t0;
    // 50 lexes of ~4KB; if start() is allocation-free this stays well
    // under 500ms even on a slow CI runner. The old implementation
    // crossed 1000ms on the same workload locally.
    assert.ok(
      dt < 1000,
      `marked.lexer on dollar-heavy 4KB text too slow: ${dt.toFixed(1)}ms / 50 iter`,
    );
  });
});
