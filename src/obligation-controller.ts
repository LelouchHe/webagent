import { randomUUID } from "node:crypto";

/**
 * Directed dispatch closure.
 *
 * A qualifying direct parent→child dispatch arms exactly one process-local
 * directed obligation. The source learns exactly one outcome: a correlated
 * typed `task_update(done|blocked)` account, or one runtime `no_account`
 * notice once bounded recovery is exhausted. Obligation state is runtime
 * memory, never SQLite, and never survives a restart.
 *
 * The obligation id is an opaque correlation receipt, not an intent or
 * expectation control: it tells the runtime which open edge an account closes,
 * and nothing about why the account was requested. Ordinary unspecialized
 * communication stays `task_send`.
 *
 * Only direct parent→child dispatch calls `arm()`; creation, user prompts,
 * sibling/child messages, reminders, cancellation, supersession, rotation,
 * and incoming status/notice messages neither arm nor settle an edge.
 */

/** Successful closing prompts a target may receive before `unanswered`. */
export const MAX_REMINDER_ATTEMPTS = 3;

/**
 * Consecutive rejected reminder submissions before the edge is declared
 * `unanswered`. This is a transport bound, not a reminder-attempt count: a
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

/** Terminal records retained for late-account routing; oldest are evicted. */
export const MAX_ARCHIVED_OBLIGATIONS = 1024;

export type ObligationState =
  | "awaiting_delivery"
  | "open"
  | "reminder_due"
  | "reminder_submitting"
  | "unanswered"
  | "settled";

export interface DirectedObligation {
  id: string;
  sourceTaskId: string;
  targetTaskId: string;
  openingMessageId: string;
  openingDeliveryId: string;
  openedAt: number;
  state: ObligationState;
  deliveredAttempts: number;
  consecutiveSubmissionFailures: number;
  lastDeliveredAttemptAt?: number;
  nextAttemptAt?: number;
  noAccountNotified: boolean;
}

export type ObligationNoticeReason = "no_account" | "no_activity";

export interface ObligationNotice {
  obligationId: string;
  reason: ObligationNoticeReason;
  evidence: Record<string, unknown>;
}

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface ObligationControllerOptions {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  /** True while the target has an ACP turn (or an equivalent delivery) running. */
  isAgentBusy: (taskId: string) => boolean;
  /**
   * Submit a closing accounting prompt to the target. Resolves `true` only
   * when the bridge accepts (and the turn completes); a rejected submission
   * must resolve `false`. The runtime includes the obligation id in the
   * prompt text so the target can name the edge.
   */
  submitReminder: (obligation: DirectedObligation) => Promise<boolean>;
  /** Emit a runtime `task_outcome_notice` to the obligation's source. */
  emitNotice: (
    notice: ObligationNotice,
    obligation: DirectedObligation,
  ) => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
  newId?: () => string;
}

interface WatchdogState {
  promptId: string;
  runningSince: number;
  lastAgentActivityAt: number;
}

function activeKey(sourceTaskId: string, targetTaskId: string): string {
  return `${sourceTaskId}\u0000${targetTaskId}`;
}

function silenceKey(obligationId: string, promptId: string): string {
  return `${obligationId}\u0000${promptId}`;
}

/**
 * Read the current state through a helper so TypeScript does not carry a
 * pre-`await` narrowing (a live agent turn can settle the edge mid-submission).
 */
function readObligationState(obligation: DirectedObligation): ObligationState {
  return obligation.state;
}

/**
 * Process-local directed-obligation state machine. All transitions are
 * synchronous; the only asynchronous work is bridge submission, and its
 * completion re-enters through a fresh critical-section check.
 */
export class ObligationController {
  private readonly active = new Map<string, DirectedObligation>();
  private readonly activeById = new Map<string, DirectedObligation>();
  private readonly archive = new Map<string, DirectedObligation>();
  private readonly attemptTimers = new Map<string, TimerHandle>();
  private readonly watchdogTimers = new Map<string, TimerHandle>();
  private readonly watchdog = new Map<string, WatchdogState>();
  private readonly silenceNotified = new Set<string>();
  private readonly opts: ObligationControllerOptions;

  constructor(options: ObligationControllerOptions) {
    this.opts = options;
  }

  private now(): number {
    return this.opts.now();
  }

  private newId(): string {
    return this.opts.newId?.() ?? randomUUID();
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.opts.log?.(event, fields);
  }

  private clearAttemptTimer(obligationId: string): void {
    const handle = this.attemptTimers.get(obligationId);
    if (handle === undefined) return;
    this.attemptTimers.delete(obligationId);
    this.opts.clearTimer(handle);
  }

  private clearWatchdogTimer(obligationId: string): void {
    const handle = this.watchdogTimers.get(obligationId);
    if (handle === undefined) return;
    this.watchdogTimers.delete(obligationId);
    this.opts.clearTimer(handle);
  }

