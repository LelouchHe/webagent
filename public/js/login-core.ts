/**
 * Pure logic for the login page. Importable by tests; called by login.ts (DOM wiring).
 *
 * Storage key is exported so other modules (e.g. api.ts fetch wrapper)
 * agree on the same name. Choose `wa_token` to match localStorage discovery
 * conventions (short, unique, no PII).
 */
export const TOKEN_STORAGE_KEY = "wa_token";

export type VerifyResult =
  | { ok: true; name: string; scope: string }
  | { ok: false; error: string };

interface VerifyDeps {
  fetch?: typeof fetch;
}

/**
 * POST the token to /api/v1/auth/verify. On 200, persist to localStorage and
 * return success. On any other outcome, do NOT touch localStorage and return
 * a user-facing error message.
 */
export async function verifyAndStoreToken(
  rawInput: string,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  const fetchFn = deps.fetch ?? fetch;
  const token = rawInput.trim();
  if (!token) return { ok: false, error: "Token is required" };

  let res: Response;
  try {
    res = await fetchFn("/api/v1/auth/verify", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error: ${msg}` };
  }

  if (res.status === 200) {
    let body: { ok?: boolean; name?: string; scope?: string };
    try {
      body = (await res.json()) as {
        ok?: boolean;
        name?: string;
        scope?: string;
      };
    } catch {
      return { ok: false, error: "Server returned invalid response" };
    }
    if (
      !body.ok ||
      typeof body.name !== "string" ||
      typeof body.scope !== "string"
    ) {
      return { ok: false, error: "Server returned malformed response" };
    }
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Could not store token: ${msg}` };
    }
    return { ok: true, name: body.name, scope: body.scope };
  }

  if (res.status === 401) {
    return { ok: false, error: "Invalid or rejected token" };
  }

  return { ok: false, error: `Unexpected response (status ${res.status})` };
}

/**
 * If the page was opened via the first-run banner URL
 * (`http://host:port/#t=wat_<...>`), consume the fragment:
 *
 *  1. Strip the hash via `history.replaceState` BEFORE writing localStorage,
 *     so even if `setItem` throws (private browsing quota etc.) the URL
 *     bar is already neutralized — no second-chance leak from a rendered
 *     login form with the token still in the address bar.
 *  2. Persist token to `wa_token`.
 *  3. Return `{ ok: true }` so the caller can `location.replace("/")`.
 *
 * Reject anything that doesn't match the strict shape — token prefix `wat_`
 * plus URL-safe base64 alphabet. Hash is left intact on rejection so
 * misformed fragments are visible during debugging instead of silently
 * eaten.
 */
export function consumeUrlHashToken(): { ok: true } | { ok: false } {
  const m = /^#t=(wat_[A-Za-z0-9_-]+)$/.exec(location.hash);
  if (!m) return { ok: false };
  const token = m[1];
  history.replaceState(null, "", location.pathname + location.search);
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    return { ok: false };
  }
  return { ok: true };
}
