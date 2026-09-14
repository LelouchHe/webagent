import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGE_ADVISORY_MS,
  DISPATCH_ADVISORY_MS,
  MAX_REMINDER_ATTEMPTS,
  MAX_REMINDER_SUBMISSION_FAILURES,
  ObligationController,
  SILENCE_THRESHOLD_S,
  type DirectedObligation,
  type ObligationNotice,
  type SettlementDecision,
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

  /** The injected scheduler port: every live deadline the controller armed. */
  pendingDeadlineTimes(): number[] {
    return this.timers.map((timer) => timer.at);
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

interface Harness {
  controller: ObligationController;
  clock: FakeClock;
  notices: ObligationNotice[];
  submissions: DirectedObligation[];
  dispatchRetries: DirectedObligation[];
  busy: Set<string>;
  setSubmitMode: (mode: "accept" | "reject" | "manual") => void;
  setTurnRunning: (running: boolean) => void;
  resolveSubmission: (index: number, accepted: boolean) => void;
}

function makeController(): Harness {
  const clock = new FakeClock();
  const notices: ObligationNotice[] = [];
  const submissions: DirectedObligation[] = [];
  const dispatchRetries: DirectedObligation[] = [];
  const pendingSubmissions: Array<(accepted: boolean) => void> = [];
  const busy = new Set<string>();
  let submitMode: "accept" | "reject" | "manual" = "accept";
  let turnRunning = true;
  const controller = new ObligationController({
    now: () => clock.now,
    setTimer: (fn, ms) => clock.setTimer(fn, ms),
    clearTimer: (handle) => {
      clock.clearTimer(handle);
    },
    isAgentBusy: (taskId) => busy.has(taskId),
    isTurnRunning: () => turnRunning,
    submitReminder: (obligation) => {
      submissions.push(obligation);
      if (submitMode === "manual") {
        return new Promise<boolean>((resolve) =>
          pendingSubmissions.push(resolve),
        );
      }
      return Promise.resolve(submitMode === "accept");
    },
    emitNotice: (notice) => {
      notices.push(notice);
    },
    retryDispatch: (obligation) => {
      dispatchRetries.push(obligation);
    },
  });
  return {
    controller,
    clock,
    notices,
    submissions,
    dispatchRetries,
    busy,
    setSubmitMode: (mode) => {
      submitMode = mode;
    },
    setTurnRunning: (running) => {
      turnRunning = running;
    },
    resolveSubmission: (index, accepted) => {
      const resolve = pendingSubmissions[index];
      assert.ok(resolve, `no pending submission at ${index}`);
      resolve(accepted);
    },
  };
}

async function tick(h: Harness, ms = 0): Promise<void> {
  h.clock.advance(ms);
  await flush();
}

function armDirect(h: Harness): DirectedObligation {
  return h.controller.arm({
    sourceTaskId: "parent",
    targetTaskId: "child",
    messageId: "m-1",
    deliveryId: "d-1",
  });
}

function armOpen(h: Harness): DirectedObligation {
  const obligation = armDirect(h);
  h.controller.markDelivered("parent", "child");
  return obligation;
}

function settleNow(
  h: Harness,
  run: (decision: SettlementDecision) => unknown = () => "ok",
): { decision: SettlementDecision; result: unknown } {
  return h.controller.settleReport({
    targetTaskId: "child",
    activeTurn: { promptId: "prompt-current", startedAt: h.clock.now },
    run,
  });
}

describe("ObligationController", () => {
  it("does not request an account until the source dispatch is accepted", async () => {
    const h = makeController();
    const obligation = armDirect(h);
    assert.equal(obligation.state, "awaiting_delivery");
    await tick(h, 10 * 60_000);
    assert.deepEqual(h.submissions, []);
    assert.equal(h.notices.length, 0);

    h.controller.markDelivered("parent", "child");
    await tick(h);
    assert.equal(obligation.state, "reminder_due");
    assert.equal(h.submissions.length, 1);
  });

  it("retries a rejected initial dispatch and bounds the transport failures", async () => {
    const h = makeController();
    const obligation = armDirect(h);
    h.controller.markDeliveryFailed("parent", "child");
    assert.equal(obligation.state, "awaiting_delivery");
    assert.equal(obligation.consecutiveSubmissionFailures, 1);
    // Mutation evidence: dropping the edge on rejection (the prior behaviour)
    // would leave getForTarget undefined instead of retrying.
    await tick(h, 1_000);
    assert.equal(h.dispatchRetries.length, 1);

    h.controller.markDelivered("parent", "child");
    // Issuance alone does not clear the transport streak; a resolved
    // submission does, so a retry that is rejected again still accumulates.
    assert.equal(obligation.consecutiveSubmissionFailures, 1);
    h.controller.markDispatchSucceeded("parent", "child");
    assert.equal(obligation.consecutiveSubmissionFailures, 0);
    await tick(h);
    assert.equal(obligation.state, "reminder_due");
    assert.equal(h.submissions.length, 1);
  });

  it("exhausts awaiting_delivery after the transport bound without spending reminders", async () => {
    const h = makeController();
    const obligation = armDirect(h);
    for (
      let failure = 0;
      failure < MAX_REMINDER_SUBMISSION_FAILURES;
      failure++
    ) {
      h.controller.markDeliveryFailed("parent", "child");
    }
    assert.equal(obligation.state, "unresolved");
    assert.equal(obligation.deliveredAttempts, 0);
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].reason, "delivery_failed");
    assert.equal(h.notices[0].evidence.deliveryUnavailable, true);
    // The notice is a capability fact, never a claim about the target's work.
    assert.match(h.notices[0].message, /could not deliver/);
    await tick(h, 60 * 60_000);
    assert.equal(h.dispatchRetries.length, 0);
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

  it("declares unresolved and notifies no_account exactly once after the last reminder", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    await tick(h);
    await tick(h, 2 * 60_000);
    await tick(h, 5 * 60_000);

    assert.equal(h.submissions.length, MAX_REMINDER_ATTEMPTS);
    assert.equal(obligation.state, "unresolved");
    await tick(h, 60 * 60_000);
    assert.equal(h.submissions.length, MAX_REMINDER_ATTEMPTS);
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].reason, "no_account");
    assert.equal(
      h.notices[0].evidence.deliveredAttempts,
      MAX_REMINDER_ATTEMPTS,
    );
  });

  it("coalesces a same-source follow-up and replaces a terminal record", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    await tick(h);
    await tick(h, 2 * 60_000);
    assert.equal(obligation.deliveredAttempts, 2);

    const coalesced = h.controller.arm({
      sourceTaskId: "parent",
      targetTaskId: "child",
      messageId: "m-2",
      deliveryId: "d-2",
    });
    // Mutation evidence: allocating a fresh record on coalescing fails both
    // the identity and the budget assertions.
    assert.equal(coalesced, obligation);
    assert.equal(coalesced.deliveredAttempts, 0);
    assert.equal(coalesced.openingMessageId, "m-2");
    h.controller.markDelivered("parent", "child");
    await tick(h);
    h.controller.onTargetTurnEnded("child");
    await tick(h);
    assert.equal(coalesced.deliveredAttempts, 1);

    // Exhaust, then a later dispatch starts a fresh epoch.
    await tick(h, 2 * 60_000);
    await tick(h, 5 * 60_000);
    assert.equal(obligation.state, "unresolved");
    const fresh = h.controller.arm({
      sourceTaskId: "parent",
      targetTaskId: "child",
      messageId: "m-3",
      deliveryId: "d-3",
    });
    assert.notEqual(fresh, obligation);
    assert.equal(fresh.state, "awaiting_delivery");
  });

  it("does not consume an attempt on rejection and bounds consecutive failures", async () => {
    const h = makeController();
    h.setSubmitMode("reject");
    const obligation = armOpen(h);
    await tick(h);
    assert.equal(h.submissions.length, 1);
    assert.equal(obligation.deliveredAttempts, 0);
    assert.equal(obligation.consecutiveSubmissionFailures, 1);

    await tick(h, 1_000);
    await tick(h, 2_000);
    assert.equal(h.submissions.length, MAX_REMINDER_SUBMISSION_FAILURES);
    assert.equal(obligation.deliveredAttempts, 0);
    assert.equal(obligation.state, "unresolved");
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].reason, "delivery_failed");
    assert.equal(h.notices[0].evidence.deliveryUnavailable, true);
    assert.match(h.notices[0].message, /could not deliver/);
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

  it("settles the record from an active current turn and routes to the stored source", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    await tick(h);
    const seen: SettlementDecision[] = [];
    const { decision, result } = settleNow(h, (d) => {
      seen.push(d);
      return "tx";
    });
    assert.equal(decision.kind, "settle");
    assert.equal(decision.sourceTaskId, "parent");
    assert.equal(result, "tx");
    assert.deepEqual(seen, [{ kind: "settle", sourceTaskId: "parent" }]);
    assert.equal(obligation.state, "settled");
    // Mutation evidence: not retiring on settle leaves the timer armed.
    await tick(h, 60 * 60_000);
    assert.equal(h.submissions.length, 1);
    assert.equal(h.notices.length, 0);

    // A settled record is terminal: a later report is routed to the stored
    // source but never re-settles.
    const later = settleNow(h);
    assert.equal(later.decision.kind, "stored-source");
    assert.equal(obligation.state, "settled");
  });

  it("does not settle while the record is awaiting_delivery", async () => {
    const h = makeController();
    const obligation = armDirect(h);
    let ran = false;
    const { decision } = settleNow(h, () => {
      ran = true;
    });
    // Mutation evidence: dropping the awaiting_delivery guard settles here.
    assert.equal(ran, true);
    assert.equal(decision.kind, "stored-source");
    assert.equal(obligation.state, "awaiting_delivery");
  });

  it("does not settle without an active turn", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    const { decision } = h.controller.settleReport({
      targetTaskId: "child",
      activeTurn: null,
      run: () => "ok",
    });
    assert.equal(decision.kind, "stored-source");
    assert.notEqual(obligation.state, "settled");
  });

  it("a late account settles an unresolved record without retracting the notice", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    await tick(h);
    await tick(h, 2 * 60_000);
    await tick(h, 5 * 60_000);
    assert.equal(obligation.state, "unresolved");
    assert.equal(h.notices.length, 1);

    const { decision } = settleNow(h);
    // Mutation evidence: refusing to settle an unresolved record leaves the
    // outcome permanently unknown even after the account arrives.
    assert.equal(decision.kind, "settle");
    assert.equal(decision.sourceTaskId, "parent");
    assert.equal(obligation.state, "settled");
    // The historical notice is not retracted.
    assert.equal(h.notices.length, 1);
  });

  it("routes to the current parent when no record exists", () => {
    const h = makeController();
    const { decision } = settleNow(h);
    assert.equal(decision.kind, "current-parent");
    assert.equal(decision.sourceTaskId, null);
  });

  it("accepts a delayed call from an earlier turn while a later turn is current", async () => {
    // Accepted boundary, not a bug: settlement is judged from the *current*
    // turn, so a call delayed from an earlier turn can settle while a newer
    // turn is current, and the stored source receives the earlier turn's
    // content. Closing this would need prompt-scoped transport attribution,
    // which is larger than the token echoing that was rejected. Do not "fix"
    // this into silence, and do not reintroduce a timestamp guard.
    const h = makeController();
    const obligation = armOpen(h);
    await tick(h);
    const { decision, result } = h.controller.settleReport({
      targetTaskId: "child",
      activeTurn: { promptId: "prompt-later", startedAt: h.clock.now + 5_000 },
      run: () => "earlier-turn-content",
    });
    assert.equal(decision.kind, "settle");
    assert.equal(result, "earlier-turn-content");
    assert.equal(obligation.state, "settled");
  });

  it("leaves the record open when the settlement transaction throws", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    await tick(h);
    assert.throws(() => {
      settleNow(h, () => {
        throw new Error("tx failed");
      });
    });
    assert.notEqual(obligation.state, "settled");
    // Mutation evidence: marking settled before running the transaction would
    // suppress this delivered reminder.
    await tick(h, 2 * 60_000);
    assert.equal(h.submissions.length, 2);
  });

  it("preserves the stored endpoints through arming, settlement, and notice", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    await tick(h);
    await tick(h, 2 * 60_000);
    await tick(h, 5 * 60_000);
    assert.equal(obligation.sourceTaskId, "parent");
    assert.equal(obligation.targetTaskId, "child");
    assert.equal(obligation.openingMessageId, "m-1");
    assert.equal(obligation.openingDeliveryId, "d-1");
    // Mutation evidence: re-deriving endpoints from the current parent_id
    // would not preserve this stored record.
    const seen = settleNow(h, (d) => d.sourceTaskId);
    assert.equal(seen.decision.kind, "settle");
    assert.equal(seen.result, "parent");
  });

  it("loses all obligation state when the controller is reconstructed", async () => {
    const first = makeController();
    const obligation = armOpen(first);
    await tick(first);
    assert.equal(first.controller.getForTarget("child"), obligation);

    const second = makeController();
    assert.equal(second.controller.getForTarget("child"), undefined);
    assert.equal(settleNow(second).decision.kind, "current-parent");
  });

  it("emits one heuristic no_activity notice per target×turn", async () => {
    const h = makeController();
    armDirect(h);
    h.controller.beginTurn("child", "prompt-1");
    await tick(h, SILENCE_THRESHOLD_S * 1000);
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].reason, "no_activity");
    // Mutation evidence: letting the watchdog invoke submitReminder would add
    // a submission here.
    assert.equal(h.submissions.length, 0);

    await tick(h, SILENCE_THRESHOLD_S * 1000);
    assert.equal(h.notices.length, 1);
  });

  it("resets the watchdog on qualifying activity and keeps epochs independent", async () => {
    const h = makeController();
    const obligation = armDirect(h);
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

    // The no_account exhaustion notice is a separate epoch from silence.
    h.controller.markDelivered("parent", "child");
    await tick(h);
    await tick(h, 2 * 60_000);
    await tick(h, 5 * 60_000);
    assert.equal(h.notices.length, 2);
    assert.equal(h.notices[1].reason, "no_account");
    assert.equal(obligation.state, "unresolved");
  });

  it("never changes obligation state from a silence notice", async () => {
    const h = makeController();
    const obligation = armDirect(h);
    h.controller.beginTurn("child", "prompt-3");
    await tick(h, SILENCE_THRESHOLD_S * 1000);
    assert.equal(h.notices[0].reason, "no_activity");
    assert.equal(obligation.state, "awaiting_delivery");
    assert.equal(obligation.deliveredAttempts, 0);
    assert.equal(h.submissions.length, 0);
  });

  it("does not watch a terminal record", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    await tick(h);
    await tick(h, 2 * 60_000);
    await tick(h, 5 * 60_000);
    assert.equal(obligation.state, "unresolved");

    // A later turn on the target must not start a watchdog for the closed edge.
    h.controller.beginTurn("child", "prompt-late");
    h.controller.noteAgentActivity("child");
    await tick(h, SILENCE_THRESHOLD_S * 2000);
    // Mutation evidence: dropping the terminal check in beginTurn emits a
    // spurious no_activity notice for this closed edge.
    assert.equal(
      h.notices.filter((notice) => notice.reason === "no_activity").length,
      0,
    );
  });

  it("purges records when a task is released, cancelling their timers", async () => {
    const h = makeController();
    armOpen(h);
    await tick(h);
    assert.ok(h.controller.getForTarget("child"));

    h.controller.purgeTask("child");
    // Mutation evidence: without the purge the record and its reminder timer
    // survive the release.
    assert.equal(h.controller.getForTarget("child"), undefined);
    assert.equal(h.controller.getActive("parent", "child"), undefined);
    const submissionsBefore = h.submissions.length;
    await tick(h, 60 * 60_000);
    assert.equal(h.submissions.length, submissionsBefore);

    const bySource = makeController();
    armOpen(bySource);
    await tick(bySource);
    bySource.controller.purgeTask("parent");
    assert.equal(bySource.controller.getForTarget("child"), undefined);
  });

  it("ignores callbacks from a superseded dispatch", () => {
    const h = makeController();
    const obligation = armDirect(h);

    // Dispatch A is issued, then fails at request level and is retried.
    h.controller.beginDispatch("parent", "child", "dispatch-A");
    h.controller.markDelivered("parent", "child", "dispatch-A");
    h.controller.markDeliveryFailed("parent", "child", "dispatch-A");
    assert.equal(obligation.state, "awaiting_delivery");
    assert.equal(obligation.consecutiveSubmissionFailures, 1);

    // Dispatch B is issued next and succeeds.
    h.controller.beginDispatch("parent", "child", "dispatch-B");
    h.controller.markDelivered("parent", "child", "dispatch-B");
    h.controller.markDispatchSucceeded("parent", "child", "dispatch-B");
    assert.equal(obligation.consecutiveSubmissionFailures, 0);

    // A late failure from A must not push B back to awaiting_delivery or
    // consume its transport budget, and a late success from A must not clear
    // B's streak.
    h.controller.markDeliveryFailed("parent", "child", "dispatch-A");
    assert.notEqual(obligation.state, "awaiting_delivery");
    assert.equal(obligation.consecutiveSubmissionFailures, 0);
    // Give B a fresh streak, then a stale A success must not clear it.
    h.controller.markDeliveryFailed("parent", "child", "dispatch-B");
    assert.equal(obligation.consecutiveSubmissionFailures, 1);
    h.controller.markDispatchSucceeded("parent", "child", "dispatch-A");
    assert.equal(obligation.consecutiveSubmissionFailures, 1);
  });

  it("keeps the live attempt's ownership across coalescing", () => {
    const h = makeController();
    const obligation = armDirect(h);
    h.controller.beginDispatch("parent", "child", "dispatch-A");
    // A's resume is in flight; a follow-up coalesces its message into the
    // batch A's drain will deliver.
    h.controller.arm({
      sourceTaskId: "parent",
      targetTaskId: "child",
      messageId: "m-2",
      deliveryId: "d-2",
    });
    // Coalescing is not a new attempt, so A still owns the record.
    assert.equal(obligation.attemptId, "dispatch-A");

    // Mutation evidence: clearing the identity on coalescing rejects this
    // hand-off, leaving the record awaiting_delivery and the target with a
    // spurious reminder turn for content it received.
    h.controller.markDelivered("parent", "child", "dispatch-A");
    assert.notEqual(obligation.state, "awaiting_delivery");
    assert.equal(obligation.attemptId, "dispatch-A");
  });

  it("rejects a hand-off from an older attempt after a newer attempt began", async () => {
    const h = makeController();
    const obligation = armDirect(h);
    h.controller.beginDispatch("parent", "child", "dispatch-A");
    h.controller.arm({
      sourceTaskId: "parent",
      targetTaskId: "child",
      messageId: "m-2",
      deliveryId: "d-2",
    });
    h.controller.beginDispatch("parent", "child", "dispatch-B");

    // A is now genuinely stale: a newer attempt installed its own identity.
    h.controller.markDelivered("parent", "child", "dispatch-A");
    assert.equal(obligation.state, "awaiting_delivery");
    assert.equal(obligation.attemptId, "dispatch-B");
    // The stale hand-off did not cancel the queued advisory: it still fires.
    await tick(h, DISPATCH_ADVISORY_MS);
    assert.equal(
      h.notices.filter((notice) => notice.evidence.phase === "not_handed_over")
        .length,
      1,
    );

    // The newer attempt's hand-off applies.
    h.controller.markDelivered("parent", "child", "dispatch-B");
    assert.notEqual(obligation.state, "awaiting_delivery");
    assert.equal(obligation.attemptId, "dispatch-B");
  });

  it("applies the live attempt's failure across coalescing", () => {
    const h = makeController();
    const obligation = armDirect(h);
    h.controller.beginDispatch("parent", "child", "resume-A");
    // A's resume is still in flight when a follow-up coalesces; A remains the
    // live attempt, so A's failure is the record's own transport accounting.
    h.controller.arm({
      sourceTaskId: "parent",
      targetTaskId: "child",
      messageId: "m-2",
      deliveryId: "d-2",
    });

    // Mutation evidence: treating coalescing as a supersession drops the live
    // attempt's own failure instead of counting it.
    h.controller.markDeliveryFailed("parent", "child", "resume-A");
    assert.equal(obligation.consecutiveSubmissionFailures, 1);
    assert.equal(obligation.attemptId, "resume-A");
  });

  it("ignores a resume failure from a superseded dispatch", () => {
    const h = makeController();
    const obligation = armDirect(h);
    h.controller.beginDispatch("parent", "child", "resume-A");
    // A's resume is in flight; a follow-up coalesces, then a newer attempt
    // installs its own identity.
    h.controller.arm({
      sourceTaskId: "parent",
      targetTaskId: "child",
      messageId: "m-2",
      deliveryId: "d-2",
    });
    h.controller.beginDispatch("parent", "child", "resume-B");

    // Mutation evidence: without identity scoping A's failure increments B.
    h.controller.markDeliveryFailed("parent", "child", "resume-A");
    assert.equal(obligation.consecutiveSubmissionFailures, 0);
    assert.equal(obligation.attemptId, "resume-B");

    h.controller.markDeliveryFailed("parent", "child", "resume-B");
    assert.equal(obligation.consecutiveSubmissionFailures, 1);
  });

  it("ignores an in-flight reminder outcome after a coalescing follow-up", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    h.setSubmitMode("manual");
    await tick(h);
    assert.equal(h.submissions.length, 1);
    assert.equal(obligation.state, "reminder_submitting");

    // A coalescing follow-up refreshes the budget while the reminder is in
    // flight; its epoch bump must make the old outcome count for nothing.
    h.controller.arm({
      sourceTaskId: "parent",
      targetTaskId: "child",
      messageId: "m-2",
      deliveryId: "d-2",
    });
    h.resolveSubmission(0, true);
    await tick(h);

    // Mutation evidence: without the epoch check the old reminder increments
    // the follow-up's delivered attempt.
    assert.equal(obligation.deliveredAttempts, 0);
  });

  it("clears the advisory deadlines when a record becomes terminal", async () => {
    const h = makeController();
    const obligation = armDirect(h);
    h.controller.markDeliveryFailed("parent", "child");
    h.controller.markDeliveryFailed("parent", "child");
    h.controller.markDeliveryFailed("parent", "child");
    assert.equal(obligation.state, "unresolved");
    // Cancellation, observed at the injected scheduler port: a terminal record
    // leaves no live deadline at all, so no callback can arrive.
    // Mutation evidence: leaving the queued dispatch advisory pending keeps a
    // timer armed here.
    assert.deepEqual(h.clock.pendingDeadlineTimes(), []);
    // And advancing arbitrarily far produces no further callback or notice.
    await tick(h, AGE_ADVISORY_MS * 10);
    assert.deepEqual(h.clock.pendingDeadlineTimes(), []);
    assert.equal(
      h.notices.filter((notice) => notice.reason === "still_waiting").length,
      0,
    );
  });

  it("does not let a stale hand-off take over the record", () => {
    const h = makeController();
    const obligation = armDirect(h);
    h.controller.beginDispatch("parent", "child", "dispatch-A");
    h.controller.markDelivered("parent", "child", "dispatch-B");
    // Mutation evidence: without the hand-off identity check B opens the record.
    assert.equal(obligation.state, "awaiting_delivery");
    assert.equal(obligation.attemptId, "dispatch-A");
  });

  it("ignores a turn_ended from a turn older than the observed one", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    const scheduledAt = obligation.waitingSince;
    h.controller.beginTurn("child", "turn-B");
    assert.equal(obligation.observedTurnId, "turn-B");

    // Mutation evidence: dropping the identity comparison accepts this stale
    // boundary, clearing the watchdog and the observed turn.
    h.controller.onTargetTurnEnded("child", "turn-A");
    assert.equal(obligation.observedTurnId, "turn-B");
    assert.equal(obligation.state, "reminder_due");
    assert.equal(obligation.waitingSince, scheduledAt);

    // The watchdog survived, so the silence threshold still reports.
    await tick(h, SILENCE_THRESHOLD_S * 1000);
    assert.ok(h.notices.some((notice) => notice.reason === "no_activity"));
  });

  it("accepts a turn boundary when no turn was observed (fail open)", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    h.busy.add("child");
    await tick(h);
    // The due reminder was deferred while busy; no turn_begun was observed.
    assert.equal(obligation.retrying, true);
    assert.equal(obligation.observedTurnId, undefined);

    // Mutation evidence: requiring an observed identity rejects this boundary
    // and leaves the reminder deferred.
    h.controller.onTargetTurnEnded("child", "turn-A");
    assert.equal(obligation.retrying, false);
    assert.equal(obligation.state, "reminder_due");
  });

  it("accepts a turn boundary whose identity is absent (fail open)", async () => {
    const h = makeController();
    const obligation = armOpen(h);
    h.controller.beginTurn("child", "turn-B");
    h.busy.add("child");
    await tick(h);
    assert.equal(obligation.retrying, true);

    // Older stored terminal events carry no prompt id.
    h.controller.onTargetTurnEnded("child");
    assert.equal(obligation.retrying, false);
    assert.equal(obligation.observedTurnId, undefined);
  });

  it("does not emit a silence notice after the turn is aborted", async () => {
    const h = makeController();
    armDirect(h);
    h.controller.beginTurn("child", "prompt-1");
    h.controller.abortTurn("child");
    await tick(h, SILENCE_THRESHOLD_S * 1000);
    // Mutation evidence: without abortTurn the watchdog survives the reset.
    assert.equal(h.notices.length, 0);
  });

  it("requires a live current turn for a silence notice", async () => {
    const h = makeController();
    armDirect(h);
    h.controller.beginTurn("child", "prompt-1");
    h.setTurnRunning(false);
    await tick(h, SILENCE_THRESHOLD_S * 1000);
    // Mutation evidence: dropping the live-turn guard emits a no_activity
    // notice for a turn that is no longer running.
    assert.equal(h.notices.length, 0);
  });

  it("emits a still-waiting advisory for a never-handed-over dispatch", async () => {
    const h = makeController();
    const obligation = armDirect(h);
    await tick(h, DISPATCH_ADVISORY_MS - 1);
    assert.equal(h.notices.length, 0);
    await tick(h, 1);
    // Mutation evidence: a terminal dispatch deadline would move this record
    // to a terminal state; an advisory must leave it unchanged.
    assert.equal(obligation.state, "awaiting_delivery");
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].reason, "still_waiting");
    assert.equal(h.notices[0].evidence.phase, "not_handed_over");
  });

  it("emits one age advisory per epoch without changing state", async () => {
    const h = makeController();
    const obligation = armDirect(h);
    await tick(h, AGE_ADVISORY_MS);
    const age = h.notices.find(
      (notice) => notice.evidence.phase === "no_account",
    );
    // Mutation evidence: a terminal age deadline would move this to a terminal
    // state instead of advising.
    assert.ok(age);
    assert.equal(age.reason, "still_waiting");
    assert.equal(obligation.state, "awaiting_delivery");

    // One per epoch: the timer is not re-armed.
    const before = h.notices.length;
    await tick(h, AGE_ADVISORY_MS);
    assert.equal(h.notices.length, before);

    // A coalescing follow-up resets the age, so a fresh epoch advises again.
    h.controller.arm({
      sourceTaskId: "parent",
      targetTaskId: "child",
      messageId: "m-2",
      deliveryId: "d-2",
    });
    await tick(h, AGE_ADVISORY_MS);
    assert.equal(
      h.notices.filter((notice) => notice.evidence.phase === "no_account")
        .length,
      2,
    );
  });

  it("clears the not-handed-over advisory once the dispatch is handed over", async () => {
    const h = makeController();
    armOpen(h);
    // Mutation evidence: not cancelling it at hand-off emits the queued
    // advisory for a dispatch that was delivered.
    await tick(h, DISPATCH_ADVISORY_MS);
    assert.equal(
      h.notices.filter((notice) => notice.evidence.phase === "not_handed_over")
        .length,
      0,
    );
  });

  it("does not start a watchdog without an active obligation", async () => {
    const h = makeController();
    h.controller.beginTurn("child", "prompt-4");
    await tick(h, SILENCE_THRESHOLD_S * 2000);
    assert.equal(h.notices.length, 0);
  });
});
