import { formatTaskReference } from "./shared/task-reference.ts";

export interface TaskCreatedMessageInput {
  /** The task that was created. */
  taskId: string;
  /** Its title, used for the human-readable reference in the row. */
  taskTitle: string;
  cwd: string;
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
  const body = [
    `Task ID: ${input.taskId}`,
    `cwd: ${input.cwd}`,
    input.model ? `model: ${input.model}` : "model: inherited",
    input.thinking ? `thinking: ${input.thinking}` : "thinking: inherited",
  ].join("\n");
  return {
    title,
    body,
    data: {
      kind: "task_created",
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      cwd: input.cwd,
      model: input.model ?? null,
      thinking: input.thinking ?? null,
      title,
      body,
    },
  };
}
