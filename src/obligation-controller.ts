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
  /** Queue a runtime notice to the account's source and close the account. */
  emitNotice: (notice: ObligationNotice) => void;
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

/** A silence window: a running turn, or a `waiting` with no visible wake source. */
interface SilenceWatch {
  lastActivityAt: number;
  /** The silence notice was already emitted for this window. */
  noticed: boolean;
}

/**
 * Process-local directed-account state, keyed by target. The only asynchronous
 * effect is queueing a reminder or notice for the delivery drain.
 */
export class ObligationController {
  private readonly accounts = new Map<string, Account>();
  private readonly turns = new Map<string, SilenceWatch>();
  /** Targets that reported `waiting` with no runtime-visible wake source. */
  private readonly waits = new Map<string, SilenceWatch>();
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
    if (this.turns.has(targetTaskId)) this.updated.add(targetTaskId);
    if (this.waits.delete(targetTaskId)) this.schedule();
  }

  /**
   * The target reported `waiting` and the runtime sees nothing that will wake
   * it. While its account is open, watch it for silence like a running turn.
   * Call after {@link noteUpdate}.
   */
  noteUnwatchedWaiting(targetTaskId: string): boolean {
    if (this.disposed || !this.accounts.has(targetTaskId)) return false;
    this.waits.set(targetTaskId, {
      lastActivityAt: this.now(),
      noticed: false,
    });
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
    this.waits.delete(targetTaskId);
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
    this.waits.delete(targetTaskId);
    this.emit(account, "target_removed");
    this.schedule();
  }

  /** A prompt was actually submitted for this turn. */
  beginTurn(targetTaskId: string): void {
    if (this.disposed) return;
    this.updated.delete(targetTaskId);
    // A real turn takes over: its end is checked against the account.
    this.waits.delete(targetTaskId);
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
    const wait = this.waits.get(targetTaskId);
    if (!turn && !wait) return;
    const now = this.now();
    if (turn) turn.lastActivityAt = now;
    if (wait) wait.lastActivityAt = now;
    this.schedule();
  }

  /** A turn ended; check it against the open account. */
  onTargetTurnEnded(targetTaskId: string, cancelled = false): void {
    if (this.disposed) return;
    const hadUpdate = this.updated.delete(targetTaskId);
    this.turns.delete(targetTaskId);
    // A waiting reported in this turn is watched from the turn's end.
    const wait = this.waits.get(targetTaskId);
    if (wait) wait.lastActivityAt = this.now();
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
    this.waits.delete(taskId);
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
    this.waits.delete(targetTaskId);
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

  /** A running turn's own watch supersedes the target's waiting watch. */
  private *silenceWatches(): Iterable<[string, SilenceWatch]> {
    yield* this.turns;
    for (const entry of this.waits) {
      if (!this.turns.has(entry[0])) yield entry;
    }
  }

  private schedule(): void {
    if (this.timer !== undefined) {
      this.opts.clearTimer(this.timer);
      this.timer = undefined;
    }
    if (this.disposed) return;
    let earliest: number | undefined;
    for (const [targetTaskId, watch] of this.silenceWatches()) {
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
    for (const [targetTaskId, watch] of this.silenceWatches()) {
      if (watch.noticed) continue;
      if (watch.lastActivityAt + this.silenceMs > now) continue;
      const account = this.accounts.get(targetTaskId);
      if (!account) continue;
      watch.noticed = true;
      this.emit(account, "no_activity");
    }
    this.schedule();
  }

  private emit(account: Account, reason: ObligationNoticeReason): void {
    this.opts.emitNotice({
      reason,
      sourceTaskId: account.sourceTaskId,
      targetTaskId: account.targetTaskId,
      message: noticeMessage(reason, this.silenceMs),
    });
  }
}

export function formatSilence(ms: number): string {
  const minutes = ms / 60_000;
  if (Number.isInteger(minutes)) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${Math.round(ms / 1000)} seconds`;
}

export function noticeMessage(
  reason: ObligationNoticeReason,
  silenceMs = SILENCE_THRESHOLD_MS,
): string {
  switch (reason) {
    case "no_update":
      return "The target ended another turn without any task_update; the runtime stopped reminding.";
    case "no_activity":
      return `No agent activity for ${formatSilence(silenceMs)} while the account is open.`;
    case "target_removed":
      return "The target left this edge (deleted or archived); the account is gone.";
  }
}
