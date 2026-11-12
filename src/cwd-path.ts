/**
 * A stored cwd has no `.` and no `..`.
 *
 * The hard part is that `..` is not a string operation. `a/link/..` names the
 * *parent of what `link` points at*, so folding it lexically would move a task
 * to a different directory. This walk therefore folds a `..` only when the
 * component it would remove is a real directory as the filesystem reports it
 * (lstat on the accumulated path, which follows earlier components exactly as
 * the kernel would). A `..` that follows a symlink component is kept verbatim:
 * removing it would mean expanding the symlink, and the symlink spelling is
 * the caller's choice.
 *
 * Everything else is removed unconditionally because it cannot change meaning:
 * `.` names the current directory, repeated separators name one separator, and
 * a trailing separator names the same directory (except at a root, which is
 * preserved: `C:\`, a UNC share root, and the device namespace's `\\.\C:\` are
 * roots, not directories with a separator to trim — `\\.\C:` is a volume
 * device, a different object).
 */
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { parse, sep } from "node:path";
import { expandHomePath } from "./home-path.ts";

/** Whether `target` is a real directory this walk may fold a `..` across. */
export type DirectoryProbe = (target: string) => boolean;

/**
 * lstat, not stat: a symlink is deliberately not a foldable component, because
 * `link/..` is the target's parent while `link` alone is the target.
 */
export function isRealDirectory(target: string): boolean {
  try {
    return lstatSync(target).isDirectory();
  } catch {
    // Missing, unreadable, or racing removal: leave the segment as typed
    // rather than guess.
    return false;
  }
}

const SEPARATORS = sep === "\\" ? /[\\/]+/ : /\/+/;

/**
 * The stored form of `input`: HOME expanded, `.` and foldable `..` removed,
 * repeated separators collapsed, and no trailing separator.
 *
 * Idempotent, and never changes which directory the path names: every removal
 * is either unconditionally transparent (`.`, separators) or verified against
 * the filesystem before it is applied.
 */
export function canonicalCwd(
  input: string,
  opts: {
    home?: string;
    probe?: DirectoryProbe;
  } = {},
): string {
  const home = opts.home ?? homedir();
  const probe = opts.probe ?? isRealDirectory;
  const expanded = expandHomePath(input, home);
  if (expanded === "") return expanded;
  const expandedTilde = expanded !== input;

  const { root } = parse(expanded);
  const parts = expanded.slice(root.length).split(SEPARATORS);
  const kept: string[] = [];
  for (const part of parts) {
    if (part === "") continue;
    if (part === ".") continue;
    if (part === "..") {
      // Two `..` never collapse into one: each one resolves from wherever the
      // previous traversal actually landed, which may be inside a symlink.
      if (
        kept.length > 0 &&
        kept[kept.length - 1] !== ".." &&
        probe(root + kept.join(sep))
      ) {
        kept.pop();
        continue;
      }
      kept.push("..");
      continue;
    }
    kept.push(part);
  }
  const result = kept.length === 0 ? root : root + kept.join(sep);
  // Dropping a leading `.` must not turn a relative path into HOME shorthand:
  // `./~/repo` names a directory called `~`, and a later pass would expand that
  // first component. The `./` keeps the result a fixed point.
  if (
    !expandedTilde &&
    (result === "~" || result.startsWith(`~${sep}`) || result.startsWith("~/"))
  ) {
    return `.${sep}${result}`;
  }
  return result;
}
