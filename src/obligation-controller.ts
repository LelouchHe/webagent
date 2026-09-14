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
 * Only direct parent→child dispatch calls `arm()`; creation, user prompts,
 * sibling/child messages, reminders, cancellation, supersession, rotation, and
 * incoming status/notice messages neither arm nor settle an edge.
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

/**
 * Backstop for an armed dispatch that is never handed to the target's session
 * (for example a resume that keeps failing before any prompt is issued). When
 * this elapses while the record is still `awaiting_delivery`, the edge ends in
 * `unanswered` with a factual `no_account` and `delivery_unavailable` evidence,
 * so the source is told instead of waiting forever.
 */
export const DISPATCH_DEADLINE_MS = 60 * 60_000;

export type ObligationState =
  | "awaiting_delivery"
  | "open"
  | "reminder_due"
  | "reminder_submitting"
  | "unanswered"
  | "settled";

export interface DirectedObligation {
  sourceTaskId: string;
  targetTaskId: string;
  openingMessageId: string;
  openingDeliveryId: string;
  openedAt: number;
  /**
   * Turn identity (promptId) of the dispatch that currently owns this record.
   * Internal only: it guards late callbacks from a superseded dispatch, and is
   * not the agent-visible correlation token that was rejected.
   */
  dispatchPromptId?: string;
  state: ObligationState;
  deliveredAttempts: number;
  consecutiveSubmissionFailures: number;
  lastDeliveredAttemptAt?: number;
  nextAttemptAt?: number;
  noAccountNotified: boolean;
}

export type ObligationNoticeReason = "no_account" | "no_activity";

export interface ObligationNotice {
  reason: ObligationNoticeReason;
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
   * without going through `onTargetTurnEnded` cannot produce a stale notice.
   */
  isTurnRunning?: (taskId: string, promptId: string) => boolean;
  /**
   * Submit a closing accounting prompt to the target. Resolves `true` only
   * when the bridge accepts (and the turn completes); a rejected submission
   * must resolve `false`.
   */
  submitReminder: (obligation: DirectedObligation) => Promise<boolean>;
  /**
   * Retry the original dispatch at an idle boundary after its prompt was
   * rejected. A successful retry re-enters through `markDelivered`; a failure
   * through `markDeliveryFailed`.
   */
  retryDispatch: (obligation: DirectedObligation) => void;
  /** Emit a runtime `task_outcome_notice` to the obligation's source. */
  emitNotice: (
    notice: ObligationNotice,
    obligation: DirectedObligation,
  ) => void;
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

function matchesDispatch(
  obligation: DirectedObligation,
  promptId: string | undefined,
): boolean {
  if (promptId === undefined) return true;
  return obligation.dispatchPromptId === promptId;
}

function isTerminal(state: ObligationState): boolean {
  return state === "unanswered" || state === "settled";
}

function logFields(obligation: DirectedObligation): Record<string, unknown> {
  return {
    sourceTaskId: obligation.sourceTaskId.slice(0, 8),
    targetTaskId: obligation.targetTaskId.slice(0, 8),
  };
}

/**
 * Process-local directed-obligation state machine. All transitions are
 * synchronous; the only asynchronous work is bridge submission, and its
 * completion re-enters through a fresh critical-section check.
 *
 * Terminal records stay in the edge-keyed map so a later account can still be
 * routed to the stored source. A later dispatch for the same edge replaces a
 * terminal record.
 */
export class ObligationController {
  private readonly active = new Map<string, DirectedObligation>();
  private readonly attemptTimers = new Map<string, TimerHandle>();
  private readonly watchdogTimers = new Map<string, TimerHandle>();
  private readonly dispatchDeadlineTimers = new Map<string, TimerHandle>();
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

  private clearDispatchDeadline(key: string): void {
    const handle = this.dispatchDeadlineTimers.get(key);
    if (handle === undefined) return;
    this.dispatchDeadlineTimers.delete(key);
    this.opts.clearTimer(handle);
  }

