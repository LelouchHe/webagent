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

/**
 * Format tree path segments as the absolute `@`-prefixed path the input grammar
 * and the UI completion use. The caller decides which segments are root-relative
 * (see `Store.getTaskPath`); this only renders them, shell-quoting as needed so
 * the result can be pasted straight into the input.
 */
export function formatTaskPath(segments: string[]): string {
  return `@/${segments.map(quoteShellWord).join("/")}`;
}
