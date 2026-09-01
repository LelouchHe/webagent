// File-browser path semantics shared by `/view` menu fetching and filtering.
//
// The backend accepts only absolute paths or `~` prefixes. The slash UI starts
// at the active session cwd and resolves relative input here before calling the
// API. The final path segment is a local filter; everything before it is the
// directory fetch key, so typing within one directory never causes extra I/O.

export interface BrowseTarget {
  directory: string;
  filter: string;
}

function appendRelative(base: string, relative: string): string {
  if (base === "/") return `/${relative}`;
  return `${base.replace(/\/+$/, "")}/${relative}`;
}

/** Resolve one exact user path to the backend's absolute/~ path contract. */
export function resolveViewPath(
  query: string,
  sessionCwd: string | null,
): string {
  const raw = query.trim();
  if (raw === "") {
    if (!sessionCwd) throw new Error("No active session cwd");
    return sessionCwd;
  }
  if (raw.startsWith("~") && raw !== "~" && !raw.startsWith("~/")) {
    throw new Error("Unsupported ~user expansion");
  }
  if (raw.startsWith("/") || raw.startsWith("~")) return raw;
  if (!sessionCwd) throw new Error("No active session cwd");
  return appendRelative(sessionCwd, raw);
}

/**
 * Resolve the `/view` tail into the directory to list and the final segment to
 * filter locally. A trailing slash means the user has entered that directory.
 */
export function resolveBrowseTarget(
  query: string,
  sessionCwd: string | null,
): BrowseTarget {
  if (query.trim() === "") {
    return { directory: resolveViewPath("", sessionCwd), filter: "" };
  }
  const path = resolveViewPath(query, sessionCwd);

  if (path === "/" || path === "~" || path.endsWith("/")) {
    return { directory: path, filter: "" };
  }
  const slash = path.lastIndexOf("/");
  return {
    directory: slash === 0 ? "/" : path.slice(0, slash),
    filter: path.slice(slash + 1),
  };
}

/** Final segment only, used by the existing local slash-menu filter. */
export function fileFilter(query: string): string {
  const raw = query.trim();
  if (raw === "" || raw === "/" || raw === "~" || raw.endsWith("/")) {
    return "";
  }
  const slash = raw.lastIndexOf("/");
  return raw.slice(slash + 1).toLowerCase();
}

/** Join a canonical API directory path and one returned entry name. */
export function joinListedPath(directory: string, name: string): string {
  if (directory === "/") return `/${name}`;
  return `${directory.replace(/\/+$/, "")}/${name}`;
}
