import { randomUUID } from "node:crypto";
import { formatFieldBlock } from "../shared/field-block.ts";
import type { CollaborationDeliveryStatus } from "../shared/delivery-status.ts";
import {
  isDeliveryLinkCategory,
  type LinkEnvelope,
  type LinkMessageData,
  type LinkNoticeData,
  type LinkReceiptData,
  type LinkRelationData,
  LinkProtocolError,
} from "../shared/link-envelope.ts";
import type {
  CollaborationDeliveryRow,
  LinkApplyEffects,
  LinkRemoteRole,
  OutboxCategory,
  OutboxRow,
} from "../store.ts";
import {
  emptyLinkApplyEffects,
  stringifyLinkData,
  type StoreInternal,
} from "./internal.ts";
import type { LinkOutboxStore } from "./link-outbox.ts";
import type { RemoteRelationsStore } from "./remote-relations.ts";

export class LinkApplyStore {
  private readonly store: StoreInternal;
  private readonly outbox: LinkOutboxStore;
  private readonly remoteRelations: RemoteRelationsStore;

  constructor(
    store: StoreInternal,
    outbox: LinkOutboxStore,
    remoteRelations: RemoteRelationsStore,
  ) {
    this.store = store;
    this.outbox = outbox;
    this.remoteRelations = remoteRelations;
  }

  applyLinkPushOperation(input: {
    remoteRole: LinkRemoteRole;
    remoteHost: string;
    envelope: LinkEnvelope;
  }): LinkApplyEffects {
    return this.store.writeOutbox(() => {
      if (isDeliveryLinkCategory(input.envelope.category)) {
        const existing = this.getInboundLinkDelivery(
          input.remoteRole,
          input.remoteHost,
          input.envelope.id,
        );
        if (existing) {
          const replayed: LinkEnvelope = {
            id: existing.source_entry_id!,
            category: existing.source_category!,
            data: {
              sourceTaskId: existing.source_task_id,
              targetTaskId: existing.recipient_task_id,
              sourceLabel: existing.source_label ?? "",
              body: existing.body,
            },
          };
          if (
            stringifyLinkData(replayed) !== stringifyLinkData(input.envelope)
          ) {
            throw new Error("link_inbound_op_conflict");
          }
          return {
            ...emptyLinkApplyEffects(),
          };
        }
      }
      const effects = this.applyLinkEnvelopeInTransaction(
        input.remoteRole,
        input.remoteHost,
        input.envelope,
      );
      return effects;
    });
  }

  applyLinkFeedOperation(input: {
    remoteRole: LinkRemoteRole;
    remoteHost: string;
    expectedApplied: number;
    nextApplied: number;
    envelope: LinkEnvelope;
  }): { committed: boolean; effects: LinkApplyEffects } {
    return this.store.writeOutbox(() => {
      const applied = this.outbox.getOutboxCursor(
        input.remoteRole,
        input.remoteHost,
      );
      if (applied !== input.expectedApplied) {
        return { committed: false, effects: emptyLinkApplyEffects() };
      }
      if (input.nextApplied <= applied) {
        throw new Error("outbox_cursor_does_not_advance");
      }
      const effects = this.applyLinkEnvelopeInTransaction(
        input.remoteRole,
        input.remoteHost,
        input.envelope,
      );
      this.store.db
        .prepare(
          `INSERT INTO outbox_cursors (remote_role, remote_host, applied_pos, pushed_pos)
           VALUES (?, ?, ?, 0)
           ON CONFLICT (remote_role, remote_host)
           DO UPDATE SET applied_pos = excluded.applied_pos`,
        )
        .run(input.remoteRole, input.remoteHost, input.nextApplied);
      return { committed: true, effects };
    });
  }

  rejectOutboxHead(
    remoteRole: LinkRemoteRole,
    remoteHost: string,
    entryId: string,
    failureReason: string,
  ): LinkApplyEffects {
    return this.store.db.transaction(() => {
      const row = this.store.db
        .prepare(
          `SELECT entry_id, pos, category, delivery_id FROM outbox
           WHERE remote_role = ? AND remote_host = ? AND entry_id = ?`,
        )
        .get(remoteRole, remoteHost, entryId) as
        | {
            entry_id: string;
            pos: number;
            category: OutboxCategory;
            delivery_id: string | null;
          }
        | undefined;
      if (!row) throw new Error("outbox_entry_not_found");
      if (!isDeliveryLinkCategory(row.category)) {
        throw new Error(`${row.category}_rejected_link_fault`);
      }
      if (!row.delivery_id) throw new Error("link_entry_missing_delivery_id");
      const changed = this.store.transitionDeliveryStatusInTransaction(
        row.delivery_id,
        "queued",
        "failed",
        Date.now(),
        failureReason,
      );
      const drainTaskIds: string[] = [];
      if (changed) {
        const drainTaskId = this.writeOutboundFailureNoticeInTransaction(
          row.delivery_id,
          failureReason,
        );
        if (drainTaskId) drainTaskIds.push(drainTaskId);
      }
      const pushedPos = this.outbox.advanceOutboxPushCursor(
        remoteRole,
        remoteHost,
        entryId,
      );
      return {
        drainTaskIds,
        deliveryStatusIds: changed ? [row.delivery_id] : [],
        outboxEntryIds: [],
        pushCursorPos: pushedPos === null ? [] : [pushedPos],
      };
    })();
  }

