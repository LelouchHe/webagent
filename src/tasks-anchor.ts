import { mkdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Resolved absolute path to `<dataDir>/sessions/` (legacy on-disk
 * directory; existing attachment realpaths reference it, so the directory
 * name stays `sessions` even though the code vocabulary is `task`).
 * Pinned at server boot so later `file://` URI construction and
 * startsWith assertions all compare
 * against the same realpath (defends against macOS `/var to /private/var`
 * symlink + any future symlink swaps under `data_dir`).
 *
 * Throws if the directory cannot be created or resolved — fail fast at boot
 * rather than later when an attachment dispatch tries to use it.
 */
export function resolveTasksAnchor(dataDir: string): string {
  const dir = join(dataDir, "sessions");
  mkdirSync(dir, { recursive: true });
  const real = realpathSync(dir);
  // Normalize trailing separator so `startsWith(anchor + sep)` is the
  // canonical "is path a strict descendant" check everywhere.
  return real.endsWith(sep) ? real.slice(0, -sep.length) : real;
}

/**
 * Returns true iff `realpath` is a strict descendant of
 * `<tasksAnchor>/<taskId>/attachments/` (on-disk directory is still
 * `sessions`). Both args must already be
 * realpath-resolved (no `..`, no symlinks left).
 */
export function isInsideTaskAttachments(
  tasksAnchor: string,
  taskId: string,
  realpath: string,
): boolean {
  const expected = tasksAnchor + sep + taskId + sep + "attachments" + sep;
  return realpath.startsWith(expected);
}
