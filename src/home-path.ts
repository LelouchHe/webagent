import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

/** Structural subset shared by node:path and node:path.win32 in tests. */
interface HomePathOps {
  isAbsolute(path: string): boolean;
  join(...paths: string[]): string;
  relative(from: string, to: string): string;
  sep: string;
}

const NATIVE_PATH: HomePathOps = { isAbsolute, join, relative, sep };

function portableDisplayPath(input: string, path: HomePathOps): string {
  return path.sep === "\\" ? input.replace(/\\/g, "/") : input;
}

/**
 * Expand the current user's HOME shorthand with one authoritative grammar.
 * Both `~/` and `~\` are accepted; named-user forms stay untouched.
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
