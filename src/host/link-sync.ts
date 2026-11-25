import { HTTP_STATUS } from "../http-status.ts";
import {
  parseLinkEnvelope,
  LinkProtocolError,
  type LinkEnvelope,
} from "../shared/link-envelope.ts";
import {
  SyncFeedConsumer,
  SyncFeedProtocolError,
  type SyncFeedConsumerOptions,
  type SyncFeedEntry,
  type SyncFeedTransport,
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
  handedOff?(entryId: string): void;
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
  onFailure?: SyncFeedConsumerOptions["onFailure"];
  onProtocolError?: SyncFeedConsumerOptions["onProtocolError"];
  clock?: SyncFeedConsumerOptions["clock"];
  effects?: LinkSyncEffectCallbacks;
}

export class LinkSyncHubConsumer {
  private readonly options: LinkSyncHubOptions;
  private readonly consumer: SyncFeedConsumer<unknown>;

  constructor(options: LinkSyncHubOptions) {
    this.options = options;
    this.consumer = new SyncFeedConsumer({
      port: {
        applied: () => options.store.getOutboxCursor("child", options.host),
        apply: (entry, expected) => this.apply(entry, expected),
      },
      transport: options.transport,
      retryDelay: options.retryDelay,
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
  for (const entryId of effects.handoffEntryIds) {
    callbacks?.handedOff?.(entryId);
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