  failOutboxMessageOnTimeout(
    remoteRole: LinkRemoteRole,
    remoteHost: string,
    entryId: string,
    now: number,
  ): { failed: boolean; pos: number | null; effects: LinkApplyEffects } {
    return this.store.db.transaction(() => {
      const pushed = this.outbox.getOutboxPushCursor(remoteRole, remoteHost);
      const row = this.store.db
        .prepare(
          `SELECT pos, delivery_id FROM outbox
           WHERE remote_role = ? AND remote_host = ? AND entry_id = ?
             AND category = 'message' AND pos > ?`,
        )
        .get(remoteRole, remoteHost, entryId, pushed) as
        { pos: number; delivery_id: string | null } | undefined;
      if (!row?.delivery_id) {
        return { failed: false, pos: null, effects: emptyLinkApplyEffects() };
      }
      const changed = this.store.transitionDeliveryStatusInTransaction(
        row.delivery_id,
        "queued",
        "failed",
        now,
        "remote_handoff_timeout",
      );
      if (!changed) {
        return {
          failed: false,
          pos: row.pos,
          effects: emptyLinkApplyEffects(),
        };
      }
      const effects = emptyLinkApplyEffects();
      effects.deliveryStatusIds.push(row.delivery_id);
      const drainTaskId = this.writeOutboundFailureNoticeInTransaction(
        row.delivery_id,
        "remote_handoff_timeout",
        "Handoff to the remote peer was not confirmed before the timeout.",
      );
      if (drainTaskId) effects.drainTaskIds.push(drainTaskId);
      const hasEarlierPending = this.store.db
        .prepare(
          `SELECT 1 FROM outbox
           WHERE remote_role = ? AND remote_host = ? AND pos > ? AND pos < ?
           LIMIT 1`,
        )
        .get(remoteRole, remoteHost, pushed, row.pos);
      if (!hasEarlierPending) {
        const committedPos =
          this.outbox.advanceOutboxPushCursorPosInTransaction(
            remoteRole,
            remoteHost,
            row.pos,
          );
        if (committedPos !== null) effects.pushCursorPos.push(committedPos);
      }
      return { failed: true, pos: row.pos, effects };
    })();
  }

  private getInboundLinkDelivery(
    remoteRole: LinkRemoteRole,
    remoteHost: string,
    entryId: string,
  ):
    | (CollaborationDeliveryRow & {
        body: string;
        source_task_id: string;
      })
    | undefined {
    return this.store.db
      .prepare(
        `SELECT d.*, m.source_task_id, m.body
         FROM deliveries d
         JOIN messages m ON m.id = d.message_id
         WHERE d.source_remote_role = ?
           AND d.source_remote_host = ?
           AND d.source_entry_id = ?`,
      )
      .get(remoteRole, remoteHost, entryId) as
      | (CollaborationDeliveryRow & {
          body: string;
          source_task_id: string;
        })
      | undefined;
  }

  private applyLinkEnvelopeInTransaction(
    remoteRole: LinkRemoteRole,
    remoteHost: string,
    envelope: LinkEnvelope,
  ): LinkApplyEffects {
    if (envelope.category === "receipt") {
      const receipt = this.applyLinkReceiptInTransaction({
        remoteRole,
        remoteHost,
        entryId: envelope.data.originalEntryId,
        status: envelope.data.status,
        failureReason:
          envelope.data.status === "failed"
            ? envelope.data.failureReason
            : null,
      });
      if (!receipt.known) throw new LinkProtocolError("unknown_link_receipt");
      return receipt.effects;
    }
    if (envelope.category === "notice") {
      if (remoteRole !== "child") {
        throw new LinkProtocolError("notice_not_allowed_on_push");
      }
      return this.applyLinkNoticeInTransaction(remoteHost, envelope.data);
    }
    if (envelope.category === "relation") {
      if (remoteRole !== "child") {
        throw new LinkProtocolError("relation_not_allowed_on_push");
      }
      return this.applyLinkRelationInTransaction(remoteHost, envelope.data);
    }
    return this.applyLinkDeliveryInTransaction(
      remoteRole,
      remoteHost,
      envelope.id,
      envelope.data,
      envelope.category,
    );
  }

