import type { TaskUpdateStatus } from "./shared/workflow-status.ts";

export function formatTaskReport(
  status: TaskUpdateStatus,
  body: string,
): string {
  return `Task status: ${status}\n${body}`;
}