  private armDispatchDeadline(obligation: DirectedObligation): void {
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    this.clearDispatchDeadline(key);
    const handle = this.opts.setTimer(() => {
      this.dispatchDeadlineTimers.delete(key);
      const current = this.active.get(key);
      if (!current || current !== obligation) return;
      if (current.state !== "awaiting_delivery") return;
      this.log("obligation dispatch deadline exceeded", logFields(current));
      this.exhaust(current, {
        deliveryUnavailable: true,
        dispatchDeadlineExceeded: true,
      });
    }, DISPATCH_DEADLINE_MS);
    this.dispatchDeadlineTimers.set(key, handle);
  }

  private armAttemptTimer(
    obligation: DirectedObligation,
    delayMs: number,
  ): void {
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    this.clearAttemptTimer(key);
    const handle = this.opts.setTimer(
      () => {
        this.attemptTimers.delete(key);
        this.runAttempt(key);
      },
      Math.max(0, delayMs),
    );
    this.attemptTimers.set(key, handle);
  }

  getActive(
    sourceTaskId: string,
    targetTaskId: string,
  ): DirectedObligation | undefined {
    return this.active.get(edgeKey(sourceTaskId, targetTaskId));
  }

  /** The sole record for a target, active or terminal. */
  getForTarget(targetTaskId: string): DirectedObligation | undefined {
    return this.findForTarget(targetTaskId);
  }

  isOwed(sourceTaskId: string, targetTaskId: string): boolean {
    const obligation = this.getActive(sourceTaskId, targetTaskId);
    return obligation !== undefined && !isTerminal(obligation.state);
  }

  /**
   * Arm (or coalesce) the directed obligation for an accepted direct
   * parent→child dispatch. A same-source follow-up coalesces: it preserves the
   * record, refreshes the delivered-attempt and submission-failure budgets,
   * and makes the next attempt due after the next eligible target turn
   * boundary. A dispatch after a terminal record starts a fresh epoch.
   */
  arm(input: {
    sourceTaskId: string;
    targetTaskId: string;
    messageId: string;
    deliveryId: string;
  }): DirectedObligation {
    const key = edgeKey(input.sourceTaskId, input.targetTaskId);
    const existing = this.active.get(key);
    if (existing && !isTerminal(existing.state)) {
      this.clearAttemptTimer(key);
      existing.deliveredAttempts = 0;
      existing.consecutiveSubmissionFailures = 0;
      existing.noAccountNotified = false;
      existing.lastDeliveredAttemptAt = undefined;
      existing.nextAttemptAt = undefined;
      existing.openingMessageId = input.messageId;
      existing.openingDeliveryId = input.deliveryId;
      // `awaiting_delivery` and `open` stay; `reminder_due` returns to `open`
      // so the next turn boundary resumes recovery with the refreshed budget.
      if (existing.state === "reminder_due") existing.state = "open";
      this.armDispatchDeadline(existing);
      this.log("obligation coalesced", {
        ...logFields(existing),
        state: existing.state,
      });
      return existing;
    }

    const obligation: DirectedObligation = {
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
    this.armDispatchDeadline(obligation);
    this.log("obligation armed", {
      ...logFields(obligation),
      replacedTerminal: existing !== undefined,
    });
    return obligation;
  }

  /** The qualifying source dispatch was handed to the target's session. */
  markDelivered(
    sourceTaskId: string,
    targetTaskId: string,
    promptId?: string,
  ): void {
    const key = edgeKey(sourceTaskId, targetTaskId);
    const obligation = this.active.get(key);
    if (!obligation) return;
    if (
      obligation.state !== "awaiting_delivery" &&
      obligation.state !== "open"
    ) {
      return;
    }
    if (promptId !== undefined) obligation.dispatchPromptId = promptId;
    this.clearDispatchDeadline(key);
    this.clearAttemptTimer(key);
    obligation.state = "open";
    // Do not reset `consecutiveSubmissionFailures` here: a retry issuance can
    // still be rejected, and resetting would let the transport budget restart
    // forever. It resets only once the submission resolves (see
    // `markDispatchSucceeded`).
    this.log("obligation opened", logFields(obligation));
    this.maybeRemindAtBoundary(obligation);
  }

  /**
   * The dispatch prompt resolved, so the submission succeeded and its transport
   * failure streak is cleared. A resolved turn still counts as a successful
   * submission even when the turn itself ends in an agent error.
   */
  markDispatchSucceeded(
    sourceTaskId: string,
    targetTaskId: string,
    promptId?: string,
  ): void {
    const obligation = this.getActive(sourceTaskId, targetTaskId);
    if (!obligation) return;
    if (!matchesDispatch(obligation, promptId)) return;
    if (isTerminal(obligation.state)) return;
    obligation.consecutiveSubmissionFailures = 0;
  }

  /**
   * The qualifying source dispatch could not be handed to the target. The
   * record returns to `awaiting_delivery` and the original delivery is retried
   * at idle boundaries under the transport bound; it never prompts the target
   * to account for unseen content. Three consecutive failed submissions end
   * the edge with `no_account` and `delivery_unavailable` evidence. Those
   * failures never consume the three delivered closing reminders.
   *
   * A rejection can arrive after issuance, when the record already opened; the
   * record then returns to `awaiting_delivery` (a pending state) and its
   * reminder schedule is cancelled, so the failure consumes the transport
   * budget once and the dispatch is retried rather than stranded open.
   */
  markDeliveryFailed(
    sourceTaskId: string,
    targetTaskId: string,
    promptId?: string,
  ): void {
    const obligation = this.getActive(sourceTaskId, targetTaskId);
    if (!obligation) return;
    if (!matchesDispatch(obligation, promptId)) return;
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
      this.exhaust(obligation, { deliveryUnavailable: true });
      return;
    }
    this.log("obligation dispatch retry scheduled", {
      ...logFields(obligation),
      consecutiveSubmissionFailures: obligation.consecutiveSubmissionFailures,
    });
    this.retrySchedule(obligation);
  }

