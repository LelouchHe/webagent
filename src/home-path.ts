import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

export function expandHomePath(input: string, home = homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  if (process.platform === "win32" && input.startsWith("~\\")) {
    return join(home, input.slice(2));
  }
  return input;
}

export function abbreviateHomePath(input: string, home = homedir()): string {
  const relativePath = relative(home, input);
  if (relativePath === "") return "~";
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return input;
  }
  return `~${sep}${relativePath}`;
}