  private armAttemptTimer(
    obligation: DirectedObligation,
    delayMs: number,
  ): void {
    this.clearAttemptTimer(obligation.id);
    const handle = this.opts.setTimer(
      () => {
        this.attemptTimers.delete(obligation.id);
        this.runAttempt(obligation.id);
      },
      Math.max(0, delayMs),
    );
    this.attemptTimers.set(obligation.id, handle);
  }

  getActive(
    sourceTaskId: string,
    targetTaskId: string,
  ): DirectedObligation | undefined {
    return this.active.get(activeKey(sourceTaskId, targetTaskId));
  }

  getById(obligationId: string): DirectedObligation | undefined {
    return this.activeById.get(obligationId) ?? this.archive.get(obligationId);
  }

  isOwed(sourceTaskId: string, targetTaskId: string): boolean {
    const obligation = this.getActive(sourceTaskId, targetTaskId);
    return obligation !== undefined && obligation.state !== "settled";
  }

  /**
   * Arm (or coalesce) the directed obligation for an accepted direct
   * parent→child dispatch. The caller has already established the parent-edge
   * policy; this method enforces only record shape and state.
   *
   * A same-source follow-up coalesces: it preserves the obligation id, resets
   * the delivered-attempt and submission-failure budgets, and makes the next
   * attempt due after the next eligible target turn boundary. It never
   * interrupts a running turn.
   */
  arm(input: {
    sourceTaskId: string;
    targetTaskId: string;
    messageId: string;
    deliveryId: string;
  }): DirectedObligation {
    const key = activeKey(input.sourceTaskId, input.targetTaskId);
    const existing = this.active.get(key);
    if (existing) {
      this.clearAttemptTimer(existing.id);
      existing.deliveredAttempts = 0;
      existing.consecutiveSubmissionFailures = 0;
      existing.noAccountNotified = false;
      existing.lastDeliveredAttemptAt = undefined;
      existing.nextAttemptAt = undefined;
      existing.openingMessageId = input.messageId;
      existing.openingDeliveryId = input.deliveryId;
      if (existing.state !== "reminder_submitting") {
        existing.state = "awaiting_delivery";
      }
      this.log("obligation coalesced", {
        obligationId: existing.id,
        targetTaskId: existing.targetTaskId.slice(0, 8),
        state: existing.state,
      });
      return existing;
    }

    const obligation: DirectedObligation = {
      id: this.newId(),
      sourceTaskId: input.sourceTaskId,
      targetTaskId: input.targetTaskId,
      openingMessageId: input.messageId,
      openingDeliveryId: input.deliveryId,
      openedAt: this.now(),
      state: "awaiting_delivery",
      deliveredAttempts: 0,
      consecutiveSubmissionFailures: 0,
      noAccountNotified: false,
    };
    this.active.set(key, obligation);
    this.activeById.set(obligation.id, obligation);
    this.log("obligation armed", {
      obligationId: obligation.id,
      sourceTaskId: obligation.sourceTaskId.slice(0, 8),
      targetTaskId: obligation.targetTaskId.slice(0, 8),
    });
    return obligation;
  }

  /** The qualifying source dispatch was accepted by the bridge. */
  markDelivered(sourceTaskId: string, targetTaskId: string): void {
    const obligation = this.getActive(sourceTaskId, targetTaskId);
    if (!obligation) return;
    if (obligation.state !== "awaiting_delivery") return;
    obligation.state = "open";
    this.log("obligation opened", {
      obligationId: obligation.id,
      targetTaskId: targetTaskId.slice(0, 8),
    });
    this.maybeRemindAtBoundary(obligation);
  }

  /**
   * The qualifying source dispatch could not be delivered. No account is
   * requested for work the target never received; the edge is dropped. A
   * coalesced follow-up never reaches this path with an earlier open account
   * at stake, because coalescing only rewinds an `awaiting_delivery` record.
   */
  markRejected(sourceTaskId: string, targetTaskId: string): void {
    const obligation = this.getActive(sourceTaskId, targetTaskId);
    if (!obligation) return;
    if (obligation.state !== "awaiting_delivery") return;
    this.discard(obligation, "delivery_rejected");
  }

  /**
   * A current target turn ended. An `open` edge enters `reminder_due` and
   * reminder 1 is scheduled; `awaiting_delivery` waits for the dispatch's own
   * acceptance. Nothing here clears obligations or widens scope.
   */
  onTargetTurnEnded(targetTaskId: string): void {
    const obligation = this.findActiveForTarget(targetTaskId);
    if (!obligation) return;
    this.clearWatchdogTimer(obligation.id);
    this.watchdog.delete(obligation.id);
    if (obligation.state === "open") {
      this.maybeRemindAtBoundary(obligation);
    }
  }

