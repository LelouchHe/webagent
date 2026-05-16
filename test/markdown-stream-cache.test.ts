// Cache-hit regression tests for the streaming markdown renderer.
//
// These are NOT wall-clock benchmarks — wall-clock varies wildly across
// CI runners and goes flaky → disabled → silently regresses. Instead we
// assert on the *internal counters* exposed by getLastMarkdownStreamTiming():
// prefix-cache hits, block-memo hits/misses, and container sub-memo
// hits/misses. Any future refactor that breaks cache-key stability or
// memo dispatch will fail loudly here, even if it still "happens to run
// fast" on the developer's machine.
//
// Layered cache contract being locked in (see docs/performance.md):
//   1. Prefix lex cache — lex.prefix == stable-block count, lex.tail == 1
//   2. Per-block memo   — hits == blocks-1 on every chunk after warm-up
//   3. Sub-block memo   — subHits grows monotonically; subMisses ≤ 1/chunk
//   4. Cold→warm        — second render of same text = full hit, zero miss
//
// This test file lives next to markdown-stream-equivalence.test.ts: that
// file locks output correctness; this one locks cache effectiveness.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";

type Mod = typeof import("../public/js/render-event.ts");

interface ChunkStat {
  blocks: number;
  hits: number;
  misses: number;
  lexPrefix: number; // lexed-prefix block count, NOT ms
  lexTail: number; // lexed-tail block count
  tailLen: number;
  subHits: number;
  subMisses: number;
}

