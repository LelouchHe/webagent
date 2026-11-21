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
 * A separate watchdog reports a running turn that has had no agent activity for
 * 15 minutes. It starts when the prompt is submitted, not when the UI shows a
 * busy turn, and it is cleared on every turn end. A cancelled turn triggers
 * nothing.
 */

/** A running target turn with an open account and no activity for this long. */
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
  /** Queue a runtime notice to the account's source and close the account. */
  emitNotice: (notice: ObligationNotice) => void;
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

interface RunningTurn {
  lastActivityAt: number;
  /** The silence notice was already emitted for this turn. */
  noticed: boolean;
}

/**
 * Process-local directed-account state, keyed by target. The only asynchronous
 * effect is queueing a reminder or notice for the delivery drain.
 */
export class ObligationController {
  private readonly accounts = new Map<string, Account>();
  private readonly turns = new Map<string, RunningTurn>();
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
    if (this.turns.has(targetTaskId)) this.updated.add(targetTaskId);
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
    this.log("account settled", {
      sourceTaskId: account.sourceTaskId.slice(0, 8),
      targetTaskId: targetTaskId.slice(0, 8),
    });
    this.schedule();
  }

  /** The target's delivery failed or it left: report and close. */
  noteTargetUnavailable(targetTaskId: string): void {
    const account = this.accounts.get(targetTaskId);
    if (!account) return;
    this.accounts.delete(targetTaskId);
    this.updated.delete(targetTaskId);
    this.turns.delete(targetTaskId);
    this.emit(account, "target_removed");
    this.schedule();
  }

  /** A prompt was actually submitted for this turn. */
  beginTurn(targetTaskId: string): void {
    if (this.disposed) return;
    this.updated.delete(targetTaskId);
    this.turns.set(targetTaskId, {
      lastActivityAt: this.now(),
      noticed: false,
    });
    this.schedule();
  }

  /** The turn stopped running without a turn-end check (release/reset). */
  clearTurnWatcher(targetTaskId: string): void {
    this.turns.delete(targetTaskId);
    this.schedule();
  }

  noteAgentActivity(targetTaskId: string): void {
    const turn = this.turns.get(targetTaskId);
    if (!turn) return;
    turn.lastActivityAt = this.now();
    this.schedule();
  }

  /** A turn ended; check it against the open account. */
  onTargetTurnEnded(targetTaskId: string, cancelled = false): void {
    if (this.disposed) return;
    const hadUpdate = this.updated.delete(targetTaskId);
    this.turns.delete(targetTaskId);
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
          this.emit(account, "no_update");
        }
      }
    }
    this.schedule();
  }

  /** A runtime reset ended the target's turn without a turn-end check. */
  abortTurn(targetTaskId: string): void {
    this.turns.delete(targetTaskId);
    this.updated.delete(targetTaskId);
    this.schedule();
  }

  /** The task is gone. A target's account reports; a source's just goes away. */
  purgeTask(taskId: string): void {
    const account = this.accounts.get(taskId);
    if (account) {
      this.accounts.delete(taskId);
      this.emit(account, "target_removed");
    }
    for (const [targetTaskId, inbound] of [...this.accounts]) {
      if (inbound.sourceTaskId !== taskId) continue;
      this.accounts.delete(targetTaskId);
    }
    this.turns.delete(taskId);
    this.updated.delete(taskId);
    this.schedule();
  }

  /** Archiving cut this edge; the target left the source. */
  dropEdge(sourceTaskId: string, targetTaskId: string): void {
    const account = this.accounts.get(targetTaskId);
    if (account?.sourceTaskId === sourceTaskId) {
      this.accounts.delete(targetTaskId);
      this.emit(account, "target_removed");
    }
    this.turns.delete(targetTaskId);
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

  private schedule(): void {
    if (this.timer !== undefined) {
      this.opts.clearTimer(this.timer);
      this.timer = undefined;
    }
    if (this.disposed) return;
    let earliest: number | undefined;
    for (const [targetTaskId, turn] of this.turns) {
      if (turn.noticed) continue;
      if (!this.accounts.has(targetTaskId)) continue;
      const deadline = turn.lastActivityAt + SILENCE_THRESHOLD_MS;
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
    for (const [targetTaskId, turn] of this.turns) {
      if (turn.noticed) continue;
      if (turn.lastActivityAt + SILENCE_THRESHOLD_MS > now) continue;
      const account = this.accounts.get(targetTaskId);
      if (!account) continue;
      turn.noticed = true;
      this.emit(account, "no_activity");
    }
    this.schedule();
  }

  private emit(account: Account, reason: ObligationNoticeReason): void {
    this.opts.emitNotice({
      reason,
      sourceTaskId: account.sourceTaskId,
      targetTaskId: account.targetTaskId,
      message: noticeMessage(reason),
    });
  }
}

export function noticeMessage(reason: ObligationNoticeReason): string {
  switch (reason) {
    case "no_update":
      return "The target ended another turn without any task_update; the runtime stopped reminding.";
    case "no_activity":
      return `No agent activity for ${SILENCE_THRESHOLD_MS / 60_000} minutes; the turn is still running.`;
    case "target_removed":
      return "The target left this edge (deleted or archived); the account is gone.";
  }
}
