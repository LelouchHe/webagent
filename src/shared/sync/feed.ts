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

export interface SyncFeedPort<TData = unknown> {
  applied(): number | Promise<number>;
  apply(
    entry: SyncFeedEntry<TData>,
    expectedApplied: number,
  ): boolean | Promise<boolean>;
}

export interface SyncFeedTransport<TData = unknown> {
  read(after: number, signal: AbortSignal): Promise<SyncFeedEntry<TData>[]>;
  watch(input: {
    after: number;
    signal: AbortSignal;
    connected(): void;
    activity(): void;
    entry(entry: SyncFeedEntry<TData>): void | Promise<void>;
  }): Promise<void>;
}

export class SyncFeedProtocolError extends Error {}

export interface SyncFeedConsumerOptions<TData = unknown> {
  port: SyncFeedPort<TData>;
  transport: SyncFeedTransport<TData>;
  retryDelay: (failures: number, failure: StreamFailure) => number;
  handshakeTimeoutMs?: number;
  onConnecting?: () => void;
  onConnected?: () => void;
  onFailure?: (failure: StreamFailure) => void;
  onProtocolError?: (error: SyncFeedProtocolError) => void;
  clock?: Partial<StreamClock>;
}

export class SyncFeedConsumer<TData = unknown> {
  private readonly supervisor: StreamSupervisor;
  private readonly port: SyncFeedPort<TData>;
  private readonly transport: SyncFeedTransport<TData>;
  private readonly onConnecting?: () => void;
  private readonly onConnected?: () => void;
  private readonly onProtocolError?: SyncFeedConsumerOptions["onProtocolError"];
  private serial = Promise.resolve();

  constructor(options: SyncFeedConsumerOptions<TData>) {
    this.port = options.port;
    this.transport = options.transport;
    this.onConnecting = options.onConnecting;
    this.onConnected = options.onConnected;
    this.onProtocolError = options.onProtocolError;
    this.supervisor = new StreamSupervisor({
      run: (attempt) => this.run(attempt),
      retryDelay: options.retryDelay,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      onFailure: options.onFailure,
      clock: options.clock,
    });
  }

  start(): StreamAttempt {
    return this.supervisor.start();
  }

  stop(): void {
    this.supervisor.stop();
  }

  reconnect(): void {
    this.supervisor.reconnect();
  }

  private async run(attempt: StreamAttempt): Promise<void> {
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
      },
      activity: () => {
        this.supervisor.noteActivity(attempt);
      },
      entry: (entry) => {
        this.supervisor.noteActivity(attempt);
        return this.queue(entry, attempt);
      },
    });
    this.supervisor.reconnect(attempt);
  }

  private queue(
    entry: SyncFeedEntry<TData>,
    attempt: StreamAttempt,
  ): Promise<void> {
    const next = this.serial.then(() => this.consume(entry, attempt));
    this.serial = next.catch(() => undefined);
    return next;
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
    let committed: boolean;
    try {
      committed = await this.port.apply(entry, applied);
    } catch (error) {
      if (!attempt.isCurrent()) return false;
      if (error instanceof SyncFeedProtocolError) {
        this.supervisor.stop();
        this.onProtocolError?.(error);
        return false;
      }
      throw error;
    }
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
