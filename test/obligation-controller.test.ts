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
    submitReminder: (_sourceTaskId, targetTaskId) =>
      reminders.push(targetTaskId),
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

    // One close removes the single account.
    assert.equal(h.controller.peekSource("child"), "parent");
    h.controller.close("child");
    assert.equal(h.controller.hasOpen("parent", "child"), false);
    assert.equal(h.controller.peekSource("child"), undefined);
  });

  it("settles to the stored source even from a late turn", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.beginTurn("child");
    h.controller.onTargetTurnEnded("child");
    assert.deepEqual(h.reminders, ["child"]);

    // A late done still settles; no turn identity is required.
    assert.equal(h.controller.peekSource("child"), "parent");
    h.controller.close("child");
    assert.equal(h.reminders.length, 1);
  });

  it("reminds once, then reports no_update and stops", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");

    h.controller.beginTurn("child");
    h.controller.onTargetTurnEnded("child");
    assert.deepEqual(h.reminders, ["child"]);

    h.controller.beginTurn("child");
    h.controller.onTargetTurnEnded("child");
    assert.deepEqual(h.reminders, ["child"], "only one reminder");
    assert.deepEqual(
      h.notices.map((notice) => notice.reason),
      ["no_update"],
    );
    assert.equal(h.notices[0].sourceTaskId, "parent");
    assert.equal(h.notices[0].targetTaskId, "child");

    // Further unaccounted turns stay quiet.
    h.controller.beginTurn("child");
    h.controller.onTargetTurnEnded("child");
    assert.equal(h.notices.length, 1);
  });

  it("counts any update in a turn, including waiting", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.beginTurn("child");
    h.controller.noteUpdate("child");
    h.controller.onTargetTurnEnded("child");
    assert.equal(h.reminders.length, 0, "an updated turn needs no reminder");
    assert.equal(h.controller.hasOpen("parent", "child"), true);
  });

  it("resets the whole cycle after an update, including the stopped flag", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");

    // First full cycle: reminder, then no_update.
    h.controller.beginTurn("child");
    h.controller.onTargetTurnEnded("child");
    h.controller.beginTurn("child");
    h.controller.onTargetTurnEnded("child");
    assert.deepEqual(h.reminders, ["child"]);
    assert.deepEqual(
      h.notices.map((notice) => notice.reason),
      ["no_update"],
    );

    // An update resets both the miss count and the stopped flag.
    h.controller.beginTurn("child");
    h.controller.noteUpdate("child");
    h.controller.onTargetTurnEnded("child");
    assert.equal(h.controller.hasOpen("parent", "child"), true);

    // Second full cycle: reminder, then another no_update.
    h.controller.beginTurn("child");
    h.controller.onTargetTurnEnded("child");
    h.controller.beginTurn("child");
    h.controller.onTargetTurnEnded("child");
    assert.deepEqual(h.reminders, ["child", "child"]);
    assert.deepEqual(
      h.notices.map((notice) => notice.reason),
      ["no_update", "no_update"],
    );
  });

  it("marks only a running turn, and resets the cycle immediately", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");

    // A late idle update resets the cycle but belongs to no turn-end check.
    h.controller.noteUpdate("child");
    assert.equal(
      (h.controller as unknown as { updated: Set<string> }).updated.has(
        "child",
      ),
      false,
    );

    // A run that follows an idle update starts a fresh cycle.
    h.controller.beginTurn("child");
    h.controller.onTargetTurnEnded("child");
    assert.deepEqual(h.reminders, ["child"]);
    h.controller.beginTurn("child");
    h.controller.onTargetTurnEnded("child");
    assert.deepEqual(
      h.notices.map((notice) => notice.reason),
      ["no_update"],
    );

    // An idle update after the notice resets the stopped flag and miss count.
    h.controller.noteUpdate("child");
    h.controller.beginTurn("child");
    h.controller.onTargetTurnEnded("child");
    assert.deepEqual(h.reminders, ["child", "child"]);
  });

  it("counts an update made during the running turn", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.beginTurn("child");
    h.controller.noteUpdate("child");
    assert.equal(
      (h.controller as unknown as { updated: Set<string> }).updated.has(
        "child",
      ),
      true,
    );
    h.controller.onTargetTurnEnded("child");
    assert.equal(h.reminders.length, 0);
  });

  it("triggers nothing for a cancelled turn", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.beginTurn("child");
    h.controller.onTargetTurnEnded("child", true);
    assert.equal(h.reminders.length, 0);
    assert.equal(h.notices.length, 0);
    assert.ok(h.controller.hasOpen("parent", "child"));
  });

  it("reports silence once per running turn and resets on activity", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.beginTurn("child");

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

  it("postpones the silence deadline when activity arrives before it fires", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.beginTurn("child");

    h.advance(SILENCE_THRESHOLD_MS - 1);
    h.controller.noteAgentActivity("child");
    h.advance(2);
    assert.equal(h.notices.length, 0, "activity resets the window");

    h.advance(SILENCE_THRESHOLD_MS - 1);
    assert.deepEqual(
      h.notices.map((notice) => notice.reason),
      ["no_activity"],
    );
  });

  it("watches an unwatched waiting for silence, reset by activity outside a prompt", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.beginTurn("child");
    h.controller.noteUpdate("child");
    assert.equal(h.controller.noteUnwatchedWaiting("child"), true);
    h.controller.onTargetTurnEnded("child");
    assert.equal(h.reminders.length, 0, "waiting satisfied the turn");

    // The agent's own background work wakes it: activity with no prompt.
    h.advance(SILENCE_THRESHOLD_MS - 1);
    h.controller.noteAgentActivity("child");
    h.advance(SILENCE_THRESHOLD_MS - 1);
    assert.equal(h.notices.length, 0, "activity resets the window");

    h.advance(1);
    assert.deepEqual(
      h.notices.map((notice) => notice.reason),
      ["no_activity"],
    );
    h.advance(SILENCE_THRESHOLD_MS * 2);
    assert.equal(h.notices.length, 1, "once per waiting");
    assert.ok(h.controller.hasOpen("parent", "child"), "facts only");
  });

  it("re-arms the waiting watch on the next waiting and clears it on any update", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.noteUpdate("child");
    h.controller.noteUnwatchedWaiting("child");
    h.advance(SILENCE_THRESHOLD_MS);
    assert.equal(h.notices.length, 1);

    // The requester asks; the child explains and waits again.
    h.controller.beginTurn("child");
    h.controller.noteUpdate("child");
    h.controller.noteUnwatchedWaiting("child");
    h.controller.onTargetTurnEnded("child");
    h.advance(SILENCE_THRESHOLD_MS);
    assert.equal(h.notices.length, 2, "a new waiting gets a new window");

    h.controller.noteUpdate("child");
    h.controller.noteUnwatchedWaiting("child");
    h.controller.noteUpdate("child");
    h.advance(SILENCE_THRESHOLD_MS * 2);
    assert.equal(h.notices.length, 2, "a later update clears the watch");
  });

  it("reports one notice when a waiting is reported inside a silent turn", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.beginTurn("child");
    h.controller.noteUpdate("child");
    h.controller.noteUnwatchedWaiting("child");
    h.advance(SILENCE_THRESHOLD_MS);
    assert.equal(h.notices.length, 1, "the turn's watch fires");

    // After the turn ends, the waiting is watched from the turn end.
    h.controller.onTargetTurnEnded("child");
    h.advance(SILENCE_THRESHOLD_MS - 1);
    assert.equal(h.notices.length, 1);
    h.advance(1);
    assert.equal(h.notices.length, 2);
  });

  it("does not watch a waiting without an open account", () => {
    const h = makeHarness();
    assert.equal(h.controller.noteUnwatchedWaiting("child"), false);
    h.advance(SILENCE_THRESHOLD_MS * 2);
    assert.equal(h.notices.length, 0);
  });

  it("uses the configured silence threshold", () => {
    const notices: ObligationNotice[] = [];
    let fire: (() => void) | undefined;
    let delay = -1;
    const controller = new ObligationController({
      now: () => 0,
      setTimer: (fn, ms) => {
        fire = fn;
        delay = ms;
        return 1 as unknown as TimerHandle;
      },
      clearTimer: () => {},
      submitReminder: () => {},
      emitNotice: (notice) => notices.push(notice),
      silenceMs: 90_000,
    });
    controller.arm("parent", "child");
    controller.beginTurn("child");
    assert.equal(delay, 90_000);
    assert.equal(controller.silenceMs, 90_000);
    void fire;
  });

  it("does not report silence without an open account", () => {
    const h = makeHarness();
    h.controller.beginTurn("child");
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
    h.controller.beginTurn("child");
    h.controller.abortTurn("child");
    h.advance(SILENCE_THRESHOLD_MS + 1);
    assert.equal(h.reminders.length, 0);
    assert.equal(h.notices.length, 0);
    assert.ok(h.controller.hasOpen("parent", "child"));
  });

  it("stops timers after dispose", () => {
    const h = makeHarness();
    h.controller.arm("parent", "child");
    h.controller.beginTurn("child");
    h.controller.dispose();
    h.advance(SILENCE_THRESHOLD_MS + 1);
    assert.equal(h.notices.length, 0);
  });
});
