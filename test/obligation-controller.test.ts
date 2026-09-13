import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REMINDER_ATTEMPTS,
  MAX_REMINDER_SUBMISSION_FAILURES,
  ObligationController,
  SILENCE_THRESHOLD_S,
  type DirectedObligation,
  type ObligationNotice,
  type TimerHandle,
} from "../src/obligation-controller.ts";

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

class FakeClock {
  now = 1_000_000;
  private timers: FakeTimer[] = [];
  private nextId = 1;

  setTimer(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.push({ id, at: this.now + Math.max(0, ms), fn });
    return id as unknown as TimerHandle;
  }

  clearTimer(handle: TimerHandle): void {
    this.timers = this.timers.filter(
      (timer) => timer.id !== (handle as unknown as number),
    );
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)
        .at(0);
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.now = due.at;
      due.fn();
    }
    this.now = target;
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Fire due timers at the current instant, then drain microtasks. */
async function tick(h: Harness, ms = 0): Promise<void> {
  h.clock.advance(ms);
  await flush();
}

interface Harness {
  controller: ObligationController;
  clock: FakeClock;
  notices: ObligationNotice[];
  submissions: DirectedObligation[];
  busy: Set<string>;
  setSubmitMode: (mode: "accept" | "reject") => void;
}

function makeController(): Harness {
  const clock = new FakeClock();
  const notices: ObligationNotice[] = [];
  const submissions: DirectedObligation[] = [];
  const busy = new Set<string>();
  let submitMode: "accept" | "reject" = "accept";
  let idSeq = 0;
  const controller = new ObligationController({
    now: () => clock.now,
    setTimer: (fn, ms) => clock.setTimer(fn, ms),
    clearTimer: (handle) => {
      clock.clearTimer(handle);
    },
    isAgentBusy: (taskId) => busy.has(taskId),
    submitReminder: (obligation) => {
      submissions.push(obligation);
      return Promise.resolve(submitMode === "accept");
    },
    emitNotice: (notice) => {
      notices.push(notice);
    },
    newId: () => `ob-${++idSeq}`,
  });
  return {
    controller,
    clock,
    notices,
    submissions,
    busy,
    setSubmitMode: (mode) => {
      submitMode = mode;
    },
  };
}

function armOpen(h: Harness): DirectedObligation {
  const obligation = h.controller.arm({
    sourceTaskId: "parent",
    targetTaskId: "child",
    messageId: "m-1",
    deliveryId: "d-1",
  });
  h.controller.markDelivered("parent", "child");
  return obligation;
}

