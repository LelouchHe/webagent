/**
 * File viewer HTTP routes — read-only access to arbitrary local files.
 *
 * URL space claimed: `/api/v1/files/{info,list,content}`.
 * Task-less by design (confirmed): the caller passes an absolute or
 * `~`-prefixed path; the server own `~` expansion + realpath canonicalization.
 * Relative paths are rejected. Bearer auth is enforced by the shared
 * `/api/**` gate in routes.ts — these paths are deliberately NOT in the
 * public whitelist, with one exception: `content` IS whitelisted so
 * `<img>` / `<a download>` can fetch without an Authorization header, and
 * it instead requires an HMAC sig+exp signed URL (issued by `info`),
 * mirroring the attachment scheme.
 *
 * Guards (see paths.ts + limits.ts): only regular files/dirs are served
 * (no fifos/sockets/devices), directory scans and inline previews are bounded,
 * downloads stream with backpressure, and responses carry nosniff + a
 * restrictive CSP. The viewer renders text/markdown/image only — nothing here
 * executes content.
 */
import { basename, dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { signAttachmentUrl, verifyAttachmentSig } from "../auth.ts";
import { buildContentDisposition, sniffMime } from "../attachments.ts";
import { HTTP_STATUS } from "../http-status.ts";
import { abbreviateHomePath } from "../home-path.ts";
import { log } from "../log.ts";
import { MAX_IMAGE_BYTES, MAX_TEXT_PREVIEW_BYTES } from "./limits.ts";
import {
  canonicalize,
  expandPath,
  FilePathError,
  listDirectory,
  openForStreaming,
  readHandleHead,
  readHead,
  statMeta,
} from "./paths.ts";

const flog = log.scope("files");

export interface FileRouteDeps {
  /** HMAC secret for signed content URLs. Absent → signed URLs disabled. */
  secret?: Buffer;
}

const CONTENT_TTL_SECONDS = 3600; // signed URLs live 1h, like attachments
const SNIFF_BYTES = 4096;

function fileSystemError(err: unknown): FilePathError | null {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM") {
    return new FilePathError(HTTP_STATUS.FORBIDDEN, "Permission denied");
  }
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new FilePathError(HTTP_STATUS.NOT_FOUND, "Path does not exist");
  }
  if (
    code === "ELOOP" ||
    code === "EINVAL" ||
    code === "ENAMETOOLONG" ||
    code === "ERR_INVALID_ARG_VALUE"
  ) {
    return new FilePathError(HTTP_STATUS.BAD_REQUEST, "Invalid path");
  }
  return null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function previewLimitFor(mime: string): number | null {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return MAX_IMAGE_BYTES;
  if (m.startsWith("text/")) return MAX_TEXT_PREVIEW_BYTES;
  return null;
}

/** Expand + canonicalize a caller-supplied path; 400 on empty/relative. */
async function resolvePath(raw: string): Promise<string> {
  if (!raw) throw new FilePathError(400, "Missing path");
  return canonicalize(expandPath(raw));
}

function contentBasePath(pathRaw: string): string {
  return `/api/v1/files/content?path=${encodeURIComponent(pathRaw)}`;
}

async function streamHandle(
  res: ServerResponse,
  handle: FileHandle,
  size: number,
): Promise<void> {
  const stream = handle.createReadStream({
    autoClose: false,
    start: 0,
    ...(size > 0 ? { end: size - 1 } : {}),
  });
  try {
    await pipeline(stream, res);
  } catch (err) {
    // Headers are already committed. A client disconnect or disk read error
    // must terminate the stream, never fall through to a second JSON response.
    if (!res.destroyed) {
      res.destroy(err instanceof Error ? err : undefined);
    }
  }
}

export async function handleFileRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: FileRouteDeps,
): Promise<boolean> {
  const url = req.url ?? "/";
  if (!url.startsWith("/api/v1/files")) return false;
  const m = url.match(/^\/api\/v1\/files\/(info|list|content)(?:\?(.*))?$/);
  if (!m) return false;

  const method = req.method ?? "GET";
  if (method !== "GET") {
    res.setHeader("Allow", "GET");
    json(res, HTTP_STATUS.METHOD_NOT_ALLOWED, {
      error: "Read-only: GET only",
    });
    return true;
  }

  try {
    const params = new URLSearchParams(m[2]);
    const pathRaw = params.get("path") ?? "";
    switch (m[1]) {
      case "info":
        await handleInfo(res, deps, pathRaw);
        return true;
      case "list":
        await handleList(res, pathRaw);
        return true;
      case "content":
        await handleContent(res, deps, pathRaw, params);
        return true;
    }
  } catch (err) {
    if (err instanceof FilePathError) {
      json(res, err.status, { error: err.message });
      return true;
    }
    const fsError = fileSystemError(err);
    if (fsError) {
      json(res, fsError.status, { error: fsError.message });
      return true;
    }
    flog.error("file route failed", { url, error: String(err) });
    json(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, { error: "internal_error" });
    return true;
  }
  return false;
}

