import type Database from "better-sqlite3";
import type { ExecutionBinding } from "../execution-authority.ts";
import type { CollaborationDeliveryStatus } from "../shared/delivery-status.ts";
import type {
  CollaborationDeliveryRow,
  CollaborationMessageRow,
  EventRow,
  LinkApplyEffects,
  LinkInboundAssociation,
  OutboxRow,
  SystemDeliveryInput,
  TaskRow,
} from "../store.ts";

export interface InsertDeliveryMessageInput {
  id: string;
  deliveryId: string;
  sourceTaskId: string;
  recipientTaskId: string;
  sourceActor: "agent" | "system";
  body: string;
  sourceLabel?: string;
  idempotencyKey: string;
  createdAt: number;
  status: "queued" | "failed";
  failureReason?: string;
  inbound?: LinkInboundAssociation;
  projection: "source" | "target" | null;
}

export interface StoreInternal {
  readonly db: Database.Database;
  getRootTaskId(): string;
  isRootTaskId(taskId: string): boolean;
  writeBindings<T>(fn: () => T): T;
  writeOutbox<T>(fn: () => T): T;
  recordPendingOutboxEntry(row: OutboxRow): void;
  getTask(id: string): TaskRow | undefined;
  getTaskIncludingDeleted(id: string): TaskRow | undefined;
  requireLiveTask(taskId: string): TaskRow;
  insertRootRow(cwd: string): void;
  insertBindingRow(
    taskId: string,
    agentId: string,
    agentSessionId: string,
  ): void;
  collectBindingChange(taskId: string, before: ExecutionBinding | null): void;
  saveEvent(
    taskId: string,
    type: string,
    data?: Record<string, unknown>,
    opts?: { from_ref?: string },
  ): EventRow;
  createSystemDelivery(input: SystemDeliveryInput): {
    message: CollaborationMessageRow;
    delivery: CollaborationDeliveryRow;
  };
  insertDeliveryMessage(input: InsertDeliveryMessageInput): void;
  enqueueTargetCollaboration(
    input: {
      sourceTaskId: string;
      targetTaskId: string;
      body: string;
      id?: string;
      deliveryId?: string;
      sourceLabel?: string;
      inbound?: LinkInboundAssociation;
    },
    record?: (result: { messageId: string; deliveryId: string }) => void,
  ): { messageId: string; deliveryId: string };
  getCollaborationDelivery(id: string): CollaborationDeliveryRow | undefined;
  getCollaborationMessage(id: string): CollaborationMessageRow | undefined;
  transitionDeliveryStatusInTransaction(
    deliveryId: string,
    expected: "queued" | "delivered",
    next: Exclude<CollaborationDeliveryStatus, "queued">,
    changedAt: number,
    failureReason?: string | null,
  ): boolean;
}

export function stringifyLinkData(data: unknown): string {
  const encoded: unknown = JSON.stringify(data);
  if (typeof encoded !== "string") {
    throw new Error("link_outbox_data_not_serializable");
  }
  return encoded;
}

export function emptyLinkApplyEffects(): LinkApplyEffects {
  return {
    drainTaskIds: [],
    deliveryStatusIds: [],
    outboxEntryIds: [],
    pushCursorPos: [],
  };
}