  /**
   * A current target turn ended. An `open` edge enters `reminder_due` and
   * reminder 1 is scheduled; `awaiting_delivery` waits for the dispatch's own
   * acceptance. Nothing here clears obligations or widens scope.
   */
  onTargetTurnEnded(targetTaskId: string): void {
    const obligation = this.findForTarget(targetTaskId);
    if (!obligation) return;
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    this.clearWatchdogTimer(key);
    this.watchdog.delete(key);
    if (obligation.state === "open") {
      this.maybeRemindAtBoundary(obligation);
      return;
    }
    // Reminder 1 may already be `reminder_due` only because the target was
    // busy when it became due; the turn boundary is its natural moment. Once a
    // reminder has been delivered, keep its +2m/+5m schedule instead of
    // restarting it on every unrelated turn.
    if (
      obligation.state === "reminder_due" &&
      obligation.deliveredAttempts === 0
    ) {
      this.scheduleNextAttempt(obligation);
    }
  }

  /**
   * A target turn started. The watchdog observes only a running turn that
   * already has an active obligation.
   */
  beginTurn(targetTaskId: string, promptId: string): void {
    const obligation = this.findForTarget(targetTaskId);
    // Terminal records stay in the map for late-account routing, but they have
    // no open obligation to watch. Starting a watchdog for one would emit a
    // spurious no_activity notice for a closed edge.
    if (!obligation || isTerminal(obligation.state)) return;
    this.startWatchdog(obligation, promptId);
  }

