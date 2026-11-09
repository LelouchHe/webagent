import { formatTaskReference } from "./shared/task-reference.ts";
import type { AgentEvent } from "./types.ts";

export type CollaborationRole = "source" | "target" | "supervisor";

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
  const title = collaborationTitle(input);
  return {
    title,
    body: input.body,
    data: {
      kind: "collaboration",
      messageId: input.messageId,
      sourceTaskId: input.sourceTaskId,
      sourceLabel: input.sourceLabel,
      targetTaskId: input.targetTaskId,
      targetLabel: input.targetLabel,
      role: input.role,
      title,
      body: input.body,
    },
  };
}

/** What one producer knows about a collaboration message, before projections. */
export interface CollaborationBroadcastRequest extends CollaborationLabels {
  messageId: string;
  sourceTaskId: string;
  targetTaskId: string;
  body: string;
}

export interface CollaborationBroadcastInput extends CollaborationBroadcastRequest {
  /** The task this projection renders into. */
  taskId: string;
  role: CollaborationRole;
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
    sourceTaskId: input.sourceTaskId,
    sourceLabel: input.sourceLabel,
    targetTaskId: input.targetTaskId,
    targetLabel: input.targetLabel,
    role: input.role,
    title: message.title,
    body: message.body,
  };
}
