import { randomBytes } from "node:crypto";

/**
 * Generate a share token.
 *
 * `randomBytes(18).toString("base64url")` gives exactly 24 URL-safe
 * characters (no padding) with ~144 bits of entropy. Repo convention is
 * `node:crypto` only — no `nanoid` / `uuid` dependency.
 *
 * Same helper is used for both preview and active share tokens; preview
 * tokens become active tokens on /publish — the lifecycle is row-state
 * (shares.shared_at), not token-identity, per share-plan §4.1.
 */
export function generateShareToken(): string {
  return randomBytes(18).toString("base64url");
}
