/**
 * Shared display-path grammar for the frontend (+/@ menus, status bar, and
 * any consumer rendering server-egress display forms).
 *
 * Display forms are `~/`-abbreviated by the server at egress (`cwdDisplay`,
 * `pathDisplay`, …): this module only classifies, splits, joins, and selects
 * them — it never expands `~` itself. The backend stays authoritative for
 * `~` expansion (`+`/`@` targets in home-relative form pass through as
 * display-absolute paths and are expanded server-side), mirroring the
 * file-viewer input contract.
 *
 * Keep this module free of DOM imports so node:test can exercise it.
 */

export interface DisplayPathSource {
  cwd: string;
  /** Server-abbreviated display form (e.g. `~/x`); absent outside home. */
  cwdDisplay?: string;
}

/** `~/…`, bare `~`, and `/…` are display-absolute; `~user` is unsupported. */
export function isDisplayAbsolutePath(raw: string): boolean {
  return (
    raw === "~" || raw.startsWith("~/") || raw === "/" || raw.startsWith("/")
  );
}

function splitSegments(p: string): string[] {
  return p.split("/").filter((s) => s.length > 0);
}

/**
 * Split a display path at the last separator. `~` is itself a directory
 * form: its children join as `~/name`, so dirname(`~/a`) is `~`.
 */
export function displayDirname(p: string): string {
  if (p === "~" || p === "/") return p;
  if (p.startsWith("~")) {
    const tail = splitSegments(p.slice(1));
    tail.pop();
    return tail.length > 0 ? "~/" + tail.join("/") : "~";
  }
  const parts = splitSegments(p);
  parts.pop();
  return "/" + parts.join("/");
}

export function displayBasename(p: string): string {
  if (p === "~" || p === "/") return "";
  const parts = splitSegments(p);
  return parts.at(-1) ?? "";
}

export function joinDisplay(dir: string, name: string): string {
  if (name === "") return dir;
  if (dir === "~") return "~/" + name;
  return dir.endsWith("/") ? dir + name : dir + "/" + name;
}

/** Server display form when present; the native path otherwise. */
export function taskDisplayPath(node: DisplayPathSource): string {
  return node.cwdDisplay ?? node.cwd;
}

/**
 * Resolve one `+`/`@` target against the current task cwd. `~`-form targets
 * are display-absolute and pass through untouched (the backend expands
 * them); relative targets resolve against `base` with `..`/`.` segments.
 */
export function resolveDisplayTarget(base: string, target: string): string {
  if (isDisplayAbsolutePath(target)) return target;
  const absoluteBase = base.startsWith("/");
  const absolute = target.startsWith("/");
  const homeRelativeBase = base === "~" || base.startsWith("~/");
  const parts = [...(absolute ? [] : splitSegments(base))];
  for (const seg of splitSegments(target)) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  if (absolute) return "/" + parts.join("/");
  if (!absoluteBase && homeRelativeBase) return "~/" + parts.join("/");
  if (absoluteBase) return "/" + parts.join("/");
  return parts.join("/");
}
