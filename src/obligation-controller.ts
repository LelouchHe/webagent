/**
 * Directed dispatch closure.
 *
 * An agent-authored direct parent→child dispatch opens exactly one in-process
 * account per `(sourceTaskId, targetTaskId)` edge. The account stays open until
 * the target reports `done` or `blocked` to the source, or the target leaves
 * the edge. There is no correlation token and no persisted state: a restart
 * simply forgets open accounts.
 *
 * Turn boundaries are the only clock. Every target turn that ends while the
 * account is open is checked once:
 *
 * - an update of any status in that turn resets the count;
 * - the first turn with no update gets one closing reminder;
 * - the next such turn reports `no_update` to the source and stops reminding.
 *
 * A separate watchdog reports a running turn that has had no agent activity for
 * 15 minutes. It only states the fact: no state change, no reminder, no
 * cancel. A cancelled turn triggers nothing.
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
   * Submit one closing reminder to the target. Best effort: a task that cannot
   * be woken now simply does not get one.
   */
  submitReminder: (targetTaskId: string) => void;
  /** Persist and deliver a runtime notice to the account's source. */
  emitNotice: (notice: ObligationNotice) => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

interface Account {
  sourceTaskId: string;
  targetTaskId: string;
  /** Consecutive target turns that ended with no `task_update`. */
  noUpdateTurns: number;
  /** `no_update` was already reported; stop reminding. */
  stopped: boolean;
}

interface RunningTurn {
  promptId: string;
  lastActivityAt: number;
  /** The silence notice was already emitted for this turn. */
  noticed: boolean;
  /** A `task_update` of any status arrived during this turn. */
  updated: boolean;
}

function edgeKey(sourceTaskId: string, targetTaskId: string): string {
  return `${sourceTaskId}\u0000${targetTaskId}`;
}

/**
 * Process-local directed-account state. All transitions are synchronous; the
 * only asynchronous effect is handing a reminder to the task runtime.
 */
export class ObligationController {
  private readonly accounts = new Map<string, Account>();
  private readonly turns = new Map<string, RunningTurn>();
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

  /** Open the edge's account, or keep the open one. */
  arm(sourceTaskId: string, targetTaskId: string): void {
    if (this.disposed) return;
    const key = edgeKey(sourceTaskId, targetTaskId);
    if (this.accounts.has(key)) return;
    this.accounts.set(key, {
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

  /** Any typed update resets the current turn's missing-update count. */
  noteUpdate(targetTaskId: string): void {
    const turn = this.turns.get(targetTaskId);
    if (turn) turn.updated = true;
  }

  /**
   * Settle the target's open account and return its source. `done` and
   * `blocked` use this; `waiting` deliberately does not.
   */
  settle(targetTaskId: string): string | undefined {
    const account = this.findForTarget(targetTaskId);
    if (!account) return undefined;
    this.accounts.delete(edgeKey(account.sourceTaskId, targetTaskId));
    this.log("account settled", {
      sourceTaskId: account.sourceTaskId.slice(0, 8),
      targetTaskId: targetTaskId.slice(0, 8),
    });
    this.schedule();
    return account.sourceTaskId;
  }

  beginTurn(targetTaskId: string, promptId: string): void {
    if (this.disposed) return;
    this.turns.set(targetTaskId, {
      promptId,
      lastActivityAt: this.now(),
      noticed: false,
      updated: false,
    });
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
    const turn = this.turns.get(targetTaskId);
    this.turns.delete(targetTaskId);
    const account = this.findForTarget(targetTaskId);
    if (account && !cancelled) {
      if (turn?.updated === true) {
        account.noUpdateTurns = 0;
      } else {
        account.noUpdateTurns += 1;
        if (account.noUpdateTurns === 1) {
          this.log("closing reminder", {
            sourceTaskId: account.sourceTaskId.slice(0, 8),
            targetTaskId: targetTaskId.slice(0, 8),
          });
          this.opts.submitReminder(targetTaskId);
        } else if (!account.stopped) {
          account.stopped = true;
          this.emit(account, "no_update");
        }
      }
    }
    this.schedule();
  }

  /**
   * A runtime reset ended the target's turn without a turn-end fact. It owes
   * nothing: drop the turn so the watchdog cannot report it.
   */
  abortTurn(targetTaskId: string): void {
    this.turns.delete(targetTaskId);
    this.schedule();
  }

  /**
   * The task is gone. An open account whose target disappeared reports
   * `target_removed` to its source; an account whose source disappeared just
   * goes away.
   */
  purgeTask(taskId: string): void {
    for (const account of [...this.accounts.values()]) {
      if (account.targetTaskId === taskId) {
        this.accounts.delete(
          edgeKey(account.sourceTaskId, account.targetTaskId),
        );
        this.emit(account, "target_removed");
      } else if (account.sourceTaskId === taskId) {
        this.accounts.delete(
          edgeKey(account.sourceTaskId, account.targetTaskId),
        );
      }
    }
    this.turns.delete(taskId);
    this.schedule();
  }

  /**
   * Archiving cut this edge. The target left the source; report it like a
   * deletion. Other edges are untouched.
   */
  dropEdge(sourceTaskId: string, targetTaskId: string): void {
    const key = edgeKey(sourceTaskId, targetTaskId);
    const account = this.accounts.get(key);
    this.accounts.delete(key);
    this.turns.delete(targetTaskId);
    if (account) this.emit(account, "target_removed");
    this.schedule();
  }

  hasOpen(sourceTaskId: string, targetTaskId: string): boolean {
    return this.accounts.has(edgeKey(sourceTaskId, targetTaskId));
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
      if (!this.findForTarget(targetTaskId)) continue;
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
      const account = this.findForTarget(targetTaskId);
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

  private findForTarget(targetTaskId: string): Account | undefined {
    for (const account of this.accounts.values()) {
      if (account.targetTaskId === targetTaskId) return account;
    }
    return undefined;
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
