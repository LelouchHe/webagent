import { randomUUID } from "node:crypto";
import { buildCollaborationSystemMessage } from "../collaboration-message.ts";
import type { CollaborationDeliveryStatus } from "../shared/delivery-status.ts";
import type { LinkEnvelope } from "../shared/link-envelope.ts";
import type {
  LinkRemoteRole,
  OutboxCategory,
  OutboxInput,
  OutboxRow,
} from "../store.ts";
import { stringifyLinkData, type StoreInternal } from "./internal.ts";

export class LinkOutboxStore {
  private readonly store: StoreInternal;

  constructor(store: StoreInternal) {
    this.store = store;
  }

  enqueueOutbox(
    input: OutboxInput & {
      id?: string;
      remoteRole: LinkRemoteRole;
      remoteHost: string;
      createdAt?: number;
    },
  ): OutboxRow {
    const withoutDelivery =
      input.category === "receipt" || input.category === "notice";
    if (withoutDelivery && "deliveryId" in input) {
      throw new Error(`link_${input.category}_has_delivery`);
    }
    const dataJson = stringifyLinkData(input.data);
    return this.store.writeOutbox(() =>
      this.enqueueOutboxInTransaction({
        entryId: input.id ?? randomUUID(),
        remoteRole: input.remoteRole,
        remoteHost: input.remoteHost,
        category: input.category,
        dataJson,
        deliveryId: withoutDelivery ? null : input.deliveryId,
        createdAt: input.createdAt ?? Date.now(),
      }),
    );
  }

  enqueueLinkMessage(input: {
    id?: string;
    deliveryId?: string;
    remoteRole: LinkRemoteRole;
    remoteHost: string;
    sourceTaskId: string;
    targetTaskId: string;
    sourceLabel: string;
    targetLabel: string;
    body: string;
    createdAt?: number;
  }): OutboxRow {
    const entryId = input.id ?? randomUUID();
    const deliveryId = input.deliveryId ?? randomUUID();
    const createdAt = input.createdAt ?? Date.now();
    return this.store.writeOutbox(() => {
      this.store.requireLiveTask(input.sourceTaskId);
      const envelope: LinkEnvelope = {
        id: entryId,
        category: "message",
        data: {
          sourceTaskId: input.sourceTaskId,
          targetTaskId: input.targetTaskId,
          sourceLabel: input.sourceLabel,
          body: input.body,
        },
      };
      this.store.insertDeliveryMessage({
        id: entryId,
        deliveryId,
        sourceTaskId: input.sourceTaskId,
        recipientTaskId: input.targetTaskId,
        sourceActor: "agent",
        body: input.body,
        idempotencyKey: `${entryId}:${input.targetTaskId}`,
        createdAt,
        status: "queued",
        projection: "source",
      });
      this.store.saveEvent(
        input.sourceTaskId,
        "system_message",
        {
          ...buildCollaborationSystemMessage({
            messageId: entryId,
            sourceTaskId: input.sourceTaskId,
            sourceLabel: input.sourceLabel,
            targetTaskId: input.targetTaskId,
            targetLabel: input.targetLabel,
            role: "source",
            body: input.body,
          }),
          deliveryStatus: "queued",
        },
        { from_ref: `msg:${entryId}` },
      );
      return this.enqueueOutboxInTransaction({
        entryId,
        remoteRole: input.remoteRole,
        remoteHost: input.remoteHost,
        category: "message",
        dataJson: stringifyLinkData(envelope.data),
        deliveryId,
        createdAt,
      });
    });
  }

  enqueueLinkReport(input: {
    id?: string;
    deliveryId?: string;
    remoteRole: LinkRemoteRole;
    remoteHost: string;
    sourceTaskId: string;
    targetTaskId: string;
    sourceLabel: string;
    body: string;
    createdAt?: number;
  }): OutboxRow {
    const entryId = input.id ?? randomUUID();
    const deliveryId = input.deliveryId ?? randomUUID();
    const createdAt = input.createdAt ?? Date.now();
    return this.store.writeOutbox(() => {
      this.store.requireLiveTask(input.sourceTaskId);
      const envelope: LinkEnvelope = {
        id: entryId,
        category: "report",
        data: {
          sourceTaskId: input.sourceTaskId,
          targetTaskId: input.targetTaskId,
          sourceLabel: input.sourceLabel,
          body: input.body,
        },
      };
      this.store.insertDeliveryMessage({
        id: entryId,
        deliveryId,
        sourceTaskId: input.sourceTaskId,
        recipientTaskId: input.targetTaskId,
        sourceActor: "agent",
        body: input.body,
        idempotencyKey: `${entryId}:${input.targetTaskId}`,
        createdAt,
        status: "queued",
        projection: "source",
      });
      return this.enqueueOutboxInTransaction({
        entryId,
        remoteRole: input.remoteRole,
        remoteHost: input.remoteHost,
        category: "report",
        dataJson: stringifyLinkData(envelope.data),
        deliveryId,
        createdAt,
      });
    });
  }

