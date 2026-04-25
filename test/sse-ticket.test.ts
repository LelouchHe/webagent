import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { TicketStore } from "../src/sse-ticket.ts";

describe("TicketStore", () => {
  let store: TicketStore;

  beforeEach(() => {
    store = new TicketStore({ ttlMs: 60_000 });
  });

  it("mints a ticket bound to principal", () => {
    const ticket = store.mint({ tokenName: "cli", scope: "admin" });
    assert.match(ticket, /^[A-Za-z0-9_-]{20,}$/);
  });

  it("mints unpredictable tickets", () => {
    const a = store.mint({ tokenName: "cli", scope: "admin" });
    const b = store.mint({ tokenName: "cli", scope: "admin" });
    assert.notEqual(a, b);
  });

  it("consume returns principal then deletes (single-use)", () => {
    const ticket = store.mint({ tokenName: "ui", scope: "api" });
    const first = store.consume(ticket);
    assert.deepEqual(first, { tokenName: "ui", scope: "api" });
    assert.equal(store.consume(ticket), null);
  });

  it("consume returns null for unknown ticket", () => {
    assert.equal(store.consume("nope"), null);
  });

  it("consume returns null after expiry", () => {
    const fakeNow = { t: 1_000_000 };
    const expiringStore = new TicketStore({ ttlMs: 60_000, now: () => fakeNow.t });
    const ticket = expiringStore.mint({ tokenName: "x", scope: "api" });
    fakeNow.t += 60_001;
    assert.equal(expiringStore.consume(ticket), null);
  });

  it("gc removes expired tickets", () => {
    const fakeNow = { t: 1_000_000 };
    const s = new TicketStore({ ttlMs: 60_000, now: () => fakeNow.t });
    const t1 = s.mint({ tokenName: "a", scope: "api" });
    fakeNow.t += 30_000;
    const t2 = s.mint({ tokenName: "b", scope: "api" });
    fakeNow.t += 31_000; // t1 expired, t2 still valid
    s.gc();
    assert.equal(s.consume(t1), null);
    assert.deepEqual(s.consume(t2), { tokenName: "b", scope: "api" });
  });
});
