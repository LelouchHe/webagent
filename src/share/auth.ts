import type { IncomingMessage } from "node:http";

export class OwnerAuthError extends Error {
  readonly status = 401;
  readonly reason: OwnerAuthRejectReason;
  constructor(reason: OwnerAuthRejectReason, message?: string) {
    super(message ?? `owner-auth rejected: ${reason}`);
    this.reason = reason;
  }
}

export type OwnerAuthRejectReason =
  | "no_origin_no_sec_fetch"
  | "sec_fetch_cross_site"
  | "origin_mismatch";

/**
 * Owner-auth gate for all /api/v1/sessions/:id/share* and /api/v1/shares
 * routes. Throws OwnerAuthError on reject, returns void on accept.
 *
 * Policy (see share-plan §4.2 R2-c1 + share-dev 2026-04-24 Origin spike):
 *
 *   1. CF Access path — `Cf-Access-Authenticated-User-Email` header set by
 *      the edge allowlist gates. If present (and email-shaped), accept.
 *   2. Browser path — accept if `Sec-Fetch-Site ∈ {same-origin, none}`
 *      OR if `Origin` matches `Host`. Either signal alone is sufficient
 *      because modern browsers always emit Sec-Fetch-Site while older
 *      ones always emit Origin on non-GET; the AND form in the spec
 *      would falsely reject same-origin GET from modern browsers that
 *      omit Origin. See share-dev spike for the empirical table.
 *   3. Naked request — no CF header, no Sec-Fetch-Site, no Origin →
 *      reject. Agent subprocess `curl` lands here.
 *   4. Cross-site — Sec-Fetch-Site reports `cross-site` or `same-site` →
 *      reject.
 *
 * Defense-in-depth; CF Access remains the primary gate. Per share-plan
 * §4.2 v7 R3-c4 single-source-of-truth discipline, do not add per-route
 * parameterization — add a new helper for divergent checks.
 */
export function assertOwner(req: IncomingMessage): void {
  const cfEmail = headerValue(req, "cf-access-authenticated-user-email");
  if (cfEmail?.includes("@")) return;

  const secFetchSite = headerValue(req, "sec-fetch-site");
  const origin = headerValue(req, "origin");
  const host = headerValue(req, "host");

  if (secFetchSite) {
    if (secFetchSite === "same-origin" || secFetchSite === "none") return;
    throw new OwnerAuthError("sec_fetch_cross_site");
  }

  if (origin && host) {
    if (originMatchesHost(origin, host)) return;
    throw new OwnerAuthError("origin_mismatch");
  }

  throw new OwnerAuthError("no_origin_no_sec_fetch");
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

function originMatchesHost(origin: string, host: string): boolean {
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return originHost.toLowerCase() === host.toLowerCase();
}
