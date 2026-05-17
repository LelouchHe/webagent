// E2 — reference-link def lost across chunks.
//
// Bug: `incrementalLex` drops the LAST cached block and re-lexes the tail.
// When the tail contains a `[label][1]` reflink whose `[1]: url` def lives
// in the stable prefix (now in cache, NOT re-lexed), marked's lexer cannot
// resolve the ref — it ends up rendered as literal `[label][1]` text.
//
// Fix: the memo carries a `links: Map<string, {href, title}>` that absorbs
// completed `def` tokens as they leave the trailing block position. Each
// re-lex creates a fresh `Lexer(MARKED_OPTIONS)` instance whose
// `tokens.links` is pre-loaded from the memo before `lexer.lex(tail)` runs.
// This is the only mechanism that resolves reflinks at lex time — assigning
// `.links` AFTER lex (the original plan) is a no-op because marked resolves
// refs during inline tokenization, not during parser walk.
//
// Three corpora locked by this file:
//   1. cross-chunk reflink   — def in chunk 1, ref in chunk 3 → must be <a>
//   2. duplicate def         — first def wins (marked baseline)
//   3. chunk-cut URL         — URL split across chunk boundary → must complete
//
// Compared against single-shot `marked.parse(fullText)` as the byte-equal
// baseline.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";

function normWs(s: string | null): string {
  return (s ?? "").replace(/\s+/g, "");
}

describe("updateMarkdownStream — reference-link memo across chunks", () => {
  let mod: typeof import("../public/js/render-event.ts");
  let baseline: (text: string) => string;

  before(async () => {
    setupDOM();
    mod = await import("../public/js/render-event.ts");
    const { marked } = await import("marked");
    const DOMPurify = (await import("dompurify")).default;
    baseline = (text: string) =>
      DOMPurify.sanitize(marked.parse(text) as string, {
        USE_PROFILES: { html: true, mathMl: true },
      });
  });
  after(() => {
    teardownDOM();
  });

  it("cross-chunk reflink resolves to <a href>", () => {
    const chunks = [
      "[1]: https://example.com\n",
      "\nIntro paragraph.\n",
      "\nClick [here][1] for more.\n",
    ];
    const fullText = chunks.join("");
    const host = document.createElement("div");
    let acc = "";
    for (const c of chunks) {
      acc += c;
      mod.updateMarkdownStream(host, acc);
    }
    const ref = document.createElement("div");
    ref.innerHTML = baseline(fullText);
    assert.equal(
      host.querySelectorAll("a[href]").length,
      ref.querySelectorAll("a[href]").length,
      "anchor count must match baseline",
    );
    const a = host.querySelector("a[href]");
    assert.ok(a, "the reflink should resolve to an <a> element");
    assert.equal(
      a.getAttribute("href"),
      "https://example.com",
      "href must be the def target",
    );
    assert.equal(normWs(host.textContent), normWs(ref.textContent));
  });

  it("duplicate def — first one wins (matches marked baseline)", () => {
    // Wedge an intermediate block between the two defs so the first def
    // is pushed into the stable prefix (cache) before the second def
    // arrives. This forces the memo's first-write-wins guard to do real
    // work — without it, the tail re-lex would only see def2.
    const chunks = [
      "[1]: https://first.com\n",
      "\nIntro paragraph.\n",
      "\n[1]: https://second.com\n",
      "\nThe [link][1].\n",
    ];
    const fullText = chunks.join("");
    const host = document.createElement("div");
    let acc = "";
    for (const c of chunks) {
      acc += c;
      mod.updateMarkdownStream(host, acc);
    }
    const a = host.querySelector("a[href]");
    assert.ok(a, "reflink must resolve");
    assert.equal(
      a.getAttribute("href"),
      "https://first.com",
      "first def wins (marked semantics)",
    );
    const ref = document.createElement("div");
    ref.innerHTML = baseline(fullText);
    assert.equal(normWs(host.textContent), normWs(ref.textContent));
  });

  it("chunk-cut URL — URL completes before def absorbed", () => {
    // The def line is split mid-URL across two chunks. As long as both
    // chunks merge before the def block stops being the trailing block,
    // the URL completes and the memo records the full href.
    const chunks = [
      "[1]: https://exam", // no newline yet — def is still growing
      "ple.com\n",
      "\nGo [here][1].\n",
    ];
    const fullText = chunks.join("");
    const host = document.createElement("div");
    let acc = "";
    for (const c of chunks) {
      acc += c;
      mod.updateMarkdownStream(host, acc);
    }
    const a = host.querySelector("a[href]");
    assert.ok(a, "reflink must resolve after URL completes");
    assert.equal(
      a.getAttribute("href"),
      "https://example.com",
      "href must be the full URL, not the chunk-1 truncation",
    );
    const ref = document.createElement("div");
    ref.innerHTML = baseline(fullText);
    assert.equal(normWs(host.textContent), normWs(ref.textContent));
  });

  it("resetMarkdownStream clears link memo", () => {
    // After reset, a reflink whose def was in the prior session must NOT
    // resolve — otherwise the memo leaks across turns.
    const host = document.createElement("div");
    mod.updateMarkdownStream(host, "[1]: https://example.com\n");
    mod.resetMarkdownStream(host);
    host.replaceChildren();
    mod.updateMarkdownStream(host, "Click [here][1] now.\n");
    // With no def visible to this turn, marked falls back to literal text.
    assert.equal(
      host.querySelectorAll("a[href]").length,
      0,
      "no anchor — def memo must be cleared on reset",
    );
    assert.match(host.textContent, /\[here\]\[1\]/);
  });
});
