import { randomUUID } from "node:crypto";
import { buildCollaborationSystemMessage } from "../collaboration-message.ts";
import type {
  CollaborationDeliveryRow,
  CollaborationMessageInput,
  CollaborationMessageRow,
  TaskRow,
} from "../store.ts";
import type { StoreInternal } from "./internal.ts";

export interface IdempotentCollaborationMessageInput {
  /** Deterministic UUID from opIdentity when an op id was sent, or null for non-idempotent random creation. */
  deterministicMessageId: string | null;
  sourceTaskId: string;
  directTargetTaskId: string;
  sourceActor: "user";
  body: string;
}

export type IdempotentCollaborationMessageResult =
  | {
      kind: "created";
      message: CollaborationMessageRow;
      delivery: CollaborationDeliveryRow;
      sourceTask: TaskRow;
      targetTask: TaskRow;
    }
  | {
      kind: "replayed";
      message: CollaborationMessageRow;
      delivery: CollaborationDeliveryRow;
    }
  | { kind: "conflict" }
  | { kind: "source_not_found" }
  | { kind: "target_not_found" }
  | { kind: "same_task" };

export class CollaborationMessagesStore {
  private readonly store: StoreInternal;

  constructor(store: StoreInternal) {
    this.store = store;
  }

  createCollaborationMessage(input: CollaborationMessageInput): {
    message: CollaborationMessageRow;
    delivery: CollaborationDeliveryRow;
  } {
    return this.store.db.transaction(() => {
      if (input.sourceTaskId === input.directTargetTaskId) {
        throw new Error("Collaboration source and target must differ");
      }
      const sourceTask = this.store.requireLiveTask(input.sourceTaskId);
      const targetTask = this.store.requireLiveTask(input.directTargetTaskId);
      return this.insertInTransaction(input, sourceTask, targetTask);
    })();
  }

  /**
   * Single-transaction create-or-replay for REST collaboration messages.
   * Check order:
   *   1. Source task exists (live)
   *   2. Deterministic message-id replay lookup (before target checks)
   *   3. Target task exists (live) and differs from source
   *   4. Create message, projections, source event, and delivery
   */
  createOrReplay(
    input: IdempotentCollaborationMessageInput,
  ): IdempotentCollaborationMessageResult {
    return this.store.db.transaction(
      (): IdempotentCollaborationMessageResult => {
        const sourceTask = this.store.getTask(input.sourceTaskId);
        if (!sourceTask) return { kind: "source_not_found" };

        if (input.deterministicMessageId !== null) {
          const existing = this.store.getCollaborationMessage(
            input.deterministicMessageId,
          );
          if (existing) {
            if (
              existing.source_task_id !== input.sourceTaskId ||
              existing.direct_target_task_id !== input.directTargetTaskId ||
              existing.body !== input.body
            ) {
              return { kind: "conflict" };
            }
            const delivery = this.store.db
              .prepare("SELECT * FROM deliveries WHERE idempotency_key = ?")
              .get(`${existing.id}:${existing.direct_target_task_id}`) as
              CollaborationDeliveryRow | undefined;
            if (!delivery) {
              throw new Error(
                `Collaboration delivery missing for message ${existing.id}`,
              );
            }
            return { kind: "replayed", message: existing, delivery };
          }
        }

        const targetTask = this.store.getTask(input.directTargetTaskId);
        if (!targetTask) return { kind: "target_not_found" };
        if (targetTask.id === sourceTask.id) return { kind: "same_task" };

        const created = this.insertInTransaction(
          {
            id: input.deterministicMessageId ?? randomUUID(),
            deliveryId: randomUUID(),
            sourceTaskId: sourceTask.id,
            directTargetTaskId: targetTask.id,
            sourceActor: input.sourceActor,
            body: input.body,
          },
          sourceTask,
          targetTask,
        );
        return {
          kind: "created",
          message: created.message,
          delivery: created.delivery,
          sourceTask,
          targetTask,
        };
      },
    )();
  }

  private insertInTransaction(
    input: CollaborationMessageInput,
    sourceTask: TaskRow,
    targetTask: TaskRow,
  ): {
    message: CollaborationMessageRow;
    delivery: CollaborationDeliveryRow;
  } {
    const createdAt = input.createdAt ?? Date.now();
    this.store.db
      .prepare(
        `INSERT INTO messages
         (id, source_task_id, direct_target_task_id, source_actor, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sourceTaskId,
        input.directTargetTaskId,
        input.sourceActor,
        input.body,
        createdAt,
      );
    const insertProjection = this.store.db.prepare(
      `INSERT INTO message_projections (message_id, task_id, role, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    insertProjection.run(input.id, input.sourceTaskId, "source", createdAt);
    insertProjection.run(
      input.id,
      input.directTargetTaskId,
      "target",
      createdAt,
    );
    const sourceLabel = sourceTask.title ?? sourceTask.id.slice(0, 8);
    const targetLabel = targetTask.title ?? targetTask.id.slice(0, 8);
    this.store.saveEvent(
      input.sourceTaskId,
      "system_message",
      buildCollaborationSystemMessage({
        messageId: input.id,
        sourceTaskId: input.sourceTaskId,
        sourceLabel,
        targetTaskId: input.directTargetTaskId,
        targetLabel,
        role: "source",
        body: input.body,
      }),
      { from_ref: `msg:${input.id}` },
    );
    this.store.db
      .prepare(
        `INSERT INTO deliveries
         (id, message_id, recipient_task_id, idempotency_key, status, queued_at)
         VALUES (?, ?, ?, ?, 'queued', ?)`,
      )
      .run(
        input.deliveryId,
        input.id,
        input.directTargetTaskId,
        `${input.id}:${input.directTargetTaskId}`,
        createdAt,
      );
    return {
      message: this.store.getCollaborationMessage(input.id)!,
      delivery: this.store.getCollaborationDelivery(input.deliveryId)!,
    };
  }
}
