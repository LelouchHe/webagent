// Tests for streaming markdown render — per-block memo (streamdown-style).
//
// Background: legacy `renderMd(fullText)` returned a full HTML string and
// the caller did `el.innerHTML = ...`. For a long incremental stream this is
// O(N²): every chunk re-parses + re-sanitizes everything, every chunk replaces
// every DOM node, hljs/Temml decorations get wiped per frame. Bench numbers
// in plan.md: 156KB stream took 23.8s without memo.
//
// `updateMarkdownStream(host, fullText)` re-lexes per call, but only
// re-renders blocks whose `raw` differs from last call. Unchanged blocks
// keep their DOM (HIT path = 0 mutation, advance offset by old root count).
// Cache anchored to `host` via WeakMap so host GC auto-releases memo.
//
// These tests lock the invariants documented in plan.md:
//   - cold render produces correct DOM
//   - tail append keeps prior block identity (HIT)
//   - tail replace only re-renders last block
//   - **mid-stream MISS on a non-tail block** must not mis-offset (this was
//     the bug that bench corpora — append-only — could never catch)
//   - block-count shrink truncates host correctly
//   - unclosed code fences get merged into one logical block until balanced
//   - dev-mode entry invariant fires if some other code path scribbled
//     `host.innerHTML` between calls (catches lifecycle reset gaps)
//   - `resetMarkdownStream(host)` clears the memo so the host can be reused
//   - async marked.parse is rejected at runtime (defensive)

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";

describe("updateMarkdownStream", () => {
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

  it("cold render produces expected DOM", () => {
    mod.updateMarkdownStream(host, "hello **world**\n");
    assert.match(host.innerHTML, /<strong>world<\/strong>/);
    assert.equal(host.children.length, 1);
  });

  it("appends a new tail block while reusing existing block DOM (HIT)", () => {
    mod.updateMarkdownStream(host, "para one\n\n");
    const firstP = host.firstElementChild;
    assert.ok(firstP);
    mod.updateMarkdownStream(host, "para one\n\npara two\n");
    assert.equal(
      host.firstElementChild,
      firstP,
      "stable block must keep DOM identity across calls",
    );
    assert.equal(host.children.length, 2);
    assert.match(host.children[1].textContent, /para two/);
  });

  it("re-renders only the changed last block", () => {
    mod.updateMarkdownStream(host, "fixed\n\npartial");
    const fixedP = host.firstElementChild;
    mod.updateMarkdownStream(host, "fixed\n\npartial text added\n");
    assert.equal(host.firstElementChild, fixedP);
    assert.equal(host.children.length, 2);
    const last = host.lastElementChild;
    assert.ok(last);
    assert.match(last.textContent, /partial text added/);
  });

  it("handles mid-stream MISS on a non-tail block without mis-offset", () => {
    // This is the case bench corpora — which only append at the tail — could
    // never reveal. If our offset accounting is wrong, the tail HIT path
    // would either skip too many children (leaving stale DOM) or remove the
    // wrong child during the next MISS, throwing on host.children[oob].
    mod.updateMarkdownStream(host, "alpha\n\nbeta\n\ngamma\n");
    assert.equal(host.children.length, 3);
    const alphaP = host.children[0];
    const gammaP = host.children[2];
    mod.updateMarkdownStream(host, "alpha\n\nBETA changed\n\ngamma\n");
    assert.equal(host.children.length, 3);
    assert.equal(host.children[0], alphaP, "first block reused (HIT)");
    assert.match(host.children[1].textContent, /BETA changed/);
    assert.equal(host.children[2], gammaP, "tail block reused (HIT)");
  });

  it("truncates host when block count shrinks", () => {
    mod.updateMarkdownStream(host, "a\n\nb\n\nc\n");
    assert.equal(host.children.length, 3);
    mod.updateMarkdownStream(host, "a\n\nb\n");
    assert.equal(host.children.length, 2);
    assert.match(host.children[1].textContent, /b/);
  });

  it("merges blocks while a fenced code block is open", () => {
    // Mid-stream: fence opened but not closed yet. The "intro" paragraph
    // and the partial fence get accumulated into one logical block so the
    // partial content does not flicker between two render shapes between
    // frames.
    mod.updateMarkdownStream(host, "intro\n\n```js\nconst x = 1;\n");
    // Now the fence closes and a real paragraph follows.
    mod.updateMarkdownStream(
      host,
      "intro\n\n```js\nconst x = 1;\n```\n\nafter\n",
    );
    assert.ok(host.querySelector("pre"), "closed fence renders to <pre>");
    assert.match(host.textContent, /after/);
  });

  it("dev-mode entry invariant fires when innerHTML is scribbled between calls", () => {
    mod.updateMarkdownStream(host, "para one\n\npara two\n");
    // Simulate a foreign code path (e.g. someone calling renderMd directly
    // on the same host, or some legacy flush) overwriting innerHTML without
    // calling resetMarkdownStream. Next update must throw.
    host.innerHTML = "<p>scribble</p>";
    assert.throws(
      () => {
        mod.updateMarkdownStream(host, "para one\n\npara two\nadded");
      },
      /entry invariant/,
      "scribble between calls must be caught at next entry",
    );
  });

  it("resetMarkdownStream clears the memo so the host can be reused", () => {
    mod.updateMarkdownStream(host, "para\n");
    host.innerHTML = "";
    mod.resetMarkdownStream(host);
    // No throw despite the host being scribbled — reset wipes the memo so
    // the next call sees a cold host.
    mod.updateMarkdownStream(host, "fresh\n");
    assert.match(host.textContent, /fresh/);
  });

  it("rejects async marked.parse (sync contract guard)", async () => {
    const { marked } = await import("marked");
    const origParse = marked.parse;
    const origParser = marked.parser;
    // Force async return — any future config flip (e.g. async extensions)
    // must announce itself loudly, not silently return Promises that we'd
    // pass to DOMPurify as `[object Promise]`. Stub both `parse` (used
    // for merged multi-token blocks) and `parser` (the opt #2 fast path
    // for single-token blocks) — either route must reject async output.
    marked.parse = (() =>
      Promise.resolve("<p>x</p>")) as unknown as typeof marked.parse;
    marked.parser = (() =>
      Promise.resolve("<p>x</p>")) as unknown as typeof marked.parser;
    try {
      const h2 = document.createElement("div");
      document.body.appendChild(h2);
      assert.throws(() => {
        mod.updateMarkdownStream(h2, "text");
      }, /requires sync marked/);
    } finally {
      marked.parse = origParse;
      marked.parser = origParser;
    }
  });
});
