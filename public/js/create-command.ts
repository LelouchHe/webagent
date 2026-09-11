// Shared preview and cwd-resolution helpers for the two task-create entry
// points, `+` and `/new`.
//
// Both menus preview a cwd value and must render it unambiguously, and both
// must send the same resolved path the preview describes, so these rules live
// here rather than in either consumer (task-command.ts imports
// slash-commands.ts, so it cannot be the shared home).

import { state } from "./state.ts";
import { resolveViewPath } from "./file-browser.ts";
import * as api from "./api.ts";

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

/**
 * Resolve a create cwd — the `+` cwd remainder or the `/new` argument — to the
 * path that must actually be sent. A relative path resolves against the current
 * Task cwd, `~` passes through for the server to expand, and the directory must
 * already exist. Shared so `+` and both `/new` entry points cannot diverge.
 */
export async function resolveCreateCwd(
  rawCwd: string,
): Promise<{ cwd: string } | { error: string }> {
  const base = state.taskCwd ?? "";
  let resolved: string;
  try {
    resolved = rawCwd === "" ? base : resolveViewPath(rawCwd, base || null);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (resolved === "") return { error: "No active task cwd" };
  resolved = tidyResolvedPath(resolved);
  try {
    const info = await api.getFileInfo(resolved);
    if (info.kind !== "dir") {
      return { error: `not a directory: '${rawCwd}'` };
    }
  } catch {
    return { error: `directory not found: '${rawCwd}'` };
  }
  return { cwd: resolved };
}
