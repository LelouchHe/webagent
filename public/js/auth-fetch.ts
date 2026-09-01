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

function defaultRedirect(loginUrl: string): void {
  // Use replace() so the user can't "Back" into the unauthenticated state.
  location.replace(loginUrl);
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
    /^\/api\/v1\/sessions\/[A-Za-z0-9_-]+\/attachments\/[^/]+$/.test(pathname)
  );
}

function extractInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function installAuthFetch(opts: AuthFetchOptions = {}): () => void {
  const base = opts.baseFetch ?? globalThis.fetch.bind(globalThis);
  const onUnauthorized = opts.onUnauthorized ?? defaultRedirect;

  // Stash original so uninstall can restore.
  originalFetch ??= globalThis.fetch;

  const wrapped: typeof fetch = async (input, init) => {
    const url = extractInputUrl(input);
    const pathname = apiPathname(url);
    const isApi = pathname?.startsWith("/api/") ?? false;

    let nextInit = init;
    if (isApi) {
      const token = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (token) {
        // Merge in our header without clobbering an explicit one.
        const baseHeaders =
          init?.headers ??
          (input instanceof Request ? input.headers : undefined);
        const headers = new Headers(baseHeaders);
        if (!headers.has("Authorization")) {
          headers.set("Authorization", `Bearer ${token}`);
        }
        nextInit = { ...(init ?? {}), headers };
      }
    }

    const res = await base(input, nextInit);

    if (
      isApi &&
      res.status === HTTP_STATUS.UNAUTHORIZED &&
      pathname !== null &&
      !usesUrlCapability(pathname)
    ) {
      try {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
      } catch {
        // ignore storage failures (private mode, quota); redirect anyway
      }
      onUnauthorized("/login");
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
}
