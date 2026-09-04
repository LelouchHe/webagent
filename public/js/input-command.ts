/** + and @ are task-command markers; detailed parsing stays in task-command.ts. */
export function isTaskCommand(text: string): boolean {
  const input = text.trim();
  return input.startsWith("+") || input.startsWith("@");
}

export function isLocalCommand(text: string): boolean {
  const input = text.trim();
  return (
    (!input.startsWith("//") && input.startsWith("/")) ||
    input === "?" ||
    input.startsWith("? ")
  );
}

export function canSubmitWhileBusy(text: string): boolean {
  const input = text.trim();
  return isLocalCommand(input) || input.startsWith("!") || isTaskCommand(input);
}
