import { formatTaskReference } from "./shared/task-reference.ts";
import { isoFromMillis } from "./shared/time.ts";
import type { CollaborationDeliveryStatus } from "./store.ts";
import type { AgentEvent } from "./types.ts";

export type CollaborationRole = "source" | "target";

/**
 * The visible title of a runtime item, keyed by the audit event type written
 * when the item is queued. The key is that event type so the row cannot
 * describe a different item than the one an operator can audit.
 */
export const RUNTIME_ITEM_TITLES = {
  handoff_reminder: "Task handoff required",
  task_outcome_notice: "Task handoff notice",
} as const;

export type RuntimeItemKind = keyof typeof RUNTIME_ITEM_TITLES;

/** The item kinds whose titles this module knows, for storage queries. */
export const RUNTIME_ITEM_KINDS: readonly RuntimeItemKind[] = Object.keys(
  RUNTIME_ITEM_TITLES,
) as RuntimeItemKind[];

/** Whether `value` names a runtime item whose title this module knows. */
export function isRuntimeItemKind(value: unknown): value is RuntimeItemKind {
  return typeof value === "string" && value in RUNTIME_ITEM_TITLES;
}

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
  /**
   * Which runtime item this is. Its presence is what makes the row a runtime
   * item: it selects the title, gives the row its own `kind`, and drops the
   * source handle, because nothing sent it.
   */
  runtimeItem?: RuntimeItemKind;
}

/**
 * The persisted payload of one projected row, and the live envelope's fields.
 * A `type` rather than an `interface` so it keeps the implicit index signature
 * `saveEvent` accepts as `Record<string, unknown>`.
 */
export type CollaborationSystemMessageData = {
  kind: string;
  messageId: string;
  /** Absent on a runtime item: nothing sent it, so there is no handle. */
  sourceTaskId?: string;
  sourceLabel?: string;
  targetTaskId: string;
  targetLabel: string;
  role: CollaborationRole;
  title: string;
  body: string;
};

/**
 * `kind` names the fact, so a runtime item names itself rather than
 * `collaboration`: its title carries no task reference, and a client that
 * dispatches on `kind` must not go looking for one.
 */
export function projectionKind(input: {
  runtimeItem?: RuntimeItemKind;
}): string {
  return input.runtimeItem ?? "collaboration";
}

/**
 * The single row shape for a collaboration projection. Every producer (the
 * Store's persisted copies, the agent tool, the user routes, runtime notices)
 * goes through it, so a title and the labels it was built from cannot drift.
 */

export function buildCollaborationSystemMessage(
  input: CollaborationSystemMessageInput,
): CollaborationSystemMessageData {
  // A runtime item has no source handle: nothing sent it, so a `sourceLabel`
  // here would describe an author that cannot be referenced or replied to.
  return {
    kind: projectionKind(input),
    messageId: input.messageId,
    ...(input.runtimeItem
      ? {}
      : { sourceTaskId: input.sourceTaskId, sourceLabel: input.sourceLabel }),
    targetTaskId: input.targetTaskId,
    targetLabel: input.targetLabel,
    role: input.role,
    title: input.runtimeItem
      ? RUNTIME_ITEM_TITLES[input.runtimeItem]
      : collaborationTitle(input),
    body: input.body,
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
  runtimeItem?: RuntimeItemKind;
  deliveryStatus?: CollaborationDeliveryStatus;
  deliveredAt?: string;
  deliveryFailureReason?: string;
}

export interface CollaborationDeliverySnapshot {
  status: CollaborationDeliveryStatus;
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
  input: CollaborationBroadcastRequest,
): Extract<AgentEvent, { type: "system_message" }> {
  // The envelope is the persisted payload plus what only a live client needs,
  // so which fields a runtime item drops is stated once, in the row builder.
  const envelope: Extract<AgentEvent, { type: "system_message" }> = {
    type: "system_message",
    taskId: input.taskId,
    ...buildCollaborationSystemMessage(input),
  };
  if (input.deliveryStatus !== undefined) {
    envelope.deliveryStatus = input.deliveryStatus;
  }
  if (input.deliveredAt !== undefined) {
    envelope.deliveredAt = input.deliveredAt;
  }
  if (input.deliveryFailureReason !== undefined) {
    envelope.deliveryFailureReason = input.deliveryFailureReason;
  }
  return envelope;
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
      data.deliveryStatus = delivery.status;
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