  /**
   * A target turn started. The watchdog observes only a running turn that
   * already has an active obligation.
   */
  beginTurn(targetTaskId: string, promptId: string): void {
    const obligation = this.findActiveForTarget(targetTaskId);
    if (!obligation) return;
    this.startWatchdog(obligation, promptId);
  }

  /**
   * Qualifying agent-runtime activity for a running turn. User and system
   * events must not reset the watchdog.
   */
  noteAgentActivity(targetTaskId: string, at = this.now()): void {
    const obligation = this.findActiveForTarget(targetTaskId);
    if (!obligation) return;
    const state = this.watchdog.get(obligation.id);
    if (!state) return;
    state.lastAgentActivityAt = at;
    this.armWatchdog(obligation, state);
  }

  private startWatchdog(
    obligation: DirectedObligation,
    promptId: string,
  ): void {
    const at = this.now();
    const state: WatchdogState = {
      promptId,
      runningSince: at,
      lastAgentActivityAt: at,
    };
    this.watchdog.set(obligation.id, state);
    this.armWatchdog(obligation, state);
  }

  private armWatchdog(
    obligation: DirectedObligation,
    state: WatchdogState,
  ): void {
    this.clearWatchdogTimer(obligation.id);
    const dueAt = state.lastAgentActivityAt + SILENCE_THRESHOLD_S * 1000;
    const handle = this.opts.setTimer(
      () => {
        this.watchdogTimers.delete(obligation.id);
        this.emitSilence(obligation.id);
      },
      Math.max(0, dueAt - this.now()),
    );
    this.watchdogTimers.set(obligation.id, handle);
  }

  private maybeRemindAtBoundary(obligation: DirectedObligation): void {
    if (obligation.state === "settled" || obligation.state === "unanswered") {
      return;
    }
    if (obligation.state === "reminder_submitting") return;
    if (obligation.deliveredAttempts >= MAX_REMINDER_ATTEMPTS) {
      this.exhaust(obligation);
      return;
    }
    obligation.state = "reminder_due";
    this.scheduleNextAttempt(obligation);
  }

  private scheduleNextAttempt(obligation: DirectedObligation): void {
    const index = obligation.deliveredAttempts;
    const delay = REMINDER_DELAYS_MS[index] ?? 0;
    const base =
      index === 0
        ? this.now()
        : (obligation.lastDeliveredAttemptAt ?? this.now());
    obligation.nextAttemptAt = base + delay;
    this.armAttemptTimer(obligation, obligation.nextAttemptAt - this.now());
  }

