import type { Store } from "../store.ts";
import type { TaskCancelResult, TaskManager } from "../task-manager.ts";
import type { AgentEvent } from "../types.ts";
import { formatFieldBlock } from "../shared/field-block.ts";
import { formatTaskReference } from "../shared/task-reference.ts";

export type McpTaskCancelNotice = Extract<
  AgentEvent,
  { type: "system_message" }
>;

export async function cancelMcpTask(
  tasks: TaskManager,
  targetTaskId: string,
  cancelTimeoutMs: number,
): Promise<TaskCancelResult> {
  const bridge = tasks.existingTaskExecution(targetTaskId)?.bridge ?? null;
  return tasks.cancelTaskExecution(targetTaskId, bridge, cancelTimeoutMs);
}

export function persistMcpTaskCancelAudit(
  store: Store,
  input: {
    sourceTaskId: string;
    targetTaskId: string;
    reason: string;
    result: TaskCancelResult;
    broadcast?: (event: McpTaskCancelNotice) => void;
  },
): void {
  const sourceTask = store.getTaskIncludingDeleted(input.sourceTaskId);
  const targetTask = store.getTaskIncludingDeleted(input.targetTaskId);
  const sourceLabel = sourceTask?.title ?? input.sourceTaskId.slice(0, 8);
  const targetLabel = targetTask?.title ?? input.targetTaskId.slice(0, 8);
  const sourceRef = formatTaskReference(sourceLabel);
  const targetRef = formatTaskReference(targetLabel);
  const body = formatFieldBlock([
    { label: "reason", value: input.reason },
    { label: "status", value: input.result.status },
  ]);
  const rows = [
    {
      taskId: input.sourceTaskId,
      role: "source" as const,
      title: `${sourceRef} cancelled ${targetRef}`,
    },
    {
      taskId: input.targetTaskId,
      role: "target" as const,
      title: `Cancelled by ${sourceRef}`,
    },
  ];
  for (const row of rows) {
    const data = {
      kind: "task_cancel" as const,
      role: row.role,
      sourceTaskId: input.sourceTaskId,
      sourceLabel,
      targetTaskId: input.targetTaskId,
      targetLabel,
      reason: input.reason,
      status: input.result.status,
      title: row.title,
      body,
    };
    store.saveEvent(row.taskId, "system_message", data, { from_ref: "agent" });
    input.broadcast?.({
      type: "system_message",
      taskId: row.taskId,
      kind: data.kind,
      role: data.role,
      sourceTaskId: data.sourceTaskId,
      sourceLabel: data.sourceLabel,
      targetTaskId: data.targetTaskId,
      targetLabel: data.targetLabel,
      title: data.title,
      body: data.body,
    });
  }
}
