/**
 * Directed dispatch closure.
 *
 * A qualifying direct parent→child dispatch arms exactly one process-local
 * directed obligation per `(sourceTaskId, targetTaskId)` edge. The source
 * learns exactly one outcome: a typed `task_update(done|blocked)` account from
 * an eligible target turn, or one runtime `no_account` notice once bounded
 * recovery is exhausted.
 *
 * There is no correlation token. Because a target has one direct parent, the
 * current record for the target is unambiguous: settlement is decided from the
 * record's state and the target's active agent turn, not from a value the
 * agent must echo back.
 *
 * Every external event enters through `apply(fact)`. A fact is named, carries
 * the identity of the turn it describes, and is a no-op when that identity does
 * not match the record's current identity. `apply` is the single transition
 * point: no other method mutates the record or arms a timer.
 */

/** Successful closing prompts a target may receive before `unresolved`. */
export const MAX_REMINDER_ATTEMPTS = 3;

/**
 * Consecutive rejected reminder submissions before the edge is declared
 * `unresolved`. This is a transport bound, not a reminder-attempt count: a
 * rejected submission never consumes a reminder attempt, so without this the
 * source could wait forever while the successful-delivery budget is never
 * spent.
 */
export const MAX_REMINDER_SUBMISSION_FAILURES = 3;

/**
 * Delay before reminder `n` (1-indexed) from the preceding *delivered*
 * reminder (for reminder 1, from the turn boundary that entered
 * `reminder_due`).
 */
export const REMINDER_DELAYS_MS = [0, 2 * 60_000, 5 * 60_000] as const;

/** Base retry delay after a rejected submission or while the target is busy. */
export const REMINDER_RETRY_BASE_MS = 1_000;

/** Upper bound for the exponential retry delay. */
export const REMINDER_RETRY_MAX_MS = 60_000;

/**
 * A running target turn with an active obligation and no qualifying agent
 * activity for this long emits one heuristic `no_activity` notice. The notice
 * never changes obligation state.
 */
export const SILENCE_THRESHOLD_S = 900;

/**
 * Advisory: an armed dispatch that has still not been handed to the target's
 * session (for example queued behind a busy target or waiting on a resume).
 * The runtime reports the fact and keeps waiting; it does not conclude.
 */
export const DISPATCH_ADVISORY_MS = 60 * 60_000;

/**
 * Advisory: a record has existed for this long with no typed account. The
 * runtime reports how long it has waited and keeps waiting; it does not
 * conclude about the work.
 */
export const AGE_ADVISORY_MS = 4 * 60 * 60_000;

export type ObligationState =
  | "awaiting_delivery"
  | "open"
  | "reminder_due"
  | "reminder_submitting"
  | "unresolved"
  | "settled";

export type ObligationTimerKind =
  | "attempt"
  | "watchdog"
  | "dispatch_advisory"
  | "age_advisory";

/**
 * Read-only projection of a live record. The mutable record type stays private
 * to this module: callers observe state and feed facts, never write fields.
 */
export interface ObligationView {
  readonly sourceTaskId: string;
  readonly targetTaskId: string;
  readonly openingMessageId: string;
  readonly openingDeliveryId: string;
  readonly openedAt: number;
  /**
   * Turn identity (promptId) of the live dispatch attempt that owns this
   * record. Installed at the start of that attempt's drain and replaced only by
   * a newer attempt's drain; a coalescing follow-up keeps it.
   */
  readonly dispatchPromptId?: string;
  /**
   * Recovery-budget generation. A coalescing follow-up bumps it so an
   * in-flight reminder submission from the previous generation is ignored.
   * Deliberately distinct from hand-off ownership.
   */
  readonly epoch: number;
  readonly state: ObligationState;
  readonly deliveredAttempts: number;
  readonly consecutiveSubmissionFailures: number;
  readonly lastDeliveredAttemptAt?: number;
  readonly nextAttemptAt?: number;
  readonly noAccountNotified: boolean;
}

interface ObligationRecord {
  sourceTaskId: string;
  targetTaskId: string;
  openingMessageId: string;
  openingDeliveryId: string;
  openedAt: number;
  dispatchPromptId?: string;
  epoch: number;
  state: ObligationState;
  deliveredAttempts: number;
  consecutiveSubmissionFailures: number;
  lastDeliveredAttemptAt?: number;
  nextAttemptAt?: number;
  noAccountNotified: boolean;
}

/**
 * The named vocabulary of external events. Every fact carries the identity of
 * the turn it describes: dispatch-scoped facts carry the dispatch attempt id,
 * the reminder outcome carries the recovery generation. A fact whose identity
 * does not match the record is a no-op.
 */
