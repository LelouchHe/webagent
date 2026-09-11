// Display helpers shared by the two task-create entry points, `+` and `/new`.
//
// Both menus preview a cwd value and must render it unambiguously, so the
// quoting and path-display rules live here rather than in either consumer
// (task-command.ts imports slash-commands.ts, so it cannot be the shared home).

import { state } from "./state.ts";
import { resolveViewPath } from "./file-browser.ts";

/**
 * Collapse the `.` segments and duplicate separators a relative cwd picks up
 * from the join, without canonicalizing symlinks: `/tmp/my dir` stays literal
 * while `./rel` stops leaking a `/./`.
 */
export function tidyResolvedPath(path: string): string {
  return path
    .replace(/\/\.\//g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/\.$/, "");
}

/**
 * Render one preview field so a value can never be misread as a different
 * (title, cwd) pair. A value without a quote character keeps the plain
 * single-quote form byte for byte; a value containing `'` or `"` switches to a
 * JSON string (double quotes with `\"`/`\\` escapes) so the delimiters stay
 * unambiguous. Titles and cwds share this rendering.
 */
export function previewValue(value: string): string {
  if (!/['"]/.test(value)) return `'${value}'`;
  return JSON.stringify(value);
}

/**
 * Display form of a cwd preview field. Resolved against the abbreviated cwd
 * base so it stays `~/…`-styled; never touches the filesystem.
 */
export function previewCwdDisplay(rawCwd: string): string {
  const base = state.taskCwd ?? "";
  const displayBase = state.taskCwdDisplay ?? base;
  if (rawCwd === "") return displayBase;
  try {
    return tidyResolvedPath(resolveViewPath(rawCwd, displayBase || null));
  } catch {
    return rawCwd;
  }
}
