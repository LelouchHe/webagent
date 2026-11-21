import { formatTaskReference } from "./shared/task-reference.ts";
import { isoFromMillis } from "./shared/time.ts";
import type { AgentEvent } from "./types.ts";

/**
 * The delivery mark a sender sees. `draining` is a storage-internal claim
 * between queued and delivered; outside the store it reads as `queued`.
 */
export type DeliveryMarkStatus = "queued" | "delivered" | "failed";

export function deliveryMarkStatus(
  status: "queued" | "draining" | "delivered" | "failed",
): DeliveryMarkStatus {
  return status === "draining" ? "queued" : status;
}

export type CollaborationRole = "source" | "target" | "supervisor";

/** The visible author label for a runtime-authored item. */
export const RUNTIME_AUTHOR_LABEL = "WebAgent runtime";

/**
 * The raw (unquoted) task titles a collaboration title is built from. They are
 * stored beside the rendered title because the title alone cannot be parsed
 * back into them: titles may contain quotes, spaces, and even the words that
 * separate the two halves.
 */
export interface CollaborationLabels {
  sourceLabel: string;
  targetLabel: string;
}

/** The one title shape for "a message crossed this edge". */
export function collaborationTitle(labels: CollaborationLabels): string {
  return `${formatTaskReference(labels.sourceLabel)} sent ${formatTaskReference(labels.targetLabel)}`;
}

export interface CollaborationSystemMessageInput extends CollaborationLabels {
  messageId: string;
  sourceTaskId: string;
  targetTaskId: string;
  role: CollaborationRole;
  body: string;
  /** Runtime-authored: show the runtime as author, not the named task. */
  systemAuthor?: boolean;
}

export interface CollaborationSystemMessage {
  title: string;
  body: string;
  /** Payload for the persisted `system_message` event. */
  data: Record<string, unknown>;
}

/**
 * The single row shape for a collaboration projection. Every producer (the
 * Store's persisted copies, the agent tool, the user routes, runtime notices)
 * goes through it, so a title and the labels it was built from cannot drift.
 */
export function buildCollaborationSystemMessage(
  input: CollaborationSystemMessageInput,
): CollaborationSystemMessage {
  const sourceLabel = input.systemAuthor
    ? RUNTIME_AUTHOR_LABEL
    : input.sourceLabel;
  const title = collaborationTitle({ ...input, sourceLabel });
  return {
    title,
    body: input.body,
    data: {
      kind: "collaboration",
      messageId: input.messageId,
      ...(input.systemAuthor ? {} : { sourceTaskId: input.sourceTaskId }),
      sourceLabel,
      targetTaskId: input.targetTaskId,
      targetLabel: input.targetLabel,
      role: input.role,
      title,
      body: input.body,
    },
  };
}

/**
 * What one producer knows about one projection of a collaboration message.
 * `taskId`/`role` name the projection; the delivery fields, when present, are
 * live-only hints for the sender's mark.
 */
export interface CollaborationBroadcastRequest extends CollaborationLabels {
  messageId: string;
  sourceTaskId: string;
  targetTaskId: string;
  body: string;
  taskId: string;
  role: CollaborationRole;
  systemAuthor?: boolean;
  deliveryStatus?: DeliveryMarkStatus;
  deliveredAt?: string;
  deliveryFailureReason?: string;
}

/** One projection of one collaboration message. */
export type CollaborationBroadcastInput = CollaborationBroadcastRequest;

export interface CollaborationDeliverySnapshot {
  status: "queued" | "draining" | "delivered" | "failed";
  deliveredAt: number | null;
  failureReason: string | null;
}

/**
 * The single wire envelope for one projection of the row above. It carries the
 * raw labels as well as the title, because a live client anchors a reference in
 * that title by task id and cannot recover the reference text from the title
 * alone. Omitting them here is a silent behavior loss (no live mark), so the
 * builder is the only place that may spell the envelope out.
 */
export function buildCollaborationBroadcast(
  input: CollaborationBroadcastInput,
): Extract<AgentEvent, { type: "system_message" }> {
  const message = buildCollaborationSystemMessage(input);
  return {
    type: "system_message",
    taskId: input.taskId,
    kind: "collaboration",
    messageId: input.messageId,
    ...(input.systemAuthor ? {} : { sourceTaskId: input.sourceTaskId }),
    sourceLabel: input.systemAuthor ? RUNTIME_AUTHOR_LABEL : input.sourceLabel,
    targetTaskId: input.targetTaskId,
    targetLabel: input.targetLabel,
    role: input.role,
    title: message.title,
    body: message.body,
    ...(input.deliveryStatus === undefined
      ? {}
      : { deliveryStatus: input.deliveryStatus }),
    ...(input.deliveredAt === undefined
      ? {}
      : { deliveredAt: input.deliveredAt }),
    ...(input.deliveryFailureReason === undefined
      ? {}
      : { deliveryFailureReason: input.deliveryFailureReason }),
  };
}

/**
 * Attach the sender-side delivery state to stored collaboration rows at egress.
 * The event itself never carries it: a refresh reads the deliveries table.
 */
export function attachCollaborationDeliveryStatus<
  T extends { type: string; data: string },
>(
  events: T[],
  lookup: (messageIds: string[]) => Map<string, CollaborationDeliverySnapshot>,
): T[] {
  const messageIds: string[] = [];
  for (const event of events) {
    if (event.type !== "system_message") continue;
    try {
      const data = JSON.parse(event.data) as {
        kind?: unknown;
        role?: unknown;
        messageId?: unknown;
      };
      if (
        data.kind === "collaboration" &&
        data.role === "source" &&
        typeof data.messageId === "string"
      ) {
        messageIds.push(data.messageId);
      }
    } catch {
      // A malformed stored row is left untouched; egress never repairs data.
    }
  }
  if (messageIds.length === 0) return events;
  const statuses = lookup(messageIds);
  if (statuses.size === 0) return events;
  for (const event of events) {
    if (event.type !== "system_message") continue;
    try {
      const data = JSON.parse(event.data) as Record<string, unknown>;
      if (
        data.kind !== "collaboration" ||
        data.role !== "source" ||
        typeof data.messageId !== "string"
      ) {
        continue;
      }
      const delivery = statuses.get(data.messageId);
      if (!delivery) continue;
      data.deliveryStatus = deliveryMarkStatus(delivery.status);
      if (delivery.deliveredAt !== null) {
        data.deliveredAt = isoFromMillis(delivery.deliveredAt);
      }
      if (delivery.failureReason !== null) {
        data.deliveryFailureReason = delivery.failureReason;
      }
      event.data = JSON.stringify(data);
    } catch {
      // Leave a malformed row as stored.
    }
  }
  return events;
}
