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
export function signImageUrl(
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
export function verifyImageSig(
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
 * Rewrite every `/api/v1/sessions/:id/images/:file` URL inside a JSON-serialized
 * payload to carry a fresh `?exp=&sig=`. Applied at egress (history GET, SSE
 * push) so a 1h-old stored URL is re-signed on the way out — the user can
 * reload history days later and images still resolve.
 */
const IMAGE_URL_RE =
  /\/api\/v1\/sessions\/[A-Za-z0-9_-]+\/images\/[A-Za-z0-9._-]+(?:\?(?:exp=\d+&sig=[a-f0-9]+|sig=[a-f0-9]+&exp=\d+))?/g;

export function reSignImageUrlsInJson(
  json: string,
  secret: Buffer,
  ttlSeconds = 3600,
): string {
  return json.replace(IMAGE_URL_RE, (match) => {
    const basePath = match.split("?")[0];
    return `${basePath}?${signImageUrl(basePath, secret, ttlSeconds)}`;
  });
}
