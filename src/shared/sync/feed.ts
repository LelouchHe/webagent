import {
  StreamSupervisor,
  type StreamAttempt,
  type StreamClock,
  type StreamFailure,
} from "../stream-supervisor.ts";

export interface SyncFeedEntry<TData = unknown> {
  pos: number;
  prev: number;
  data: TData;
}

export interface SyncFeedCatchUpPlan {
  targetPos?: number;
  commit?: () => void | Promise<void>;
}

export interface SyncFeedPort<TData = unknown, TEphemeral = unknown> {
  applied(): number | Promise<number>;
  apply(
    entry: SyncFeedEntry<TData>,
    expectedApplied: number,
  ): boolean | Promise<boolean>;
  applyEphemeral?(data: TEphemeral): void | Promise<void>;
  beforeCatchUp?(
    signal: AbortSignal,
  ): SyncFeedCatchUpPlan | void | Promise<SyncFeedCatchUpPlan | void>;
}

export interface SyncFeedReadOptions {
  upTo?: number;
}

export interface SyncFeedTransport<TData = unknown, TEphemeral = unknown> {
  read(
    after: number,
    signal: AbortSignal,
    opts?: SyncFeedReadOptions,
  ): Promise<SyncFeedEntry<TData>[]>;
  watch(input: {
    after: number;
    signal: AbortSignal;
    connected(): void;
    activity(): void;
    entry(entry: SyncFeedEntry<TData>): void | Promise<void>;
    ephemeral?(data: TEphemeral): void | Promise<void>;
  }): Promise<void>;
}

export class SyncFeedProtocolError extends Error {}

export class SyncFeedTerminalError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "SyncFeedTerminalError";
    this.status = status;
  }
}

export type SyncFeedLivenessMode = "owned" | "external";

export interface SyncFeedConsumerOptions<
  TData = unknown,
  TEphemeral = unknown,
> {
  port: SyncFeedPort<TData, TEphemeral>;
  transport: SyncFeedTransport<TData, TEphemeral>;
  retryDelay: (failures: number, failure: StreamFailure) => number;
  handshakeTimeoutMs?: number;
  liveness?: SyncFeedLivenessMode;
  catchUpOnConnect?: boolean;
  onConnecting?: () => void;
  onConnected?: () => void;
  onFailure?: (failure: StreamFailure) => void;
  onProtocolError?: (error: SyncFeedProtocolError) => void;
  onTerminalError?: (error: SyncFeedTerminalError) => void;
  clock?: Partial<StreamClock>;
}

export class SyncFeedConsumer<TData = unknown, TEphemeral = unknown> {
  private readonly supervisor: StreamSupervisor;
  private readonly port: SyncFeedPort<TData, TEphemeral>;
  private readonly transport: SyncFeedTransport<TData, TEphemeral>;
  private readonly catchUpOnConnect: boolean;
  private readonly onConnecting?: () => void;
  private readonly onConnected?: () => void;
  private readonly onProtocolError?: SyncFeedConsumerOptions<
    TData,
    TEphemeral
  >["onProtocolError"];
  private readonly onTerminalError?: SyncFeedConsumerOptions<
    TData,
    TEphemeral
  >["onTerminalError"];
  private serial = Promise.resolve();
  private currentAttempt: StreamAttempt | null = null;
  private inflightCatchUp: Promise<void> | null = null;

  constructor(options: SyncFeedConsumerOptions<TData, TEphemeral>) {
    this.port = options.port;
    this.transport = options.transport;
    this.catchUpOnConnect = options.catchUpOnConnect ?? false;
    this.onConnecting = options.onConnecting;
    this.onConnected = options.onConnected;
    this.onProtocolError = options.onProtocolError;
    this.onTerminalError = options.onTerminalError;
    const isExternal = options.liveness === "external";
    this.supervisor = new StreamSupervisor({
      run: (attempt) => this.run(attempt),
      retryDelay: options.retryDelay,
      handshakeTimeoutMs: isExternal ? undefined : options.handshakeTimeoutMs,
      stallTimeoutMs: isExternal ? null : undefined,
      onFailure: options.onFailure,
      clock: options.clock,
    });
  }

  start(): StreamAttempt {
    this.inflightCatchUp = null;
    const attempt = this.supervisor.start();
    return attempt;
  }

  stop(): void {
    this.currentAttempt = null;
    this.inflightCatchUp = null;
    this.supervisor.stop();
  }

  reconnect(): void {
    this.inflightCatchUp = null;
    this.supervisor.reconnect();
  }

  catchUp(): Promise<void> {
    const attempt = this.currentAttempt;
    if (!attempt?.isCurrent()) return Promise.resolve();
    if (this.inflightCatchUp) return this.inflightCatchUp;
    const pending = this.enqueue(attempt, () => this.runCatchUp(attempt))
      .catch(() => undefined)
      .finally(() => {
        if (this.inflightCatchUp === pending) {
          this.inflightCatchUp = null;
        }
      });
    this.inflightCatchUp = pending;
    return pending;
  }

