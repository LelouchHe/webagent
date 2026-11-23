export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
export const STREAM_STALL_TIMEOUT_MS = 3 * SSE_HEARTBEAT_INTERVAL_MS;
export const STREAM_WATCHDOG_INTERVAL_MS = 5_000;

export type StreamFailureKind = "attempt" | "stalled" | "requested";

export interface StreamAttempt {
  readonly epoch: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export interface StreamFailure {
  attempt: StreamAttempt;
  kind: StreamFailureKind;
  error?: unknown;
  silentMs?: number;
}

interface StreamTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
}

export interface StreamSupervisorOptions {
  run(attempt: StreamAttempt): void | Promise<void>;
  retryDelay: (failures: number, failure: StreamFailure) => number;
  onFailure?: (failure: StreamFailure) => void;
  stallTimeoutMs?: number;
  watchdogIntervalMs?: number;
  timers?: StreamTimers;
}

const DEFAULT_TIMERS: StreamTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
  now: () => Date.now(),
};

/**
 * Owns the process-independent lifecycle for a single long-lived stream.
 * Every launch supersedes the prior epoch and aborts its work. The watchdog
 * starts before the caller opens a ticket, request, or stream, so a hung
 * pre-handshake operation is covered by the same silence deadline as the
 * established connection.
 *
 * EventSource can remain OPEN forever after a NAT rebind, HTTP/3 stall, or OS
 * resume, with neither bytes nor an error callback. Timestamping every frame
 * is therefore the only liveness signal, and the watchdog remains independent
 * of a concrete stream because a ticket mint can stall before one exists.
 *
 * A failed attempt schedules at most one retry. Suppressed timer or network
 * callbacks from invalidated epochs can neither mutate state nor schedule
 * another retry.
 */
export class StreamSupervisor {
  private readonly run: StreamSupervisorOptions["run"];
  private readonly retryDelay: StreamSupervisorOptions["retryDelay"];
  private readonly onFailure: StreamSupervisorOptions["onFailure"];
  private readonly stallTimeoutMs: number;
  private readonly watchdogIntervalMs: number;
  private readonly timers: StreamTimers;
  private epoch = 0;
  private current: StreamAttempt | null = null;
  private currentAbort: AbortController | null = null;
  private lastActivity = 0;
  private hasActivity = false;
  private failures = 0;
  private watchdog: unknown = null;
  private retry: unknown = null;
  private started = false;

  constructor(options: StreamSupervisorOptions) {
    this.run = (attempt) => options.run(attempt);
    this.retryDelay = (failures, failure) =>
      options.retryDelay(failures, failure);
    this.onFailure = options.onFailure
      ? (failure) => {
          options.onFailure?.(failure);
        }
      : undefined;
    this.stallTimeoutMs = options.stallTimeoutMs ?? STREAM_STALL_TIMEOUT_MS;
    this.watchdogIntervalMs = Math.min(
      options.watchdogIntervalMs ?? STREAM_WATCHDOG_INTERVAL_MS,
      this.stallTimeoutMs,
    );
    this.timers = options.timers ?? DEFAULT_TIMERS;
  }

  start(): StreamAttempt {
    this.started = true;
    this.clearRetry();
    this.invalidateCurrent();
    return this.launch();
  }

  stop(): void {
    if (!this.started && !this.current && !this.retry) return;
    this.started = false;
    this.clearRetry();
    this.invalidateCurrent();
    if (this.watchdog !== null) {
      this.timers.clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  /** Refresh liveness for any frame, including the initial handshake. */
  noteActivity(attempt: StreamAttempt | null = this.current): void {
    if (!attempt?.isCurrent()) return;
    this.lastActivity = this.timers.now();
    this.hasActivity = true;
  }

  /** Reset exponential backoff after a successful protocol handshake. */
  connected(attempt: StreamAttempt): void {
    if (!attempt.isCurrent()) return;
    this.failures = 0;
    this.noteActivity(attempt);
  }

  /** Request the sole retry for an explicit stream error. */
  reconnect(attempt: StreamAttempt, error?: unknown): void {
    this.fail(attempt, "requested", error);
  }

  /** Probe immediately, e.g. when an iOS runtime resumes after timer suspension. */
  checkLiveness(): void {
    const attempt = this.current;
    if (!attempt || !this.hasActivity) return;
    const silentMs = this.timers.now() - this.lastActivity;
    if (silentMs < this.stallTimeoutMs) return;
    this.fail(attempt, "stalled", undefined, silentMs);
  }

  private launch(): StreamAttempt {
    const abort = new AbortController();
    const epoch = ++this.epoch;
    const attempt: StreamAttempt = {
      epoch,
      signal: abort.signal,
      isCurrent: () => this.current?.epoch === epoch && !abort.signal.aborted,
    };
    this.currentAbort = abort;
    this.current = attempt;
    this.noteActivity(attempt);
    this.armWatchdog();
    try {
      Promise.resolve(this.run(attempt)).catch((error: unknown) => {
        this.fail(attempt, "attempt", error);
      });
    } catch (error) {
      this.fail(attempt, "attempt", error);
    }
    return attempt;
  }

  private fail(
    attempt: StreamAttempt,
    kind: StreamFailureKind,
    error?: unknown,
    silentMs?: number,
  ): void {
    if (!this.started || !attempt.isCurrent()) return;
    const delayBase = this.failures;
    this.invalidateCurrent();
    this.failures += 1;
    const failure = { attempt, kind, error, silentMs };
    this.onFailure?.(failure);
    this.scheduleRetry(delayBase, failure);
  }

  private scheduleRetry(failures: number, failure: StreamFailure): void {
    if (!this.started || this.retry !== null) return;
    const delay = Math.max(0, this.retryDelay(failures, failure));
    if (delay === 0) {
      this.launch();
      return;
    }
    const epoch = this.epoch;
    const retry = this.timers.setTimeout(() => {
      if (!this.started || epoch !== this.epoch || this.retry !== retry) return;
      this.retry = null;
      this.launch();
    }, delay);
    this.retry = retry;
    const unref = (retry as { unref?: () => void } | null)?.unref;
    unref?.call(retry);
  }

  private armWatchdog(): void {
    if (this.watchdog !== null) return;
    const watchdog = this.timers.setInterval(() => {
      this.checkLiveness();
    }, this.watchdogIntervalMs);
    this.watchdog = watchdog;
    const unref = (watchdog as { unref?: () => void } | null)?.unref;
    unref?.call(watchdog);
  }

  private invalidateCurrent(): void {
    this.currentAbort?.abort();
    this.currentAbort = null;
    this.current = null;
    this.lastActivity = 0;
    this.hasActivity = false;
    this.epoch += 1;
  }

  private clearRetry(): void {
    if (this.retry === null) return;
    this.timers.clearTimeout(this.retry);
    this.retry = null;
  }
}