export type ObligationFact =
  | {
      type: "armed";
      sourceTaskId: string;
      targetTaskId: string;
      messageId: string;
      deliveryId: string;
    }
  | {
      type: "attempt_begun";
      sourceTaskId: string;
      targetTaskId: string;
      attemptId: string;
    }
  | {
      type: "handed_over";
      sourceTaskId: string;
      targetTaskId: string;
      attemptId?: string;
    }
  | {
      type: "dispatch_succeeded";
      sourceTaskId: string;
      targetTaskId: string;
      attemptId?: string;
    }
  | {
      type: "dispatch_failed";
      sourceTaskId: string;
      targetTaskId: string;
      attemptId?: string;
    }
  | { type: "turn_begun"; targetTaskId: string; attemptId: string }
  | { type: "turn_ended"; targetTaskId: string }
  | { type: "turn_aborted"; targetTaskId: string }
  | { type: "agent_activity"; targetTaskId: string; at: number }
  | { type: "released"; taskId: string }
  | { type: "reminder_started"; sourceTaskId: string; targetTaskId: string }
  | {
      type: "reminder_resolved";
      sourceTaskId: string;
      targetTaskId: string;
      recoveryGeneration: number;
      accepted: boolean;
    }
  | {
      type: "timer_due";
      sourceTaskId: string;
      targetTaskId: string;
      kind: ObligationTimerKind;
      attemptId?: string;
    }
  | {
      type: "settle_requested";
      targetTaskId: string;
      activeTurn: ActiveAgentTurn | null;
      run: (decision: SettlementDecision) => unknown;
    }
  | { type: "disposed" };

/** Compatibility alias: the read-only record projection callers observe. */
export type DirectedObligation = ObligationView;

export type ObligationNoticeReason =
  | "no_account"
  | "no_activity"
  | "still_waiting"
  | "delivery_failed";

export interface ObligationNotice {
  reason: ObligationNoticeReason;
  /** Human-readable fact statement, safe to show verbatim to the recipient. */
  message: string;
  evidence: Record<string, unknown>;
}

export interface ActiveAgentTurn {
  promptId: string;
  /** Turn start, epoch ms. */
  startedAt: number;
}

/**
 * How one agent update should be routed. `settle` and `stored-source` both
 * address the record's stored source; `current-parent` is an ordinary report
 * with no record to address.
 */