  private retrySchedule(obligation: DirectedObligation): void {
    const failures = obligation.consecutiveSubmissionFailures;
    const backoff = Math.min(
      REMINDER_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1),
      REMINDER_RETRY_MAX_MS,
    );
    obligation.nextAttemptAt = this.now() + backoff;
    this.armAttemptTimer(obligation, backoff);
  }

  /** Scheduler entry point: submit only while the target is idle. */
  private runAttempt(obligationId: string): void {
    const obligation = this.activeById.get(obligationId);
    if (!obligation) return;
    if (obligation.state !== "reminder_due") return;
    if (this.opts.isAgentBusy(obligation.targetTaskId)) {
      this.retrySchedule(obligation);
      return;
    }
    void this.submit(obligation);
  }

  private async submit(obligation: DirectedObligation): Promise<void> {
    obligation.state = "reminder_submitting";
    this.clearAttemptTimer(obligation.id);
    const accepted = await this.opts.submitReminder(obligation);
    // `submitReminder` awaits a live agent turn; the target may have settled
    // the edge through `task_update` while that turn ran. Re-read state after
    // the await rather than trusting the pre-await narrowing.
    const stateAfter = readObligationState(obligation);
    if (
      stateAfter === "settled" ||
      stateAfter === "unanswered" ||
      !this.activeById.has(obligation.id)
    ) {
      return;
    }
    if (!accepted) {
      obligation.consecutiveSubmissionFailures += 1;
      if (
        obligation.consecutiveSubmissionFailures >=
        MAX_REMINDER_SUBMISSION_FAILURES
      ) {
        this.exhaust(obligation, { deliveryUnavailable: true });
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
      obligationId: obligation.id,
      deliveredAttempts: obligation.deliveredAttempts,
    });
    if (obligation.deliveredAttempts >= MAX_REMINDER_ATTEMPTS) {
      this.exhaust(obligation);
      return;
    }
    obligation.state = "reminder_due";
    this.scheduleNextAttempt(obligation);
  }

  private discard(obligation: DirectedObligation, reason: string): void {
    this.clearAttemptTimer(obligation.id);
    this.clearWatchdogTimer(obligation.id);
    this.watchdog.delete(obligation.id);
    this.active.delete(
      activeKey(obligation.sourceTaskId, obligation.targetTaskId),
    );
    this.activeById.delete(obligation.id);
    this.log("obligation discarded", {
      obligationId: obligation.id,
      reason,
    });
  }

  /**
   * Bounded recovery ended without a matching account. The only notice reason
   * is the factual `no_account`; a transport-exhaustion cause is evidence, not
   * a second outcome.
   */
  private exhaust(
    obligation: DirectedObligation,
    extraEvidence: Record<string, unknown> = {},
  ): void {
    if (obligation.state === "unanswered") return;
    this.clearAttemptTimer(obligation.id);
    this.clearWatchdogTimer(obligation.id);
    this.watchdog.delete(obligation.id);
    obligation.state = "unanswered";
    this.archive.set(obligation.id, obligation);
    this.evictArchive();
    if (obligation.noAccountNotified) return;
    obligation.noAccountNotified = true;
    const evidence: Record<string, unknown> = {
      deliveredAttempts: obligation.deliveredAttempts,
      consecutiveSubmissionFailures: obligation.consecutiveSubmissionFailures,
      lastDeliveredAttemptAt: obligation.lastDeliveredAttemptAt ?? null,
      ...extraEvidence,
    };
    this.opts.emitNotice(
      { obligationId: obligation.id, reason: "no_account", evidence },
      obligation,
    );
    this.log("obligation unanswered", {
      obligationId: obligation.id,
      evidence,
    });
  }

  private evictArchive(): void {
    while (this.archive.size > MAX_ARCHIVED_OBLIGATIONS) {
      const oldest = this.archive.keys().next().value;
      if (oldest === undefined) return;
      this.archive.delete(oldest);
    }
  }

  private findActiveForTarget(
    targetTaskId: string,
  ): DirectedObligation | undefined {
    for (const obligation of this.active.values()) {
      if (obligation.targetTaskId === targetTaskId) return obligation;
    }
    return undefined;
  }

  /**
   * Settle one open edge. Validation and the transition are one synchronous
   * critical section: `run` performs the store transaction (typed update,
   * workflow status, source-directed account message) and only after it
   * succeeds is the in-memory record retired. A throwing `run` leaves the
   * edge open. No await occurs between validation and transition.
   *
   * A terminal `unanswered` edge accepts a later account with its own id and
   * becomes late `settled`, without retracting the historical notice.
   */
  settle<T>(input: {
    sourceTaskId: string;
    obligationId: string;
    run: (obligation: DirectedObligation) => T;
  }): T | undefined {
    const activeObligation = this.activeById.get(input.obligationId);
    if (activeObligation) {
      if (activeObligation.targetTaskId !== input.sourceTaskId)
        return undefined;
      if (activeObligation.state === "settled") return undefined;
      const result = input.run(activeObligation);
      this.clearAttemptTimer(activeObligation.id);
      this.clearWatchdogTimer(activeObligation.id);
      this.watchdog.delete(activeObligation.id);
      this.active.delete(
        activeKey(activeObligation.sourceTaskId, activeObligation.targetTaskId),
      );
      this.activeById.delete(activeObligation.id);
      activeObligation.state = "settled";
      this.archive.set(activeObligation.id, activeObligation);
      this.evictArchive();
      this.log("obligation settled", {
        obligationId: activeObligation.id,
        targetTaskId: activeObligation.targetTaskId.slice(0, 8),
      });
      return result;
    }
    const archived = this.archive.get(input.obligationId);
    if (!archived) return undefined;
    if (archived.targetTaskId !== input.sourceTaskId) return undefined;
    if (archived.state !== "unanswered") return undefined;
    const result = input.run(archived);
    archived.state = "settled";
    this.log("obligation settled late", {
      obligationId: archived.id,
      targetTaskId: archived.targetTaskId.slice(0, 8),
    });
    return result;
  }

  /** Watchdog timer fired: emit at most one `no_activity` per edge×turn. */
  private emitSilence(obligationId: string): void {
    const obligation = this.activeById.get(obligationId);
    if (!obligation) return;
    const state = this.watchdog.get(obligationId);
    if (!state) return;
    const key = silenceKey(obligation.id, state.promptId);
    if (this.silenceNotified.has(key)) return;
    this.silenceNotified.add(key);
    this.opts.emitNotice(
      {
        obligationId: obligation.id,
        reason: "no_activity",
        evidence: {
          runningSince: state.runningSince,
          lastAgentActivityAt: state.lastAgentActivityAt,
          promptId: state.promptId,
        },
      },
      obligation,
    );
    this.log("obligation silence notice", {
      obligationId: obligation.id,
      promptId: state.promptId,
    });
  }
}
