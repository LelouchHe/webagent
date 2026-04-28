import type { AuthStore, Scope, TokenRecord } from "./auth-store.ts";

export type AuthFailureReason = "missing" | "invalid";

export type AuthResult =
  | { ok: true; principal: TokenRecord }
  | { ok: false; reason: AuthFailureReason };

interface WhitelistEntry {
  method: "GET" | "POST" | "DELETE";
  test: (path: string) => boolean;
}

// All whitelisted paths must be GETs that read non-sensitive data, or static
// assets needed before the user can present a token.
const WHITELIST: readonly WhitelistEntry[] = [
  // Public probes
  { method: "GET", test: (p) => p === "/api/v1/version" },
  { method: "GET", test: (p) => p === "/api/beta/push/vapid-key" },

  // Static shell + login UI
  { method: "GET", test: (p) => p === "/" },
  { method: "GET", test: (p) => p === "/login" },
  { method: "GET", test: (p) => p === "/login.html" },
  { method: "GET", test: (p) => p === "/manifest.json" },
  { method: "GET", test: (p) => p === "/sw.js" },
  { method: "GET", test: (p) => p === "/favicon.ico" },
  { method: "GET", test: (p) => p === "/theme-init.js" },

  // Hashed bundles (must match build output naming)
  { method: "GET", test: (p) => /^\/js\/[A-Za-z0-9._-]+\.js$/.test(p) },
  { method: "GET", test: (p) => /^\/styles\.[A-Za-z0-9._-]+\.css$/.test(p) },
  { method: "GET", test: (p) => p === "/styles.css" },

  // Icons directory (no traversal: enforced by the check below)
  { method: "GET", test: (p) => /^\/icons\/[A-Za-z0-9._-]+$/.test(p) },

  // SSE streams — authenticated via short-lived ticket in query string
  // (EventSource cannot send custom headers).
  { method: "GET", test: (p) => p === "/api/v1/events/stream" },
  {
    method: "GET",
    test: (p) =>
      /^\/api\/v1\/sessions\/[A-Za-z0-9_-]+\/events\/stream$/.test(p),
  },

  // Image GETs — authenticated via HMAC sig+exp query string (an <img>
  // tag cannot send Authorization headers). The image route handler does
  // its own verification before serving bytes.
  {
    method: "GET",
    test: (p) =>
      /^\/api\/v1\/sessions\/[A-Za-z0-9_-]+\/images\/[A-Za-z0-9._-]+$/.test(p),
  },

  // --- Share viewer (public read-only snapshots) ---
  // Viewer HTML shell + image proxy + viewer-namespaced static assets
  // (CSS/JS) all live under /s/* — see src/share/routes.ts. The auth gate
  // only applies to /api/**, so /s/* paths fall through to share routes
  // without needing a whitelist entry. The viewer's event stream is the
  // only public /api/ path: it serves a frozen snapshot identified solely
  // by the share token in the URL.
  {
    method: "GET",
    test: (p) => /^\/api\/v1\/shared\/[A-Za-z0-9_-]{24}\/events$/.test(p),
  },
];

/**
 * True if the request can bypass authentication. Path must be normalized
 * (no `..`, no `//`); we reject anything containing those segments to avoid
 * traversal-based whitelist bypass.
 */
export function isWhitelistedPath(method: string, path: string): boolean {
  if (!path || path.includes("..") || path.includes("//")) return false;
  const m = method.toUpperCase();
  for (const entry of WHITELIST) {
    if (entry.method === m && entry.test(path)) return true;
  }
  return false;
}

/**
 * Validate the Authorization header against the auth store.
 * Touches lastUsedAt on success. Pure header parsing + store lookup —
 * no I/O beyond the in-memory map.
 */
export function authenticate(
  headers: Record<string, string | string[] | undefined>,
  store: AuthStore,
): AuthResult {
  const raw = headers.authorization ?? headers.Authorization;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety for dynamic headers
  if (raw === undefined || raw === null)
    return { ok: false, reason: "missing" };
  if (Array.isArray(raw)) return { ok: false, reason: "invalid" };
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };

  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "missing" };

  // Parse "Bearer <token>" case-insensitively. Reject scheme-only or extra spaces.
  const match = /^Bearer\s+(\S+)\s*$/i.exec(trimmed);
  if (!match) return { ok: false, reason: "invalid" };
  const token = match[1];

  const principal = store.findByToken(token);
  if (!principal) return { ok: false, reason: "invalid" };

  store.touchLastUsed(token);
  return { ok: true, principal };
}

/**
 * Returns true if the auth result has at least the required scope.
 * admin > api (admin is a superset).
 */
export function requireScope(result: AuthResult, required: Scope): boolean {
  if (!result.ok) return false;
  const have = result.principal.scope;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- exhaustive check for type safety
  if (required === "api") return have === "api" || have === "admin";
  return have === "admin";
}
