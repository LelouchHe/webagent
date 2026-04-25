/**
 * Monkey-patches globalThis.fetch to inject `Authorization: Bearer <token>`
 * on same-origin /api/* requests, and to clear the token + redirect to /login
 * on 401 responses from those same paths. All other requests pass through
 * untouched (cross-origin, non-/api, etc.) so we never leak the token.
 */
import { TOKEN_STORAGE_KEY } from "./login-core.ts";

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

/** True if the URL targets the same origin we're loaded from and starts with /api/. */
function isAuthedApiCall(url: string): boolean {
  let pathname: string;
  try {
    if (url.startsWith("/")) {
      pathname = url.split("?")[0]!;
    } else {
      const parsed = new URL(url);
      // Different origin? leave it alone.
      if (parsed.origin !== location.origin) return false;
      pathname = parsed.pathname;
    }
  } catch {
    return false;
  }
  return pathname.startsWith("/api/");
}

function extractInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

export function installAuthFetch(opts: AuthFetchOptions = {}): () => void {
  const base = opts.baseFetch ?? globalThis.fetch.bind(globalThis);
  const onUnauthorized = opts.onUnauthorized ?? defaultRedirect;

  // Stash original so uninstall can restore.
  if (!originalFetch) originalFetch = globalThis.fetch;

  const wrapped: typeof fetch = async (input, init) => {
    const url = extractInputUrl(input);
    const isApi = isAuthedApiCall(url);

    let nextInit = init;
    if (isApi) {
      const token = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (token) {
        // Merge in our header without clobbering an explicit one.
        const baseHeaders = init?.headers
          ? init.headers
          : input instanceof Request
            ? input.headers
            : undefined;
        const headers = new Headers(baseHeaders as HeadersInit | undefined);
        if (!headers.has("Authorization")) {
          headers.set("Authorization", `Bearer ${token}`);
        }
        nextInit = { ...(init ?? {}), headers };
      }
    }

    const res = await base(input, nextInit);

    if (isApi && res.status === 401) {
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
