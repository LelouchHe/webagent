/**
 * Tests for the new visibility API on ClientRegistry (Plan C, Step 1).
 *
 * Semantics intentionally mirror PushService.updateClient so the
 * /visibility handler can double-write to both during the migration
 * window and observe identical behavior.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { ClientRegistry } from "../src/client-registry.ts";

function newClock(start = 1_000_000): {
  now: () => number;
  tick: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

describe("ClientRegistry declarative visibility", () => {
  it("register initializes empty visibleTaskIds, lastVisibilityRev=0, visibleSince=0", () => {
    const r = new ClientRegistry();
    const e = r.register("c1", { capabilities: [] });
    assert.equal(e.visibleTaskIds.size, 0);
    assert.equal(e.lastVisibilityRev, 0);
    assert.equal(e.visibleSince, 0);
  });

  it("setVisibility on unknown client is no-op (no throw, no entry created)", () => {
    const r = new ClientRegistry();
    const result = r.setVisibility("ghost", ["s1"], 1);
    assert.equal(result.applied, false);
    assert.deepEqual(result.newlyVisibleTaskIds, []);
    assert.equal(r.get("ghost"), undefined);
  });

  it("setVisibility non-empty stamps visibleSince and empty resets visibleSince to 0", () => {
    const clock = newClock(50_000);
    const r = new ClientRegistry({ now: clock.now });
    r.register("c1", { capabilities: [] });
    r.setVisibility("c1", ["sA"], 1);
    assert.equal(r.get("c1")!.visibleSince, 50_000);
    assert.equal(r.isVisibleForTask("c1", "sA"), true);

    r.setVisibility("c1", [], 2);
    assert.equal(r.get("c1")!.visibleSince, 0);
    assert.equal(r.isVisibleForTask("c1", "sA"), false);
  });

  it("setVisibility enforces monotonic X-Visibility-Rev (ignores stale or equal rev)", () => {
    const r = new ClientRegistry();
    r.register("c1", { capabilities: [] });
    const first = r.setVisibility("c1", ["sA"], 5);
    assert.equal(first.applied, true);
    assert.deepEqual(first.newlyVisibleTaskIds, ["sA"]);

    const stale = r.setVisibility("c1", ["sB"], 4);
    assert.equal(stale.applied, false);
    assert.deepEqual(stale.newlyVisibleTaskIds, []);
    assert.equal(r.isVisibleForTask("c1", "sA"), true);
    assert.equal(r.isVisibleForTask("c1", "sB"), false);

    const dup = r.setVisibility("c1", ["sB"], 5);
    assert.equal(dup.applied, false);
    assert.equal(r.isVisibleForTask("c1", "sA"), true);
  });

  it("newlyVisibleTaskIds only reports newly added tasks (heartbeat refresh returns empty)", () => {
    const r = new ClientRegistry();
    r.register("c1", { capabilities: [] });
    const initial = r.setVisibility("c1", ["sA"], 1);
    assert.deepEqual(initial.newlyVisibleTaskIds, ["sA"]);

    const refresh = r.setVisibility("c1", ["sA"], 2);
    assert.equal(refresh.applied, true);
    assert.deepEqual(refresh.newlyVisibleTaskIds, []);

    const addSecond = r.setVisibility("c1", ["sA", "sB"], 3);
    assert.deepEqual(addSecond.newlyVisibleTaskIds, ["sB"]);

    const hide = r.setVisibility("c1", [], 4);
    assert.deepEqual(hide.newlyVisibleTaskIds, []);
  });

  it("isVisibleForTask and isTaskVisibleToAnyClient honor TTL expiry", () => {
    const clock = newClock(0);
    const r = new ClientRegistry({ now: clock.now, visibilityTtlMs: 60_000 });
    r.register("c1", { capabilities: [] });
    r.register("c2", { capabilities: [] });
    r.setVisibility("c1", ["sA"], 1);
    r.setVisibility("c2", ["sB"], 1);

    assert.equal(r.isVisibleForTask("c1", "sA"), true);
    assert.equal(r.isVisibleForTask("c1", "sB"), false);
    assert.equal(r.isTaskVisibleToAnyClient("sA"), true);
    assert.equal(r.isTaskVisibleToAnyClient("sB"), true);
    assert.equal(r.isTaskVisibleToAnyClient("sZ"), false);
    assert.equal(r.hasAnyVisibleClient(), true);

    clock.tick(60_001);
    assert.equal(r.isVisibleForTask("c1", "sA"), false);
    assert.equal(r.isTaskVisibleToAnyClient("sA"), false);
    assert.equal(r.hasAnyVisibleClient(), false);
  });

  it("remove drops visibility along with the entry", () => {
    const r = new ClientRegistry();
    r.register("c1", { capabilities: [] });
    r.setVisibility("c1", ["sA"], 1);
    r.remove("c1");
    assert.equal(r.hasAnyVisibleClient(), false);
    assert.equal(r.isTaskVisibleToAnyClient("sA"), false);
  });
});
