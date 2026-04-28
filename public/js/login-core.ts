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
