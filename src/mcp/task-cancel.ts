import type { Store } from "../store.ts";
import type { TaskCancelResult, TaskManager } from "../task-manager.ts";
import type { AgentEvent } from "../types.ts";
import { formatFieldBlock } from "../shared/field-block.ts";
import { formatTaskReference } from "../shared/task-reference.ts";

export type McpTaskCancelNotice = Extract<
  AgentEvent,
  { type: "system_message" }
>;

export function cancelMcpTask(
  tasks: TaskManager,
  targetTaskId: string,
  cancelTimeoutMs: number,
): Promise<TaskCancelResult> {
  const bridge = tasks.existingTaskExecution(targetTaskId)?.bridge ?? null;
  return tasks.cancelTaskExecution(targetTaskId, bridge, cancelTimeoutMs);
}

export interface McpTaskCancelFact {
  sourceTaskId: string;
  targetTaskId: string;
  sourceLabel: string;
  targetLabel: string;
  reason: string;
  status: TaskCancelResult["status"];
}

export function buildMcpTaskCancelFact(
  store: Store,
  input: {
    sourceTaskId: string;
    targetTaskId: string;
    reason: string;
    result: TaskCancelResult;
  },
): McpTaskCancelFact {
  const sourceTask = store.getTaskIncludingDeleted(input.sourceTaskId);
  const targetTask = store.getTaskIncludingDeleted(input.targetTaskId);
  return {
    sourceTaskId: input.sourceTaskId,
    targetTaskId: input.targetTaskId,
    sourceLabel: sourceTask?.title ?? input.sourceTaskId.slice(0, 8),
    targetLabel: targetTask?.title ?? input.targetTaskId.slice(0, 8),
    reason: input.reason,
    status: input.result.status,
  };
}

export function persistMcpTaskCancelAuditSide(
  store: Store,
  fact: McpTaskCancelFact,
  role: "source" | "target",
  broadcast?: (event: McpTaskCancelNotice) => void,
): void {
  const sourceRef = formatTaskReference(fact.sourceLabel);
  const targetRef = formatTaskReference(fact.targetLabel);
  const body = formatFieldBlock([
    { label: "reason", value: fact.reason },
    { label: "status", value: fact.status },
  ]);
  const taskId = role === "source" ? fact.sourceTaskId : fact.targetTaskId;
  const data = {
    kind: "task_cancel" as const,
    role,
    sourceTaskId: fact.sourceTaskId,
    sourceLabel: fact.sourceLabel,
    targetTaskId: fact.targetTaskId,
    targetLabel: fact.targetLabel,
    reason: fact.reason,
    status: fact.status,
    title:
      role === "source"
        ? `${sourceRef} cancelled ${targetRef}`
        : `Cancelled by ${sourceRef}`,
    body,
  };
  store.saveEvent(taskId, "system_message", data, { from_ref: "agent" });
  broadcast?.({
    type: "system_message",
    taskId,
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
