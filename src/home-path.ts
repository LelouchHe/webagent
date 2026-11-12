import { homedir } from "node:os";
import { isAbsolute, join, normalize, parse, relative, sep } from "node:path";

/** Structural subset shared by node:path and node:path.win32 in tests. */
export interface HomePathOps {
  isAbsolute(path: string): boolean;
  join(...paths: string[]): string;
  normalize(path: string): string;
  parse(path: string): { root: string };
  relative(from: string, to: string): string;
  sep: string;
}

const NATIVE_PATH: HomePathOps = {
  isAbsolute,
  join,
  normalize,
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
 * that need one spelling per directory use `canonicalDirectoryPath`, which
 * composes this with lexical canonicalization — resolution order matters for
 * paths that contain both a symlink and `..`, so it is never applied behind a
 * caller that means to resolve the path itself (`realpath` in the file API).
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
 * The one spelling of a directory: HOME expanded, normalized, and without a
 * trailing separator.
 *
 * Used wherever a cwd is stored or compared — task rows, the recent-path LRU,
 * the pickers' "this is the current directory" check — so `/x`, `/x/`, and
 * `/x/./` can never occupy two keys. `normalize` alone keeps a trailing
 * separator (`/x/./` → `/x/`), so it is stripped down to the path's own root.
 * Bounding the strip by that root is what keeps a filesystem root intact:
 * `C:\`, a UNC share root, and the device namespace's `\\.\C:\` are roots, not
 * directories with a separator to trim (`\\.\C:` is a volume device, a
 * different object). Relative input keeps its meaning and loses the same
 * redundant parts, so `src/` and `src` agree.
 */
export function canonicalDirectoryPath(
  input: string,
  home = homedir(),
  path: HomePathOps = NATIVE_PATH,
): string {
  const expanded = expandHomePath(input, home, path);
  if (expanded === "") return expanded;
  const normalized = path.normalize(expanded);
  const root = path.parse(normalized).root;
  let canonical = normalized;
  while (
    canonical.length > root.length &&
    (canonical.endsWith(path.sep) || canonical.endsWith("/"))
  ) {
    canonical = canonical.slice(0, -1);
  }
  return canonical;
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