  private async run(attempt: StreamAttempt): Promise<void> {
    this.currentAttempt = attempt;
    this.inflightCatchUp = null;
    this.onConnecting?.();
    const applied = await this.port.applied();
    if (!attempt.isCurrent()) return;
    this.supervisor.beginHandshake(attempt);
    await this.transport.watch({
      after: applied,
      signal: attempt.signal,
      connected: () => {
        if (!attempt.isCurrent()) return;
        this.supervisor.connected(attempt);
        this.onConnected?.();
        if (this.catchUpOnConnect) {
          void this.catchUp();
        }
      },
      activity: () => {
        this.supervisor.noteActivity(attempt);
      },
      entry: (entry) => {
        this.supervisor.noteActivity(attempt);
        return this.enqueue(attempt, () => this.consume(entry, attempt));
      },
      ephemeral: (data) => {
        this.supervisor.noteActivity(attempt);
        return this.enqueue(attempt, () =>
          this.consumeEphemeral(data, attempt),
        );
      },
    });
    this.supervisor.reconnect(attempt);
  }

  private enqueue(
    attempt: StreamAttempt,
    work: () => Promise<void>,
  ): Promise<void> {
    const next = this.serial.then(async () => {
      if (!attempt.isCurrent()) return;
      try {
        await work();
      } catch (error) {
        this.handleQueuedError(error, attempt);
      }
    });
    this.serial = next.catch(() => undefined);
    return next;
  }

  private handleQueuedError(error: unknown, attempt: StreamAttempt): void {
    if (!attempt.isCurrent()) return;
    if (error instanceof SyncFeedProtocolError) {
      this.supervisor.stop();
      this.onProtocolError?.(error);
      return;
    }
    if (error instanceof SyncFeedTerminalError) {
      this.supervisor.stop();
      this.onTerminalError?.(error);
      return;
    }
    // Transient failure: immediately void this attempt so queued entries and
    // ephemeral frames cannot skip past recovery, then retry via supervisor.
    this.supervisor.reconnect(attempt);
  }

  private async consumeEphemeral(
    data: TEphemeral,
    attempt: StreamAttempt,
  ): Promise<void> {
    if (!attempt.isCurrent()) return;
    await this.port.applyEphemeral?.(data);
  }

  private async runCatchUp(attempt: StreamAttempt): Promise<void> {
    if (!attempt.isCurrent()) return;
    const plan = await this.port.beforeCatchUp?.(attempt.signal);
    if (!attempt.isCurrent()) return;
    let applied = await this.port.applied();
    if (!attempt.isCurrent()) return;

    const targetPos = plan?.targetPos;
    const readOpts = targetPos !== undefined ? { upTo: targetPos } : undefined;
    while (targetPos === undefined || applied < targetPos) {
      const entries = await this.transport.read(
        applied,
        attempt.signal,
        readOpts,
      );
      if (!attempt.isCurrent()) return;
      if (entries.length === 0) {
        if (targetPos !== undefined && applied < targetPos) {
          this.protocolError("feed read did not reach target position");
          return;
        }
        break;
      }
      const nextApplied = await this.applyReadPage(entries, applied, attempt);
      if (nextApplied === null) return;
      applied = nextApplied;
    }

    if (!attempt.isCurrent()) return;
    await plan?.commit?.();
  }

  private async applyReadPage(
    entries: readonly SyncFeedEntry<TData>[],
    startApplied: number,
    attempt: StreamAttempt,
  ): Promise<number | null> {
    let applied = startApplied;
    let progress = false;
    for (const missing of entries) {
      if (!attempt.isCurrent()) return null;
      if (missing.pos <= applied) continue;
      if (missing.prev !== applied) {
        this.protocolError("link read returned a broken chain");
        return null;
      }
      if (!(await this.apply(missing, applied, attempt))) return null;
      applied = await this.port.applied();
      if (!attempt.isCurrent()) return null;
      progress = true;
    }
    if (!progress) {
      this.protocolError("link read made no progress");
      return null;
    }
    return applied;
  }

  private async consume(
    entry: SyncFeedEntry<TData>,
    attempt: StreamAttempt,
  ): Promise<void> {
    if (!attempt.isCurrent()) return;
    let applied = await this.port.applied();
    if (!attempt.isCurrent()) return;
    if (entry.pos <= applied) return;
    while (entry.prev !== applied && entry.pos > applied) {
      const entries = await this.transport.read(applied, attempt.signal);
      if (!attempt.isCurrent()) return;
      if (entries.length === 0) {
        this.protocolError("link read did not fill feed gap");
        return;
      }
      let progress = false;
      for (const missing of entries) {
        if (!attempt.isCurrent()) return;
        if (missing.pos <= applied) continue;
        if (missing.prev !== applied) {
          this.protocolError("link read returned a broken chain");
          return;
        }
        if (!(await this.apply(missing, applied, attempt))) return;
        applied = await this.port.applied();
        if (!attempt.isCurrent()) return;
        progress = true;
        if (entry.pos <= applied) return;
      }
      if (!progress) {
        this.protocolError("link read made no progress");
        return;
      }
    }
    await this.apply(entry, applied, attempt);
  }

  private async apply(
    entry: SyncFeedEntry<TData>,
    applied: number,
    attempt: StreamAttempt,
  ): Promise<boolean> {
    const committed = await this.port.apply(entry, applied);
    if (!attempt.isCurrent()) return false;
    if (!committed) {
      this.protocolError("persistent apply did not advance expected position");
      return false;
    }
    return committed;
  }

  private protocolError(message: string): void {
    const error = new SyncFeedProtocolError(message);
    this.supervisor.stop();
    this.onProtocolError?.(error);
  }
}
