/**
 * The stored form of a cwd: no `.`, no `..`, no redundant separators.
 *
 * Folding is *logical*, the way a shell resolves `cd` — not the way the kernel
 * resolves a raw string handed to `chdir`. `a/link/..` becomes `a`: the user
 * typed a path, not a symlink graph, and is unlikely to know that `link` is a
 * link, so "the directory before `..`" is what they meant. A logical `cd` puts
 * the process in that directory, and so does the stored cwd.
 *
 * Pure string work, so a stored value cannot depend on when it was written:
 * existence belongs to the caller that already checks the directory, and
 * symlinks are never expanded (a workspace keeps the spelling it was addressed
 * by). The same rule runs in the browser (`foldCwdPath` in
 * `public/js/file-browser.ts`), so the picker lists, checks, fills, and stores
 * one directory rather than two.
 */
import { homedir } from "node:os";
import { parse, sep } from "node:path";
import { expandHomePath } from "./home-path.ts";

const SEPARATORS = sep === "\\" ? /[\\/]+/ : /\/+/;

/**
 * HOME expanded, then folded. A root — `/`, `C:\`, a UNC share, the device
 * namespace's `\\.\C:\` — is kept intact: `\\.\C:` is a volume device, a
 * different object. A relative path that would newly start with `~/` keeps a
 * `./`, so a directory literally named `~` cannot be read as HOME by the next
 * pass; ingress and the storage boundary both call this, so it is idempotent.
 */
export function canonicalCwd(
  input: string,
  opts: { home?: string } = {},
): string {
  const expanded = expandHomePath(input, opts.home ?? homedir());
  if (expanded === "") return expanded;

  // The root keeps whatever separator the caller typed (`C:/a` parses to a
  // `C:/` root), so re-join it natively; otherwise one directory would keep two
  // keys on Windows.
  const root =
    sep === "\\"
      ? parse(expanded).root.replace(/\//g, sep)
      : parse(expanded).root;
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
