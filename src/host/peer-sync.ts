import { z } from "zod";
import { HTTP_STATUS } from "../http-status.ts";
import {
  SyncFeedProtocolError,
  SyncFeedConsumer,
  type SyncFeedEntry,
  type SyncFeedTransport,
  type SyncFeedConsumerOptions,
} from "../shared/sync/index.ts";
import type { PeerOutboxRow, PeerRemoteRole, Store } from "../store.ts";

const envelopeSchema = z.object({
  id: z.uuid(),
  category: z.enum(["message", "report", "receipt"]),
  data: z.unknown(),
});

const messageSchema = z.object({
  sourceTaskId: z.string(),
  targetTaskId: z.string(),
  sourceLabel: z.string(),
  body: z.string(),
});

const receiptSchema = z.object({
  originalEntryId: z.uuid(),
  status: z.enum(["delivered", "failed"]),
  failureReason: z.string().optional(),
});

type PeerEnvelope = z.infer<typeof envelopeSchema>;

export interface PeerWatchObserver {
  entry(entry: SyncFeedEntry): void | Promise<void>;
  heartbeat?(): void;
}

export interface PeerPushResponse {
  status: number;
  body: unknown;
}

export class PeerSyncOwner {
  private readonly store: Store;
  private readonly observers = new Set<{
    host: string;
    after: number;
    observer: PeerWatchObserver;
  }>();

  constructor(store: Store) {
    this.store = store;
  }

  read(host: string, after: number, limit = 100): SyncFeedEntry[] {
    const boundedLimit = Math.max(1, Math.min(100, limit));
    return this.store
      .listPeerOutbox("parent", host, after, boundedLimit)
      .map(peerFeedEntry);
  }

  watch(host: string, after: number, observer: PeerWatchObserver): () => void {
    const registration = { host, after, observer };
    this.observers.add(registration);
    void this.emitSnapshot(registration);
    return () => {
      this.observers.delete(registration);
    };
  }

  publish(entryId: string): void {
    const row = this.store.getPeerOutbox(entryId);
    if (row?.remote_role !== "parent") return;
    const frame = peerFeedEntry(row);
    for (const observer of this.observers) {
      if (observer.host !== row.remote_host || frame.pos <= observer.after) {
        continue;
      }
      observer.after = frame.pos;
      void observer.observer.entry(frame);
    }
  }

  heartbeat(): void {
    for (const observer of this.observers) observer.observer.heartbeat?.();
  }

  push(host: string, raw: unknown): PeerPushResponse {
    const envelope = parseEnvelope(raw);
    try {
      const result = this.store.applyPeerInboundOperation({
        remoteRole: "parent",
        remoteHost: host,
        entryId: envelope.id,
        request: envelope,
        execute: () => {
          this.applyPush(host, envelope);
          return {
            status: HTTP_STATUS.ACCEPTED,
            body: { accepted: true },
          };
        },
      });
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
      if (error instanceof SyncFeedProtocolError) {
        return {
          status: HTTP_STATUS.BAD_REQUEST,
          body: { error: error.message },
        };
      }
      throw error;
    }
  }

  private async emitSnapshot(registration: {
    host: string;
    after: number;
    observer: PeerWatchObserver;
  }): Promise<void> {
    for (const frame of this.read(registration.host, registration.after)) {
      if (frame.pos <= registration.after) continue;
      registration.after = frame.pos;
      await registration.observer.entry(frame);
    }
  }

  private applyPush(host: string, envelope: PeerEnvelope): void {
    if (envelope.category === "receipt") {
      const receipt = parseReceipt(envelope.data);
      const applied = this.store.applyPeerReceipt({
        remoteRole: "parent",
        remoteHost: host,
        entryId: receipt.originalEntryId,
        status: receipt.status,
        failureReason: receipt.failureReason,
      });
      if (!applied.known) protocolError("unknown_peer_receipt");
      return;
    }
    if (envelope.category !== "message") {
      protocolError("unsupported_peer_push_category");
    }
    const message = parseMessage(envelope.data);
    const target = this.store.getTask(message.targetTaskId);
    if (!target) {
      enqueueFailureReceipt(this.store, "parent", host, envelope.id);
      return;
    }
    const relation = this.store.getExternalParentLink(message.targetTaskId);
    if (
      relation?.remote_host !== host ||
      relation.remote_task_id !== message.sourceTaskId
    ) {
      protocolError("peer_link_mismatch");
    }
    this.store.enqueueTargetCollaboration({
      id: envelope.id,
      deliveryId: envelope.id,
      sourceTaskId: message.sourceTaskId,
      targetTaskId: message.targetTaskId,
      body: message.body,
      sourceLabel: message.sourceLabel,
      inbound: {
        remoteRole: "parent",
        remoteHost: host,
        entryId: envelope.id,
      },
    });
  }
}

