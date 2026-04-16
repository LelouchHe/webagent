// Display constants for the frontend UI.

// --- Tool call kind → display icon ---
export const TOOL_ICONS: Record<string, string> = {
  task_complete: "✔",
  read: "cat",
  edit: "edit",
  execute: "exec",
  search: "find",
  delete: "rm",
};
export const DEFAULT_TOOL_ICON = "run";

// --- Plan entry status → display symbol ---
export const PLAN_STATUS_ICONS: Record<string, string> = {
  pending: "○",
  in_progress: "◉",
  completed: "●",
};
