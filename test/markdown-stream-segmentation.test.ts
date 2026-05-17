// Performance contract: `mergeUnclosedBlocks` must not collapse separately-
// closeable blocks into one merged block just because:
//   (1) a fenced code block contained literal unclosed HTML, or
//   (2) a paragraph mentioned literal triple-backticks (e.g. LLM teaching
//       speech "use ``` to open a fenced code block").
//
// Why this is a *performance* contract, not a correctness one: the merged
// path renders via `marked.parse(raw)` which produces byte-equal HTML to
// the un-merged path. So `markdown-stream-equivalence.test.ts` cannot
// catch this. The damage is invisible to byte-equal but real: every
// subsequent chunk re-renders the merged big block end-to-end (the merge
// poisons the tag-stack so the segmentation never closes), turning what
// should be O(1) per chunk into O(tail-length). On iOS Safari with a
// 2-3KB tail this is 16ms+ per chunk.
//
// We assert segmentation via `timing.blocks` (the post-merge block count)
// rather than `host.children.length`. The merged-render path emits N <p>
// elements from one merged raw, so child count is not a reliable signal.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";

describe("mergeUnclosedBlocks segmentation contract", () => {
  let mod: typeof import("../public/js/markdown-stream.ts");
  let host: HTMLElement;

  before(async () => {
    setupDOM();
    mod = await import("../public/js/markdown-stream.ts");
  });
  after(() => {
    teardownDOM();
  });
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  // Each fixture asserts EXACT block count (per verdict F6). A loose
  // lower bound like `>= 3` would silently accept partial poisoning where
  // only some subsequent blocks collapse. Note: marked emits `space`
  // tokens between content blocks (one per blank-line separator), each
  // of which mergeUnclosedBlocks emits as its own block — so a "code +
  // 2 paragraphs" input becomes 5 blocks (code, space, para, space, para)
  // when segmentation is healthy.
  const fixtures: { name: string; text: string; expectedBlocks: number }[] = [
    {
      name: "closed fenced code with unclosed <div> inside does not poison tag-stack",
      text: "```html\n<div>\nstuff inside\n```\n\npara one\n\npara two\n",
      expectedBlocks: 5,
    },
    {
      name: "closed fenced code with <my-widget/> self-closing inside does not poison",
      text: "```html\n<my-widget/>\n```\n\npara one\n\npara two\n",
      expectedBlocks: 5,
    },
    {
      name: "two closed fenced code blocks each containing unclosed HTML do not poison",
      text: "```html\n<div>\n```\n\nmiddle\n\n```html\n<span>\n```\n\nafter\n",
      expectedBlocks: 7,
    },
    {
      name: "paragraph mentioning literal triple-backtick (LLM teaching speech) does not flip fence state",
      text: "Use ``` to start a fenced code block.\n\npara one\n\npara two\n",
      expectedBlocks: 5,
    },
  ];

  for (const f of fixtures) {
    it(`${f.name} → ${f.expectedBlocks} blocks`, () => {
      mod.updateMarkdownStream(host, f.text);
      const t = mod.getLastMarkdownStreamTiming();
      assert.equal(
        t.blocks,
        f.expectedBlocks,
        `${f.name}: expected ${f.expectedBlocks} blocks, got ${t.blocks}`,
      );
    });
  }
});
