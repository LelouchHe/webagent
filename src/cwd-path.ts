/**
 * The stored form of a cwd: no `.`, no `..`, no redundant separators.
 *
 * Folding is *logical*, the way a shell resolves `cd` — not the way the kernel
 * resolves a raw string handed to `chdir`. `a/link/..` becomes `a`: the user
 * typed a path, not a symlink graph, and is unlikely to know that `link` is a
 * link, so "the directory before `..`" is what they meant. A logical `cd` puts
 * the process in that directory, and so does the stored cwd.
 *
 * Pure string work: no `stat`, no `realpath`, no I/O. Existence belongs to the
 * caller that already checks the directory (`createTask` stats it), and reading
 * the filesystem here would make a stored value depend on when it was written.
 * Symlinks are never expanded, so a workspace keeps the spelling it was
 * addressed by.
 *
 * The same rule runs in the browser (`public/js/file-browser.ts`), so the
 * picker lists, checks, fills, and stores one directory rather than two.
 */
import { homedir } from "node:os";
import { parse, sep } from "node:path";
import { expandHomePath } from "./home-path.ts";

const SEPARATORS = sep === "\\" ? /[\\/]+/ : /\/+/;

/**
 * HOME expanded, `.` and `..` folded, repeated and trailing separators removed.
 * A root — `/`, `C:\`, a UNC share, the device namespace's `\\.\C:\` — is kept
 * intact: `\\.\C:` is a volume device, a different object.
 *
 * A relative path that would newly start with `~/` keeps a `./`, so a directory
 * literally named `~` cannot be read as HOME by the next pass. That is what
 * makes the function idempotent, which matters because ingress and the storage
 * boundary both call it.
 */
export function canonicalCwd(
  input: string,
  opts: { home?: string } = {},
): string {
  const expanded = expandHomePath(input, opts.home ?? homedir());
  if (expanded === "") return expanded;

  const { root } = parse(expanded);
  const kept: string[] = [];
  for (const part of expanded.slice(root.length).split(SEPARATORS)) {
    if (part === "" || part === ".") continue;
    if (part === ".." && kept.length > 0 && kept[kept.length - 1] !== "..") {
      kept.pop();
      continue;
    }
    kept.push(part);
  }

  const folded = kept.length === 0 ? root || "." : root + kept.join(sep);
  if (
    expanded === input &&
    !input.startsWith("~") &&
    (folded === "~" || folded.startsWith(`~${sep}`) || folded.startsWith("~/"))
  ) {
    return `.${sep}${folded}`;
  }
  return folded;
}
