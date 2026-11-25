export const WORKFLOW_STATUSES = [
  "running",
  "idle",
  "waiting",
  "blocked",
  "done",
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const TASK_UPDATE_STATUSES = ["waiting", "blocked", "done"] as const;

export type TaskUpdateStatus = (typeof TASK_UPDATE_STATUSES)[number];

export function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return (
    typeof value === "string" &&
    (WORKFLOW_STATUSES as readonly string[]).includes(value)
  );
}
