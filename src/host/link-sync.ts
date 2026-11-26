import { HTTP_STATUS } from "../http-status.ts";
import {
  parseLinkEnvelope,
  LinkProtocolError,
  type LinkEnvelope,
} from "../shared/link-envelope.ts";
import {
  SyncFeedConsumer,
  SyncFeedProtocolError,
  SyncOutbox,
  type SyncFeedConsumerOptions,
  type SyncFeedEntry,
  type SyncFeedTransport,
  type SyncRequestResult,
  type SyncRequestTransport,
  type SyncTimer,
} from "../shared/sync/index.ts";
import type { LinkApplyEffects, OutboxRow, Store } from "../store.ts";

export interface LinkWatchObserver {
  entry(entry: SyncFeedEntry<LinkEnvelope>): void | Promise<void>;
  heartbeat?(): void;
  closed?(error: unknown): void;
}

export interface LinkPushResponse {
  status: number;
  body: unknown;
}

export interface LinkSyncEffectCallbacks {
  drainTask?(taskId: string): void;
  outboxChanged?(entryId: string): void;
  pushed?(position: number): void;
}

interface OwnerSubscription {
  active: boolean;
  pumping: boolean;
  after: number;
  host: string;
  observer: LinkWatchObserver;
}

export class LinkSyncOwner {
  private readonly store: Store;
  private readonly effects: LinkSyncEffectCallbacks;
  private readonly subscriptions = new Set<OwnerSubscription>();

  constructor(store: Store, effects: LinkSyncEffectCallbacks = {}) {
    this.store = store;
    this.effects = effects;
  }

  read(
    host: string,
    after: number,
    limit = 100,
  ): SyncFeedEntry<LinkEnvelope>[] {
    const boundedLimit = Math.max(1, Math.min(100, limit));
    return this.store
      .listOutbox("parent", host, after, boundedLimit)
      .map(outboxEntry);
  }

  watch(host: string, after: number, observer: LinkWatchObserver): () => void {
    const subscription: OwnerSubscription = {
      active: true,
      pumping: false,
      after,
      host,
      observer,
    };
    this.subscriptions.add(subscription);
    void this.pump(subscription);
    return () => {
      subscription.active = false;
      this.subscriptions.delete(subscription);
    };
  }

  publish(entryId: string): void {
    const row = this.store.getOutbox(entryId);
    if (row?.remote_role !== "parent") return;
    for (const subscription of this.subscriptions) {
      if (subscription.host === row.remote_host) {
        void this.pump(subscription);
      }
    }
  }

  heartbeat(): void {
    for (const subscription of this.subscriptions) {
      subscription.observer.heartbeat?.();
    }
  }

  push(host: string, raw: unknown): LinkPushResponse {
    let envelope: LinkEnvelope;
    try {
      envelope = parseLinkEnvelope(raw);
    } catch (error) {
      return protocolResponse(error);
    }
    try {
      const result = this.store.applyLinkPushOperation({
        remoteRole: "parent",
        remoteHost: host,
        envelope,
      });
      executeLinkEffects(this.store, result, this.effects);
      for (const entryId of result.outboxEntryIds) {
        this.publish(entryId);
      }
      return { status: HTTP_STATUS.ACCEPTED, body: { accepted: true } };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "link_inbound_op_conflict"
      ) {
        return {
          status: HTTP_STATUS.CONFLICT,
          body: { error: "link_op_conflict" },
        };
      }
      return protocolResponse(error);
    }
  }

  private async pump(subscription: OwnerSubscription): Promise<void> {
    if (!this.isActive(subscription) || subscription.pumping) return;
    subscription.pumping = true;
    try {
      for (;;) {
        if (!this.isActive(subscription)) return;
        const frames = this.read(subscription.host, subscription.after);
        if (frames.length === 0) return;
        for (const frame of frames) {
          if (!this.isActive(subscription)) return;
          if (frame.pos <= subscription.after) continue;
          await subscription.observer.entry(frame);
          subscription.after = frame.pos;
        }
        if (!this.isActive(subscription)) return;
      }
    } catch (error) {
      this.subscriptions.delete(subscription);
      subscription.active = false;
      try {
        subscription.observer.closed?.(error);
      } catch {
        // A reporting hook cannot keep a failed subscription registered.
      }
    } finally {
      subscription.pumping = false;
    }
  }

  private isActive(subscription: OwnerSubscription): boolean {
    return subscription.active;
  }
}

export interface LinkSyncHubOptions {
  host: string;
  store: Store;
  transport: SyncFeedTransport<unknown>;
  retryDelay: SyncFeedConsumerOptions["retryDelay"];
  handshakeTimeoutMs?: number;
  onConnecting?: () => void;
  onConnected?: () => void;
  onFailure?: SyncFeedConsumerOptions["onFailure"];
  onProtocolError?: SyncFeedConsumerOptions["onProtocolError"];
  clock?: SyncFeedConsumerOptions["clock"];
  effects?: LinkSyncEffectCallbacks;
}

export class LinkSyncHubConsumer {
  private readonly options: LinkSyncHubOptions;
  private readonly consumer: SyncFeedConsumer<unknown>;
  private appliedPos: number | null = null;

  constructor(options: LinkSyncHubOptions) {
    this.options = options;
    this.consumer = new SyncFeedConsumer({
      port: {
        applied: () => {
          this.appliedPos ??= options.store.getOutboxCursor(
            "child",
            options.host,
          );
          return this.appliedPos;
        },
        apply: (entry, expected) => this.apply(entry, expected),
      },
      transport: options.transport,
      retryDelay: options.retryDelay,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      onConnecting: options.onConnecting,
      onConnected: options.onConnected,
      onFailure: options.onFailure,
      onProtocolError: options.onProtocolError,
      clock: options.clock,
    });
  }

