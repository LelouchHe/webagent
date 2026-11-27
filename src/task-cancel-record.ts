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
  role: "source" | "target";
  sourceTaskId: string;
  sourceLabel: string;
  targetTaskId: string;
  targetLabel: string;
  reason: string;
  status: string;
}): void {
  const taskId =
    input.role === "source" ? input.sourceTaskId : input.targetTaskId;
  const sourceRef = formatTaskReference(input.sourceLabel);
  const targetRef = formatTaskReference(input.targetLabel);
  const identity = {
    kind: "task_cancel" as const,
    role: input.role,
    sourceTaskId: input.sourceTaskId,
    sourceLabel: input.sourceLabel,
    targetTaskId: input.targetTaskId,
    targetLabel: input.targetLabel,
  };
  const title =
    input.role === "source"
      ? `${sourceRef} cancelled ${targetRef}`
      : `Cancelled by ${sourceRef}`;
  const body = formatFieldBlock([
    { label: "reason", value: input.reason },
    { label: "status", value: input.status },
  ]);
  input.store.saveEvent(
    taskId,
    "system_message",
    { ...identity, reason: input.reason, status: input.status, title, body },
    { from_ref: "agent" },
  );
  input.broadcastTaskCancelNotice?.({
    type: "system_message",
    taskId,
    ...identity,
    title,
    body,
  });
}
