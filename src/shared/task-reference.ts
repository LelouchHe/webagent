/** Quote one task/path word for the shell-style task command grammar. */
export function quoteShellWord(word: string): string {
  if (/[\s"'\\]/.test(word) || word === "") {
    return `"${word.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return word;
}

/** Format a task title as a stable, shell-parseable @ reference. */
export function formatTaskReference(title: string): string {
  return `@${quoteShellWord(title)}`;
}
