import { formatTaskReference } from "./shared/task-reference.ts";
import { formatFieldBlock } from "./shared/field-block.ts";
import type { AgentEvent } from "./types.ts";

export interface TaskCreatedMessageInput {
  /** The task that was created. */
  taskId: string;
  /** Its title, used for the human-readable reference in the row. */
  taskTitle: string;
  /**
   * The agent the created task actually landed on. This is the only place a
   * caller can confirm where its request (`agent` / `cwd`, either of which may
   * have been omitted) ended up.
   */
  agentId: string;
  cwd: string;
  /**
   * The **effective** model / thinking value, not the request: an explicit
   * override, the value inherited from a same-agent source, or the target
   * session's own current value. Only a value that genuinely cannot be
   * determined is left null, and that is what renders as `inherited`.
   */
  model?: string | null;
  thinking?: string | null;
}

export interface TaskCreatedSystemMessage {
  title: string;
  body: string;
  /** Payload for the persisted `system_message` event. */
  data: Record<string, unknown>;
}

/**
 * The single row shape for "a task was created", used by every initiator —
 * the agent's `task_create` tool and the user's create routes. Callers persist
 * and broadcast it; only `from_ref` differs between them ("agent" / "user").
 */
export function buildTaskCreatedSystemMessage(
  input: TaskCreatedMessageInput,
): TaskCreatedSystemMessage {
  const title = `Created task ${formatTaskReference(input.taskTitle)}`;
  const body = formatFieldBlock([
    { label: "Task ID", value: input.taskId },
    { label: "agent", value: input.agentId },
    { label: "cwd", value: input.cwd },
    { label: "model", value: input.model ?? "", fallback: "inherited" },
    { label: "thinking", value: input.thinking ?? "", fallback: "inherited" },
  ]);
  return {
    title,
    body,
    data: {
      kind: "task_created",
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      agentId: input.agentId,
      cwd: input.cwd,
      model: input.model ?? null,
      thinking: input.thinking ?? null,
      title,
      body,
    },
  };
}

export interface TaskCreatedBroadcastInput {
  messageId: string;
  sourceTaskId: string;
  targetTaskId: string;
  /** Raw title of the created task, so a live client can rebuild its reference. */
  taskTitle: string;
  title: string;
  body: string;
}

/**
 * The single wire envelope for the row above. Every producer broadcasts this
 * shape, so a live row and its persisted twin cannot drift apart.
 */
export function buildTaskCreatedBroadcast(
  input: TaskCreatedBroadcastInput,
): Extract<AgentEvent, { type: "system_message" }> {
  return {
    type: "system_message",
    taskId: input.sourceTaskId,
    kind: "task_created",
    messageId: input.messageId,
    sourceTaskId: input.sourceTaskId,
    targetTaskId: input.targetTaskId,
    taskTitle: input.taskTitle,
    role: "source",
    title: input.title,
    body: input.body,
  };
}