describe("markdown-stream cache-hit regression", () => {
  let mod: Mod;
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
  });

  // The `lexPrefix` / `lexTail` fields on MarkdownStreamTiming store *ms*,
  // not counts. The block counts we want are `tailBlocks` (lexed-tail block
  // count) and `blocks - tailBlocks` (cache-prefix block count). Wrap so
  // every test gets the same shape.
  function snap(): ChunkStat {
    const t = mod.getLastMarkdownStreamTiming();
    return {
      blocks: t.blocks,
      hits: t.hits,
      misses: t.misses,
      lexPrefix: t.blocks - t.tailBlocks,
      lexTail: t.tailBlocks,
      tailLen: t.tailLen,
      subHits: t.subHits,
      subMisses: t.subMisses,
    };
  }

  // Drive a sequence of growing prefixes through updateMarkdownStream
  // and capture per-chunk stats. Returns one ChunkStat per chunk.
  function driveChunks(target: HTMLElement, chunks: string[]): ChunkStat[] {
    const stats: ChunkStat[] = [];
    let acc = "";
    for (const c of chunks) {
      acc += c;
      mod.updateMarkdownStream(target, acc);
      stats.push(snap());
    }
    return stats;
  }

  it("prefix-cache: stable blocks lex only once, tail re-lexes", () => {
    // 5 stable paragraphs, then a 6th paragraph grows char-by-char.
    const stable =
      "para one.\n\npara two.\n\npara three.\n\npara four.\n\npara five.\n\n";
    const tail = "growing tail text here.";
    const chunks = [stable];
    for (const ch of tail) chunks.push(ch);

    const stats = driveChunks(host, chunks);

    // After the first chunk, the 5 stable paragraphs become cache prefix.
    // `incrementalLex` deliberately drops the LAST stable cache block before
    // re-lexing, so the tail re-lex covers (last-stable + growing) = 2 blocks
    // — the last-stable is still a cache HIT at the per-block memo layer
    // because its raw is identical. So the per-chunk tail is bounded at 2.
    for (let i = 1; i < stats.length; i++) {
      const s = stats[i];
      assert.ok(
        s.lexPrefix >= 4,
        `chunk ${i}: expected ≥4 prefix-cached blocks, got ${s.lexPrefix} (tail=${s.lexTail})`,
      );
      assert.ok(
        s.lexTail <= 2,
        `chunk ${i}: tail re-lex should cover ≤2 blocks (last-stable + growing), got ${s.lexTail}`,
      );
    }
  });

  it("block-memo: stable blocks HIT on every chunk after warm-up", () => {
    const stable =
      "alpha.\n\nbeta.\n\ngamma.\n\n```js\nconst x=1;\n```\n\ndelta.\n\n";
    const tail = "epsilon growing tail.";
    const chunks = [stable];
    for (const ch of tail) chunks.push(ch);

    const stats = driveChunks(host, chunks);

    // From chunk 1 onward, every stable block is a HIT and exactly one
    // tail block is the MISS (the growing paragraph).
    for (let i = 1; i < stats.length; i++) {
      const s = stats[i];
      assert.equal(
        s.misses,
        1,
        `chunk ${i}: expected exactly 1 miss (the growing block), got ${s.misses}`,
      );
      assert.equal(
        s.hits,
        s.blocks - 1,
        `chunk ${i}: expected ${s.blocks - 1} hits, got ${s.hits}`,
      );
    }
  });

  it("list sub-memo: appending items keeps subHits monotonic, subMisses bounded", () => {
    // Build a list one item at a time. Each new item should be a
    // sub-memo MISS; all previously-stabilized items should be sub-HITs.
    //
    // marked quirk: when item N gains a successor, its raw gains a
    // trailing "\n" (e.g. "- item N" → "- item N\n"). So each append
    // invalidates TWO sub-memo entries: the newly-appended item AND the
    // previously-last item whose raw just changed. Items 1..N-2 are
    // stable.
    const items = Array.from(
      { length: 15 },
      (_, i) => `- item ${i + 1} with **emphasis**`,
    );
    const chunks: string[] = [];
    for (let i = 0; i < items.length; i++) {
      chunks.push((i === 0 ? "" : "\n") + items[i]);
    }

    const stats = driveChunks(host, chunks);

    let lastSubHits = -1;
    for (let i = 1; i < stats.length; i++) {
      const s = stats[i];
      assert.ok(
        s.subHits >= lastSubHits,
        `chunk ${i}: subHits regressed (${lastSubHits} → ${s.subHits})`,
      );
      lastSubHits = s.subHits;

      // ≤2: newly-appended item + previously-last item (trailing-newline flip).
      assert.ok(
        s.subMisses <= 2,
        `chunk ${i}: expected ≤2 sub-misses, got ${s.subMisses}`,
      );

      // After several items have been rendered, subHits must be > 0
      // — confirming items 1..N-2 are being reused, not re-rendered.
      if (i >= 5) {
        assert.ok(
          s.subHits > 0,
          `chunk ${i}: expected sub-memo to reuse prior items, subHits=${s.subHits}`,
        );
      }
    }

    // Final chunk: 13 of 15 items must be sub-cached (15 - 2 churn).
    const final = stats[stats.length - 1];
    assert.ok(
      final.subHits >= 12,
      `final chunk: expected ≥12 sub-hits across 15 items, got ${final.subHits}`,
    );
  });

  it("table sub-memo: appending rows keeps subHits monotonic, subMisses bounded", () => {
    // GFM table header + delim + 12 data rows, streamed row-by-row.
    const header = "| a | b |\n| --- | --- |\n";
    const rows = Array.from({ length: 12 }, (_, i) => `| ${i} | x${i} |`);
    const chunks: string[] = [header + rows[0]];
    for (let i = 1; i < rows.length; i++) chunks.push("\n" + rows[i]);

    const stats = driveChunks(host, chunks);

    let lastSubHits = -1;
    for (let i = 1; i < stats.length; i++) {
      const s = stats[i];
      assert.ok(
        s.subHits >= lastSubHits,
        `chunk ${i}: table subHits regressed (${lastSubHits} → ${s.subHits})`,
      );
      lastSubHits = s.subHits;
      assert.ok(
        s.subMisses <= 1,
        `chunk ${i}: expected ≤1 table sub-miss, got ${s.subMisses}`,
      );
    }

    const final = stats[stats.length - 1];
    assert.ok(
      final.subHits >= 10,
      `final chunk: expected ≥10 row sub-hits across 12 rows, got ${final.subHits}`,
    );
  });

  it("cold→warm: re-rendering identical text yields zero miss", () => {
    const text =
      "# Heading\n\nFirst paragraph with `code`.\n\n" +
      "```js\nconst x = 1;\n```\n\n" +
      "- one\n- two\n- three\n\n" +
      "| a | b |\n| --- | --- |\n| 1 | 2 |\n";

    // First render: cold cache, expect some misses.
    mod.updateMarkdownStream(host, text);
    const cold = snap();
    assert.ok(cold.misses > 0, "cold render should have misses");

    // Second render of the IDENTICAL text on the SAME host: every block
    // is a cache hit. Zero parse / sanitize / DOM work. Note: the last
    // cache block always re-lexes (incrementalLex drops it to allow
    // growing-tail cases), but the re-lex output is identical → block
    // memo HIT → zero misses.
    mod.updateMarkdownStream(host, text);
    const warm = snap();
    assert.equal(
      warm.misses,
      0,
      `warm render must have zero misses, got ${warm.misses}`,
    );
    assert.equal(
      warm.hits,
      warm.blocks,
      `warm render: all ${warm.blocks} blocks must be HITs, got hits=${warm.hits}`,
    );
  });
});