  private applyLinkNoticeInTransaction(
    remoteHost: string,
    notice: LinkNoticeData,
  ): LinkApplyEffects {
    const effects = emptyLinkApplyEffects();
    const source = this.store.getTask(notice.sourceTaskId);
    const relation = this.remoteRelations.getRemoteChild(
      remoteHost,
      notice.targetTaskId,
    );
    if (!source || relation?.local_task_id !== notice.sourceTaskId) {
      return effects;
    }
    const drainTaskId = this.writeOutcomeNoticeInTransaction({
      sourceTaskId: notice.sourceTaskId,
      targetTaskId: notice.targetTaskId,
      reason: notice.reason,
      message: notice.message,
      targetLabel: notice.targetLabel,
    });
    if (drainTaskId) effects.drainTaskIds.push(drainTaskId);
    return effects;
  }

  private applyLinkRelationInTransaction(
    remoteHost: string,
    relation: LinkRelationData,
  ): LinkApplyEffects {
    const effects = emptyLinkApplyEffects();
    const existing = this.remoteRelations.getRemoteChild(
      remoteHost,
      relation.childTaskId,
    );
    if (existing?.local_task_id !== relation.parentTaskId) {
      return effects;
    }
    const recordedTitle = this.remoteRelations.getRemoteChildTitle(
      relation.parentTaskId,
      relation.childTaskId,
    );
    this.remoteRelations.deleteRemoteChildInTransaction(
      remoteHost,
      relation.parentTaskId,
      relation.childTaskId,
    );
    if (relation.accountOpen && this.store.getTask(relation.parentTaskId)) {
      const targetLabel = recordedTitle ?? relation.childTaskId.slice(0, 8);
      const drainTaskId = this.writeOutcomeNoticeInTransaction({
        sourceTaskId: relation.parentTaskId,
        targetTaskId: relation.childTaskId,
        reason: "target_removed",
        message:
          "The target left this edge (deleted or archived); the account is gone.",
        targetLabel,
      });
      if (drainTaskId) effects.drainTaskIds.push(drainTaskId);
    }
    return effects;
  }

  private applyLinkDeliveryInTransaction(
    remoteRole: LinkRemoteRole,
    remoteHost: string,
    entryId: string,
    message: LinkMessageData,
    category: "message" | "report",
  ): LinkApplyEffects {
    const effects = emptyLinkApplyEffects();
    const target = this.store.getTask(message.targetTaskId);
    const relationMatches =
      target !== undefined &&
      (remoteRole === "parent"
        ? (() => {
            const relation = this.remoteRelations.getExternalParentLink(
              message.targetTaskId,
            );
            return (
              relation?.remote_host === remoteHost &&
              relation.remote_task_id === message.sourceTaskId
            );
          })()
        : this.remoteRelations.getRemoteChild(remoteHost, message.sourceTaskId)
            ?.local_task_id === message.targetTaskId);
    if (!target || !relationMatches) {
      const failureReason = !target ? "target_deleted" : "link_mismatch";
      const deliveryId = entryId;
      this.store.insertDeliveryMessage({
        id: entryId,
        deliveryId,
        sourceTaskId: message.sourceTaskId,
        recipientTaskId: message.targetTaskId,
        sourceActor: "agent",
        body: message.body,
        sourceLabel: message.sourceLabel,
        idempotencyKey: `${entryId}:${message.targetTaskId}`,
        createdAt: Date.now(),
        status: "failed",
        failureReason,
        inbound: { remoteRole, remoteHost, entryId, category },
        projection: null,
      });
      const receiptId = randomUUID();
      this.outbox.enqueueOutboxInTransaction({
        entryId: receiptId,
        remoteRole,
        remoteHost,
        category: "receipt",
        dataJson: stringifyLinkData({
          originalEntryId: entryId,
          status: "failed",
          failureReason,
        } satisfies LinkReceiptData),
        deliveryId: null,
        createdAt: Date.now(),
      });
      effects.outboxEntryIds.push(receiptId);
      return effects;
    }
    this.store.enqueueTargetCollaboration({
      id: entryId,
      deliveryId: entryId,
      sourceTaskId: message.sourceTaskId,
      targetTaskId: message.targetTaskId,
      body: message.body,
      sourceLabel: message.sourceLabel,
      inbound: { remoteRole, remoteHost, entryId, category },
    });
    effects.drainTaskIds.push(message.targetTaskId);
    return effects;
  }

