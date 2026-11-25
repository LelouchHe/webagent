import {
  StreamSupervisor,
  type StreamAttempt,
  type StreamClock,
  type StreamFailure,
} from "../stream-supervisor.ts";

export interface SyncFeedEntry {
  pos: number;
  prev: number;
  data: unknown;
}

export interface SyncFeedPort {
  applied(): number | Promise<number>;
  apply(
    entry: SyncFeedEntry,
    expectedApplied: number,
  ): boolean | Promise<boolean>;
}

export interface SyncFeedTransport {
  read(after: number, signal: AbortSignal): Promise<SyncFeedEntry[]>;
  watch(input: {
    after: number;
    signal: AbortSignal;
    connected(): void;
    entry(entry: SyncFeedEntry): void | Promise<void>;
  }): Promise<void>;
}

export class SyncFeedProtocolError extends Error {}

export interface SyncFeedConsumerOptions {
  port: SyncFeedPort;
  transport: SyncFeedTransport;
  retryDelay: (failures: number, failure: StreamFailure) => number;
  onFailure?: (failure: StreamFailure) => void;
  onProtocolError?: (error: SyncFeedProtocolError) => void;
  clock?: Partial<StreamClock>;
}

export class SyncFeedConsumer {
  private readonly supervisor: StreamSupervisor;
  private readonly port: SyncFeedPort;
  private readonly transport: SyncFeedTransport;
  private serial = Promise.resolve();

  constructor(options: SyncFeedConsumerOptions) {
    this.port = options.port;
    this.transport = options.transport;
    this.supervisor = new StreamSupervisor({
      run: (attempt) => this.run(attempt),
      retryDelay: options.retryDelay,
      onFailure: options.onFailure,
      clock: options.clock,
    });
    this.onProtocolError = options.onProtocolError;
  }

  private readonly onProtocolError?: SyncFeedConsumerOptions["onProtocolError"];

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
    const applied = await this.port.applied();
    if (!attempt.isCurrent()) return;
    await this.transport.watch({
      after: applied,
      signal: attempt.signal,
      connected: () => {
        this.supervisor.connected(attempt);
      },
      entry: (entry) => this.queue(entry, attempt),
    });
    this.supervisor.reconnect(attempt);
  }

  private queue(entry: SyncFeedEntry, attempt: StreamAttempt): Promise<void> {
    const next = this.serial.then(() => this.consume(entry, attempt));
    this.serial = next.catch(() => undefined);
    return next;
  }

  private async consume(
    entry: SyncFeedEntry,
    attempt: StreamAttempt,
    canRead = true,
  ): Promise<void> {
    if (!attempt.isCurrent()) return;
    const applied = await this.port.applied();
    if (!attempt.isCurrent() || entry.pos <= applied) return;
    if (entry.prev !== applied) {
      if (!canRead) {
        this.protocolError("gap remained after peer read");
        return;
      }
      const entries = await this.transport.read(applied, attempt.signal);
      if (!attempt.isCurrent()) return;
      if (entries.length === 0) {
        this.protocolError("peer read did not fill feed gap");
        return;
      }
      for (const missing of entries) {
        await this.consume(missing, attempt, false);
      }
      return this.consume(entry, attempt, false);
    }
    let committed: boolean;
    try {
      committed = await this.port.apply(entry, applied);
    } catch (error) {
      if (error instanceof SyncFeedProtocolError) {
        this.supervisor.stop();
        this.onProtocolError?.(error);
        return;
      }
      throw error;
    }
    if (!committed && attempt.isCurrent()) {
      this.protocolError("persistent apply did not advance expected position");
    }
  }

  private protocolError(message: string): void {
    const error = new SyncFeedProtocolError(message);
    this.supervisor.stop();
    this.onProtocolError?.(error);
  }
}
