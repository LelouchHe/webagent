import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ObligationController,
  SILENCE_THRESHOLD_MS,
  type ObligationNotice,
  type TimerHandle,
} from "../src/obligation-controller.ts";

interface ScheduledTimer {
  at: number;
  fn: () => void;
  handle: TimerHandle;
}

function makeHarness() {
  let now = 1_000;
  const timers: ScheduledTimer[] = [];
  const reminders: string[] = [];
  const notices: ObligationNotice[] = [];
  let nextHandle = 1;
  const controller = new ObligationController({
    now: () => now,
    setTimer: (fn, ms) => {
      const handle = nextHandle++ as unknown as TimerHandle;
      timers.push({ at: now + ms, fn, handle });
      return handle;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index !== -1) timers.splice(index, 1);
    },
    submitReminder: (targetTaskId) => reminders.push(targetTaskId),
    emitNotice: (notice) => notices.push(notice),
  });
  return {
    controller,
    reminders,
    notices,
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
      for (;;) {
        const candidates = timers
          .filter((timer) => timer.at <= now)
          .sort((a, b) => a.at - b.at);
        if (candidates.length === 0) break;
        const due = candidates[0];
        timers.splice(timers.indexOf(due), 1);
        due.fn();
      }
    },
  };
}

describe("ObligationController", () => {
  it("opens one account per edge and coalesces a follow-up dispatch", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.arm("parent", "child");

    assert.equal(h.controller.hasOpen("parent", "child"), true);

    // One settle closes the single account.
    assert.equal(h.controller.settle("child"), "parent");
    assert.equal(h.controller.hasOpen("parent", "child"), false);
    assert.equal(h.controller.settle("child"), undefined);
  });

  it("settles to the stored source even from a late turn", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.beginTurn("child", "p1");
    h.controller.onTargetTurnEnded("child");
    assert.deepEqual(h.reminders, ["child"]);

    // A late done still settles; no turn identity is required.
    assert.equal(h.controller.settle("child"), "parent");
    assert.equal(h.reminders.length, 1);
  });

  it("reminds once, then reports no_update and stops", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");

    h.controller.beginTurn("child", "p1");
    h.controller.onTargetTurnEnded("child");
    assert.deepEqual(h.reminders, ["child"]);

    h.controller.beginTurn("child", "p2");
    h.controller.onTargetTurnEnded("child");
    assert.deepEqual(h.reminders, ["child"], "only one reminder");
    assert.deepEqual(
      h.notices.map((notice) => notice.reason),
      ["no_update"],
    );
    assert.equal(h.notices[0].sourceTaskId, "parent");
    assert.equal(h.notices[0].targetTaskId, "child");

    // Further unaccounted turns stay quiet.
    h.controller.beginTurn("child", "p3");
    h.controller.onTargetTurnEnded("child");
    assert.equal(h.notices.length, 1);
  });

  it("counts any update in a turn, including waiting", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.beginTurn("child", "p1");
    h.controller.noteUpdate("child");
    h.controller.onTargetTurnEnded("child");
    assert.equal(h.reminders.length, 0, "an updated turn needs no reminder");
    assert.equal(h.controller.hasOpen("parent", "child"), true);
  });

  it("resets the missing-update count when a later turn reports", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");

    h.controller.beginTurn("child", "p1");
    h.controller.onTargetTurnEnded("child");
    assert.deepEqual(h.reminders, ["child"]);

    h.controller.beginTurn("child", "p2");
    h.controller.noteUpdate("child");
    h.controller.onTargetTurnEnded("child");

    h.controller.beginTurn("child", "p3");
    h.controller.onTargetTurnEnded("child");
    assert.deepEqual(h.reminders, ["child", "child"], "reminder budget resets");
    assert.equal(h.notices.length, 0);
  });

  it("triggers nothing for a cancelled turn", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.beginTurn("child", "p1");
    h.controller.onTargetTurnEnded("child", true);
    assert.equal(h.reminders.length, 0);
    assert.equal(h.notices.length, 0);
    assert.ok(h.controller.hasOpen("parent", "child"));
  });

  it("reports silence once per running turn and resets on activity", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.beginTurn("child", "p1");

    h.advance(SILENCE_THRESHOLD_MS - 1);
    assert.equal(h.notices.length, 0);
    h.advance(1);
    assert.deepEqual(
      h.notices.map((notice) => notice.reason),
      ["no_activity"],
    );
    h.controller.noteAgentActivity("child");
    h.advance(SILENCE_THRESHOLD_MS);
    assert.equal(h.notices.length, 1, "at most once per turn");
    assert.ok(h.controller.hasOpen("parent", "child"), "facts only");
  });

  it("does not report silence without an open account", () => {
    const h = makeHarness();
    h.controller.beginTurn("child", "p1");
    h.advance(SILENCE_THRESHOLD_MS + 1);
    assert.equal(h.notices.length, 0);
  });

  it("reports target_removed when the target disappears", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.purgeTask("child");
    assert.deepEqual(
      h.notices.map((notice) => notice.reason),
      ["target_removed"],
    );
    assert.equal(h.controller.hasOpen("parent", "child"), false);
  });

  it("reports target_removed when archive cuts the edge", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.arm("child", "grandchild");
    h.controller.dropEdge("parent", "child");
    assert.deepEqual(
      h.notices.map((notice) => notice.reason),
      ["target_removed"],
    );
    assert.equal(h.controller.hasOpen("parent", "child"), false);
    assert.ok(
      h.controller.hasOpen("child", "grandchild"),
      "the subtree-internal edge survives",
    );
  });

  it("drops an account whose source disappeared without a notice", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.purgeTask("parent");
    assert.equal(h.notices.length, 0);
    assert.equal(h.controller.hasOpen("parent", "child"), false);
  });

  it("aborts a turn without reminding or noticing", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.beginTurn("child", "p1");
    h.controller.abortTurn("child");
    h.advance(SILENCE_THRESHOLD_MS + 1);
    assert.equal(h.reminders.length, 0);
    assert.equal(h.notices.length, 0);
    assert.ok(h.controller.hasOpen("parent", "child"));
  });

  it("stops timers after dispose", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.beginTurn("child", "p1");
    h.controller.dispose();
    h.advance(SILENCE_THRESHOLD_MS + 1);
    assert.equal(h.notices.length, 0);
  });
});