  private applyLinkReceiptInTransaction(input: {
    remoteRole: LinkRemoteRole;
    remoteHost: string;
    entryId: string;
    status: Exclude<CollaborationDeliveryStatus, "queued">;
    failureReason?: string | null;
  }): { known: boolean; changed: boolean; effects: LinkApplyEffects } {
    const row = this.store.db
      .prepare(
        `SELECT * FROM outbox
         WHERE entry_id = ? AND remote_role = ? AND remote_host = ?
           AND category IN ('message', 'report')`,
      )
      .get(input.entryId, input.remoteRole, input.remoteHost) as
      OutboxRow | undefined;
    const effects = emptyLinkApplyEffects();
    if (!row) return { known: false, changed: false, effects };
    if (!row.delivery_id) {
      throw new Error("link_entry_missing_delivery_id");
    }
    const delivery = this.store.getCollaborationDelivery(row.delivery_id);
    if (!delivery) throw new Error("link_delivery_missing");
    const previous = delivery.status;
    const changed =
      previous === "queued" &&
      this.store.transitionDeliveryStatusInTransaction(
        row.delivery_id,
        "queued",
        input.status,
        Date.now(),
        input.failureReason,
      );
    const terminal =
      previous === "delivered" &&
      input.status === "failed" &&
      this.store.transitionDeliveryStatusInTransaction(
        row.delivery_id,
        "delivered",
        "failed",
        Date.now(),
        input.failureReason,
      );
    // Owner keeps writing pushed_pos symmetrically; harmless because only hub reads it.
    const pushedPos = this.outbox.advanceOutboxPushCursor(
      row.remote_role,
      row.remote_host,
      row.entry_id,
    );
    if (pushedPos !== null) effects.pushCursorPos.push(pushedPos);
    if (changed || terminal) {
      effects.deliveryStatusIds.push(row.delivery_id);
      if (input.status === "failed") {
        const drainTaskId = this.writeOutboundFailureNoticeInTransaction(
          row.delivery_id,
          input.failureReason,
        );
        if (drainTaskId) effects.drainTaskIds.push(drainTaskId);
      }
      return { known: true, changed: true, effects };
    }
    return { known: true, changed: false, effects };
  }

  private writeOutcomeNoticeInTransaction(input: {
    sourceTaskId: string;
    targetTaskId: string;
    reason: "no_update" | "no_activity" | "target_removed";
    message: string;
    targetLabel?: string | null;
  }): string | null {
    if (!this.store.getTask(input.sourceTaskId)) return null;
    const trimmedLabel = input.targetLabel?.trim();
    const explicitLabel =
      trimmedLabel && trimmedLabel.length > 0 ? trimmedLabel : null;
    const externalParent = this.remoteRelations.getExternalParentLink(
      input.sourceTaskId,
    );
    const targetLabel =
      explicitLabel ??
      this.store.getTaskIncludingDeleted(input.targetTaskId)?.title ??
      this.remoteRelations.getRemoteChildTitle(
        input.sourceTaskId,
        input.targetTaskId,
      ) ??
      (externalParent?.remote_task_id === input.targetTaskId
        ? this.remoteRelations.getLatestInboundSourceLabel(
            input.sourceTaskId,
            input.targetTaskId,
            "parent",
            externalParent.remote_host,
          )
        : null);
    const messageId = randomUUID();
    this.store.saveEvent(
      input.sourceTaskId,
      "task_outcome_notice",
      {
        messageId,
        reason: input.reason,
        sourceTaskId: input.sourceTaskId,
        targetTaskId: input.targetTaskId,
        message: input.message,
      },
      { from_ref: "system" },
    );
    const body = formatFieldBlock([
      {
        label: "target",
        value: targetLabel
          ? `${targetLabel} (${input.targetTaskId})`
          : input.targetTaskId,
      },
      { label: "message", value: input.message },
    ]);
    this.store.createSystemDelivery({
      messageId,
      deliveryId: randomUUID(),
      fromTaskId: input.targetTaskId,
      recipientTaskId: input.sourceTaskId,
      body,
    });
    return input.sourceTaskId;
  }

  private writeOutboundFailureNoticeInTransaction(
    deliveryId: string,
    failureReason: string | null | undefined,
    customMessage?: string,
  ): string | null {
    const delivery = this.store.getCollaborationDelivery(deliveryId);
    if (!delivery) return null;
    const message = this.store.getCollaborationMessage(delivery.message_id);
    if (message?.source_actor !== "agent") return null;
    const text =
      customMessage ??
      `A message to the target was not delivered (${failureReason ?? "unknown"}).`;
    return this.writeOutcomeNoticeInTransaction({
      sourceTaskId: message.source_task_id,
      targetTaskId: delivery.recipient_task_id,
      reason: "target_removed",
      message: text,
    });
  }
}
