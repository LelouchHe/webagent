export function formatTaskReport(
  status: "waiting" | "blocked" | "done",
  body: string,
): string {
  return `Task status: ${status}\n${body}`;
}
