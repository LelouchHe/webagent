/**
 * Path resolution and directory listing helpers for the file viewer.
 *
 * Contract (confirmed design): the viewer accepts *absolute* paths or `~`
 * prefixes only — relative paths are rejected outright so there is no base
 * ambiguity to exploit. `~` expands to HOME, then `realpath` canonicalizes
 * symlinks and `..` segments once; every path on the system is legal by
 * design (single-owner personal tool), so there is deliberately no escape
 * rejection logic — the guards here are about not hanging on special files
 * and not reading unbounded data.
 */
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, basename } from "node:path";
import { MAX_LIST_ITEMS } from "./limits.ts";

/** HTTP status-backed error; routes map it to a JSON error response. */
export class FilePathError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Expand a user-supplied path string into an absolute path.
 * Accepts `/absolute/path` and `~/...` / `~`. Everything else (including
 * `~user` and bare relative paths) is rejected with 400.
 */
export function expandPath(raw: string, home: string = homedir()): string {
  if (raw.length === 0) throw new FilePathError(400, "Missing path");
  if (raw.includes("\0")) throw new FilePathError(400, "Invalid path");
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return join(home, raw.slice(2));
  if (raw.startsWith("~")) {
    throw new FilePathError(400, "Unsupported ~user expansion");
  }
  if (!isAbsolute(raw)) {
    throw new FilePathError(400, "Path must be absolute or start with ~");
  }
  return raw;
}

/** realpath canonicalization; missing paths map to 404. */
export async function canonicalize(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FilePathError(404, "Path does not exist");
    }
    throw err;
  }
}

export interface PathMeta {
  path: string;
  name: string;
  kind: "file" | "dir";
  size: number;
  mtime: number;
}

/** stat a canonical path; non-regular files (fifo/socket/device) → 400. */
export async function statMeta(path: string): Promise<PathMeta> {
  const s = await stat(path);
  let kind: "file" | "dir";
  if (s.isFile()) kind = "file";
  else if (s.isDirectory()) kind = "dir";
  else throw new FilePathError(400, "Not a regular file or directory");
  return {
    path,
    name: basename(path),
    kind,
    size: s.size,
    mtime: s.mtimeMs,
  };
}

export interface DirEntry {
  name: string;
  kind: "file" | "dir";
  size: number | null;
  mtime: number;
}

/**
 * List one directory: dotfiles excluded, entries sorted dirs-first then
 * lexicographically, capped at MAX_LIST_ITEMS with
 * a `truncated` flag. Entries that vanish mid-list are skipped.
 */
export async function listDirectory(
  target: string,
): Promise<{ entries: DirEntry[]; truncated: boolean }> {
  const names = await readdir(target);
  names.sort();
  const visible = names.filter((n) => !n.startsWith("."));
  const truncated = visible.length > MAX_LIST_ITEMS;
  const entries: DirEntry[] = [];
  for (const name of visible.slice(0, MAX_LIST_ITEMS)) {
    try {
      const s = await stat(join(target, name));
      // Only expose targets the viewer can actually open. Symlinks to
      // regular files/dirs pass because stat follows them; fifos, sockets,
      // and devices are omitted rather than mislabelled as files.
      if (!s.isDirectory() && !s.isFile()) continue;
      entries.push({
        name,
        kind: s.isDirectory() ? "dir" : "file",
        size: s.isFile() ? s.size : null,
        mtime: s.mtimeMs,
      });
    } catch {
      // Raced deletion — skip rather than fail the whole listing.
    }
  }
  entries.sort(compareEntries);
  return { entries, truncated };
}

function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Read up to `n` bytes from the head of a regular file (mime sniffing). */
export async function readHead(file: string, n = 4096): Promise<Buffer> {
  const h = await open(file, "r");
  try {
    const st = await h.stat();
    const len = Math.min(st.size, n);
    const buf = Buffer.alloc(len);
    if (len > 0) await h.read(buf, 0, len, 0);
    return buf;
  } finally {
    await h.close();
  }
}

/**
 * Read a file bounded by `cap` bytes. Files within the cap are read fully;
 * larger files yield only the first `cap` bytes with `truncated: true`
 * (used for text — never reads a multi-GB "text" file into memory whole).
 */
export async function readFileCapped(
  file: string,
  cap: number,
): Promise<{ data: Buffer; truncated: boolean }> {
  const h = await open(file, "r");
  try {
    const st = await h.stat();
    if (st.size <= cap) return { data: await h.readFile(), truncated: false };
    const data = Buffer.alloc(cap);
    const { bytesRead } = await h.read(data, 0, cap, 0);
    return { data: data.subarray(0, bytesRead), truncated: true };
  } finally {
    await h.close();
  }
}
