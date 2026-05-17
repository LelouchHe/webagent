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

describe("ClientRegistry visibility (Plan C Step 1)", () => {
  it("register initializes visible=false, active=null, visibleSince=0", () => {
    const r = new ClientRegistry();
    const e = r.register("c1", { capabilities: [] });
    assert.equal(e.visible, false);
    assert.equal(e.active, null);
    assert.equal(e.visibleSince, 0);
  });

  it("setVisibility on unknown client is no-op (no throw, no entry created)", () => {
    const r = new ClientRegistry();
    const result = r.setVisibility("ghost", { visible: true, active: "s1" });
    assert.equal(result.becameVisibleFor, null);
    assert.equal(r.get("ghost"), undefined);
  });

  it("setVisibility { visible:true } stamps visibleSince from injected now()", () => {
    const clock = newClock(50_000);
    const r = new ClientRegistry({ now: clock.now });
    r.register("c1", { capabilities: [] });
    r.setVisibility("c1", { visible: true });
    const e = r.get("c1")!;
    assert.equal(e.visible, true);
    assert.equal(e.visibleSince, 50_000);
  });

  it("setVisibility { visible:false } resets visibleSince to 0", () => {
    const clock = newClock();
    const r = new ClientRegistry({ now: clock.now });
    r.register("c1", { capabilities: [] });
    r.setVisibility("c1", { visible: true });
    r.setVisibility("c1", { visible: false });
    const e = r.get("c1")!;
    assert.equal(e.visible, false);
    assert.equal(e.visibleSince, 0);
  });

  it("setVisibility omitting active preserves; null clears; string replaces", () => {
    const r = new ClientRegistry();
    r.register("c1", { capabilities: [] });
    r.setVisibility("c1", { visible: true, active: "sA" });
    assert.equal(r.get("c1")!.active, "sA");

    // omit active — preserve
    r.setVisibility("c1", { visible: true });
    assert.equal(r.get("c1")!.active, "sA");

    // explicit null — clear
    r.setVisibility("c1", { visible: true, active: null });
    assert.equal(r.get("c1")!.active, null);

    // replace
    r.setVisibility("c1", { visible: true, active: "sB" });
    assert.equal(r.get("c1")!.active, "sB");
  });

  it("becameVisibleFor: invisible/no-session → visible+session returns the session", () => {
    const r = new ClientRegistry();
    r.register("c1", { capabilities: [] });
    const result = r.setVisibility("c1", { visible: true, active: "sA" });
    assert.equal(result.becameVisibleFor, "sA");
  });

  it("becameVisibleFor: heartbeat refresh (same visible+session) returns null", () => {
    const r = new ClientRegistry();
    r.register("c1", { capabilities: [] });
    r.setVisibility("c1", { visible: true, active: "sA" });
    const refresh = r.setVisibility("c1", { visible: true, active: "sA" });
    assert.equal(refresh.becameVisibleFor, null);
  });

  it("becameVisibleFor: session switch while visible (sA → sB) returns sB", () => {
    const r = new ClientRegistry();
    r.register("c1", { capabilities: [] });
    r.setVisibility("c1", { visible: true, active: "sA" });
    const sw = r.setVisibility("c1", { visible: true, active: "sB" });
    assert.equal(sw.becameVisibleFor, "sB");
  });

  it("becameVisibleFor: visible:true patch-only after session change still resets TTL", () => {
    // Mirrors push-service: when the only thing that changed is sessionId
    // (without an explicit visible field), TTL must reset so the new session
    // doesn't inherit the old session's staleness clock.
    const clock = newClock(1000);
    const r = new ClientRegistry({ now: clock.now });
    r.register("c1", { capabilities: [] });
    r.setVisibility("c1", { visible: true, active: "sA" });
    assert.equal(r.get("c1")!.visibleSince, 1000);

    clock.tick(5_000);
    const sw = r.setVisibility("c1", { active: "sB" }); // sessionId-only patch
    assert.equal(sw.becameVisibleFor, "sB");
    assert.equal(r.get("c1")!.visibleSince, 6_000);
  });

  it("becameVisibleFor: visible:false transition returns null", () => {
    const r = new ClientRegistry();
    r.register("c1", { capabilities: [] });
    r.setVisibility("c1", { visible: true, active: "sA" });
    const hide = r.setVisibility("c1", { visible: false });
    assert.equal(hide.becameVisibleFor, null);
  });

  it("isVisibleForSession: true iff visible && active===sid && within TTL", () => {
    const clock = newClock();
    const r = new ClientRegistry({ now: clock.now, visibilityTtlMs: 60_000 });
    r.register("c1", { capabilities: [] });

    assert.equal(r.isVisibleForSession("c1", "sA"), false);

    r.setVisibility("c1", { visible: true, active: "sA" });
    assert.equal(r.isVisibleForSession("c1", "sA"), true);
    assert.equal(r.isVisibleForSession("c1", "sB"), false);

    r.setVisibility("c1", { visible: false });
    assert.equal(r.isVisibleForSession("c1", "sA"), false);
  });

  it("isVisibleForSession: false after TTL elapsed even if visible flag still true", () => {
    const clock = newClock(0);
    const r = new ClientRegistry({ now: clock.now, visibilityTtlMs: 60_000 });
    r.register("c1", { capabilities: [] });
    r.setVisibility("c1", { visible: true, active: "sA" });
    assert.equal(r.isVisibleForSession("c1", "sA"), true);

    clock.tick(60_001);
    assert.equal(r.isVisibleForSession("c1", "sA"), false);
  });

  it("isVisibleForSession: unknown client → false", () => {
    const r = new ClientRegistry();
    assert.equal(r.isVisibleForSession("ghost", "sA"), false);
  });

  it("isSessionVisibleToAnyClient: any fresh visible client matching", () => {
    const r = new ClientRegistry();
    r.register("c1", { capabilities: [] });
    r.register("c2", { capabilities: [] });
    r.setVisibility("c1", { visible: true, active: "sA" });
    r.setVisibility("c2", { visible: true, active: "sB" });

    assert.equal(r.isSessionVisibleToAnyClient("sA"), true);
    assert.equal(r.isSessionVisibleToAnyClient("sB"), true);
    assert.equal(r.isSessionVisibleToAnyClient("sZ"), false);
  });

  it("isSessionVisibleToAnyClient: ignores stale records past TTL", () => {
    const clock = newClock(0);
    const r = new ClientRegistry({ now: clock.now, visibilityTtlMs: 60_000 });
    r.register("c1", { capabilities: [] });
    r.setVisibility("c1", { visible: true, active: "sA" });
    assert.equal(r.isSessionVisibleToAnyClient("sA"), true);

    clock.tick(60_001);
    assert.equal(r.isSessionVisibleToAnyClient("sA"), false);
  });

  it("hasAnyVisibleClient: true iff at least one fresh visible client", () => {
    const clock = newClock(0);
    const r = new ClientRegistry({ now: clock.now, visibilityTtlMs: 60_000 });
    assert.equal(r.hasAnyVisibleClient(), false);

    r.register("c1", { capabilities: [] });
    assert.equal(r.hasAnyVisibleClient(), false);

    r.setVisibility("c1", { visible: true, active: null });
    assert.equal(r.hasAnyVisibleClient(), true);

    clock.tick(60_001);
    assert.equal(r.hasAnyVisibleClient(), false);
  });

  it("remove drops visibility along with the entry", () => {
    const r = new ClientRegistry();
    r.register("c1", { capabilities: [] });
    r.setVisibility("c1", { visible: true, active: "sA" });
    r.remove("c1");
    assert.equal(r.hasAnyVisibleClient(), false);
    assert.equal(r.isSessionVisibleToAnyClient("sA"), false);
  });
});