  /**
   * Qualifying agent-runtime activity for a running turn. User and system
   * events must not reset the watchdog.
   */
  noteAgentActivity(targetTaskId: string, at = this.now()): void {
    const obligation = this.findForTarget(targetTaskId);
    if (!obligation || isTerminal(obligation.state)) return;
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    const state = this.watchdog.get(key);
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
    this.watchdog.set(
      edgeKey(obligation.sourceTaskId, obligation.targetTaskId),
      state,
    );
    this.armWatchdog(obligation, state);
  }

  private armWatchdog(
    obligation: DirectedObligation,
    state: WatchdogState,
  ): void {
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    this.clearWatchdogTimer(key);
    const dueAt = state.lastAgentActivityAt + SILENCE_THRESHOLD_S * 1000;
    const handle = this.opts.setTimer(
      () => {
        this.watchdogTimers.delete(key);
        this.emitSilence(obligation);
      },
      Math.max(0, dueAt - this.now()),
    );
    this.watchdogTimers.set(key, handle);
  }

  private maybeRemindAtBoundary(obligation: DirectedObligation): void {
    if (isTerminal(obligation.state)) return;
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
  private runAttempt(key: string): void {
    const obligation = this.active.get(key);
    if (!obligation) return;
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

  private async submit(obligation: DirectedObligation): Promise<void> {
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    obligation.state = "reminder_submitting";
    this.clearAttemptTimer(key);
    const accepted = await this.opts.submitReminder(obligation);
    // `submitReminder` awaits a live agent turn; the target may have settled
    // the edge through `task_update` while that turn ran. Re-read state after
    // the await rather than trusting the pre-await narrowing.
    const stateAfter = readObligationState(obligation);
    if (
      stateAfter === "settled" ||
      stateAfter === "unanswered" ||
      this.active.get(key) !== obligation
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
      ...logFields(obligation),
      deliveredAttempts: obligation.deliveredAttempts,
    });
    if (obligation.deliveredAttempts >= MAX_REMINDER_ATTEMPTS) {
      this.exhaust(obligation);
      return;
    }
    obligation.state = "reminder_due";
    this.scheduleNextAttempt(obligation);
  }

  /**
   * Decide and perform one agent update for `targetTaskId`.
   *
   * A record settles only when both hold: its state is
   * `open|reminder_due|reminder_submitting`, and the target has an active
   * current agent turn. Otherwise the update is routed without settling: a
   * record that exists addresses its stored source, and no record addresses
   * the caller's current parent.
   *
   * There is deliberately **no timestamp guard** here. The delivery turn is
   * added to `activePrompts` and stamped before `bridge.prompt` is issued, and
   * `markDelivered` runs only when that prompt resolves, so any comparison of
   * the current turn's start against bridge-acceptance time would reject the
   * legitimate dispatch account. The accepted residual is handled by the state
   * gate and documented instead; do not reintroduce a timestamp condition.
   *
   * `run` performs the synchronous store transaction for the chosen route. The
   * in-memory transition happens only after it succeeds, so a throwing `run`
   * leaves a settleable record open. No await occurs between validation and
   * transition.
   */
  settleReport<T>(input: {
    targetTaskId: string;
    activeTurn: ActiveAgentTurn | null;
    run: (decision: SettlementDecision) => T;
  }): { decision: SettlementDecision; result: T } {
    const obligation = this.findForTarget(input.targetTaskId);
    if (!obligation) {
      const decision: SettlementDecision = {
        kind: "current-parent",
        sourceTaskId: null,
      };
      return { decision, result: input.run(decision) };
    }
    const settleable =
      (obligation.state === "open" ||
        obligation.state === "reminder_due" ||
        obligation.state === "reminder_submitting") &&
      input.activeTurn !== null;
    if (!settleable) {
      const decision: SettlementDecision = {
        kind: "stored-source",
        sourceTaskId: obligation.sourceTaskId,
      };
      return { decision, result: input.run(decision) };
    }
    const decision: SettlementDecision = {
      kind: "settle",
      sourceTaskId: obligation.sourceTaskId,
    };
    const result = input.run(decision);
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    this.clearAttemptTimer(key);
    this.clearWatchdogTimer(key);
    this.watchdog.delete(key);
    obligation.state = "settled";
    this.log("obligation settled", logFields(obligation));
    return { decision, result };
  }

  /** Bounded recovery ended without a matching account. */
  private exhaust(
    obligation: DirectedObligation,
    extraEvidence: Record<string, unknown> = {},
  ): void {
    if (obligation.state === "unanswered") return;
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    this.clearAttemptTimer(key);
    this.clearWatchdogTimer(key);
    this.watchdog.delete(key);
    obligation.state = "unanswered";
    if (obligation.noAccountNotified) return;
    obligation.noAccountNotified = true;
    const evidence: Record<string, unknown> = {
      deliveredAttempts: obligation.deliveredAttempts,
      consecutiveSubmissionFailures: obligation.consecutiveSubmissionFailures,
      lastDeliveredAttemptAt: obligation.lastDeliveredAttemptAt ?? null,
      ...extraEvidence,
    };
    this.opts.emitNotice({ reason: "no_account", evidence }, obligation);
    this.log("obligation unanswered", {
      ...logFields(obligation),
      evidence,
    });
  }

  private findForTarget(targetTaskId: string): DirectedObligation | undefined {
    for (const obligation of this.active.values()) {
      if (obligation.targetTaskId === targetTaskId) return obligation;
    }
    return undefined;
  }

  /** Watchdog timer fired: emit at most one `no_activity` per target×turn. */
  private emitSilence(obligation: DirectedObligation): void {
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    if (this.active.get(key) !== obligation) return;
    const state = this.watchdog.get(key);
    if (!state) return;
    // Require the turn to still be live: the watchdog timer can outlive a
    // runtime reset that never delivered a terminal event.
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

  /**
   * Drop the watchdog for the target's turn without touching the record. Called
   * by runtime reset paths (rotation, bridge restart) that end a turn without a
   * terminal event.
   */
  abortTurn(targetTaskId: string): void {
    const obligation = this.findForTarget(targetTaskId);
    if (!obligation) return;
    const key = edgeKey(obligation.sourceTaskId, obligation.targetTaskId);
    this.clearWatchdogTimer(key);
    this.watchdog.delete(key);
  }

  /** Stop all scheduled work (shutdown/tests); the controller is then unusable. */
  dispose(): void {
    for (const handle of this.attemptTimers.values()) {
      this.opts.clearTimer(handle);
    }
    for (const handle of this.watchdogTimers.values()) {
      this.opts.clearTimer(handle);
    }
    for (const handle of this.dispatchDeadlineTimers.values()) {
      this.opts.clearTimer(handle);
    }
    this.attemptTimers.clear();
    this.watchdogTimers.clear();
    this.dispatchDeadlineTimers.clear();
    this.watchdog.clear();
  }

  /**
   * Drop every record whose source or target is `taskId`, cancelling its
   * timers. Called when a task is released so a deleted task cannot leave a
   * record or a scheduled attempt behind; this is hygiene, not deletion
   * recovery.
   */
  purgeTask(taskId: string): void {
    for (const [key, obligation] of [...this.active]) {
      if (
        obligation.sourceTaskId !== taskId &&
        obligation.targetTaskId !== taskId
      ) {
        continue;
      }
      this.clearAttemptTimer(key);
      this.clearWatchdogTimer(key);
      this.clearDispatchDeadline(key);
      this.watchdog.delete(key);
      this.active.delete(key);
    }
    for (const seen of [...this.silenceNotified]) {
      if (seen.startsWith(`${taskId}\u0000`)) this.silenceNotified.delete(seen);
    }
  }
}

/**
 * Read the current state through a helper so TypeScript does not carry a
 * pre-`await` narrowing (a live agent turn can settle the edge mid-submission).
 */
function readObligationState(obligation: DirectedObligation): ObligationState {
  return obligation.state;
}
