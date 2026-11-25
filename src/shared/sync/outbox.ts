import {
  sendSyncRequest,
  type SyncRequestResult,
  type SyncRequestTransport,
  type SyncTimer,
} from "./request.ts";

export interface SyncOutboxEntry<TRequest = unknown> {
  id: string;
  request: TRequest;
  position: number;
}

export interface SyncOutboxPort<TRequest = unknown, TResponse = unknown> {
  next():
    | SyncOutboxEntry<TRequest>
    | undefined
    | Promise<SyncOutboxEntry<TRequest> | undefined>;
  finish(
    entry: SyncOutboxEntry<TRequest>,
    result: SyncRequestResult<TResponse>,
  ): boolean | Promise<boolean>;
}

export interface SyncOutboxOptions<TRequest = unknown, TResponse = unknown> {
  port: SyncOutboxPort<TRequest, TResponse>;
  transport: SyncRequestTransport<TRequest, TResponse>;
  timer: SyncTimer;
  timeoutMs: number;
  retryDelay(attempt: number, result: SyncRequestResult<TResponse>): number;
}

export class SyncOutbox<TRequest = unknown, TResponse = unknown> {
  private readonly port: SyncOutboxPort<TRequest, TResponse>;
  private readonly options: SyncOutboxOptions<TRequest, TResponse>;
  private active: {
    id: string;
    generation: number;
    retry: unknown;
  } | null = null;
  private generation = 0;
  private started = false;
  private pumping = false;

  constructor(options: SyncOutboxOptions<TRequest, TResponse>) {
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
    if (this.active?.retry !== null && this.active?.retry !== undefined) {
      this.options.timer.clearTimeout(this.active.retry);
    }
    this.active = null;
  }

  wake(): void {
    if (!this.started) return;
    void this.pump();
  }

  handedOff(entryId: string): void {
    if (this.active?.id !== entryId) return;
    if (this.active.retry !== null) {
      this.options.timer.clearTimeout(this.active.retry);
    }
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
      this.active = { id: entry.id, generation, retry: null };
      void this.send(entry, generation, 1);
    } finally {
      this.pumping = false;
    }
  }

  private async send(
    entry: SyncOutboxEntry<TRequest>,
    generation: number,
    attempt: number,
  ): Promise<void> {
    if (
      !this.isStarted() ||
      this.generation !== generation ||
      !this.isActive(entry.id, generation)
    ) {
      return;
    }
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
    const active = this.active;
    if (!active) return;
    active.retry = this.options.timer.setTimeout(() => {
      if (this.active !== active) return;
      active.retry = null;
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