export interface SettlementDecision {
  kind: "settle" | "stored-source" | "current-parent";
  sourceTaskId: string | null;
}

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface ObligationControllerOptions {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  /** True while the target has an ACP turn (or an equivalent delivery) running. */
  isAgentBusy: (taskId: string) => boolean;
  /**
   * True when `promptId` is still the target's live turn. A silence notice is
   * emitted only for a live turn, so a runtime reset that clears busy state
   * without going through a turn-end fact cannot produce a stale notice.
   */
  isTurnRunning?: (taskId: string, promptId: string) => boolean;
  /**
   * Submit a closing accounting prompt to the target. Resolves `true` only
   * when the bridge accepts (and the turn completes); a rejected submission
   * must resolve `false`.
   */
  submitReminder: (obligation: ObligationView) => Promise<boolean>;
  /**
   * Retry the original dispatch at an idle boundary after its prompt was
   * rejected. A successful retry re-enters through a hand-off fact; a failure
   * through a dispatch-failure fact.
   */
  retryDispatch: (obligation: ObligationView) => void;
  /** Emit a runtime `task_outcome_notice` to the obligation's source. */
  emitNotice: (notice: ObligationNotice, obligation: ObligationView) => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

interface WatchdogState {
  promptId: string;
  runningSince: number;
  lastAgentActivityAt: number;
}

function edgeKey(sourceTaskId: string, targetTaskId: string): string {
  return `${sourceTaskId}\u0000${targetTaskId}`;
}

function silenceKey(targetTaskId: string, promptId: string): string {
  return `${targetTaskId}\u0000${promptId}`;
}

/**
 * Strict, uniform attempt-identity comparison: a fact carrying identity X
 * applies only when the record's current identity is exactly X (both
 * `undefined` counts as "no identity"). Only a fact from the live dispatch
 * attempt — or from the drain that owns it — applies.
 */
function matchesDispatch(
  obligation: ObligationRecord,
  attemptId: string | undefined,
): boolean {
  return obligation.dispatchPromptId === attemptId;
}

/** No further supervision: the runtime has stopped, or the record is settled. */
function isTerminal(state: ObligationState): boolean {
  return state === "unresolved" || state === "settled";
}

/**
 * A typed account can settle the record. `unresolved` stays settleable: the
 * runtime stopped its own attempts, but a later account still resolves the
 * edge. `settled` is the only state that cannot be settled again.
 */
function isSettleable(state: ObligationState): boolean {
  return (
    state === "open" ||
    state === "reminder_due" ||
    state === "reminder_submitting" ||
    state === "unresolved"
  );
}

function logFields(obligation: ObligationRecord): Record<string, unknown> {
  return {
    sourceTaskId: obligation.sourceTaskId.slice(0, 8),
    targetTaskId: obligation.targetTaskId.slice(0, 8),
  };
}

/**
 * Process-local directed-obligation state machine. All transitions are
 * synchronous; the only asynchronous work is bridge submission, and its
 * completion re-enters through a fresh fact.
 *
 * Terminal records stay in the edge-keyed map so a later account can still be
 * routed to the stored source. A later dispatch for the same edge replaces a
 * terminal record.
 */
export class ObligationController {
  private readonly active = new Map<string, ObligationRecord>();
  private readonly attemptTimers = new Map<string, TimerHandle>();
  private readonly watchdogTimers = new Map<string, TimerHandle>();
  private readonly dispatchAdvisoryTimers = new Map<string, TimerHandle>();
  private readonly ageAdvisoryTimers = new Map<string, TimerHandle>();
  private readonly watchdog = new Map<string, WatchdogState>();
  private readonly silenceNotified = new Set<string>();
  private readonly opts: ObligationControllerOptions;

  constructor(options: ObligationControllerOptions) {
    this.opts = options;
  }

  private now(): number {
    return this.opts.now();
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.opts.log?.(event, fields);
  }

  /**
   * The single transition point. Every fact is applied here; a fact whose
   * identity does not match the current record is a no-op.
   */
  apply(fact: ObligationFact): unknown {
    switch (fact.type) {
      case "armed":
        this.transitionArmed(fact);
        return undefined;
      case "attempt_begun":
        this.transitionAttemptBegun(fact);
        return undefined;
      case "handed_over":
        this.transitionHandedOver(fact);
        return undefined;
      case "dispatch_succeeded":
        this.transitionDispatchSucceeded(fact);
        return undefined;
      case "dispatch_failed":
        this.transitionDispatchFailed(fact);
        return undefined;
      case "turn_begun":
        this.transitionTurnBegun(fact);
        return undefined;
      case "turn_ended":
        this.transitionTurnEnded(fact);
        return undefined;
      case "turn_aborted":
        this.transitionTurnAborted(fact);
        return undefined;
      case "agent_activity":
        this.transitionAgentActivity(fact);
        return undefined;
      case "released":
        this.transitionReleased(fact);
        return undefined;
      case "reminder_started":
        this.transitionReminderStarted(fact);
        return undefined;
      case "reminder_resolved":
        this.transitionReminderResolved(fact);
        return undefined;
      case "timer_due":
        this.transitionTimerDue(fact);
        return undefined;
      case "settle_requested":
        return this.transitionSettle(fact);
      case "disposed":
        this.transitionDisposed();
        return undefined;
    }
  }

  // --- Public fact emitters (no mutation; they only call apply) ---

  getActive(
    sourceTaskId: string,
    targetTaskId: string,
  ): ObligationView | undefined {
    return this.active.get(edgeKey(sourceTaskId, targetTaskId));
  }

  /** The sole record for a target, active or terminal. */
  getForTarget(targetTaskId: string): ObligationView | undefined {
    return this.findForTarget(targetTaskId);
  }

  isOwed(sourceTaskId: string, targetTaskId: string): boolean {
    const obligation = this.active.get(edgeKey(sourceTaskId, targetTaskId));
    return obligation !== undefined && !isTerminal(obligation.state);
  }

  arm(input: {
    sourceTaskId: string;
    targetTaskId: string;
    messageId: string;
    deliveryId: string;
  }): ObligationView {
    this.apply({
      type: "armed",
      sourceTaskId: input.sourceTaskId,
      targetTaskId: input.targetTaskId,
      messageId: input.messageId,
      deliveryId: input.deliveryId,
    });
    return this.active.get(edgeKey(input.sourceTaskId, input.targetTaskId))!;
  }

  beginDispatch(
    sourceTaskId: string,
    targetTaskId: string,
    promptId: string,
  ): void {
    this.apply({
      type: "attempt_begun",
      sourceTaskId,
      targetTaskId,
      attemptId: promptId,
    });
  }

  markDelivered(
    sourceTaskId: string,
    targetTaskId: string,
    promptId?: string,
  ): void {
    this.apply({
      type: "handed_over",
      sourceTaskId,
      targetTaskId,
      attemptId: promptId,
    });
  }

  markDispatchSucceeded(
    sourceTaskId: string,
    targetTaskId: string,
    promptId?: string,
  ): void {
    this.apply({
      type: "dispatch_succeeded",
      sourceTaskId,
      targetTaskId,
      attemptId: promptId,
    });
  }

  markDeliveryFailed(
    sourceTaskId: string,
    targetTaskId: string,
    promptId?: string,
  ): void {
    this.apply({
      type: "dispatch_failed",
      sourceTaskId,
      targetTaskId,
      attemptId: promptId,
    });
  }

  onTargetTurnEnded(targetTaskId: string): void {
    this.apply({ type: "turn_ended", targetTaskId });
  }

  beginTurn(targetTaskId: string, promptId: string): void {
    this.apply({ type: "turn_begun", targetTaskId, attemptId: promptId });
  }

  noteAgentActivity(targetTaskId: string): void {
    this.apply({ type: "agent_activity", targetTaskId, at: this.now() });
  }

  abortTurn(targetTaskId: string): void {
    this.apply({ type: "turn_aborted", targetTaskId });
  }

  purgeTask(taskId: string): void {
    this.apply({ type: "released", taskId });
  }

  dispose(): void {
    this.apply({ type: "disposed" });
  }

  settleReport<T>(input: {
    targetTaskId: string;
    activeTurn: ActiveAgentTurn | null;
    run: (decision: SettlementDecision) => T;
  }): { decision: SettlementDecision; result: T } {
    return this.apply({
      type: "settle_requested",
      targetTaskId: input.targetTaskId,
      activeTurn: input.activeTurn,
      run: (decision) => input.run(decision),
    }) as { decision: SettlementDecision; result: T };
  }

  // --- Timer helpers (armed only from within apply's call graph) ---

  private clearAttemptTimer(key: string): void {
    const handle = this.attemptTimers.get(key);
    if (handle === undefined) return;
    this.attemptTimers.delete(key);
    this.opts.clearTimer(handle);
  }

  private clearWatchdogTimer(key: string): void {
    const handle = this.watchdogTimers.get(key);
    if (handle === undefined) return;
    this.watchdogTimers.delete(key);
    this.opts.clearTimer(handle);
  }

  private clearDispatchAdvisory(key: string): void {
    const handle = this.dispatchAdvisoryTimers.get(key);
    if (handle === undefined) return;
    this.dispatchAdvisoryTimers.delete(key);
    this.opts.clearTimer(handle);
  }

  private clearAgeAdvisory(key: string): void {
    const handle = this.ageAdvisoryTimers.get(key);
    if (handle === undefined) return;
    this.ageAdvisoryTimers.delete(key);
    this.opts.clearTimer(handle);
  }

  private timerDue(
    obligation: ObligationRecord,
    kind: ObligationTimerKind,
    attemptId?: string,
  ): void {
    this.apply({
      type: "timer_due",
      sourceTaskId: obligation.sourceTaskId,
      targetTaskId: obligation.targetTaskId,
      kind,
      attemptId,
    });
  }

  private armDispatchAdvisory(obligation: ObligationRecord): void {
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    this.clearDispatchAdvisory(key);
    const handle = this.opts.setTimer(() => {
      this.dispatchAdvisoryTimers.delete(key);
      this.timerDue(obligation, "dispatch_advisory");
    }, DISPATCH_ADVISORY_MS);
    this.dispatchAdvisoryTimers.set(key, handle);
  }

  private armAgeAdvisory(obligation: ObligationRecord): void {
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    this.clearAgeAdvisory(key);
    const handle = this.opts.setTimer(() => {
      this.ageAdvisoryTimers.delete(key);
      this.timerDue(obligation, "age_advisory");
    }, AGE_ADVISORY_MS);
    this.ageAdvisoryTimers.set(key, handle);
  }

  private armAttemptTimer(obligation: ObligationRecord, delayMs: number): void {
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    this.clearAttemptTimer(key);
    const handle = this.opts.setTimer(
      () => {
        this.attemptTimers.delete(key);
        this.timerDue(obligation, "attempt");
      },
      Math.max(0, delayMs),
    );
    this.attemptTimers.set(key, handle);
  }

  private armWatchdog(
    obligation: ObligationRecord,
    state: WatchdogState,
  ): void {
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    this.clearWatchdogTimer(key);
    const dueAt = state.lastAgentActivityAt + SILENCE_THRESHOLD_S * 1000;
    const handle = this.opts.setTimer(
      () => {
        this.watchdogTimers.delete(key);
        this.timerDue(obligation, "watchdog", state.promptId);
      },
      Math.max(0, dueAt - this.now()),
    );
    this.watchdogTimers.set(key, handle);
  }

  // --- Transition table (each row is reachable only through apply) ---

  private transitionArmed(
    fact: Extract<ObligationFact, { type: "armed" }>,
  ): void {
    const key = edgeKey(fact.sourceTaskId, fact.targetTaskId);
    const existing = this.active.get(key);
    if (existing && !isTerminal(existing.state)) {
      this.clearAttemptTimer(key);
      existing.deliveredAttempts = 0;
      existing.consecutiveSubmissionFailures = 0;
      existing.noAccountNotified = false;
      existing.lastDeliveredAttemptAt = undefined;
      existing.openingMessageId = fact.messageId;
      existing.openingDeliveryId = fact.deliveryId;
      existing.epoch += 1;
      if (
        existing.state === "reminder_due" ||
        existing.state === "reminder_submitting"
      ) {
        existing.state = "open";
      }
      this.armDispatchAdvisory(existing);
      this.armAgeAdvisory(existing);
      this.log("obligation coalesced", {
        ...logFields(existing),
        state: existing.state,
      });
      return;
    }

    const obligation: ObligationRecord = {
      sourceTaskId: fact.sourceTaskId,
      targetTaskId: fact.targetTaskId,
      openingMessageId: fact.messageId,
      openingDeliveryId: fact.deliveryId,
      openedAt: this.now(),
      epoch: 0,
      state: "awaiting_delivery",
      deliveredAttempts: 0,
      consecutiveSubmissionFailures: 0,
      noAccountNotified: false,
    };
    this.active.set(key, obligation);
    this.armDispatchAdvisory(obligation);
    this.armAgeAdvisory(obligation);
    this.log("obligation armed", {
      ...logFields(obligation),
      replacedTerminal: existing !== undefined,
    });
  }

  private transitionAttemptBegun(
    fact: Extract<ObligationFact, { type: "attempt_begun" }>,
  ): void {
    const obligation = this.active.get(
      edgeKey(fact.sourceTaskId, fact.targetTaskId),
    );
    if (!obligation || isTerminal(obligation.state)) return;
    obligation.dispatchPromptId = fact.attemptId;
  }

  private transitionHandedOver(
    fact: Extract<ObligationFact, { type: "handed_over" }>,
  ): void {
    const key = edgeKey(fact.sourceTaskId, fact.targetTaskId);
    const obligation = this.active.get(key);
    if (!obligation) return;
    if (
      obligation.state !== "awaiting_delivery" &&
      obligation.state !== "open"
    ) {
      return;
    }
    if (!matchesDispatch(obligation, fact.attemptId)) return;
    if (fact.attemptId !== undefined)
      obligation.dispatchPromptId = fact.attemptId;
    this.clearDispatchAdvisory(key);
    this.clearAttemptTimer(key);
    obligation.state = "open";
    this.log("obligation opened", logFields(obligation));
    this.maybeRemindAtBoundary(obligation);
  }

  private transitionDispatchSucceeded(
    fact: Extract<ObligationFact, { type: "dispatch_succeeded" }>,
  ): void {
    const obligation = this.active.get(
      edgeKey(fact.sourceTaskId, fact.targetTaskId),
    );
    if (!obligation) return;
    if (!matchesDispatch(obligation, fact.attemptId)) return;
    if (isTerminal(obligation.state)) return;
    obligation.consecutiveSubmissionFailures = 0;
  }

  private transitionDispatchFailed(
    fact: Extract<ObligationFact, { type: "dispatch_failed" }>,
  ): void {
    const obligation = this.active.get(
      edgeKey(fact.sourceTaskId, fact.targetTaskId),
    );
    if (!obligation) return;
    if (!matchesDispatch(obligation, fact.attemptId)) return;
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    const dispatchPhase =
      obligation.state === "awaiting_delivery" ||
      obligation.state === "open" ||
      (obligation.state === "reminder_due" &&
        obligation.deliveredAttempts === 0);
    if (!dispatchPhase) return;
    this.clearAttemptTimer(key);
    this.clearWatchdogTimer(key);
    this.watchdog.delete(key);
    obligation.state = "awaiting_delivery";
    obligation.consecutiveSubmissionFailures += 1;
    if (
      obligation.consecutiveSubmissionFailures >=
      MAX_REMINDER_SUBMISSION_FAILURES
    ) {
      this.exhaust(obligation, "delivery_failed", {
        deliveryUnavailable: true,
      });
      return;
    }
    this.log("obligation dispatch retry scheduled", {
      ...logFields(obligation),
      consecutiveSubmissionFailures: obligation.consecutiveSubmissionFailures,
    });
    this.retrySchedule(obligation);
  }

  private transitionTurnEnded(
    fact: Extract<ObligationFact, { type: "turn_ended" }>,
  ): void {
    const obligation = this.findForTarget(fact.targetTaskId);
    if (!obligation) return;
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    this.clearWatchdogTimer(key);
    this.watchdog.delete(key);
    if (obligation.state === "open") {
      this.maybeRemindAtBoundary(obligation);
      return;
    }
    if (
      obligation.state === "reminder_due" &&
      obligation.deliveredAttempts === 0
    ) {
      this.scheduleNextAttempt(obligation);
    }
  }

  private transitionTurnBegun(
    fact: Extract<ObligationFact, { type: "turn_begun" }>,
  ): void {
    const obligation = this.findForTarget(fact.targetTaskId);
    if (!obligation || isTerminal(obligation.state)) return;
    this.startWatchdog(obligation, fact.attemptId);
  }

  private transitionAgentActivity(
    fact: Extract<ObligationFact, { type: "agent_activity" }>,
  ): void {
    const obligation = this.findForTarget(fact.targetTaskId);
    if (!obligation || isTerminal(obligation.state)) return;
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    const state = this.watchdog.get(key);
    if (!state) return;
    state.lastAgentActivityAt = fact.at;
    this.armWatchdog(obligation, state);
  }

  private transitionTurnAborted(
    fact: Extract<ObligationFact, { type: "turn_aborted" }>,
  ): void {
    const obligation = this.findForTarget(fact.targetTaskId);
    if (!obligation) return;
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    this.clearWatchdogTimer(key);
    this.watchdog.delete(key);
  }

  private transitionReleased(
    fact: Extract<ObligationFact, { type: "released" }>,
  ): void {
    for (const [key, obligation] of [...this.active]) {
      if (
        obligation.sourceTaskId !== fact.taskId &&
        obligation.targetTaskId !== fact.taskId
      ) {
        continue;
      }
      this.clearAttemptTimer(key);
      this.clearWatchdogTimer(key);
      this.clearDispatchAdvisory(key);
      this.clearAgeAdvisory(key);
      this.watchdog.delete(key);
      this.active.delete(key);
    }
    for (const seen of [...this.silenceNotified]) {
      if (seen.startsWith(`${fact.taskId}\u0000`)) {
        this.silenceNotified.delete(seen);
      }
    }
  }

  private transitionReminderStarted(
    fact: Extract<ObligationFact, { type: "reminder_started" }>,
  ): void {
    const obligation = this.active.get(
      edgeKey(fact.sourceTaskId, fact.targetTaskId),
    );
    if (!obligation) return;
    obligation.state = "reminder_submitting";
    this.clearAttemptTimer(
      edgeKey(obligation.sourceTaskId, obligation.targetTaskId),
    );
  }

  private transitionReminderResolved(
    fact: Extract<ObligationFact, { type: "reminder_resolved" }>,
  ): void {
    const key = edgeKey(fact.sourceTaskId, fact.targetTaskId);
    const obligation = this.active.get(key);
    if (!obligation) return;
    if (obligation.state === "settled" || obligation.state === "unresolved") {
      return;
    }
    if (obligation.epoch !== fact.recoveryGeneration) return;
    if (!fact.accepted) {
      obligation.consecutiveSubmissionFailures += 1;
      if (
        obligation.consecutiveSubmissionFailures >=
        MAX_REMINDER_SUBMISSION_FAILURES
      ) {
        this.exhaust(obligation, "delivery_failed", {
          deliveryUnavailable: true,
        });
        return;
      }
      obligation.state = "reminder_due";
      this.retrySchedule(obligation);
      return;
    }
    obligation.deliveredAttempts += 1;
    obligation.lastDeliveredAttemptAt = this.now();
    obligation.consecutiveSubmissionFailures = 0;
    this.log("obligation reminder delivered", {
      ...logFields(obligation),
      deliveredAttempts: obligation.deliveredAttempts,
    });
    if (obligation.deliveredAttempts >= MAX_REMINDER_ATTEMPTS) {
      this.exhaust(obligation, "no_account");
      return;
    }
    obligation.state = "reminder_due";
    this.scheduleNextAttempt(obligation);
  }

  private transitionTimerDue(
    fact: Extract<ObligationFact, { type: "timer_due" }>,
  ): void {
    const key = edgeKey(fact.sourceTaskId, fact.targetTaskId);
    const obligation = this.active.get(key);
    if (!obligation) return;
    switch (fact.kind) {
      case "dispatch_advisory": {
        if (obligation.state !== "awaiting_delivery") return;
        this.log("obligation dispatch still queued", logFields(obligation));
        this.opts.emitNotice(
          {
            reason: "still_waiting",
            message: `This dispatch has not been handed to the target for ${Math.round(
              (this.now() - obligation.openedAt) / 60_000,
            )} minutes; it is still queued.`,
            evidence: {
              phase: "not_handed_over",
              waitingMs: this.now() - obligation.openedAt,
            },
          },
          obligation,
        );
        return;
      }
      case "age_advisory": {
        if (isTerminal(obligation.state)) return;
        const lastAgentActivityAt =
          this.watchdog.get(key)?.lastAgentActivityAt ?? null;
        this.log("obligation age advisory", logFields(obligation));
        this.opts.emitNotice(
          {
            reason: "still_waiting",
            message: `This Task has had no typed account for ${Math.round(
              (this.now() - obligation.openedAt) / 3_600_000,
            )} hours; the runtime is still waiting.`,
            evidence: {
              phase: "no_account",
              openForMs: this.now() - obligation.openedAt,
              deliveredAttempts: obligation.deliveredAttempts,
              lastAgentActivityAt,
            },
          },
          obligation,
        );
        return;
      }
      case "watchdog":
        this.emitSilence(obligation, fact.attemptId);
        return;
      case "attempt":
        this.runAttempt(obligation);
        return;
    }
  }

  private transitionSettle(
    fact: Extract<ObligationFact, { type: "settle_requested" }>,
  ): { decision: SettlementDecision; result: unknown } {
    const obligation = this.findForTarget(fact.targetTaskId);
    if (!obligation) {
      const decision: SettlementDecision = {
        kind: "current-parent",
        sourceTaskId: null,
      };
      return { decision, result: fact.run(decision) };
    }
    const settleable =
      isSettleable(obligation.state) && fact.activeTurn !== null;
    if (!settleable) {
      const decision: SettlementDecision = {
        kind: "stored-source",
        sourceTaskId: obligation.sourceTaskId,
      };
      return { decision, result: fact.run(decision) };
    }
    const decision: SettlementDecision = {
      kind: "settle",
      sourceTaskId: obligation.sourceTaskId,
    };
    const result = fact.run(decision);
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    this.clearAttemptTimer(key);
    this.clearWatchdogTimer(key);
    this.clearDispatchAdvisory(key);
    this.clearAgeAdvisory(key);
    this.watchdog.delete(key);
    obligation.state = "settled";
    this.log("obligation settled", logFields(obligation));
    return { decision, result };
  }

  private transitionDisposed(): void {
    for (const handle of this.attemptTimers.values()) {
      this.opts.clearTimer(handle);
    }
    for (const handle of this.watchdogTimers.values()) {
      this.opts.clearTimer(handle);
    }
    for (const handle of this.dispatchAdvisoryTimers.values()) {
      this.opts.clearTimer(handle);
    }
    for (const handle of this.ageAdvisoryTimers.values()) {
      this.opts.clearTimer(handle);
    }
    this.attemptTimers.clear();
    this.watchdogTimers.clear();
    this.dispatchAdvisoryTimers.clear();
    this.ageAdvisoryTimers.clear();
    this.watchdog.clear();
  }

  // --- Effect helpers (called only from transition rows) ---

  private startWatchdog(obligation: ObligationRecord, promptId: string): void {
    const at = this.now();
    const state: WatchdogState = {
      promptId,
      runningSince: at,
      lastAgentActivityAt: at,
    };
    this.watchdog.set(
      edgeKey(obligation.sourceTaskId, obligation.targetTaskId),
      state,
    );
    this.armWatchdog(obligation, state);
  }

  private maybeRemindAtBoundary(obligation: ObligationRecord): void {
    if (isTerminal(obligation.state)) return;
    if (obligation.state === "reminder_submitting") return;
    if (obligation.deliveredAttempts >= MAX_REMINDER_ATTEMPTS) {
      this.exhaust(obligation, "no_account");
      return;
    }
    obligation.state = "reminder_due";
    this.scheduleNextAttempt(obligation);
  }

  private scheduleNextAttempt(obligation: ObligationRecord): void {
    const index = obligation.deliveredAttempts;
    const delay = REMINDER_DELAYS_MS[index] ?? 0;
    const base =
      index === 0
        ? this.now()
        : (obligation.lastDeliveredAttemptAt ?? this.now());
    obligation.nextAttemptAt = base + delay;
    this.armAttemptTimer(obligation, obligation.nextAttemptAt - this.now());
  }

  private retrySchedule(obligation: ObligationRecord): void {
    const failures = obligation.consecutiveSubmissionFailures;
    const backoff = Math.min(
      REMINDER_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1),
      REMINDER_RETRY_MAX_MS,
    );
    obligation.nextAttemptAt = this.now() + backoff;
    this.armAttemptTimer(obligation, backoff);
  }

  /** Scheduler entry point: submit only while the target is idle. */
  private runAttempt(obligation: ObligationRecord): void {
    if (obligation.state === "awaiting_delivery") {
      if (this.opts.isAgentBusy(obligation.targetTaskId)) {
        this.retrySchedule(obligation);
        return;
      }
      this.opts.retryDispatch(obligation);
      return;
    }
    if (obligation.state !== "reminder_due") return;
    if (this.opts.isAgentBusy(obligation.targetTaskId)) {
      this.retrySchedule(obligation);
      return;
    }
    void this.submit(obligation);
  }

  private async submit(obligation: ObligationRecord): Promise<void> {
    const generation = obligation.epoch;
    this.apply({
      type: "reminder_started",
      sourceTaskId: obligation.sourceTaskId,
      targetTaskId: obligation.targetTaskId,
    });
    const accepted = await this.opts.submitReminder(obligation);
    this.apply({
      type: "reminder_resolved",
      sourceTaskId: obligation.sourceTaskId,
      targetTaskId: obligation.targetTaskId,
      recoveryGeneration: generation,
      accepted,
    });
  }

  private exhaust(
    obligation: ObligationRecord,
    reason: Extract<ObligationNoticeReason, "no_account" | "delivery_failed">,
    extraEvidence: Record<string, unknown> = {},
  ): void {
    if (obligation.state === "unresolved") return;
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    this.clearAttemptTimer(key);
    this.clearWatchdogTimer(key);
    this.clearDispatchAdvisory(key);
    this.clearAgeAdvisory(key);
    this.watchdog.delete(key);
    obligation.state = "unresolved";
    if (obligation.noAccountNotified) return;
    obligation.noAccountNotified = true;
    const evidence: Record<string, unknown> = {
      deliveredAttempts: obligation.deliveredAttempts,
      consecutiveSubmissionFailures: obligation.consecutiveSubmissionFailures,
      lastDeliveredAttemptAt: obligation.lastDeliveredAttemptAt ?? null,
      ...extraEvidence,
    };
    const message =
      reason === "delivery_failed"
        ? `I could not deliver this dispatch after ${obligation.consecutiveSubmissionFailures} attempts; I have stopped.`
        : `No typed done|blocked account arrived after ${obligation.deliveredAttempts} delivered reminders; the runtime has stopped its own attempts. The outcome is unknown.`;
    this.opts.emitNotice({ reason, message, evidence }, obligation);
    this.log("obligation unresolved", {
      ...logFields(obligation),
      reason,
      evidence,
    });
  }

  private findForTarget(targetTaskId: string): ObligationRecord | undefined {
    for (const obligation of this.active.values()) {
      if (obligation.targetTaskId === targetTaskId) return obligation;
    }
    return undefined;
  }

  private emitSilence(
    obligation: ObligationRecord,
    attemptId: string | undefined,
  ): void {
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    if (this.active.get(key) !== obligation) return;
    const state = this.watchdog.get(key);
    if (!state) return;
    if (attemptId !== undefined && state.promptId !== attemptId) return;
    if (
      this.opts.isTurnRunning &&
      !this.opts.isTurnRunning(obligation.targetTaskId, state.promptId)
    ) {
      this.clearWatchdogTimer(key);
      this.watchdog.delete(key);
      return;
    }
    const seen = silenceKey(obligation.targetTaskId, state.promptId);
    if (this.silenceNotified.has(seen)) return;
    this.silenceNotified.add(seen);
    this.opts.emitNotice(
      {
        reason: "no_activity",
        message: `No agent activity for ${Math.round(
          (this.now() - state.lastAgentActivityAt) / 1000,
        )} seconds; the turn is still running.`,
        evidence: {
          runningSince: state.runningSince,
          lastAgentActivityAt: state.lastAgentActivityAt,
          promptId: state.promptId,
        },
      },
      obligation,
    );
    this.log("obligation silence notice", {
      ...logFields(obligation),
      promptId: state.promptId,
    });
  }
}
