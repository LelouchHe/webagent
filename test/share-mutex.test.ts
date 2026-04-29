import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  withSessionLock,
  __clearAllLocks,
  __locksSize,
} from "../src/share/mutex.ts";

describe("withSessionLock — per-key async mutex", () => {
  beforeEach(() => {
    __clearAllLocks();
  });

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
      () =>
        withSessionLock("k1", async () => {
          throw new Error("boom");
        }),
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
