import { mkdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Resolved absolute path to `<dataDir>/sessions/`. Pinned at server boot so
 * later `file://` URI construction and startsWith assertions all compare
 * against the same realpath (defends against macOS `/var → /private/var`
 * symlink + any future symlink swaps under `data_dir`).
 *
 * Throws if the directory cannot be created or resolved — fail fast at boot
 * rather than later when an attachment dispatch tries to use it.
 */
export function resolveSessionsAnchor(dataDir: string): string {
  const dir = join(dataDir, "sessions");
  mkdirSync(dir, { recursive: true });
  const real = realpathSync(dir);
  // Normalize trailing separator so `startsWith(anchor + sep)` is the
  // canonical "is path a strict descendant" check everywhere.
  return real.endsWith(sep) ? real.slice(0, -sep.length) : real;
}

/**
 * Returns true iff `realpath` is a strict descendant of
 * `<sessionsAnchor>/<sessionId>/attachments/`. Both args must already be
 * realpath-resolved (no `..`, no symlinks left).
 */
export function isInsideSessionAttachments(
  sessionsAnchor: string,
  sessionId: string,
  realpath: string,
): boolean {
  const expected = sessionsAnchor + sep + sessionId + sep + "attachments" + sep;
  return realpath.startsWith(expected);
}
