import { HTTP_STATUS } from "../http-status.ts";
import { log } from "../log.ts";
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
          body: { error: "link_op_conflict", code: "link_op_conflict" },
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
  handoffTimeoutMs?: number;
  retryDelay: (attempt: number, result: SyncRequestResult<unknown>) => number;
  timer?: SyncTimer;
  epochClock?: { now(): number };
  effects?: LinkSyncEffectCallbacks;
}

const DEFAULT_HANDOFF_TIMEOUT_MS = 10 * 60_000;
const TIMEOUT_RETRY_DELAY_MS = 1_000;

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
  private readonly timer: SyncTimer;
  private readonly epochClock: { now(): number };
  private readonly handoffTimeoutMs: number;
  private started = false;
  private watchOnline = false;
  private offlineSince: number | null = null;
  private timeoutTimer: unknown = null;

  constructor(options: LinkSyncHubPusherOptions) {
    this.options = options;
    this.timer = options.timer ?? DEFAULT_SYNC_TIMER;
    this.epochClock = options.epochClock ?? { now: () => Date.now() };
    this.handoffTimeoutMs =
      options.handoffTimeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS;
    this.outbox = new SyncOutbox({
      port: {
        next: () => this.next(),
        finish: (entry, result) => this.finish(entry, result),
      },
      transport: options.transport,
      timer: this.timer,
      timeoutMs: options.timeoutMs ?? 8_000,
      retryDelay: options.retryDelay,
    });
  }

  start(): void {
    this.started = true;
    this.outbox.start();
    this.scheduleTimeout();
  }

  stop(): void {
    this.started = false;
    this.clearTimeoutTimer();
    this.outbox.stop();
  }

  wake(): void {
    this.outbox.wake();
    this.scheduleTimeout();
  }

  handedOffPosition(position: number): void {
    this.outbox.handedOffPosition(position);
    this.scheduleTimeout();
  }

  setWatchOnline(online: boolean): void {
    if (online) {
      if (this.watchOnline) return;
      this.watchOnline = true;
      this.offlineSince = null;
      this.clearTimeoutTimer();
      return;
    }
    if (!this.watchOnline) return;
    this.watchOnline = false;
    this.scheduleTimeout();
  }

  private clearTimeoutTimer(): void {
    if (this.timeoutTimer !== null) {
      this.timer.clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private scheduleTimeout(): void {
    this.clearTimeoutTimer();
    if (!this.started || this.watchOnline) return;
    const pushed = this.options.store.getOutboxPushCursor(
      "child",
      this.options.host,
    );
    const hasPendingWork =
      this.options.store.listOutbox("child", this.options.host, pushed, 1)
        .length > 0;
    if (!hasPendingWork) {
      this.offlineSince = null;
      return;
    }
    this.offlineSince ??= this.epochClock.now();
    const earliest = this.options.store.getEarliestPendingOutboxMessage(
      "child",
      this.options.host,
    );
    if (!earliest) return;
    const deadline =
      Math.max(earliest.queued_at, this.offlineSince) + this.handoffTimeoutMs;
    const delay = Math.max(0, deadline - this.epochClock.now());
    this.timeoutTimer = this.timer.setTimeout(() => {
      this.timeoutTimer = null;
      this.onTimeout();
    }, delay);
  }

  private onTimeout(): void {
    if (!this.started || this.watchOnline || this.offlineSince === null) return;
    const earliest = this.options.store.getEarliestPendingOutboxMessage(
      "child",
      this.options.host,
    );
    if (!earliest) {
      this.scheduleTimeout();
      return;
    }
    const now = this.epochClock.now();
    const deadline =
      Math.max(earliest.queued_at, this.offlineSince) + this.handoffTimeoutMs;
    if (now < deadline) {
      this.scheduleTimeout();
      return;
    }
    let outcome: ReturnType<Store["failOutboxMessageOnTimeout"]>;
    try {
      outcome = this.options.store.failOutboxMessageOnTimeout(
        "child",
        this.options.host,
        earliest.entry_id,
        now,
      );
    } catch (error) {
      log.scope("hosts").warn("link handoff timeout persistence failed", {
        host: this.options.host,
        entryId: earliest.entry_id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.timeoutTimer = this.timer.setTimeout(() => {
        this.timeoutTimer = null;
        this.onTimeout();
      }, TIMEOUT_RETRY_DELAY_MS);
      return;
    }
    if (outcome.failed) {
      executeLinkEffects(
        this.options.store,
        outcome.effects,
        this.options.effects,
      );
      const skippedPos = this.options.store.skipFailedOutboxMessagePrefix(
        "child",
        this.options.host,
      );
      if (skippedPos !== null) {
        this.outbox.handedOffPosition(skippedPos);
        this.outbox.wake();
      }
    }
    this.scheduleTimeout();
  }

  private next() {
    let pushed = this.options.store.getOutboxPushCursor(
      "child",
      this.options.host,
    );
    let rows = this.options.store.listOutbox(
      "child",
      this.options.host,
      pushed,
      1,
    );
    if (rows.length === 0) return undefined;
    if (
      rows[0].category === "message" &&
      rows[0].delivery_id !== null &&
      this.options.store.getCollaborationDelivery(rows[0].delivery_id)
        ?.status === "failed"
    ) {
      this.options.store.skipFailedOutboxMessagePrefix(
        "child",
        this.options.host,
      );
      pushed = this.options.store.getOutboxPushCursor(
        "child",
        this.options.host,
      );
      rows = this.options.store.listOutbox(
        "child",
        this.options.host,
        pushed,
        1,
      );
      if (rows.length === 0) return undefined;
    }
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
    if (result.kind === "unknown") return false;
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
      this.scheduleTimeout();
      return true;
    }
    if (
      result.status === HTTP_STATUS.UNAUTHORIZED ||
      result.status === HTTP_STATUS.FORBIDDEN
    ) {
      log.scope("hosts").warn("link push credential rejected", {
        host: this.options.host,
        status: result.status,
      });
      return false;
    }
    const code =
      result.body &&
      typeof result.body === "object" &&
      typeof (result.body as { code?: unknown }).code === "string"
        ? (result.body as { code: string }).code
        : null;
    const isProtocolRejection =
      code === "link_op_conflict" || code === "link_protocol_error";
    if (!isProtocolRejection || entry.request.category === "receipt") {
      log.scope("hosts").warn("link push fault", {
        host: this.options.host,
        status: result.status,
        category: entry.request.category,
        ...(code ? { code } : {}),
      });
      return false;
    }
    const reason =
      result.body &&
      typeof result.body === "object" &&
      typeof (result.body as { error?: unknown }).error === "string"
        ? (result.body as { error: string }).error
        : code;
    let effects: LinkApplyEffects;
    try {
      effects = this.options.store.rejectOutboxHead(
        "child",
        this.options.host,
        entry.id,
        reason,
      );
    } catch (error) {
      log.scope("hosts").warn("link push reject persistence failed", {
        host: this.options.host,
        entryId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    executeLinkEffects(this.options.store, effects, this.options.effects);
    this.scheduleTimeout();
    return true;
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
      body: { error: error.message, code: "link_protocol_error" },
    };
  }
  throw error;
}