export interface PeerSyncHubOptions {
  host: string;
  store: Store;
  transport: SyncFeedTransport;
  retryDelay: SyncFeedConsumerOptions["retryDelay"];
  onFailure?: SyncFeedConsumerOptions["onFailure"];
  onProtocolError?: SyncFeedConsumerOptions["onProtocolError"];
  clock?: SyncFeedConsumerOptions["clock"];
}

export class PeerSyncHubConsumer {
  private readonly options: PeerSyncHubOptions;
  private readonly consumer: SyncFeedConsumer;

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

  private apply(entry: SyncFeedEntry, expectedApplied: number): boolean {
    const envelope = parseEnvelope(entry.data);
    return this.options.store.applyPeerFeedEntry({
      remoteRole: "child",
      remoteHost: this.options.host,
      expectedApplied,
      nextApplied: entry.pos,
      apply: () => {
        this.applyEnvelope(envelope);
      },
    });
  }

  private applyEnvelope(envelope: PeerEnvelope): void {
    if (envelope.category === "receipt") {
      const receipt = parseReceipt(envelope.data);
      const applied = this.options.store.applyPeerReceipt({
        remoteRole: "child",
        remoteHost: this.options.host,
        entryId: receipt.originalEntryId,
        status: receipt.status,
        failureReason: receipt.failureReason,
      });
      if (!applied.known) protocolError("unknown_peer_receipt");
      return;
    }
    const message = parseMessage(envelope.data);
    const target = this.options.store.getTask(message.targetTaskId);
    if (!target) {
      enqueueFailureReceipt(
        this.options.store,
        "child",
        this.options.host,
        envelope.id,
      );
      return;
    }
    const relation = this.options.store.getRemoteChild(
      this.options.host,
      message.sourceTaskId,
    );
    if (relation?.local_task_id !== message.targetTaskId) {
      protocolError("peer_link_mismatch");
    }
    this.options.store.enqueueTargetCollaboration({
      id: envelope.id,
      deliveryId: envelope.id,
      sourceTaskId: message.sourceTaskId,
      targetTaskId: message.targetTaskId,
      body: message.body,
      sourceLabel: message.sourceLabel,
      inbound: {
        remoteRole: "child",
        remoteHost: this.options.host,
        entryId: envelope.id,
      },
    });
  }
}

function peerFeedEntry(row: PeerOutboxRow): SyncFeedEntry {
  return {
    pos: row.pos,
    prev: row.prev,
    data: {
      id: row.entry_id,
      category: row.category,
      data: JSON.parse(row.data_json) as unknown,
    },
  };
}

function enqueueFailureReceipt(
  store: Store,
  remoteRole: PeerRemoteRole,
  host: string,
  entryId: string,
): void {
  store.enqueuePeerOutbox({
    remoteRole,
    remoteHost: host,
    category: "receipt",
    data: {
      originalEntryId: entryId,
      status: "failed",
      failureReason: "target_deleted",
    },
  });
}

function parseEnvelope(input: unknown): PeerEnvelope {
  const result = envelopeSchema.safeParse(input);
  if (!result.success) protocolError("invalid_peer_envelope");
  return result.data;
}

function parseMessage(input: unknown): z.infer<typeof messageSchema> {
  const result = messageSchema.safeParse(input);
  if (!result.success) protocolError("invalid_peer_message");
  return result.data;
}

function parseReceipt(input: unknown): z.infer<typeof receiptSchema> {
  const result = receiptSchema.safeParse(input);
  if (!result.success) protocolError("invalid_peer_receipt");
  return result.data;
}

function protocolError(message: string): never {
  throw new SyncFeedProtocolError(message);
}
