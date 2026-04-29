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
 * Share viewer token. 24 base64url chars / 144 bits of entropy.
 *
 * Base64url (`[A-Za-z0-9_-]`) is the RFC 4648 standard, has Node
 * built-in support, and is 33% shorter than the hex form at the same
 * entropy. Share links are produced as full URLs by the client
 * (copy-link affordance, no manual retyping), so the double-click
 * selection that hex previously enabled is no longer relevant.
 */
export function generateShareToken(): string {
  return randomBytes(18).toString("base64url");
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
