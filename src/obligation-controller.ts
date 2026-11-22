import type { ObligationOutcomeFact } from "./obligation-outcomes.ts";

/**
 * Directed dispatch closure.
 *
 * An agent-authored direct parent→child dispatch opens exactly one in-process
 * account per target (a target has one parent, so one inbound account). The
 * account stays open until the target reports `done` or `blocked`, or the
 * target leaves the edge. There is no correlation token and no persisted state:
 * a restart simply forgets open accounts.
 *
 * Turn boundaries are the only clock. Every target turn that ends while the
 * account is open is checked once:
 *
 * - an update of any status in that turn resets the whole cycle;
 * - the first turn with no update gets one closing reminder;
 * - the next such turn reports `no_update` to the source and stops reminding.
 *
 * A separate watchdog reports a target that has had no agent activity for the
 * silence threshold while it owes the account: during a running turn (from the
 * prompt submission, cleared on every turn end), or after it reported
 * `waiting` with nothing the runtime can see that will wake it (cleared by the
 * next update or turn). Any agent activity resets the window, including
 * activity the agent starts on its own outside a prompt. A cancelled turn
 * triggers nothing.
 */

/** Default silence threshold; deployments override it with `limits.silence_timeout`. */
export const SILENCE_THRESHOLD_MS = 15 * 60_000;

export type ObligationNoticeReason =
  "no_update" | "no_activity" | "target_removed";

