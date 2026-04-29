import { randomBytes } from "node:crypto";

/**
 * Auth-bearing token generators (single audit surface).
 *
 * This file centralizes generation of all string tokens that act as
 * credentials — i.e. clients hold them, present them to the server,
 * and the server grants access on that basis. New auth-bearing tokens
 * MUST be added here so the security review surface stays one file.
 *
 * Out of scope (intentionally not here):
 *   - Internal IDs that aren't auth-bearing (client IDs, request IDs,
 *     error correlation IDs) — see sse-manager.ts, routes.ts, etc.
 *   - HMAC signing keys (image URL secret) — see server.ts.
 *   - UUIDs used as opaque labels (session IDs, msg IDs) — these
 *     are protocol identifiers, not credentials.
 *
 * Repo convention: `node:crypto` only. No `nanoid` / `uuid` deps.
 */

const API_TOKEN_PREFIX = "wat_";

/**
 * Share viewer token. 36 lowercase hex chars / 144 bits of entropy.
 *
 * Hex (not base64url) so double-click in a browser selects the whole
 * token — base64url's `-` is a word boundary on every major engine,
 * and share tokens are routinely copy-pasted from URL bars.
 */
export function generateShareToken(): string {
  return randomBytes(18).toString("hex");
}

/**
 * API auth token. "wat_" prefix + 43 base64url chars / 256 bits.
 *
 * Prefix lets secret scanners (GitHub, Slack) match `wat_[A-Za-z0-9_-]{43}`
 * and gives `grep` an obvious search target in logs.
 */
export function generateApiToken(): string {
  return API_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * Single-use SSE ticket. 32 base64url chars / 192 bits.
 *
 * Lifecycle is short (default 60s TTL, deleted on consume), so length
 * sits between share and API tokens — well above brute-force feasibility,
 * comfortably below "user pastes this manually".
 */
export function generateSseTicket(): string {
  return randomBytes(24).toString("base64url");
}
