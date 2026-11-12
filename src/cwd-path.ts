/**
 * The stored form of a cwd: no `.`, no `..`, no redundant separators.
 *
 * Folding is *logical*, the way a shell resolves `cd` — not the way the kernel
 * resolves a raw string handed to `chdir`. `a/link/..` becomes `a`: the user
 * typed a path, not a symlink graph, and is unlikely to know that `link` is a
 * link, so "the directory before `..`" is what they meant. A logical `cd` puts
 * the process in exactly that directory, and so does the stored cwd.
 *
 * Logical resolution still checks its components, as `cd` does: a `..` must be
 * preceded by a path that exists, so a typo cannot silently land in the parent
 * (`missing/..` is reported, not folded).
 *
 * Two things are deliberately preserved:
 * - Symlink spellings. Nothing here expands a link, so a workspace addressed
 *   through one keeps its short name.
 * - A path that only resolves in kernel order, i.e. one whose component after a
 *   symlink exists only in the target (`a/link/../notes` where `notes` lives
 *   beside the target). The logical result does not exist there, so the
 *   physically resolved directory is stored instead of a path that fails.
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { parse, sep } from "node:path";
import { expandHomePath } from "./home-path.ts";

/** Filesystem access, injectable so the rules can be exercised without a disk. */
export interface CwdFs {
  /** Does this name an existing directory? Follows symlinks, like `cd`. */
  isDirectory: (target: string) => boolean;
  /** Physical resolution of a path that exists. */
  resolvePhysical: (target: string) => string;
}

const NATIVE_FS: CwdFs = {
  isDirectory: (target) => {
    try {
      return statSync(target).isDirectory();
    } catch {
      return false;
    }
  },
  // `.native` instead of the JS fallback: the JS implementation resolves a
  // missing intermediate component by folding it, which would turn an invalid
  // path into a real directory.
  resolvePhysical: (target) => realpathSync.native(target),
};

const SEPARATORS = sep === "\\" ? /[\\/]+/ : /\/+/;

/**
 * The logical form of `input`: HOME expanded, `.` and `..` folded the way a
 * shell folds the string, repeated separators collapsed, and no trailing
 * separator (a root — `/`, `C:\`, a UNC share, the device namespace's `\\.\C:\`
 * — is kept intact; `\\.\C:` is a volume device, a different object).
 *
 * Returns null when the string cannot be folded without inventing a directory:
 * a `..` whose preceding path does not exist. `resolveStoredCwd` then falls back
 * to the physical path, or reports the input.
 *
 * Idempotent: a relative path that would newly start with `~/` keeps a `./`, so
 * a second pass cannot read a directory literally named `~` as HOME.
 */
export function canonicalCwd(
  input: string,
  opts: { home?: string; fs?: Pick<CwdFs, "isDirectory"> } = {},
): string | null {
  const isDirectory = opts.fs?.isDirectory ?? NATIVE_FS.isDirectory;
  const expanded = expandHomePath(input, opts.home ?? homedir());
  if (expanded === "") return expanded;

  const { root } = parse(expanded);
  const parts = expanded.slice(root.length).split(SEPARATORS);
  const kept: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === ".." && kept.length > 0 && kept[kept.length - 1] !== "..") {
      // `cd` checks the component it is about to leave.
      if (!isDirectory(root + kept.join(sep))) return null;
      kept.pop();
      continue;
    }
    kept.push(part);
  }

  const result = kept.length === 0 ? root || "." : root + kept.join(sep);
  if (
    expanded === input &&
    !input.startsWith("~") &&
    (result === "~" || result.startsWith(`~${sep}`) || result.startsWith("~/"))
  ) {
    return `.${sep}${result}`;
  }
  return result;
}

/**
 * What to store for a cwd the caller asked for.
 *
 * The logical form wins whenever that directory exists, which is every case
 * that does not cross a symlink with `..`. Otherwise the physically resolved
 * path is stored, so a path that only works in kernel order still lands in the
 * directory it named. If the input has no verifiable form at all (a `..` after a
 * component that does not exist), it is returned unchanged for the caller's
 * existence check to reject; nothing is stored from there.
 */
export function resolveStoredCwd(
  input: string,
  opts: { home?: string; fs?: CwdFs } = {},
): string {
  const fs = opts.fs ?? NATIVE_FS;
  const home = opts.home ?? homedir();
  const logical = canonicalCwd(input, { home, fs });
  if (logical !== null && (logical === "" || fs.isDirectory(logical))) {
    return logical;
  }
  try {
    const physical = fs.resolvePhysical(expandHomePath(input, home));
    if (fs.isDirectory(physical)) {
      return canonicalCwd(physical, { home, fs }) ?? physical;
    }
  } catch {
    // Not resolvable physically; the logical form still describes what the
    // caller meant, so a removed directory keeps its canonical spelling.
  }
  return logical ?? input;
}