describe("ObligationController", () => {
  it("does not request an account until the source dispatch is accepted", async () => {
    const h = makeController();
    const obligation = h.controller.arm({
      sourceTaskId: "parent",
      targetTaskId: "child",
      messageId: "m-1",
      deliveryId: "d-1",
    });
    assert.equal(obligation.state, "awaiting_delivery");
    // Mutation evidence: deleting the awaiting_delivery gate opens the edge at
    // arm time and schedules reminder 1 here, so this advance would submit.
    await tick(h, 10 * 60_000);
    assert.deepEqual(h.submissions, []);
    assert.equal(h.notices.length, 0);

    h.controller.markDelivered("parent", "child");
    await tick(h);
    assert.equal(obligation.state, "reminder_due");
    assert.equal(h.submissions.length, 1);
  });

  it("drops the edge when the qualifying dispatch is rejected", async () => {
    const h = makeController();
    h.controller.arm({
      sourceTaskId: "parent",
      targetTaskId: "child",
      messageId: "m-1",
      deliveryId: "d-1",
    });
    h.controller.markRejected("parent", "child");
    await tick(h, 10 * 60_000);
    assert.equal(h.controller.getById("ob-1"), undefined);
    assert.equal(h.submissions.length, 0);
    // Mutation evidence: removing markRejected leaves an awaiting_delivery edge
    // that a delivery acceptance would still open.
    assert.equal(h.notices.length, 0);
  });

  it("delivers reminders at the turn boundary and at +2m and +5m", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    await tick(h);
    assert.equal(h.submissions.length, 1);
    assert.equal(obligation.deliveredAttempts, 1);
    assert.equal(obligation.lastDeliveredAttemptAt, h.clock.now);

    // Mutation evidence: replacing REMINDER_DELAYS_MS[index] with a fixed
    // delay changes this boundary.
    await tick(h, 2 * 60_000 - 1);
    assert.equal(h.submissions.length, 1);
    await tick(h, 1);
    assert.equal(h.submissions.length, 2);

    await tick(h, 5 * 60_000 - 1);
    assert.equal(h.submissions.length, 2);
    await tick(h, 1);
    assert.equal(h.submissions.length, 3);
    assert.equal(obligation.deliveredAttempts, MAX_REMINDER_ATTEMPTS);
  });

  it("declares unanswered and notifies no_account exactly once after the last reminder", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    await tick(h);
    await tick(h, 2 * 60_000);
    await tick(h, 5 * 60_000);

    assert.equal(h.submissions.length, MAX_REMINDER_ATTEMPTS);
    assert.equal(obligation.state, "unanswered");
    // Mutation evidence: omitting the deliveredAttempts cap keeps scheduling a
    // fourth reminder (submissions.length grows past the bound).
    await tick(h, 60 * 60_000);
    assert.equal(h.submissions.length, MAX_REMINDER_ATTEMPTS);
    assert.equal(h.notices.length, 1);
    const notice = h.notices[0];
    assert.equal(notice.reason, "no_account");
    assert.equal(notice.obligationId, obligation.id);
    assert.equal(notice.evidence.deliveredAttempts, MAX_REMINDER_ATTEMPTS);
  });

  it("coalesces a same-source follow-up without a fresh id or budget", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    await tick(h);
    await tick(h, 2 * 60_000);
    assert.equal(h.submissions.length, 2);
    assert.equal(obligation.deliveredAttempts, 2);

    // The follow-up coalesces onto the open edge.
    const coalesced = h.controller.arm({
      sourceTaskId: "parent",
      targetTaskId: "child",
      messageId: "m-2",
      deliveryId: "d-2",
    });
    // Mutation evidence: allocating a fresh id on coalescing fails both asserts.
    assert.equal(coalesced.id, obligation.id);
    assert.equal(coalesced.deliveredAttempts, 0);
    assert.equal(coalesced.state, "awaiting_delivery");
    assert.equal(coalesced.openingMessageId, "m-2");
    h.controller.markDelivered("parent", "child");
    await tick(h);
    // The refreshed budget is spent from the new turn boundary again.
    assert.equal(coalesced.deliveredAttempts, 1);
    await tick(h, 2 * 60_000);
    assert.equal(coalesced.deliveredAttempts, 2);
  });

  it("does not consume an attempt on rejection and bounds consecutive failures", async () => {
    const h = makeController();
    h.setSubmitMode("reject");
    const obligation = armOpen(h);
    await tick(h);
    assert.equal(h.submissions.length, 1);
    assert.equal(obligation.deliveredAttempts, 0);
    assert.equal(obligation.consecutiveSubmissionFailures, 1);

    // Mutation evidence: counting the rejected prompt as delivered makes
    // deliveredAttempts 1 here; omitting the cut-off never reaches exhausted.
    await tick(h, 1_000);
    await tick(h, 2_000);
    assert.equal(h.submissions.length, MAX_REMINDER_SUBMISSION_FAILURES);
    assert.equal(obligation.deliveredAttempts, 0);
    assert.equal(obligation.state, "unanswered");
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].reason, "no_account");
    assert.equal(h.notices[0].evidence.deliveryUnavailable, true);
  });

  it("waits for the target to be idle before submitting", async () => {
    const h = makeController();
    armOpen(h);
    await tick(h);
    assert.equal(h.submissions.length, 1);
    await tick(h);
    h.busy.add("child");
    // Mutation evidence: removing the isAgentBusy guard submits here (3).
    await tick(h, 2 * 60_000);
    assert.equal(h.submissions.length, 1);
    h.busy.delete("child");
    await tick(h, 60_000);
    assert.equal(h.submissions.length, 2);
  });

  it("retires the edge on a correlated account and cancels scheduling", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    await tick(h);
    const settledBy: DirectedObligation[] = [];
    const result = h.controller.settle({
      sourceTaskId: "child",
      obligationId: obligation.id,
      run: (o) => {
        settledBy.push(o);
        return "tx";
      },
    });
    assert.equal(result, "tx");
    assert.equal(settledBy[0].id, obligation.id);
    assert.equal(obligation.state, "settled");
    // Mutation evidence: not retiring on settle leaves the timer armed and a
    // reminder would be submitted after this advance.
    await tick(h, 60 * 60_000);
    assert.equal(h.submissions.length, 1);
    assert.equal(h.notices.length, 0);
  });

  it("leaves the edge open when the settlement transaction throws", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    await tick(h);
    assert.throws(() => {
      h.controller.settle({
        sourceTaskId: "child",
        obligationId: obligation.id,
        run: () => {
          throw new Error("tx failed");
        },
      });
    });
    assert.equal(obligation.state, "reminder_due");
    // Mutation evidence: marking settled before running the transaction would
    // suppress this delivered reminder.
    await tick(h, 2 * 60_000);
    assert.equal(h.submissions.length, 2);
  });

  it("accepts a late account for an unanswered edge without retracting the notice", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    await tick(h);
    await tick(h, 2 * 60_000);
    await tick(h, 5 * 60_000);
    assert.equal(obligation.state, "unanswered");
    assert.equal(h.notices.length, 1);

    const ran = h.controller.settle({
      sourceTaskId: "child",
      obligationId: obligation.id,
      run: () => "late",
    });
    assert.equal(ran, "late");
    assert.equal(obligation.state, "settled");
    assert.equal(h.notices.length, 1);
    // Mutation evidence: rejecting archived ids returns undefined here.
    assert.equal(h.controller.getById(obligation.id)?.state, "settled");
  });

  it("ignores stale, wrong-target, and settled obligation ids", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    await tick(h);
    let ran = false;
    // Wrong target.
    assert.equal(
      h.controller.settle({
        sourceTaskId: "other",
        obligationId: obligation.id,
        run: () => {
          ran = true;
        },
      }),
      undefined,
    );
    // Unknown id.
    assert.equal(
      h.controller.settle({
        sourceTaskId: "child",
        obligationId: "nope",
        run: () => {
          ran = true;
        },
      }),
      undefined,
    );
    // Mutation evidence: dropping the target check or unknown-id guard runs the
    // transaction for one of the two calls above.
    assert.equal(ran, false);
    h.controller.settle({
      sourceTaskId: "child",
      obligationId: obligation.id,
      run: () => "ok",
    });
    // Repeated settlement after retirement is a no-op.
    assert.equal(
      h.controller.settle({
        sourceTaskId: "child",
        obligationId: obligation.id,
        run: () => {
          ran = true;
        },
      }),
      undefined,
    );
    assert.equal(ran, false);
  });

  it("preserves the stored endpoints through arming, settlement, and notice", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    await tick(h);
    assert.equal(obligation.sourceTaskId, "parent");
    assert.equal(obligation.targetTaskId, "child");
    await tick(h, 2 * 60_000);
    await tick(h, 5 * 60_000);
    assert.equal(h.notices[0].obligationId, obligation.id);
    // Mutation evidence: re-deriving endpoints from the current parent_id
    // would not fix this store-and-read round trip.
    const seen = h.controller.settle({
      sourceTaskId: "child",
      obligationId: obligation.id,
      run: (o) => `${o.sourceTaskId}->${o.targetTaskId}`,
    });
    assert.equal(seen, "parent->child");
  });

  it("loses all obligation state when the controller is reconstructed", async () => {
    const first = makeController();
    const obligation = armOpen(first);
    await tick(first);
    assert.ok(first.controller.getById(obligation.id));

    // A fresh controller is the process-local loss boundary; no restart or
    // persistence participates.
    const second = makeController();
    assert.equal(second.controller.getById(obligation.id), undefined);
    assert.equal(
      second.controller.settle({
        sourceTaskId: "child",
        obligationId: obligation.id,
        run: () => "should not run",
      }),
      undefined,
    );
  });

  it("emits one heuristic no_activity notice per edge×turn", async () => {
    const h = makeController();
    const obligation = h.controller.arm({
      sourceTaskId: "parent",
      targetTaskId: "child",
      messageId: "m-1",
      deliveryId: "d-1",
    });
    h.controller.beginTurn("child", "prompt-1");
    await tick(h, SILENCE_THRESHOLD_S * 1000);
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].reason, "no_activity");
    assert.equal(h.notices[0].obligationId, obligation.id);
    // Mutation evidence: letting the watchdog invoke submitReminder would add
    // a submission here; sharing the no_account epoch would suppress that
    // independent notice below.
    assert.equal(h.submissions.length, 0);

    // A second threshold with no further activity does not repeat.
    await tick(h, SILENCE_THRESHOLD_S * 1000);
    assert.equal(h.notices.length, 1);
  });

  it("resets the watchdog on qualifying activity and keeps epochs independent", async () => {
    const h = makeController();
    const obligation = h.controller.arm({
      sourceTaskId: "parent",
      targetTaskId: "child",
      messageId: "m-1",
      deliveryId: "d-1",
    });
    h.controller.beginTurn("child", "prompt-2");
    h.clock.advance(SILENCE_THRESHOLD_S * 1000 - 1);
    h.controller.noteAgentActivity("child");
    await tick(h, SILENCE_THRESHOLD_S * 1000 - 1);
    // Mutation evidence: deriving activity from generic latest event (not a
    // qualifying agent event) would have emitted here.
    assert.equal(h.notices.length, 0);

    await tick(h, 1);
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].reason, "no_activity");

    // The no_account exhaustion notice is a separate epoch from silence, so
    // the silence notice cannot suppress the factual outcome.
    h.controller.markDelivered("parent", "child");
    await tick(h);
    await tick(h, 2 * 60_000);
    await tick(h, 5 * 60_000);
    assert.equal(h.notices.length, 2);
    assert.equal(h.notices[1].reason, "no_account");
    assert.equal(obligation.state, "unanswered");
  });

  it("never changes obligation state from a silence notice", async () => {
    const h = makeController();
    const obligation = h.controller.arm({
      sourceTaskId: "parent",
      targetTaskId: "child",
      messageId: "m-1",
      deliveryId: "d-1",
    });
    h.controller.beginTurn("child", "prompt-3");
    await tick(h, SILENCE_THRESHOLD_S * 1000);
    assert.equal(h.notices[0].reason, "no_activity");
    assert.equal(obligation.state, "awaiting_delivery");
    assert.equal(obligation.deliveredAttempts, 0);
    assert.equal(h.submissions.length, 0);
  });

  it("does not start a watchdog without an active obligation", async () => {
    const h = makeController();
    h.controller.beginTurn("child", "prompt-4");
    await tick(h, SILENCE_THRESHOLD_S * 2000);
    assert.equal(h.notices.length, 0);
  });
});