export interface ObligationNotice {
  reason: ObligationNoticeReason;
  sourceTaskId: string;
  targetTaskId: string;
  /** Human-readable fact, safe to show verbatim to the recipient. */
  message: string;
}

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface ObligationControllerOptions {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  /**
   * Queue one closing reminder from the account's source to its target. The
   * delivery drain owns when the target actually receives it.
   */
  submitReminder: (sourceTaskId: string, targetTaskId: string) => void;
  /** Hand one account fact to the outcome reducer. */
  emitOutcome: (fact: ObligationOutcomeFact) => void;
  /** No-activity threshold in milliseconds; defaults to {@link SILENCE_THRESHOLD_MS}. */
  silenceMs?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

interface Account {
  sourceTaskId: string;
  targetTaskId: string;
  /** Consecutive target turns that ended with no `task_update`. */
  noUpdateTurns: number;
  /** `no_update` was already reported; stop reminding until an update. */
  stopped: boolean;
}

/**
 * One silence window per target. It exists while a turn runs, and outlives the
 * turn when the target reported `waiting` with no visible wake source.
 */
interface SilenceWatch {
  lastActivityAt: number;
  /** The silence notice was already emitted for this window. */
  noticed: boolean;
  inTurn: boolean;
  /** A `waiting` with no visible wake source keeps the watch after the turn. */
  waiting: boolean;
}

/**
 * Process-local directed-account state, keyed by target. The only asynchronous
 * effect is queueing a reminder or notice for the delivery drain.
 */
export class ObligationController {
  private readonly accounts = new Map<string, Account>();
  private readonly watches = new Map<string, SilenceWatch>();
  /** Targets whose current turn carried a `task_update` of any status. */
  private readonly updated = new Set<string>();
  private timer: TimerHandle | undefined;
  private disposed = false;
  private readonly opts: ObligationControllerOptions;

  constructor(options: ObligationControllerOptions) {
    this.opts = options;
  }

  private now(): number {
    return this.opts.now();
  }

  get silenceMs(): number {
    return this.opts.silenceMs ?? SILENCE_THRESHOLD_MS;
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.opts.log?.(event, fields);
  }

  /** Open the target's account, or keep the open one. */
  arm(sourceTaskId: string, targetTaskId: string): void {
    if (this.disposed) return;
    const existing = this.accounts.get(targetTaskId);
    if (existing) {
      if (existing.sourceTaskId === sourceTaskId) return;
      // The target was reparented without the archive edge drop; the old edge
      // is gone and this one replaces it.
      this.accounts.delete(targetTaskId);
    }
    this.accounts.set(targetTaskId, {
      sourceTaskId,
      targetTaskId,
      noUpdateTurns: 0,
      stopped: false,
    });
    this.log("account opened", {
      sourceTaskId: sourceTaskId.slice(0, 8),
      targetTaskId: targetTaskId.slice(0, 8),
    });
    this.schedule();
  }

  /**
   * A successful update resets the account cycle immediately. It marks the
   * current running turn only when there is one; a late update made while the
   * target is idle belongs to no turn-end check.
   */
  noteUpdate(targetTaskId: string): void {
    const account = this.accounts.get(targetTaskId);
    if (account) {
      account.noUpdateTurns = 0;
      account.stopped = false;
    }
    const watch = this.watches.get(targetTaskId);
    if (watch?.inTurn) this.updated.add(targetTaskId);
    if (watch?.waiting) {
      watch.waiting = false;
      if (!watch.inTurn) this.watches.delete(targetTaskId);
      this.schedule();
    }
  }

  /**
   * The target reported `waiting` and the runtime sees nothing that will wake
   * it. While its account is open, watch it for silence like a running turn.
   * Call after {@link noteUpdate}.
   */
  noteUnwatchedWaiting(targetTaskId: string): boolean {
    if (this.disposed || !this.accounts.has(targetTaskId)) return false;
    const watch = this.watches.get(targetTaskId);
    if (watch) watch.waiting = true;
    else this.watch(targetTaskId, { inTurn: false, waiting: true });
    this.schedule();
    return true;
  }

  /** Open account source for a target, without closing it. */
  peekSource(targetTaskId: string): string | undefined {
    return this.accounts.get(targetTaskId)?.sourceTaskId;
  }

  /** Close an account after the settlement transaction committed. */
  close(targetTaskId: string): void {
    const account = this.accounts.get(targetTaskId);
    if (!account) return;
    this.accounts.delete(targetTaskId);
    this.watches.delete(targetTaskId);
    this.log("account settled", {
      sourceTaskId: account.sourceTaskId.slice(0, 8),
      targetTaskId: targetTaskId.slice(0, 8),
    });
    this.schedule();
  }

  /** Close an account after a delivery-failure fact reduced to closure. */
  closeUnavailable(targetTaskId: string): void {
    const account = this.accounts.get(targetTaskId);
    if (!account) return;
    this.accounts.delete(targetTaskId);
    this.updated.delete(targetTaskId);
    this.watches.delete(targetTaskId);
    this.schedule();
  }

  /** A prompt was actually submitted for this turn. */
  beginTurn(targetTaskId: string): void {
    if (this.disposed) return;
    this.updated.delete(targetTaskId);
    // A new turn opens a new window; its end is checked against the account.
    this.watch(targetTaskId, { inTurn: true, waiting: false });
    this.schedule();
  }

  /** The turn stopped running without a turn-end check (release/reset). */
  clearTurnWatcher(targetTaskId: string): void {
    this.leaveTurn(targetTaskId);
  }

  noteAgentActivity(targetTaskId: string): void {
    const watch = this.watches.get(targetTaskId);
    if (!watch) return;
    watch.lastActivityAt = this.now();
    this.schedule();
  }

  /** A turn ended; check it against the open account. */
  onTargetTurnEnded(targetTaskId: string, cancelled = false): void {
    if (this.disposed) return;
    const hadUpdate = this.updated.delete(targetTaskId);
    this.leaveTurn(targetTaskId);
    const account = this.accounts.get(targetTaskId);
    if (account && !cancelled) {
      if (hadUpdate) {
        account.noUpdateTurns = 0;
        account.stopped = false;
      } else {
        account.noUpdateTurns += 1;
        if (account.noUpdateTurns === 1) {
          this.log("closing reminder", {
            sourceTaskId: account.sourceTaskId.slice(0, 8),
            targetTaskId: targetTaskId.slice(0, 8),
          });
          this.opts.submitReminder(account.sourceTaskId, targetTaskId);
        } else if (!account.stopped) {
          account.stopped = true;
          this.emitOutcome({
            kind: "repeated_unreported_turn",
            sourceTaskId: account.sourceTaskId,
            targetTaskId,
          });
        }
      }
    }
    this.schedule();
  }

  /** A runtime reset ended the target's turn without a turn-end check. */
  abortTurn(targetTaskId: string): void {
    this.updated.delete(targetTaskId);
    this.leaveTurn(targetTaskId);
  }

  /** The task is gone. A target's account reports; a source's just goes away. */
  purgeTask(taskId: string): void {
    const account = this.accounts.get(taskId);
    if (account) {
      this.accounts.delete(taskId);
      this.emitOutcome({
        kind: "target_unavailable",
        sourceTaskId: account.sourceTaskId,
        targetTaskId: taskId,
      });
    }
    for (const [targetTaskId, inbound] of [...this.accounts]) {
      if (inbound.sourceTaskId !== taskId) continue;
      this.accounts.delete(targetTaskId);
    }
    this.watches.delete(taskId);
    this.updated.delete(taskId);
    this.schedule();
  }

  /** Archiving cut this edge; the target left the source. */
  dropEdge(sourceTaskId: string, targetTaskId: string): void {
    const account = this.accounts.get(targetTaskId);
    if (account?.sourceTaskId !== sourceTaskId) {
      return;
    }
    this.accounts.delete(targetTaskId);
    this.emitOutcome({
      kind: "target_unavailable",
      sourceTaskId: account.sourceTaskId,
      targetTaskId,
    });
    this.watches.delete(targetTaskId);
    this.updated.delete(targetTaskId);
    this.schedule();
  }

  /** Whether this task is the source of any open account. */
  hasOpenAsSource(sourceTaskId: string): boolean {
    for (const account of this.accounts.values()) {
      if (account.sourceTaskId === sourceTaskId) return true;
    }
    return false;
  }

  hasOpen(sourceTaskId: string, targetTaskId: string): boolean {
    return this.accounts.get(targetTaskId)?.sourceTaskId === sourceTaskId;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      this.opts.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  // --- The single watchdog timer ---

  private watch(
    targetTaskId: string,
    kind: Pick<SilenceWatch, "inTurn" | "waiting">,
  ): void {
    this.watches.set(targetTaskId, {
      lastActivityAt: this.now(),
      noticed: false,
      ...kind,
    });
  }

  /** The turn ended: a standing `waiting` keeps a fresh window from now. */
  private leaveTurn(targetTaskId: string): void {
    const watch = this.watches.get(targetTaskId);
    if (watch?.waiting)
      this.watch(targetTaskId, { inTurn: false, waiting: true });
    else this.watches.delete(targetTaskId);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined) {
      this.opts.clearTimer(this.timer);
      this.timer = undefined;
    }
    if (this.disposed) return;
    let earliest: number | undefined;
    for (const [targetTaskId, watch] of this.watches) {
      if (watch.noticed) continue;
      if (!this.accounts.has(targetTaskId)) continue;
      const deadline = watch.lastActivityAt + this.silenceMs;
      if (earliest === undefined || deadline < earliest) earliest = deadline;
    }
    if (earliest === undefined) return;
    this.timer = this.opts.setTimer(
      () => {
        this.timer = undefined;
        this.fireSilence();
      },
      Math.max(0, earliest - this.now()),
    );
  }

  private fireSilence(): void {
    if (this.disposed) return;
    const now = this.now();
    for (const [targetTaskId, watch] of this.watches) {
      if (watch.noticed) continue;
      if (watch.lastActivityAt + this.silenceMs > now) continue;
      const account = this.accounts.get(targetTaskId);
      if (!account) continue;
      watch.noticed = true;
      this.emitOutcome({
        kind: "silent_account",
        sourceTaskId: account.sourceTaskId,
        targetTaskId,
        silenceMs: this.silenceMs,
      });
    }
    this.schedule();
  }

  private emitOutcome(fact: ObligationOutcomeFact): void {
    this.opts.emitOutcome(fact);
  }
}

export function formatSilence(ms: number): string {
  const minutes = ms / 60_000;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
