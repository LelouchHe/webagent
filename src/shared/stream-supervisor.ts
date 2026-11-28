export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
export const STREAM_STALL_TIMEOUT_MS = 3 * SSE_HEARTBEAT_INTERVAL_MS;
const WATCHDOG_INTERVAL_MS = 5_000;

export type StreamFailureKind = "attempt" | "stalled" | "requested";

export interface StreamAttempt {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export interface StreamFailure {
  kind: StreamFailureKind;
  error?: unknown;
  silentMs?: number;
}

export interface StreamClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface StreamSupervisorOptions {
  run(attempt: StreamAttempt): void | Promise<void>;
  retryDelay: (failures: number, failure: StreamFailure) => number;
  onFailure?: (failure: StreamFailure) => void;
  handshakeTimeoutMs?: number;
  stallTimeoutMs?: number | null;
  clock?: Partial<StreamClock>;
}

const DEFAULT_CLOCK: StreamClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * Environment-independent lifecycle for one stream. A single object identifies
 * each attempt: superseding it aborts its signal, and stale continuations see
 * `isCurrent() === false`.
 *
 * The watchdog begins before ticket mint/stream creation because EventSource
 * can remain OPEN after NAT rebind, HTTP/3 stall, or OS resume with neither
 * bytes nor an error. Silence is then the only liveness signal.
 */
export class StreamSupervisor {
  private readonly run: StreamSupervisorOptions["run"];
  private readonly retryDelay: StreamSupervisorOptions["retryDelay"];
  private readonly onFailure: StreamSupervisorOptions["onFailure"];
  private readonly handshakeTimeoutMs: number | null;
  private readonly stallTimeoutMs: number | null;
  private readonly clock: StreamClock;
  private current: StreamAttempt | null = null;
  private abort: AbortController | null = null;
  private lastActivity: number | null = null;
  private failures = 0;
  private watchdog: unknown = null;
  private retry: unknown = null;
  private handshake: unknown = null;
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
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? null;
    this.stallTimeoutMs =
      options.stallTimeoutMs === undefined
        ? STREAM_STALL_TIMEOUT_MS
        : options.stallTimeoutMs;
    this.clock = { ...DEFAULT_CLOCK, ...options.clock };
  }

  start(): StreamAttempt {
    this.started = true;
    this.clearRetry();
    this.invalidate();
    return this.launch();
  }

  stop(): void {
    if (!this.started && !this.current && !this.retry) return;
    this.started = false;
    this.clearRetry();
    this.invalidate();
    this.clearWatchdog();
  }

  noteActivity(attempt: StreamAttempt): void {
    if (!attempt.isCurrent()) return;
    this.lastActivity = this.clock.now();
  }

  beginHandshake(attempt: StreamAttempt): void {
    if (!attempt.isCurrent() || this.handshakeTimeoutMs === null) return;
    this.clearHandshake();
    const timer = this.clock.setTimeout(() => {
      if (!attempt.isCurrent() || this.handshake !== timer) return;
      this.handshake = null;
      this.fail(attempt, "attempt");
    }, this.handshakeTimeoutMs);
    this.handshake = timer;
    unref(timer);
  }

  connected(attempt: StreamAttempt): void {
    if (!attempt.isCurrent()) return;
    this.clearHandshake();
    this.failures = 0;
    this.noteActivity(attempt);
  }

  reconnect(attempt: StreamAttempt | null = this.current): void {
    if (!attempt) return;
    this.fail(attempt, "requested");
  }

  checkLiveness(): void {
    const attempt = this.current;
    if (
      !attempt ||
      this.lastActivity === null ||
      this.stallTimeoutMs === null
    ) {
      return;
    }
    const silentMs = this.clock.now() - this.lastActivity;
    if (silentMs < this.stallTimeoutMs) return;
    this.fail(attempt, "stalled", undefined, silentMs);
  }

  private launch(): StreamAttempt {
    const abort = new AbortController();
    const attempt: StreamAttempt = {
      signal: abort.signal,
      isCurrent: () => this.current === attempt && !abort.signal.aborted,
    };
    this.abort = abort;
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
    const failures = this.failures;
    this.invalidate();
    this.failures += 1;
    const failure = { kind, error, silentMs };
    this.onFailure?.(failure);
    // Synchronous start() from onFailure or abort callbacks is unsupported:
    // callers report/clean up here and let the retry path launch.
    const delay = Math.max(0, this.retryDelay(failures, failure));
    if (delay === 0) {
      this.launch();
      return;
    }
    const retry = this.clock.setTimeout(() => {
      if (!this.started || this.retry !== retry) return;
      this.retry = null;
      this.launch();
    }, delay);
    this.retry = retry;
    unref(retry);
  }

  private armWatchdog(): void {
    if (this.watchdog !== null || this.stallTimeoutMs === null) return;
    const interval = Math.min(WATCHDOG_INTERVAL_MS, this.stallTimeoutMs);
    const watchdog = this.clock.setInterval(() => {
      this.checkLiveness();
    }, interval);
    this.watchdog = watchdog;
    unref(watchdog);
  }

  private invalidate(): void {
    this.clearHandshake();
    this.abort?.abort();
    this.abort = null;
    this.current = null;
    this.lastActivity = null;
  }

  private clearHandshake(): void {
    if (this.handshake === null) return;
    this.clock.clearTimeout(this.handshake);
    this.handshake = null;
  }

  private clearWatchdog(): void {
    if (this.watchdog === null) return;
    this.clock.clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private clearRetry(): void {
    if (this.retry === null) return;
    this.clock.clearTimeout(this.retry);
    this.retry = null;
  }
}

function unref(timer: unknown): void {
  (timer as { unref?: () => void } | null)?.unref?.();
}
