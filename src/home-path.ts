import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, sep } from "node:path";

/** Structural subset shared by node:path and node:path.win32 in tests. */
export interface HomePathOps {
  isAbsolute(path: string): boolean;
  join(...paths: string[]): string;
  parse(path: string): { root: string };
  relative(from: string, to: string): string;
  sep: string;
}

const NATIVE_PATH: HomePathOps = {
  isAbsolute,
  join,
  parse,
  relative,
  sep,
};

function portableDisplayPath(input: string, path: HomePathOps): string {
  return path.sep === "\\" ? input.replace(/\\/g, "/") : input;
}

/**
 * Expand the current user's HOME shorthand with one authoritative grammar.
 * Both `~/` and `~\` are accepted; named-user forms stay untouched.
 *
 * Expansion only: the result is passed to the filesystem as typed. Callers
 * that store or compare a cwd use `canonicalDirectoryPath`, which composes this
 * with a trailing-end collapse; neither step rewrites interior segments, so
 * resolution order still belongs to whoever resolves the path (`realpath` in
 * the file API).
 */
export function expandHomePath(
  input: string,
  home = homedir(),
  path: HomePathOps = NATIVE_PATH,
): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    const tail = input.slice(2).replace(/[\\/]/g, path.sep);
    return path.join(home, tail);
  }
  return input;
}

/**
 * A cwd's canonical spelling: HOME expanded, with trailing separators and
 * trailing `.` segments removed. It collapses the trailing end only — it is
 * deliberately not a claim that every spelling of one directory agrees.
 *
 * Used wherever a cwd is stored or compared — task rows, the recent-path LRU,
 * the pickers' "this is the current directory" check — so `/x`, `/x/`, and
 * `/x/./` cannot occupy two keys.
 *
 * Only semantically transparent parts are dropped, because this string is a
 * directory a process will actually run in:
 * - A trailing separator names the same directory (`/x/` is `/x`).
 * - A trailing `.` segment names the same directory and passes through no
 *   symlink, so `/x/.` is `/x`.
 * - An interior `.` or `..` is left alone. Lexical folding is not equivalent:
 *   with `a/link -> b/nested`, `a/link/..` is `b`, not `a`, so rewriting it
 *   would move an existing or historical task to a different directory.
 * The strip is bounded by the path's own root, which keeps a filesystem root
 * intact: `C:\`, a UNC share root, and the device namespace's `\\.\C:\` are
 * roots, not directories with a separator to trim (`\\.\C:` is a volume
 * device, a different object). A trailing `.` under a root yields that root
 * (`/.` is `/`), never an empty string.
 *
 * Idempotent: the result never starts a new `~` expansion, so passing a stored
 * cwd through this twice (ingress, then the storage boundary) is a no-op.
 */
export function canonicalDirectoryPath(
  input: string,
  home = homedir(),
  path: HomePathOps = NATIVE_PATH,
): string {
  const expanded = expandHomePath(input, home, path);
  if (expanded === "") return expanded;
  const root = path.parse(expanded).root;
  let canonical = expanded;
  for (;;) {
    const before = canonical;
    while (
      canonical.length > root.length &&
      (canonical.endsWith(path.sep) || canonical.endsWith("/"))
    ) {
      canonical = canonical.slice(0, -1);
    }
    for (const dot of [`${path.sep}.`, "/."]) {
      if (!canonical.endsWith(dot)) continue;
      const trimmed = canonical.slice(0, -dot.length);
      // A `.` directly under a root names that root (`/.` is `/`,
      // `C:\.` is `C:\`); a result shorter than the root is not a path,
      // so the root itself is the answer rather than an empty string.
      canonical = trimmed.length < root.length ? root : trimmed;
      break;
    }
    if (canonical === before) return canonical;
  }
}

/**
 * Abbreviate HOME and normalize Windows display paths to portable `/`
 * separators. Canonical filesystem paths remain native and are stored/signed
 * separately; this function is exclusively for UI round-tripping.
 */
export function abbreviateHomePath(
  input: string,
  home = homedir(),
  path: HomePathOps = NATIVE_PATH,
): string {
  const relativePath = path.relative(home, input);
  if (relativePath === "") return "~";
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return portableDisplayPath(input, path);
  }
  return `~/${portableDisplayPath(relativePath, path)}`;
}
