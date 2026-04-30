// Helpers for the attachment upload pipeline. The upload handler in
// routes.ts threads request -> busboy -> stream-to-disk -> DB row using
// these primitives. Everything here is server-only; clients never see
// realpaths or temp filenames.

import { fileTypeFromBuffer } from "file-type";

/**
 * Server-controlled mime → file extension map (uploads-plan v2.6 §14).
 *
 * The disk extension is derived from the mime type, NOT the client-supplied
 * filename. That way a client lying about the extension cannot trick disk
 * tooling that uses extension-based heuristics. Anything not in the table
 * falls through to `.bin` so `mime` and `ext` stay consistent.
 */
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/html": "html",
  "text/csv": "csv",
  "text/javascript": "js",
  "application/json": "json",
  "application/javascript": "js",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/zip": "zip",
  "application/gzip": "gz",
  "application/x-tar": "tar",
  "application/x-7z-compressed": "7z",
  "application/x-rar-compressed": "rar",
};

export function mimeToExt(mime: string): string {
  return MIME_TO_EXT[mime.toLowerCase()] ?? "bin";
}

/**
 * Detect the real mime type of an uploaded file by inspecting its content,
 * not the client-supplied Content-Type or filename extension. Resolves the
 * "user uploads `.clj` → browser sends application/octet-stream → agents
 * skip reading binary blobs" failure mode (uploads-plan dev log 2026-04-30).
 *
 * Strategy:
 *   1. `file-type` checks magic bytes for ~200 binary formats (PDF, PNG,
 *      ZIP, office, audio, video, ...). If it hits, trust that.
 *   2. No magic match → check whether the buffer is plausibly text:
 *      - no NUL bytes (binary marker)
 *      - decodes cleanly as UTF-8
 *      → return "text/plain". Source code (Clojure, Lua, Rust, Go, ...)
 *        all land here regardless of how the OS / browser tagged them.
 *   3. Otherwise fall through to "application/octet-stream".
 *
 * Pass `head` as a buffer of at least the first 4 KB of file content; that's
 * enough for every magic signature `file-type` knows about.
 */
export async function sniffMime(head: Buffer): Promise<string> {
  const detected = await fileTypeFromBuffer(head);
  if (detected) return detected.mime;
  if (looksLikeUtf8Text(head)) return "text/plain";
  return "application/octet-stream";
}

function looksLikeUtf8Text(buf: Buffer): boolean {
  if (buf.length === 0) return true;
  for (const byte of buf) {
    if (byte === 0) return false;
  }
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mimes we are willing to render inline in <img>. Everything else is forced
 * to download via Content-Disposition: attachment so a malicious upload (HTML,
 * SVG, text/plain interpreted as HTML by Chrome) cannot script the page.
 */
const INLINE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function isInlineMime(mime: string): boolean {
  return INLINE_MIMES.has(mime.toLowerCase());
}

/**
 * Classify an upload as "image" (sent as ACP image block, inlined as base64)
 * or "file" (sent as ACP resource_link). Decision is mime-prefix-based —
 * anything with `image/*` is "image", everything else is "file". Clients
 * cannot override this.
 */
export function classifyKind(mime: string): "image" | "file" {
  return mime.toLowerCase().startsWith("image/") ? "image" : "file";
}

/**
 * Normalize a client-supplied filename for safe display + disk use:
 *  - NFC-normalize Unicode (combining characters → composed form).
 *  - Strip ASCII control characters (CR, LF, tab, NUL, etc).
 *  - Strip path separators ("/", "\") so the name cannot encode a
 *    sub-path on its own.
 *  - Reject "." and ".." outright (path-traversal sentinels).
 *  - Cap to 255 UTF-8 bytes (POSIX NAME_MAX).
 *
 * Returns null if normalization would produce an empty name or one of the
 * forbidden sentinels. Callers should fall back to a generated default
 * (e.g. `image-N` / `file-N`).
 */
export function normalizeDisplayName(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.normalize("NFC");
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1f\x7f]/g, "");
  s = s.replace(/[/\\]/g, "");
  s = s.trim();
  if (s.length === 0) return null;
  if (s === "." || s === "..") return null;
  // Cap at 255 UTF-8 bytes — slice in code units first as a fast path,
  // then verify byte-length and trim if needed.
  if (Buffer.byteLength(s, "utf8") > 255) {
    while (Buffer.byteLength(s, "utf8") > 255 && s.length > 0) {
      s = s.slice(0, -1);
    }
    if (s.length === 0) return null;
  }
  return s;
}

/**
 * Build a Content-Disposition value with both an ASCII fallback (filename=)
 * and an RFC 5987 percent-encoded UTF-8 form (filename*=) so non-ASCII names
 * survive every browser's download dialog.
 *
 * `disposition` is "inline" or "attachment". "attachment" forces the browser
 * to download instead of rendering, which is what we use for non-image
 * mimes (decision 3).
 */
export function buildContentDisposition(
  disposition: "inline" | "attachment",
  displayName: string,
): string {
  const ascii = displayName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  const utf8 = encodeURIComponent(displayName);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
