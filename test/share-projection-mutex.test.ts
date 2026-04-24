import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getOrComputeProjection,
  clearProjectionCache,
  projectionCacheSize,
  configureProjectionCache,
} from "../src/share/projection.ts";
import { withSessionLock, __clearAllLocks, __locksSize } from "../src/share/mutex.ts";

describe("projection LRU cache", () => {
  beforeEach(() => {
    clearProjectionCache();
    configureProjectionCache({ capacity: 100 });
  });

  const baseCtx = { cwd: "/tmp", homeDir: "/home", internalHosts: [] };

  it("first call computes, second call hits cache", () => {
    const events = [{ seq: 1, type: "assistant_message", data: { text: "x" } }];
    const r1 = getOrComputeProjection({ sessionId: "s1", events, ...baseCtx });
    assert.equal(r1.cacheHit, false);
    const r2 = getOrComputeProjection({ sessionId: "s1", events, ...baseCtx });
    assert.equal(r2.cacheHit, true);
    assert.deepEqual(r2.events, r1.events);
  });

  it("different sessionId creates different cache entry", () => {
    const events = [{ seq: 1, type: "assistant_message", data: { text: "y" } }];
    getOrComputeProjection({ sessionId: "s1", events, ...baseCtx });
    const r2 = getOrComputeProjection({ sessionId: "s2", events, ...baseCtx });
    assert.equal(r2.cacheHit, false);
  });

  it("different event content bypasses cache", () => {
    getOrComputeProjection({
      sessionId: "s1",
      events: [{ seq: 1, type: "assistant_message", data: { text: "a" } }],
      ...baseCtx,
    });
    const r2 = getOrComputeProjection({
      sessionId: "s1",
      events: [{ seq: 1, type: "assistant_message", data: { text: "b" } }],
      ...baseCtx,
    });
    assert.equal(r2.cacheHit, false);
  });

  it("evicts oldest when capacity reached", () => {
    configureProjectionCache({ capacity: 3 });
    for (let i = 0; i < 5; i++) {
      getOrComputeProjection({
        sessionId: `s${i}`,
        events: [{ seq: 1, type: "assistant_message", data: { text: String(i) } }],
        ...baseCtx,
      });
    }
    assert.equal(projectionCacheSize(), 3);
    // s0 and s1 should be evicted; s2-s4 present.
    const r0 = getOrComputeProjection({
      sessionId: "s0",
      events: [{ seq: 1, type: "assistant_message", data: { text: "0" } }],
      ...baseCtx,
    });
    assert.equal(r0.cacheHit, false);
  });

  it("re-accessing an entry moves it to MRU position", () => {
    configureProjectionCache({ capacity: 3 });
    for (let i = 0; i < 3; i++) {
      getOrComputeProjection({
        sessionId: `s${i}`,
        events: [{ seq: 1, type: "assistant_message", data: { text: String(i) } }],
        ...baseCtx,
      });
    }
    // Re-access s0 → it becomes MRU.
    getOrComputeProjection({
      sessionId: "s0",
      events: [{ seq: 1, type: "assistant_message", data: { text: "0" } }],
      ...baseCtx,
    });
    // Now add s3, should evict s1 (oldest), not s0.
    getOrComputeProjection({
      sessionId: "s3",
      events: [{ seq: 1, type: "assistant_message", data: { text: "3" } }],
      ...baseCtx,
    });
    const r0 = getOrComputeProjection({
      sessionId: "s0",
      events: [{ seq: 1, type: "assistant_message", data: { text: "0" } }],
      ...baseCtx,
    });
    assert.equal(r0.cacheHit, true, "s0 should still be cached (was MRU-refreshed)");
    const r1 = getOrComputeProjection({
      sessionId: "s1",
      events: [{ seq: 1, type: "assistant_message", data: { text: "1" } }],
      ...baseCtx,
    });
    assert.equal(r1.cacheHit, false, "s1 should have been evicted");
  });

  it("sanitizer applied to result (rewrites cwd)", () => {
    const out = getOrComputeProjection({
      sessionId: "s1",
      events: [{ seq: 1, type: "assistant_message", data: { text: "cd /Users/alice/proj" } }],
      cwd: "/Users/alice/proj",
      homeDir: "/Users/alice",
      internalHosts: [],
    });
    assert.equal((out.events[0].data.text as string), "cd <cwd>");
  });
});

describe("withSessionLock — per-key async mutex", () => {
  beforeEach(() => __clearAllLocks());

  it("serializes callers with the same key", async () => {
    const order: string[] = [];
    const p1 = withSessionLock("k1", async () => {
      order.push("a:start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("a:end");
    });
    const p2 = withSessionLock("k1", async () => {
      order.push("b:start");
      order.push("b:end");
    });
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
  });

  it("parallelizes different keys", async () => {
    const order: string[] = [];
    const p1 = withSessionLock("k1", async () => {
      order.push("a:start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a:end");
    });
    // Start later but finishes first because different key.
    await new Promise((r) => setTimeout(r, 5));
    const p2 = withSessionLock("k2", async () => {
      order.push("b:start");
      order.push("b:end");
    });
    await Promise.all([p1, p2]);
    // b should finish before a:end (different key = no blocking).
    assert.deepEqual(order, ["a:start", "b:start", "b:end", "a:end"]);
  });

  it("propagates exceptions without wedging the lock", async () => {
    await assert.rejects(
      () => withSessionLock("k1", async () => { throw new Error("boom"); }),
      /boom/,
    );
    // Subsequent acquirers still work.
    const r = await withSessionLock("k1", async () => "ok");
    assert.equal(r, "ok");
  });

  it("returns fn's value", async () => {
    const r = await withSessionLock("k1", async () => 42);
    assert.equal(r, 42);
  });

  it("cleans up Map entry after release (no leak)", async () => {
    __clearAllLocks();
    await withSessionLock("leak-k1", async () => {});
    await withSessionLock("leak-k2", async () => {});
    // Both entries must have been removed once each released.
    assert.equal(__locksSize(), 0);
  });

  it("cleans up after concurrent acquirers all drain", async () => {
    __clearAllLocks();
    await Promise.all([
      withSessionLock("leak-k", async () => {}),
      withSessionLock("leak-k", async () => {}),
      withSessionLock("leak-k", async () => {}),
    ]);
    assert.equal(__locksSize(), 0);
  });
});
