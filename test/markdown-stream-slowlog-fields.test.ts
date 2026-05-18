// Slow-log field contract for streaming markdown.
//
// markdown-stream-cache.test.ts locks behavior (hit/miss counters);
// markdown-stream-equivalence.test.ts locks output (DOM byte-equal);
// THIS file locks the *observability surface* — the field set on
// MarkdownStreamTiming that the slow-log payload in events.ts depends on.
//
// Adding or removing a slow-log field without updating events.ts → silent
// data loss in production diagnostics. These assertions catch that
// drift mechanically.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";

type Mod = typeof import("../public/js/render-event.ts");

describe("markdown-stream slow-log field contract", () => {
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

  it("emits seq as 1-indexed per-host call count, monotonic", () => {
    mod.updateMarkdownStream(host, "first");
    assert.strictEqual(mod.getLastMarkdownStreamTiming().seq, 1);
    mod.updateMarkdownStream(host, "first second");
    assert.strictEqual(mod.getLastMarkdownStreamTiming().seq, 2);
    mod.updateMarkdownStream(host, "first second third");
    assert.strictEqual(mod.getLastMarkdownStreamTiming().seq, 3);

    // Different host → independent counter.
    const host2 = document.createElement("div");
    mod.updateMarkdownStream(host2, "fresh");
    assert.strictEqual(mod.getLastMarkdownStreamTiming().seq, 1);
  });

  it("prefixBlocks + prefixLen track cache reuse precisely", () => {
    const chunks = [
      "# A\n\n",
      "# A\n\nbody one\n\n",
      "# A\n\nbody one\n\nbody two",
    ];
    let acc = "";
    const snapshots: Array<{
      prefixBlocks: number;
      prefixLen: number;
      blocks: number;
    }> = [];
    for (const c of chunks) {
      acc += c;
      mod.updateMarkdownStream(host, acc);
      const t = mod.getLastMarkdownStreamTiming();
      snapshots.push({
        prefixBlocks: t.prefixBlocks,
        prefixLen: t.prefixLen,
        blocks: t.blocks,
      });
    }
    // Chunk 0: no prefix reuse (cold).
    assert.strictEqual(snapshots[0].prefixBlocks, 0);
    assert.strictEqual(snapshots[0].prefixLen, 0);
    // Chunk 1: at least the `# A` heading from chunk 0 should be stable
    // (the conservative "don't trust last cached block" rule may leave
    // prefixBlocks=0 if cache had 1 block; verify by chunk 2 where N≥2).
    // Chunk 2: cache has ≥2 blocks after chunk 1 → prefixBlocks ≥ 1, and
    // prefixLen must equal sum of raw lengths of those stable blocks.
    assert.ok(
      snapshots[2].prefixBlocks >= 1,
      `expected prefix reuse by chunk 2, got prefixBlocks=${snapshots[2].prefixBlocks}`,
    );
    assert.ok(
      snapshots[2].prefixLen > 0,
      `prefixBlocks=${snapshots[2].prefixBlocks} but prefixLen=${snapshots[2].prefixLen}`,
    );
    // Sanity: prefixBlocks ≤ blocks
    for (const s of snapshots) {
      assert.ok(
        s.prefixBlocks <= s.blocks,
        `prefixBlocks (${s.prefixBlocks}) > blocks (${s.blocks})`,
      );
    }
  });

  it("tailRawBlocks ≥ tailBlocks (merge is monotonic-decreasing)", () => {
    // Without any open fence / straddling HTML, raw == merged.
    mod.updateMarkdownStream(host, "para one\n\npara two\n\npara three");
    const t = mod.getLastMarkdownStreamTiming();
    assert.ok(
      t.tailRawBlocks >= t.tailBlocks,
      `tailRawBlocks (${t.tailRawBlocks}) must be ≥ tailBlocks (${t.tailBlocks})`,
    );
    // Plain paragraphs → no merge → equal.
    assert.strictEqual(t.tailRawBlocks, t.tailBlocks);
  });

  it("fastPath counter increments for single-token blocks (opt #2)", () => {
    // Cold render of 3 plain paragraphs — each is a single-token block,
    // so all 3 should go through marked.parser([token]) fast path.
    mod.updateMarkdownStream(host, "para one\n\npara two\n\npara three");
    const t = mod.getLastMarkdownStreamTiming();
    assert.ok(
      t.fastPath >= 3,
      `expected ≥3 fastPath hits for 3 single-token paragraphs, got ${t.fastPath}`,
    );
    // fastPath bounded by misses (every fastPath block is a miss block).
    assert.ok(
      t.fastPath <= t.misses,
      `fastPath (${t.fastPath}) > misses (${t.misses}) — impossible`,
    );
  });

  it("defsAbsorbed counts new reflink defs added to memo", () => {
    // Chunk 1: only def `[1]: ...` then a paragraph block referencing it.
    // After chunk 1: def is in cache prefix slot 0; defsAbsorbed should
    // record 1 (the new def absorbed into memo).
    mod.updateMarkdownStream(host, "[1]: https://a.example\n\nhello\n\nworld");
    const t1 = mod.getLastMarkdownStreamTiming();
    assert.ok(
      t1.defsAbsorbed >= 1,
      `expected ≥1 defsAbsorbed on first render with def, got ${t1.defsAbsorbed}`,
    );
    assert.ok(
      t1.linkMemoSize >= 1,
      `expected linkMemoSize ≥ 1 after absorbing def, got ${t1.linkMemoSize}`,
    );

    // Chunk 2: no new def → defsAbsorbed should be 0 this call.
    mod.updateMarkdownStream(
      host,
      "[1]: https://a.example\n\nhello\n\nworld more",
    );
    const t2 = mod.getLastMarkdownStreamTiming();
    assert.strictEqual(
      t2.defsAbsorbed,
      0,
      `expected 0 new defs on second chunk, got ${t2.defsAbsorbed}`,
    );
    // Memo size persists.
    assert.ok(t2.linkMemoSize >= 1);
  });

  it("subList.hits/misses replaces aggregate subHits/subMisses for lists", () => {
    mod.updateMarkdownStream(host, "- a\n- b\n- c");
    mod.updateMarkdownStream(host, "- a\n- b\n- c\n- d");
    const t = mod.getLastMarkdownStreamTiming();
    assert.ok(
      typeof t.subList === "object" && t.subList !== null,
      "subList must be present",
    );
    assert.strictEqual(typeof t.subList.hits, "number");
    assert.strictEqual(typeof t.subList.misses, "number");
    assert.ok(
      t.subList.hits >= 3,
      `expected ≥3 subList.hits after appending one item to 3-item list, got ${t.subList.hits}`,
    );
    // Table breakdown exists but is unused this case.
    assert.strictEqual(t.subTable.hits, 0);
    assert.strictEqual(t.subTable.misses, 0);
  });

  it("subTable.hits/misses tracks rows independently of subList", () => {
    const header = "| a | b |\n| --- | --- |\n";
    mod.updateMarkdownStream(host, header + "| 1 | 2 |");
    mod.updateMarkdownStream(host, header + "| 1 | 2 |\n| 3 | 4 |");
    const t = mod.getLastMarkdownStreamTiming();
    assert.ok(
      t.subTable.hits >= 1,
      `expected ≥1 subTable.hits, got ${t.subTable.hits}`,
    );
    assert.strictEqual(t.subList.hits, 0);
    assert.strictEqual(t.subList.misses, 0);
  });

  it("missDetails entries use full field names (parseMs/sanMs/domMs, not p/s/d)", () => {
    // This locks the in-memory shape that events.ts maps to log JSON.
    // The slow-log JSON itself is asserted in events.test.ts but the
    // timing-struct contract lives here.
    mod.updateMarkdownStream(host, "para one\n\npara two");
    const t = mod.getLastMarkdownStreamTiming();
    assert.ok(
      t.missDetails.length > 0,
      "expected ≥1 missDetail for cold render",
    );
    const m = t.missDetails[0];
    for (const key of [
      "type",
      "len",
      "snip",
      "parseMs",
      "sanMs",
      "domMs",
      "path",
    ]) {
      assert.ok(key in m, `missDetails entry missing '${key}'`);
    }
    // Single-letter aliases must NOT appear on the in-memory struct
    // (they only existed as a compaction in events.ts before).
    assert.ok(!("p" in m), "missDetails entry must not have 'p' shorthand");
    assert.ok(!("s" in m), "missDetails entry must not have 's' shorthand");
    assert.ok(!("d" in m), "missDetails entry must not have 'd' shorthand");
  });
});
