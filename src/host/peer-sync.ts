import { HTTP_STATUS } from "../http-status.ts";
import {
  parsePeerEnvelope,
  PeerProtocolError,
  type PeerEnvelope,
} from "../shared/peer-envelope.ts";
import {
  SyncFeedConsumer,
  SyncFeedProtocolError,
  type SyncFeedConsumerOptions,
  type SyncFeedEntry,
  type SyncFeedTransport,
} from "../shared/sync/index.ts";
import type { PeerApplyEffects, PeerOutboxRow, Store } from "../store.ts";

export interface PeerWatchObserver {
  entry(entry: SyncFeedEntry<PeerEnvelope>): void | Promise<void>;
  heartbeat?(): void;
}

export interface PeerPushResponse {
  status: number;
  body: unknown;
}

export interface PeerSyncEffectCallbacks {
  drainTask?(taskId: string): void;
  outboxChanged?(entryId: string): void;
  handedOff?(entryId: string): void;
  businessStateChanged?(entryId: string): void;
}

interface OwnerSubscription {
  active: boolean;
  dirty: boolean;
  pumping: boolean;
  after: number;
  host: string;
  observer: PeerWatchObserver;
}

export class PeerSyncOwner {
  private readonly store: Store;
  private readonly effects: PeerSyncEffectCallbacks;
  private readonly subscriptions = new Set<OwnerSubscription>();

  constructor(store: Store, effects: PeerSyncEffectCallbacks = {}) {
    this.store = store;
    this.effects = effects;
  }

  read(
    host: string,
    after: number,
    limit = 100,
  ): SyncFeedEntry<PeerEnvelope>[] {
    const boundedLimit = Math.max(1, Math.min(100, limit));
    return this.store
      .listPeerOutbox("parent", host, after, boundedLimit)
      .map(peerFeedEntry);
  }

  watch(host: string, after: number, observer: PeerWatchObserver): () => void {
    const subscription: OwnerSubscription = {
      active: true,
      dirty: true,
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
    const row = this.store.getPeerOutbox(entryId);
    if (row?.remote_role !== "parent") return;
    for (const subscription of this.subscriptions) {
      if (subscription.host === row.remote_host) {
        subscription.dirty = true;
        void this.pump(subscription);
      }
    }
  }

  heartbeat(): void {
    for (const subscription of this.subscriptions) {
      subscription.observer.heartbeat?.();
    }
  }

  push(host: string, raw: unknown): PeerPushResponse {
    let envelope: PeerEnvelope;
    try {
      envelope = parsePeerEnvelope(raw);
    } catch (error) {
      return protocolResponse(error);
    }
    try {
      const result = this.store.applyPeerPushOperation({
        remoteRole: "parent",
        remoteHost: host,
        envelope,
      });
      if (!result.replayed) {
        executePeerEffects(this.store, result.effects, this.effects);
        for (const entryId of result.effects.outboxEntryIds) {
          this.publish(entryId);
        }
      }
      return { status: result.status, body: result.body };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "peer_inbound_op_conflict"
      ) {
        return {
          status: HTTP_STATUS.CONFLICT,
          body: { error: "peer_op_conflict" },
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
        subscription.dirty = false;
        const frames = this.read(subscription.host, subscription.after);
        if (frames.length === 0) {
          if (this.isDirty(subscription)) continue;
          return;
        }
        for (const frame of frames) {
          if (!this.isActive(subscription)) return;
          if (frame.pos <= subscription.after) continue;
          await subscription.observer.entry(frame);
          subscription.after = frame.pos;
        }
        if (!this.isActive(subscription)) return;
      }
    } finally {
      subscription.pumping = false;
      if (this.isActive(subscription) && this.isDirty(subscription)) {
        void this.pump(subscription);
      }
    }
  }

  private isActive(subscription: OwnerSubscription): boolean {
    return subscription.active;
  }

  private isDirty(subscription: OwnerSubscription): boolean {
    return subscription.dirty;
  }
}

export interface PeerSyncHubOptions {
  host: string;
  store: Store;
  transport: SyncFeedTransport<unknown>;
  retryDelay: SyncFeedConsumerOptions["retryDelay"];
  onFailure?: SyncFeedConsumerOptions["onFailure"];
  onProtocolError?: SyncFeedConsumerOptions["onProtocolError"];
  clock?: SyncFeedConsumerOptions["clock"];
  effects?: PeerSyncEffectCallbacks;
}

export class PeerSyncHubConsumer {
  private readonly options: PeerSyncHubOptions;
  private readonly consumer: SyncFeedConsumer<unknown>;

  constructor(options: PeerSyncHubOptions) {
    this.options = options;
    this.consumer = new SyncFeedConsumer({
      port: {
        applied: () => options.store.getPeerFeedApplied("child", options.host),
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
      const envelope = parsePeerEnvelope(entry.data);
      const result = this.options.store.applyPeerFeedOperation({
        remoteRole: "child",
        remoteHost: this.options.host,
        expectedApplied,
        nextApplied: entry.pos,
        envelope,
      });
      if (result.committed) {
        executePeerEffects(
          this.options.store,
          result.effects,
          this.options.effects,
        );
      }
      return result.committed;
    } catch (error) {
      if (error instanceof PeerProtocolError) {
        throw new SyncFeedProtocolError(error.message);
      }
      throw error;
    }
  }
}

function executePeerEffects(
  store: Store,
  effects: PeerApplyEffects,
  callbacks: PeerSyncEffectCallbacks | undefined,
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
  for (const entryId of effects.businessStateEntryIds) {
    callbacks?.businessStateChanged?.(entryId);
  }
}

function peerFeedEntry(row: PeerOutboxRow): SyncFeedEntry<PeerEnvelope> {
  return {
    pos: row.pos,
    prev: row.prev,
    data: parsePeerEnvelope({
      id: row.entry_id,
      category: row.category,
      data: JSON.parse(row.data_json) as unknown,
    }),
  };
}

function protocolResponse(error: unknown): PeerPushResponse {
  if (error instanceof PeerProtocolError) {
    return {
      status: HTTP_STATUS.BAD_REQUEST,
      body: { error: error.message },
    };
  }
  throw error;
}
