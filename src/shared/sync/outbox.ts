import {
  sendSyncRequest,
  type SyncRequestResult,
  type SyncRequestTransport,
  type SyncTimer,
} from "./request.ts";

export interface SyncOutboxEntry {
  id: string;
  request: unknown;
}

export interface SyncOutboxPort {
  next(): SyncOutboxEntry | undefined | Promise<SyncOutboxEntry | undefined>;
  finish(
    entry: SyncOutboxEntry,
    result: SyncRequestResult,
  ): boolean | Promise<boolean>;
}

export interface SyncOutboxOptions {
  port: SyncOutboxPort;
  transport: SyncRequestTransport;
  timer: SyncTimer;
  timeoutMs: number;
  retryDelay(attempt: number, result: SyncRequestResult): number;
}

export class SyncOutbox {
  private readonly port: SyncOutboxPort;
  private readonly options: SyncOutboxOptions;
  private active: { id: string; generation: number } | null = null;
  private generation = 0;
  private retry: unknown = null;
  private started = false;
  private pumping = false;

  constructor(options: SyncOutboxOptions) {
    this.port = options.port;
    this.options = options;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.pump();
  }

  stop(): void {
    this.started = false;
    this.generation += 1;
    this.active = null;
    if (this.retry !== null) {
      this.options.timer.clearTimeout(this.retry);
      this.retry = null;
    }
  }

  wake(): void {
    if (!this.started) return;
    if (this.retry !== null) {
      this.options.timer.clearTimeout(this.retry);
      this.retry = null;
    }
    void this.pump();
  }

  handedOff(entryId: string): void {
    if (this.active?.id !== entryId) return;
    this.generation += 1;
    this.active = null;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (!this.started || this.pumping || this.active) return;
    this.pumping = true;
    try {
      const entry = await this.port.next();
      if (!entry || !this.isStarted() || this.hasActive()) return;
      const generation = ++this.generation;
      this.active = { id: entry.id, generation };
      void this.send(entry, generation, 1);
    } finally {
      this.pumping = false;
    }
  }

  private async send(
    entry: SyncOutboxEntry,
    generation: number,
    attempt: number,
  ): Promise<void> {
    const result = await sendSyncRequest({
      operationId: entry.id,
      request: entry.request,
      timeoutMs: this.options.timeoutMs,
      transport: this.options.transport,
      timer: this.options.timer,
    });
    if (
      !this.started ||
      this.generation !== generation ||
      !this.isActive(entry.id, generation)
    ) {
      return;
    }
    const release = await this.port.finish(entry, result);
    if (
      this.generation !== generation ||
      !this.isActive(entry.id, generation)
    ) {
      return;
    }
    if (release) {
      this.active = null;
      void this.pump();
      return;
    }
    const delay = this.options.retryDelay(attempt, result);
    if (delay <= 0) {
      void this.send(entry, generation, attempt + 1);
      return;
    }
    this.retry = this.options.timer.setTimeout(() => {
      this.retry = null;
      void this.send(entry, generation, attempt + 1);
    }, delay);
  }

  private hasActive(): boolean {
    return this.active !== null;
  }

  private isStarted(): boolean {
    return this.started;
  }

  private isActive(id: string, generation: number): boolean {
    return this.active?.id === id && this.active.generation === generation;
  }
}
