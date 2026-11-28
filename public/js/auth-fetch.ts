/**
 * Monkey-patches globalThis.fetch to inject `Authorization: Bearer <token>`
 * on same-origin /api/* requests, and to clear the token + redirect to /login
 * on 401 responses from those same paths. All other requests pass through
 * untouched (cross-origin, non-/api, etc.) so we never leak the token.
 */
import { TOKEN_STORAGE_KEY } from "./login-core.ts";
import { HTTP_STATUS } from "../../src/http-status.ts";

interface AuthFetchOptions {
  /** Underlying fetch to wrap. Defaults to globalThis.fetch at install time. */
  baseFetch?: typeof fetch;
  /** Called when a same-origin /api/* request returns 401. Defaults to
   *  redirecting via location.replace. Tests pass a stub. */
  onUnauthorized?: (loginUrl: string) => void;
}

let originalFetch: typeof fetch | null = null;
let installedOnUnauthorized: ((loginUrl: string) => void) | null = null;
const tokenChangeListeners = new Set<(token: string | null) => void>();

function defaultRedirect(loginUrl: string): void {
  // Use replace() so the user can't "Back" into the unauthenticated state.
  location.replace(loginUrl);
}

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function onStoredTokenChange(
  listener: (token: string | null) => void,
): () => void {
  tokenChangeListeners.add(listener);
  return () => {
    tokenChangeListeners.delete(listener);
  };
}

/**
 * Conditional 401 invalidation shared by `auth-fetch.ts` and `SyncHub`:
 * clears the stored token and redirects to `/login` ONLY when the token sent
 * on the failing request still matches the current token in `localStorage`.
 * Prevents a stale 401 from an old tab/worker from wiping a fresh login.
 */
export function handleUnauthorizedToken(
  sentToken: string | null,
  onUnauthorized?: (loginUrl: string) => void,
): boolean {
  const current = getStoredToken();
  if (sentToken !== null && current !== null && current !== sentToken) {
    return false;
  }
  if (sentToken === null && current !== null) {
    return false;
  }
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignore storage failures (private mode, quota); redirect anyway
  }
  for (const listener of tokenChangeListeners) listener(null);
  (onUnauthorized ?? installedOnUnauthorized ?? defaultRedirect)("/login");
  return true;
}

/** Same-origin pathname, or null for malformed/cross-origin URLs. */
function apiPathname(url: string): string | null {
  try {
    if (url.startsWith("/")) return url.split("?")[0];
    const parsed = new URL(url);
    if (parsed.origin !== location.origin) return null;
    return parsed.pathname;
  } catch {
    return null;
  }
}

/** Routes whose 401 means an expired/tampered capability, not a bad token. */
function usesUrlCapability(pathname: string): boolean {
  return (
    pathname === "/api/v1/files/content" ||
    /^\/api\/v1\/tasks\/[A-Za-z0-9_-]+\/attachments\/[^/]+$/.test(pathname)
  );
}

function extractInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function extractBearerToken(headers: Headers): string | null {
  const raw = headers.get("Authorization");
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1] : null;
}

let storageListenerInstalled = false;
function handleStorageEvent(event: StorageEvent): void {
  if (event.key !== TOKEN_STORAGE_KEY) return;
  for (const listener of tokenChangeListeners) {
    listener(event.newValue ?? null);
  }
}

export function installAuthFetch(opts: AuthFetchOptions = {}): () => void {
  const base = opts.baseFetch ?? globalThis.fetch.bind(globalThis);
  const onUnauthorized = opts.onUnauthorized ?? defaultRedirect;
  installedOnUnauthorized = onUnauthorized;

  if (!storageListenerInstalled && typeof window !== "undefined") {
    window.addEventListener("storage", handleStorageEvent);
    storageListenerInstalled = true;
  }

  // Stash original so uninstall can restore.
  originalFetch ??= globalThis.fetch;

  const wrapped: typeof fetch = async (input, init) => {
    const url = extractInputUrl(input);
    const pathname = apiPathname(url);
    const isApi = pathname?.startsWith("/api/") ?? false;

    let nextInit = init;
    let sentToken: string | null = null;
    if (isApi) {
      const baseHeaders =
        init?.headers ?? (input instanceof Request ? input.headers : undefined);
      const headers = new Headers(baseHeaders);
      sentToken = extractBearerToken(headers);
      if (sentToken === null) {
        const token = getStoredToken();
        if (token) {
          headers.set("Authorization", `Bearer ${token}`);
          sentToken = token;
          nextInit = { ...(init ?? {}), headers };
        }
      }
    }

    const res = await base(input, nextInit);

    if (
      isApi &&
      res.status === HTTP_STATUS.UNAUTHORIZED &&
      pathname !== null &&
      !usesUrlCapability(pathname)
    ) {
      handleUnauthorizedToken(sentToken, onUnauthorized);
    }

    return res;
  };

  globalThis.fetch = wrapped;
  return uninstallAuthFetch;
}

export function uninstallAuthFetch(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
  installedOnUnauthorized = null;
}
