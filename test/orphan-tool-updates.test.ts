import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OrphanToolUpdateCache } from "../public/js/orphan-tool-updates.ts";
import type { AgentEvent } from "../src/types.ts";

type ToolUpdate = Extract<AgentEvent, { type: "tool_call_update" }>;

const update = (id: string, text: string): ToolUpdate => ({
  type: "tool_call_update",
  taskId: "s1",
  id,
  status: "in_progress",
  content: [{ type: "content", content: { text } }],
});

describe("OrphanToolUpdateCache", () => {
  it("merges patches by field presence and consumes once", () => {
    let now = 0;
    const cache = new OrphanToolUpdateCache({ now: () => now });
    cache.put(update("tc-1", "partial"));
    now = 10;
    cache.put({
      type: "tool_call_update",
      taskId: "s1",
      id: "tc-1",
      status: "completed",
    });

    const merged = cache.take("tc-1");
    assert.ok(merged);
    assert.equal(merged.status, "completed");
    assert.equal(merged.content?.[0]?.type, "content");
    assert.equal(cache.take("tc-1"), null);
  });

  it("replaces cumulative content instead of appending snapshots", () => {
    const cache = new OrphanToolUpdateCache();
    cache.put(update("tc-1", "first snapshot"));
    cache.put(update("tc-1", "second snapshot"));

    const merged = cache.take("tc-1");
    assert.ok(merged);
    assert.equal(merged.content?.length, 1);
    assert.equal(
      (merged.content[0].content as { text?: string } | undefined)?.text,
      "second snapshot",
    );
  });

  it("reports buffered ids via has() until recovered, merged, or cleared", () => {
    let now = 0;
    const cache = new OrphanToolUpdateCache({ now: () => now });

    assert.equal(cache.has("tc-1"), false);
    cache.put(update("tc-1", "first"));
    assert.equal(cache.has("tc-1"), true);
    cache.put(update("tc-1", "second")); // merge keeps it buffered
    assert.equal(cache.has("tc-1"), true);
    assert.ok(cache.take("tc-1"));
    assert.equal(cache.has("tc-1"), false);

    cache.put(update("tc-2", "lost"));
    assert.equal(cache.has("tc-2"), true);
    now = 70_000; // past TTL
    assert.equal(cache.has("tc-2"), false); // pruned
  });

  it("warns on expiration only, once per id, never on take/merge/clear", () => {
    let now = 0;
    const expired: string[] = [];
    const cache = new OrphanToolUpdateCache({
      ttlMs: 60_000,
      now: () => now,
      onExpire: (id) => expired.push(id),
    });

    cache.put(update("tc-1", "first"));
    cache.put(update("tc-1", "second")); // merge: same episode, no expire
    now = 30_000;
    assert.ok(cache.take("tc-1")); // recovered: no expire
    assert.deepEqual(expired, []);

    cache.put(update("tc-2", "lost"));
    cache.clear(); // programmatic reset: no expire
    assert.deepEqual(expired, []);

    cache.put(update("tc-3", "pending"));
    now = 120_000; // past the 60s TTL with no host in between
    cache.put(update("tc-4", "unrelated")); // prune runs here
    assert.deepEqual(expired, ["tc-3"]);

    // tc-4 is put at 120s (expires 180s): recovered just under the TTL → no warn.
    now = 179_999;
    assert.ok(cache.take("tc-4"));
    assert.deepEqual(expired, ["tc-3"]);

    // A fresh episode for the same id that also never recovers expires again.
    now = 180_000;
    cache.put(update("tc-3", "pending again")); // prunes nothing (tc-4 consumed)
    assert.deepEqual(expired, ["tc-3"]);
    now = 240_000;
    cache.put(update("tc-5", "unrelated")); // prunes tc-3's second episode
    assert.deepEqual(expired, ["tc-3", "tc-3"]);
  });

  it("does not let an older replay patch overwrite a newer terminal", () => {
    const cache = new OrphanToolUpdateCache();
    cache.put(
      {
        type: "tool_call_update",
        taskId: "s1",
        id: "tc-1",
        status: "completed",
        content: [{ type: "content", content: { text: "final" } }],
      },
      300,
    );
    cache.put(update("tc-1", "old progress"), 200);

    const merged = cache.take("tc-1");
    assert.ok(merged);
    assert.equal(merged.status, "completed");
    assert.equal(
      (merged.content?.[0].content as { text?: string } | undefined)?.text,
      "final",
    );
  });

  it("expires entries opportunistically without timers", () => {
    let now = 0;
    const cache = new OrphanToolUpdateCache({ now: () => now, ttlMs: 60_000 });
    cache.put(update("tc-old", "old"));
    now = 60_001;

    assert.equal(cache.take("tc-old"), null);
  });

  it("evicts the oldest id at capacity", () => {
    const cache = new OrphanToolUpdateCache({ maxIds: 2 });
    cache.put(update("tc-1", "one"));
    cache.put(update("tc-2", "two"));
    cache.put(update("tc-3", "three"));

    assert.equal(cache.take("tc-1"), null);
    assert.equal(cache.take("tc-3")?.id, "tc-3");
  });

  it("rejects oversized entries and clears retained state", () => {
    const cache = new OrphanToolUpdateCache({
      maxEntryBytes: 64,
      maxTotalBytes: 128,
    });
    cache.put(update("tc-large", "x".repeat(1000)));
    assert.equal(cache.take("tc-large"), null);

    cache.put(update("tc-small", "ok"));
    cache.clear();
    assert.equal(cache.take("tc-small"), null);
  });
});
