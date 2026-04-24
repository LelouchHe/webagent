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
  | "origin_mismatch"
  | "origin_without_sec_fetch";

/**
 * Owner-auth gate for all /api/v1/sessions/:id/share* and /api/v1/shares
 * routes. Throws OwnerAuthError on reject, returns void on accept.
 *
 * Policy (see share-plan §4.2 R2-c1 + share-dev 2026-04-24 Origin spike +
 * C5-review anomaly-guard tightening):
 *
 *   1. CF Access — `Cf-Access-Authenticated-User-Email` present (email
 *      shape) → accept.
 *   2. Browser — `Sec-Fetch-Site ∈ {same-origin, none}` → accept.
 *      `Sec-Fetch-Site ∈ {cross-site, same-site}` → reject.
 *   3. Origin-without-Sec-Fetch → reject ('origin_without_sec_fetch').
 *      Real browsers in 2026 always emit Sec-Fetch-Site alongside Origin;
 *      the asymmetry is a curl / server-to-server forgery signature.
 *   4. Naked (no CF, no Sec-Fetch, no Origin) → reject.
 */
export function assertOwner(req: IncomingMessage): void {
  const cfEmail = headerValue(req, "cf-access-authenticated-user-email");
  if (cfEmail?.includes("@")) return;

  const secFetchSite = headerValue(req, "sec-fetch-site");
  const origin = headerValue(req, "origin");

  if (secFetchSite) {
    if (secFetchSite === "same-origin" || secFetchSite === "none") return;
    throw new OwnerAuthError("sec_fetch_cross_site");
  }

  // Anomaly guard (code-review C1/C5 follow-up): every modern browser that
  // sends Origin also sends Sec-Fetch-Site. We only reach here when
  // Sec-Fetch-Site is absent; Origin-without-Sec-Fetch is a curl /
  // server-to-server signature — reject so a LAN-reachable dogfood
  // server can't be owned via a forged Origin header.
  if (origin) {
    throw new OwnerAuthError("origin_without_sec_fetch");
  }

  throw new OwnerAuthError("no_origin_no_sec_fetch");
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}
