// File-browser path semantics shared by `/view` menu fetching and filtering.
//
// The backend accepts only absolute paths or `~` prefixes. The slash UI starts
// at the active task cwd and resolves relative input here before calling the
// API. The final path segment is a local filter; everything before it is the
// directory fetch key, so typing within one directory never causes extra I/O.

export interface BrowseTarget {
  directory: string;
  filter: string;
}

function normalizeDisplayInput(input: string): string {
  // The server emits portable `/` display paths on Windows, but accept native
  // forms typed by the user as well. On POSIX, backslashes remain legal name
  // characters unless the whole input unmistakably has Windows path syntax.
  if (/^(?:~\\|[A-Za-z]:[\\/]|\\\\)/.test(input)) {
    return input.replace(/\\/g, "/");
  }
  return input;
}

function isAbsoluteDisplayPath(input: string): boolean {
  return input.startsWith("/") || /^[A-Za-z]:\//.test(input);
}

function appendRelative(base: string, relative: string): string {
  const normalizedBase = normalizeDisplayInput(base);
  if (normalizedBase === "/") return `/${relative}`;
  return `${normalizedBase.replace(/\/+$/, "")}/${relative}`;
}

/**
 * Fold `.` and `..` the way a shell's `cd` folds them, for the display paths the
 * pickers work in. This is the client half of the server's stored-cwd rule
 * (`src/cwd-path.ts`): folding here means the entry the picker lists, the path
 * it checks, and the path the server stores all name one directory.
 *
 * A leading `~` segment is opaque. The result must not start with a `~/` that
 * was not there before, or the server would expand a directory named `~` into
 * HOME.
 */
/** The root of a display cwd: `~`, a UNC share, `/`, or a drive root. */
function displayCwdRoot(raw: string): string {
  if (raw === "~" || raw.startsWith("~/")) return "~";
  const unc = raw.match(/^\/\/[^/]+\/[^/]+/);
  if (unc !== null) return unc[0];
  if (raw.startsWith("/")) return "/";
  return /^[A-Za-z]:\//.test(raw) ? raw.slice(0, 3) : "";
}

/**
 * Fold `.` and `..` over `parts`. A `..` above the base is absorbed when the
 * base is a filesystem root, and kept when it is `~` (HOME has a parent the
 * browser cannot name) or a relative path.
 */
function foldCwdParts(parts: string[], absorbsDots: boolean): string[] {
  const kept: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part !== "..") {
      kept.push(part);
      continue;
    }
    if (kept.length > 0 && kept[kept.length - 1] !== "..") {
      kept.pop();
      continue;
    }
    if (!absorbsDots) kept.push("..");
  }
  return kept;
}

export function foldCwdPath(path: string): string {
  const raw = normalizeDisplayInput(path);
  if (raw === "") return raw;
  const root = displayCwdRoot(raw);
  // Only a filesystem root absorbs a `..`; `~` keeps it for the server.
  const kept = foldCwdParts(
    raw.slice(root.length).split("/"),
    root !== "" && root !== "~",
  );
  const body = kept.join("/");
  const folded =
    body === ""
      ? root || "."
      : root === "" || root.endsWith("/")
        ? root + body
        : `${root}/${body}`;
  if (root === "" && /^~$|^~\//.test(folded) && !/^~$|^~\//.test(raw)) {
    return `./${folded}`;
  }
  return folded;
}

/** Resolve one exact user path to the backend's absolute/~ path contract. */
export function resolveViewPath(query: string, taskCwd: string | null): string {
  const raw = normalizeDisplayInput(query.trim());
  if (raw === "") {
    if (!taskCwd) throw new Error("No active task cwd");
    return normalizeDisplayInput(taskCwd);
  }
  if (raw.startsWith("~") && raw !== "~" && !raw.startsWith("~/")) {
    throw new Error("Unsupported ~user expansion");
  }
  if (isAbsoluteDisplayPath(raw) || raw.startsWith("~")) return raw;
  if (!taskCwd) throw new Error("No active task cwd");
  return appendRelative(taskCwd, raw);
}

/**
 * Resolve the `/view` tail into the directory to list and the final segment to
 * filter locally. A trailing slash means the user has entered that directory.
 */
export function resolveBrowseTarget(
  query: string,
  taskCwd: string | null,
): BrowseTarget {
  const trimmed = query.trim();
  const path = resolveViewPath(trimmed, taskCwd);
  // A trailing slash means "entered this directory". It is read from the typed
  // text, because folding the directory removes the separator that carried it.
  if (
    trimmed === "" ||
    trimmed === "/" ||
    trimmed === "~" ||
    trimmed.endsWith("/")
  ) {
    return { directory: foldCwdPath(path), filter: "" };
  }
  // Split first: the final segment is the live filter, and a `.`/`..` there is
  // text the user is typing, not a directory to resolve. Only the directory
  // part is folded, so the listing shows what creating there would use.
  const slash = path.lastIndexOf("/");
  return {
    directory: foldCwdPath(slash === 0 ? "/" : path.slice(0, slash)),
    filter: path.slice(slash + 1),
  };
}

/** Final segment only, used by the existing local slash-menu filter. */
export function fileFilter(query: string): string {
  const raw = normalizeDisplayInput(query.trim());
  if (raw === "" || raw === "/" || raw === "~" || raw.endsWith("/")) {
    return "";
  }
  const slash = raw.lastIndexOf("/");
  return raw.slice(slash + 1).toLowerCase();
}

/**
 * A filter segment that starts with `.` addresses hidden entries: no visible
 * name begins with a dot, so a leading dot is the unambiguous way to ask for
 * them. This decides both the backend listing flag and the matching rule, and
 * it keeps dotfiles out of every other menu.
 */
export function wantsHidden(filter: string): boolean {
  return filter.trim().startsWith(".");
}

/** Join a canonical API directory path and one returned entry name. */
export function joinListedPath(directory: string, name: string): string {
  if (directory === "/") return `/${name}`;
  return `${directory.replace(/\/+$/, "")}/${name}`;
}