  getOutboxCursor(remoteRole: LinkRemoteRole, remoteHost: string): number {
    const row = this.store.db
      .prepare(
        `SELECT applied_pos FROM outbox_cursors
         WHERE remote_role = ? AND remote_host = ?`,
      )
      .get(remoteRole, remoteHost) as { applied_pos: number } | undefined;
    return row?.applied_pos ?? 0;
  }

  listOutbox(
    remoteRole: LinkRemoteRole,
    remoteHost: string,
    after = 0,
    limit = 100,
  ): OutboxRow[] {
    return this.store.db
      .prepare(
        `SELECT * FROM outbox
         WHERE remote_role = ? AND remote_host = ? AND pos > ?
         ORDER BY pos
         LIMIT ?`,
      )
      .all(remoteRole, remoteHost, after, limit) as OutboxRow[];
  }

  getOutbox(entryId: string): OutboxRow | undefined {
    return this.store.db
      .prepare("SELECT * FROM outbox WHERE entry_id = ?")
      .get(entryId) as OutboxRow | undefined;
  }

  getOutboxPushCursor(remoteRole: LinkRemoteRole, remoteHost: string): number {
    const row = this.store.db
      .prepare(
        `SELECT pushed_pos FROM outbox_cursors
         WHERE remote_role = ? AND remote_host = ?`,
      )
      .get(remoteRole, remoteHost) as { pushed_pos: number } | undefined;
    return row?.pushed_pos ?? 0;
  }

  advanceOutboxPushCursor(
    remoteRole: LinkRemoteRole,
    remoteHost: string,
    entryId: string,
  ): number | null {
    return this.store.db.transaction(() => {
      const row = this.store.db
        .prepare(
          `SELECT pos FROM outbox
           WHERE remote_role = ? AND remote_host = ? AND entry_id = ?`,
        )
        .get(remoteRole, remoteHost, entryId) as { pos: number } | undefined;
      if (!row) throw new Error("outbox_entry_not_found");
      return this.advanceOutboxPushCursorPosInTransaction(
        remoteRole,
        remoteHost,
        row.pos,
      );
    })();
  }

  advanceOutboxPushCursorPosInTransaction(
    remoteRole: LinkRemoteRole,
    remoteHost: string,
    targetPos: number,
  ): number | null {
    const previous =
      (
        this.store.db
          .prepare(
            `SELECT pushed_pos FROM outbox_cursors
             WHERE remote_role = ? AND remote_host = ?`,
          )
          .get(remoteRole, remoteHost) as { pushed_pos: number } | undefined
      )?.pushed_pos ?? 0;
    let finalPos = Math.max(previous, targetPos);
    const stmt = this.store.db.prepare(
      `SELECT o.pos, o.category, d.status AS delivery_status
       FROM outbox o
       LEFT JOIN deliveries d ON d.id = o.delivery_id
       WHERE o.remote_role = ? AND o.remote_host = ? AND o.pos > ?
       ORDER BY o.pos ASC`,
    );
    for (const row of stmt.iterate(
      remoteRole,
      remoteHost,
      finalPos,
    ) as Iterable<{
      pos: number;
      category: OutboxCategory;
      delivery_status: CollaborationDeliveryStatus | null;
    }>) {
      if (row.category === "message" && row.delivery_status === "failed") {
        finalPos = row.pos;
        continue;
      }
      break;
    }
    if (finalPos <= previous) return null;
    const result = this.store.db
      .prepare(
        `INSERT INTO outbox_cursors
           (remote_role, remote_host, applied_pos, pushed_pos)
         VALUES (?, ?, 0, ?)
         ON CONFLICT (remote_role, remote_host)
         DO UPDATE SET pushed_pos = MAX(pushed_pos, excluded.pushed_pos)
         RETURNING pushed_pos`,
      )
      .get(remoteRole, remoteHost, finalPos) as { pushed_pos: number };
    return previous < result.pushed_pos ? result.pushed_pos : null;
  }