  start(): void {
    this.consumer.start();
  }

  stop(): void {
    this.consumer.stop();
  }

  reconnect(): void {
    this.consumer.reconnect();
  }

  private apply(
    entry: SyncFeedEntry<unknown>,
    expectedApplied: number,
  ): boolean {
    try {
      const envelope = parseLinkEnvelope(entry.data);
      const result = this.options.store.applyLinkFeedOperation({
        remoteRole: "child",
        remoteHost: this.options.host,
        expectedApplied,
        nextApplied: entry.pos,
        envelope,
      });
      if (result.committed) {
        this.appliedPos = entry.pos;
        executeLinkEffects(
          this.options.store,
          result.effects,
          this.options.effects,
        );
      }
      return result.committed;
    } catch (error) {
      if (error instanceof LinkProtocolError) {
        throw new SyncFeedProtocolError(error.message);
      }
      throw error;
    }
  }
}

export interface LinkSyncHubPusherOptions {
  host: string;
  store: Store;
  transport: SyncRequestTransport<LinkEnvelope, unknown>;
  timeoutMs?: number;
  retryDelay: (attempt: number, result: SyncRequestResult<unknown>) => number;
  timer?: SyncTimer;
  onAuthFailure?: () => void;
  onLinkFault?: (result: SyncRequestResult<unknown>) => void;
}

const DEFAULT_SYNC_TIMER: SyncTimer = {
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return timer;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class LinkSyncHubPusher {
  private readonly options: LinkSyncHubPusherOptions;
  private readonly outbox: SyncOutbox<LinkEnvelope, unknown>;

  constructor(options: LinkSyncHubPusherOptions) {
    this.options = options;
    this.outbox = new SyncOutbox({
      port: {
        next: () => this.next(),
        finish: (entry, result) => this.finish(entry, result),
      },
      transport: options.transport,
      timer: options.timer ?? DEFAULT_SYNC_TIMER,
      timeoutMs: options.timeoutMs ?? 8_000,
      retryDelay: options.retryDelay,
    });
  }

  start(): void {
    this.outbox.start();
  }

  stop(): void {
    this.outbox.stop();
  }

  wake(): void {
    this.outbox.wake();
  }

  handedOffPosition(position: number): void {
    this.outbox.handedOffPosition(position);
  }

  private next() {
    const pushed = this.options.store.getOutboxPushCursor(
      "child",
      this.options.host,
    );
    const rows = this.options.store.listOutbox(
      "child",
      this.options.host,
      pushed,
      1,
    );
    if (rows.length === 0) return undefined;
    const row = rows[0];
    return {
      id: row.entry_id,
      position: row.pos,
      request: parseLinkEnvelope({
        id: row.entry_id,
        category: row.category,
        data: JSON.parse(row.data_json) as unknown,
      }),
    };
  }

  private finish(
    entry: { id: string; position: number; request: LinkEnvelope },
    result: SyncRequestResult<unknown>,
  ): boolean {
    const pushed = this.options.store.getOutboxPushCursor(
      "child",
      this.options.host,
    );
    if (pushed >= entry.position) return true;
    if (result.kind === "success") {
      if (result.status !== HTTP_STATUS.ACCEPTED) return false;
      this.options.store.advanceOutboxPushCursor(
        "child",
        this.options.host,
        entry.id,
      );
      return true;
    }
    if (result.kind === "rejected") {
      if (
        result.status === HTTP_STATUS.UNAUTHORIZED ||
        result.status === HTTP_STATUS.FORBIDDEN
      ) {
        this.options.onAuthFailure?.();
        return false;
      }
      if (entry.request.category === "receipt") {
        this.options.onLinkFault?.(result);
        return false;
      }
      const reason =
        result.body &&
        typeof result.body === "object" &&
        typeof (result.body as { error?: unknown }).error === "string"
          ? (result.body as { error: string }).error
          : `http_${result.status}`;
      const effects = this.options.store.rejectOutboxHead(
        "child",
        this.options.host,
        entry.id,
        reason,
      );
      this.options.store.broadcastDeliveryStatus(effects.deliveryStatusIds, {
        suppressFailureNotice: true,
      });
      return true;
    }
    return false;
  }
}

function executeLinkEffects(
  store: Store,
  effects: LinkApplyEffects,
  callbacks: LinkSyncEffectCallbacks | undefined,
): void {
  store.broadcastDeliveryStatus(effects.deliveryStatusIds, {
    suppressFailureNotice: true,
  });
  for (const taskId of effects.drainTaskIds) callbacks?.drainTask?.(taskId);
  for (const entryId of effects.outboxEntryIds) {
    callbacks?.outboxChanged?.(entryId);
  }
  for (const position of effects.pushCursorPos) {
    callbacks?.pushed?.(position);
  }
}

function outboxEntry(row: OutboxRow): SyncFeedEntry<LinkEnvelope> {
  return {
    pos: row.pos,
    prev: row.prev,
    data: parseLinkEnvelope({
      id: row.entry_id,
      category: row.category,
      data: JSON.parse(row.data_json) as unknown,
    }),
  };
}

function protocolResponse(error: unknown): LinkPushResponse {
  if (error instanceof LinkProtocolError) {
    return {
      status: HTTP_STATUS.BAD_REQUEST,
      body: { error: error.message },
    };
  }
  throw error;
}
