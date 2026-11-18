import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { generateApiToken } from "./tokens.ts";

const HASH_HEX_LEN = 64; // SHA-256 hex

/**
 * Generate a fresh API token. Thin re-export — the canonical generator
 * lives in `src/tokens.ts` alongside the other auth-bearing token
 * generators (share, SSE) for a single audit surface.
 */
export function generateToken(): string {
  return generateApiToken();
}

/** Hash a token with SHA-256 -> 64-char lowercase hex. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time check that the given token hashes to the given hex hash.
 * Returns false on any malformed input rather than throwing.
 */
export function verifyToken(token: string, expectedHashHex: string): boolean {
  if (!token || expectedHashHex.length !== HASH_HEX_LEN) {
    return false;
  }
  if (!/^[a-f0-9]+$/i.test(expectedHashHex)) return false;
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHashHex, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// --- Image URL signing -------------------------------------------------------

function hmacHex(secret: Buffer, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

/** Build the canonical input string for HMAC. Path + ":" + exp. */
function canonical(path: string, exp: number | string): string {
  return `${path}:${exp}`;
}

/**
 * Returns "exp=<unix>&sig=<hex>" — appendable as a query string to the path.
 * ttlSeconds may be negative (yields an already-expired URL, useful in tests).
 */
export function signAttachmentUrl(
  path: string,
  secret: Buffer,
  ttlSeconds: number,
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = hmacHex(secret, canonical(path, exp));
  return `exp=${exp}&sig=${sig}`;
}

/**
 * Verify a signed image URL. Returns false on any malformed input or expired/tampered URL.
 * HMAC binds (path, exp) so altering either invalidates the signature.
 */
export function verifyAttachmentSig(
  path: string,
  expRaw: string,
  sigHex: string,
  secret: Buffer,
): boolean {
  if (!path || !expRaw || !sigHex) return false;
  if (!/^\d+$/.test(expRaw)) return false;
  if (!/^[a-f0-9]+$/i.test(sigHex)) return false;

  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return false;
  if (exp < Math.floor(Date.now() / 1000)) return false;

  const expected = Buffer.from(hmacHex(secret, canonical(path, expRaw)), "hex");
  let actual: Buffer;
  try {
    actual = Buffer.from(sigHex, "hex");
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Rewrite every `/api/v1/tasks/:id/attachments/:file` URL inside a JSON-serialized
 * payload to carry a valid `?exp=&sig=`. Applied at egress (history GET, SSE
 * push); a per-secret bounded cache keeps a path's URL stable while it has a
 * safety margin left, so recreated DOM can reuse the browser's immutable entry.
 */
const ATTACHMENT_URL_RE =
  /\/api\/v1\/tasks\/[A-Za-z0-9_-]+\/attachments\/[A-Za-z0-9._-]+(?:\?(?:exp=\d+&sig=[a-f0-9]+|sig=[a-f0-9]+&exp=\d+))?/g;

const SIGNING_CACHE_MARGIN_SECONDS = 60;
const SIGNING_CACHE_MAX_ENTRIES = 2048;

interface SignedAttachmentCacheEntry {
  exp: number;
  ttlSeconds: number;
  query: string;
}

const signedAttachmentCache = new WeakMap<
  Buffer,
  Map<string, SignedAttachmentCacheEntry>
>();

function cachedSignedQuery(
  basePath: string,
  secret: Buffer,
  ttlSeconds: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  let entries = signedAttachmentCache.get(secret);
  if (!entries) {
    entries = new Map();
    signedAttachmentCache.set(secret, entries);
  }

  for (const [path, entry] of entries) {
    if (entry.exp <= now + SIGNING_CACHE_MARGIN_SECONDS) {
      entries.delete(path);
    }
  }
  const existing = entries.get(basePath);
  if (existing?.ttlSeconds === ttlSeconds) {
    entries.delete(basePath);
    entries.set(basePath, existing);
    return existing.query;
  }

  const query = signAttachmentUrl(basePath, secret, ttlSeconds);
  const exp = Number(new URLSearchParams(query).get("exp"));
  if (entries.size >= SIGNING_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(basePath, { exp, ttlSeconds, query });
  return query;
}

export function reSignAttachmentUrlsInJson(
  json: string,
  secret: Buffer,
  ttlSeconds = 3600,
): string {
  return json.replace(ATTACHMENT_URL_RE, (match) => {
    const basePath = match.split("?")[0];
    return `${basePath}?${cachedSignedQuery(basePath, secret, ttlSeconds)}`;
  });
}
