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
  private retryNotBefore = 0;
  private pendingHeadSkip = false;

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
      if (!this.pendingHeadSkip) {
        this.clearTimeoutTimer();
      } else {
        this.scheduleTimeout();
      }
      return;
    }
    if (!this.watchOnline) return;
    this.watchOnline = false;
    this.scheduleTimeout();
  }

  private warn(
    msg: string,
    error: unknown,
    extra: Record<string, unknown> = {},
  ): void {
    log.scope("hosts").warn(msg, {
      host: this.options.host,
      ...extra,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private clearTimeoutTimer(): void {
    if (this.timeoutTimer !== null) {
      this.timer.clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private armTimer(delay: number): void {
    this.clearTimeoutTimer();
    if (!this.started) return;
    this.timeoutTimer = this.timer.setTimeout(
      () => {
        this.timeoutTimer = null;
        this.onTimeout();
      },
      Math.max(0, delay),
    );
  }

  private armRetryFloor(): void {
    const now = this.epochClock.now();
    this.retryNotBefore = Math.max(
      this.retryNotBefore,
      now + TIMEOUT_RETRY_DELAY_MS,
    );
    this.armTimer(this.retryNotBefore - now);
  }

  private trySkipFailedHead(): boolean {
    try {
      const skippedPos = this.options.store.skipFailedOutboxMessagePrefix(
        "child",
        this.options.host,
      );
      this.pendingHeadSkip = false;
      if (skippedPos !== null) {
        this.outbox.handedOffPosition(skippedPos);
        this.outbox.wake();
      }
      return true;
    } catch (error) {
      this.pendingHeadSkip = true;
      this.warn("link failed head skip persistence failed", error);
      this.armRetryFloor();
      return false;
    }
  }

  private scheduleTimeout(): void {
    this.clearTimeoutTimer();
    if (!this.started) return;
    const now = this.epochClock.now();
    if (this.pendingHeadSkip) {
      this.armTimer(this.retryNotBefore - now);
      return;
    }
    if (this.watchOnline) return;
    let pending: ReturnType<Store["getPendingOutboxTimeoutState"]>;
    try {
      pending = this.options.store.getPendingOutboxTimeoutState(
        "child",
        this.options.host,
      );
    } catch (error) {
      this.warn("link handoff timeout schedule read failed", error);
      this.armRetryFloor();
      return;
    }
    if (!pending.hasPendingWork) {
      this.offlineSince = null;
      return;
    }
    this.offlineSince ??= now;
    if (!pending.earliest) return;
    const deadline =
      Math.max(pending.earliest.queued_at, this.offlineSince) +
      this.handoffTimeoutMs;
    this.armTimer(Math.max(deadline, this.retryNotBefore) - now);
  }

  private onTimeout(): void {
    if (!this.started) return;
    if (this.pendingHeadSkip) {
      if (this.trySkipFailedHead()) this.scheduleTimeout();
      return;
    }
    if (this.watchOnline || this.offlineSince === null) return;
    let pending: ReturnType<Store["getPendingOutboxTimeoutState"]>;
    try {
      pending = this.options.store.getPendingOutboxTimeoutState(
        "child",
        this.options.host,
      );
    } catch (error) {
      this.warn("link handoff timeout read failed", error);
      this.armRetryFloor();
      return;
    }
    if (!pending.earliest) {
      this.scheduleTimeout();
      return;
    }
    const now = this.epochClock.now();
    const deadline =
      Math.max(pending.earliest.queued_at, this.offlineSince) +
      this.handoffTimeoutMs;
    if (now < deadline) {
      this.scheduleTimeout();
      return;
    }
    let outcome: ReturnType<Store["failOutboxMessageOnTimeout"]>;
    try {
      outcome = this.options.store.failOutboxMessageOnTimeout(
        "child",
        this.options.host,
        pending.earliest.entry_id,
        now,
      );
    } catch (error) {
      this.warn("link handoff timeout persistence failed", error, {
        entryId: pending.earliest.entry_id,
      });
      this.armRetryFloor();
      return;
    }
    if (outcome.failed) {
      try {
        executeLinkEffects(
          this.options.store,
          outcome.effects,
          this.options.effects,
        );
      } catch (error) {
        this.warn("link handoff timeout post-commit publish failed", error, {
          entryId: pending.earliest.entry_id,
        });
      }
      if (!this.trySkipFailedHead()) {
        if (outcome.pos !== null) this.outbox.handedOffPosition(outcome.pos);
        return;
      }
    }
    this.scheduleTimeout();
  }

  private next() {
    if (this.pendingHeadSkip) return undefined;
    let row = this.options.store.getOutboxHeadWithStatus(
      "child",
      this.options.host,
    );
    if (!row) return undefined;
    if (row.category === "message" && row.delivery_status === "failed") {
      if (!this.trySkipFailedHead()) return undefined;
      row = this.options.store.getOutboxHeadWithStatus(
        "child",
        this.options.host,
      );
      if (!row) return undefined;
    }
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
    let pushed: number;
    try {
      pushed = this.options.store.getOutboxPushCursor(
        "child",
        this.options.host,
      );
    } catch (error) {
      this.warn("link push cursor read failed", error, { entryId: entry.id });
      return false;
    }
    if (pushed >= entry.position) return true;
    if (result.kind === "success") {
      if (result.status !== HTTP_STATUS.ACCEPTED) return false;
      try {
        this.options.store.advanceOutboxPushCursor(
          "child",
          this.options.host,
          entry.id,
        );
      } catch (error) {
        this.warn("link push cursor commit failed", error, {
          entryId: entry.id,
        });
        return false;
      }
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
    return this.commitRejectedHead(entry.id, reason);
  }

  private commitRejectedHead(entryId: string, reason: string): boolean {
    let effects: LinkApplyEffects;
    try {
      effects = this.options.store.rejectOutboxHead(
        "child",
        this.options.host,
        entryId,
        reason,
      );
    } catch (error) {
      this.warn("link push reject persistence failed", error, { entryId });
      return false;
    }
    try {
      executeLinkEffects(this.options.store, effects, this.options.effects);
    } catch (error) {
      this.warn("link push reject post-commit publish failed", error, {
        entryId,
      });
    }
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