  getPendingOutboxTimeoutState(
    remoteRole: LinkRemoteRole,
    remoteHost: string,
  ): {
    hasPendingWork: boolean;
    earliest:
      | {
          pos: number;
          entry_id: string;
          delivery_id: string;
          queued_at: number;
        }
      | undefined;
  } {
    const row = this.store.db
      .prepare(
        `SELECT
           EXISTS(
             SELECT 1 FROM outbox o
             WHERE o.remote_role = ? AND o.remote_host = ?
               AND o.pos > COALESCE(
                 (SELECT pushed_pos FROM outbox_cursors
                  WHERE remote_role = ? AND remote_host = ?),
                 0
               )
           ) AS has_pending,
           m.pos,
           m.entry_id,
           m.delivery_id,
           m.queued_at
         FROM (SELECT 1) _
         LEFT JOIN (
           SELECT o.pos, o.entry_id, o.delivery_id, d.queued_at
           FROM outbox o
           JOIN deliveries d ON d.id = o.delivery_id
           WHERE o.remote_role = ? AND o.remote_host = ?
             AND o.pos > COALESCE(
               (SELECT pushed_pos FROM outbox_cursors
                WHERE remote_role = ? AND remote_host = ?),
               0
             )
             AND o.category = 'message'
             AND d.status = 'queued'
           ORDER BY d.queued_at ASC, o.pos ASC
           LIMIT 1
         ) m ON 1 = 1`,
      )
      .get(
        remoteRole,
        remoteHost,
        remoteRole,
        remoteHost,
        remoteRole,
        remoteHost,
        remoteRole,
        remoteHost,
      ) as {
      has_pending: number;
      pos: number | null;
      entry_id: string | null;
      delivery_id: string | null;
      queued_at: number | null;
    };
    return {
      hasPendingWork: row.has_pending === 1,
      earliest:
        row.pos !== null &&
        row.entry_id !== null &&
        row.delivery_id !== null &&
        row.queued_at !== null
          ? {
              pos: row.pos,
              entry_id: row.entry_id,
              delivery_id: row.delivery_id,
              queued_at: row.queued_at,
            }
          : undefined,
    };
  }

  getOutboxHead(
    remoteRole: LinkRemoteRole,
    remoteHost: string,
  ): OutboxRow | undefined {
    return this.store.db
      .prepare(
        `SELECT * FROM outbox
         WHERE remote_role = ? AND remote_host = ?
           AND pos > COALESCE(
             (SELECT pushed_pos FROM outbox_cursors
              WHERE remote_role = ? AND remote_host = ?),
             0
           )
         ORDER BY pos ASC
         LIMIT 1`,
      )
      .get(remoteRole, remoteHost, remoteRole, remoteHost) as
      OutboxRow | undefined;
  }

  enqueueOutboxInTransaction(input: {
    entryId: string;
    remoteRole: LinkRemoteRole;
    remoteHost: string;
    category: OutboxCategory;
    dataJson: string;
    deliveryId: string | null;
    createdAt: number;
  }): OutboxRow {
    const withoutDelivery =
      input.category === "receipt" || input.category === "notice";
    if (withoutDelivery && input.deliveryId !== null) {
      throw new Error(`link_${input.category}_has_delivery`);
    }
    if (!withoutDelivery) {
      if (!input.deliveryId) throw new Error("link_entry_missing_delivery");
      const delivery = this.store.getCollaborationDelivery(input.deliveryId);
      if (!delivery) throw new Error("link_delivery_missing");
      if (delivery.source_entry_id !== null) {
        throw new Error("link_inbound_delivery_cannot_be_outbound");
      }
    }
    const previous = this.store.db
      .prepare(
        `SELECT COALESCE(MAX(pos), 0) AS pos FROM outbox
         WHERE remote_role = ? AND remote_host = ?`,
      )
      .get(input.remoteRole, input.remoteHost) as { pos: number };
    this.store.db
      .prepare(
        `INSERT INTO outbox
           (entry_id, remote_role, remote_host, prev, category, data_json,
            delivery_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.entryId,
        input.remoteRole,
        input.remoteHost,
        previous.pos,
        input.category,
        input.dataJson,
        input.deliveryId,
        input.createdAt,
      );
    const row = this.getOutbox(input.entryId)!;
    this.store.recordPendingOutboxEntry(row);
    return row;
  }
}
