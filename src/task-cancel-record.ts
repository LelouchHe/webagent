import { formatFieldBlock } from "./shared/field-block.ts";
import { formatTaskReference } from "./shared/task-reference.ts";
import type { Store } from "./store.ts";
import type { AgentEvent } from "./types.ts";

export type TaskCancelNoticeEvent = Extract<
  AgentEvent,
  { type: "system_message" }
>;

export function recordTaskCancelEvent(input: {
  store: Store;
  broadcastTaskCancelNotice?: (event: TaskCancelNoticeEvent) => void;
  taskId: string;
  role: "source" | "target";
  sourceTaskId: string;
  sourceLabel: string;
  targetTaskId: string;
  targetLabel: string;
  reason: string;
  status: string;
}): void {
  const sourceRef = formatTaskReference(input.sourceLabel);
  const targetRef = formatTaskReference(input.targetLabel);
  const title =
    input.role === "source"
      ? `${sourceRef} cancelled ${targetRef}`
      : `Cancelled by ${sourceRef}`;
  const body = formatFieldBlock([
    { label: "reason", value: input.reason },
    { label: "status", value: input.status },
  ]);
  input.store.saveEvent(
    input.taskId,
    "system_message",
    {
      kind: "task_cancel",
      role: input.role,
      sourceTaskId: input.sourceTaskId,
      sourceLabel: input.sourceLabel,
      targetTaskId: input.targetTaskId,
      targetLabel: input.targetLabel,
      reason: input.reason,
      status: input.status,
      title,
      body,
    },
    { from_ref: "agent" },
  );
  input.broadcastTaskCancelNotice?.({
    type: "system_message",
    taskId: input.taskId,
    kind: "task_cancel",
    role: input.role,
    sourceTaskId: input.sourceTaskId,
    sourceLabel: input.sourceLabel,
    targetTaskId: input.targetTaskId,
    targetLabel: input.targetLabel,
    title,
    body,
  });
}