async function handleInfo(
  res: ServerResponse,
  deps: FileRouteDeps,
  pathRaw: string,
): Promise<void> {
  const canonical = await resolvePath(pathRaw);
  const meta = await statMeta(canonical);
  const out: Record<string, unknown> = {
    path: meta.path,
    pathDisplay: abbreviateHomePath(meta.path),
    name: meta.name,
    kind: meta.kind,
    size: meta.size,
    mtime: meta.mtime,
  };
  if (meta.kind === "file") {
    const mime = await sniffMime(await readHead(canonical, SNIFF_BYTES));
    const previewLimit = previewLimitFor(mime);
    out.mime = mime;
    if (previewLimit !== null) out.maxBytes = previewLimit;
    if (deps.secret) {
      const basePath = contentBasePath(canonical);
      out.contentUrl = `${basePath}&${signAttachmentUrl(
        basePath,
        deps.secret,
        CONTENT_TTL_SECONDS,
      )}`;
    }
  }
  json(res, HTTP_STATUS.OK, out);
}

async function handleList(res: ServerResponse, pathRaw: string): Promise<void> {
  const canonical = await resolvePath(pathRaw);
  const meta = await statMeta(canonical);
  if (meta.kind !== "dir") {
    throw new FilePathError(HTTP_STATUS.BAD_REQUEST, "Not a directory");
  }
  const { entries, truncated } = await listDirectory(canonical);
  const parent = dirname(canonical);
  json(res, HTTP_STATUS.OK, {
    path: canonical,
    pathDisplay: abbreviateHomePath(canonical),
    parent,
    parentDisplay: abbreviateHomePath(parent),
    truncated,
    entries,
  });
}

async function handleContent(
  res: ServerResponse,
  deps: FileRouteDeps,
  pathRaw: string,
  params: URLSearchParams,
): Promise<void> {
  const basePath = contentBasePath(pathRaw);
  const sig = params.get("sig") ?? "";
  const exp = params.get("exp") ?? "";
  // content is whitelisted in auth-middleware.ts (media tags / downloads
  // cannot send Authorization headers), so it must verify its own URL.
  // Unlike the older attachment route, this new security-sensitive route
  // fails closed when no signing secret is wired.
  if (!deps.secret) {
    json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
      error: "file_content_signing_unavailable",
    });
    return;
  }
  if (!sig || !exp || !verifyAttachmentSig(basePath, exp, sig, deps.secret)) {
    res.writeHead(HTTP_STATUS.UNAUTHORIZED, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const canonical = await resolvePath(pathRaw);
  // `info` signs the realpath-canonical string. If that path now resolves to
  // another target (for example it was replaced by a symlink), the old
  // capability must not silently acquire authority over the new target.
  if (canonical !== pathRaw) {
    json(res, HTTP_STATUS.UNAUTHORIZED, { error: "Unauthorized" });
    return;
  }

  const handle = await openForStreaming(canonical);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new FilePathError(HTTP_STATUS.BAD_REQUEST, "Not a regular file");
    }
    const mime = await sniffMime(
      await readHandleHead(handle, stats.size, SNIFF_BYTES),
    );
    const previewLimit = previewLimitFor(mime);
    const disposition =
      previewLimit !== null && stats.size <= previewLimit
        ? "inline"
        : "attachment";
    res.writeHead(HTTP_STATUS.OK, {
      "Content-Type": mime,
      "X-Content-Type-Options": "nosniff",
      // Ordinary project files change in place; never let reopening show a
      // cached pre-edit body under the same path-bound signed URL.
      "Cache-Control": "no-store",
      // Belt-and-braces: even if a mime mis-sniff ever lets a browser
      // interpret this body as HTML, it can't load any subresource.
      "Content-Security-Policy": "default-src 'none'",
      "Content-Disposition": buildContentDisposition(
        disposition,
        basename(canonical),
      ),
    });
    await streamHandle(res, handle, stats.size);
  } finally {
    await handle.close().catch(() => {});
  }
}
