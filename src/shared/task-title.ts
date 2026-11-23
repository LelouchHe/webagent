export function validateTaskTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  const trimmed = title.trim();
  if (
    !trimmed ||
    trimmed.includes("/") ||
    trimmed === "." ||
    trimmed === ".."
  ) {
    return null;
  }
  return trimmed;
}
