import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

/** Structural subset shared by node:path and node:path.win32 in tests. */
export interface HomePathOps {
  isAbsolute(path: string): boolean;
  join(...paths: string[]): string;
  normalize(path: string): string;
  relative(from: string, to: string): string;
  sep: string;
}

const NATIVE_PATH: HomePathOps = {
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
};

function portableDisplayPath(input: string, path: HomePathOps): string {
  return path.sep === "\\" ? input.replace(/\\/g, "/") : input;
}

/**
 * The one spelling of a directory: normalized, without a trailing separator.
 *
 * `normalize` alone keeps a trailing separator (`/x/./` → `/x/`), so it is
 * stripped here; a strip that would turn a filesystem root into something
 * relative (`C:\` → `C:`) is refused. Callers that persist a cwd — task rows
 * and the recent-path LRU — and callers that compare one use this, so one
 * directory never occupies two keys.
 */
export function canonicalDirectoryPath(
  input: string,
  path: HomePathOps = NATIVE_PATH,
): string {
  const normalized = path.normalize(input);
  let canonical = normalized;
  while (
    canonical.length > 1 &&
    (canonical.endsWith(path.sep) || canonical.endsWith("/"))
  ) {
    canonical = canonical.slice(0, -1);
  }
  return path.isAbsolute(canonical) ? canonical : normalized;
}

/**
 * Expand the current user's HOME shorthand with one authoritative grammar, and
 * return exactly one spelling for one directory.
 *
 * Both `~/` and `~\` are accepted; named-user forms stay untouched. Every
 * other input keeps its own meaning (absolute stays absolute, relative stays
 * relative to the caller's cwd) but loses redundant separators, interior `.`
 * segments, and a trailing separator: `/x`, `/x/`, and `/x/./` name the same
 * directory, and storing them verbatim made a task's cwd — and the recent-path
 * LRU key derived from it — depend on how the user happened to type it.
 */
export function expandHomePath(
  input: string,
  home = homedir(),
  path: HomePathOps = NATIVE_PATH,
): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    const tail = input.slice(2).replace(/[\\/]/g, path.sep);
    return canonicalDirectoryPath(path.join(home, tail), path);
  }
  // Empty stays empty so callers keep their own "no cwd given" handling
  // (`normalize("")` would turn it into `.`).
  if (input === "" || input.startsWith("~")) return input;
  return canonicalDirectoryPath(input, path);
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
