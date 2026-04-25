import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";
import { installAuthFetch, uninstallAuthFetch } from "../public/js/auth-fetch.ts";
import { TOKEN_STORAGE_KEY } from "../public/js/login-core.ts";

interface FetchCall {
  url: string;
  headers: Headers;
  method: string;
}

function recordedFetch(response: Response): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    calls.push({ url, headers, method: init?.method ?? "GET" });
    return response;
  }) as typeof fetch;
  return { fetch: fn, calls };
}

describe("auth-fetch wrapper", () => {
  let restore: () => void;

  beforeEach(() => {
    setupDOM();
    localStorage.setItem(TOKEN_STORAGE_KEY, "wat_test");
  });

  afterEach(() => {
    uninstallAuthFetch();
    teardownDOM();
  });

  it("attaches Bearer to same-origin /api/* requests", async () => {
    const { fetch, calls } = recordedFetch(new Response("{}", { status: 200 }));
    restore = installAuthFetch({ baseFetch: fetch });
    await globalThis.fetch("/api/v1/sessions");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.headers.get("Authorization"), "Bearer wat_test");
  });

  it("attaches Bearer to /api/beta/* requests", async () => {
    const { fetch, calls } = recordedFetch(new Response("{}", { status: 200 }));
    restore = installAuthFetch({ baseFetch: fetch });
    await globalThis.fetch("/api/beta/push/subscribe", { method: "POST" });
    assert.equal(calls[0]!.headers.get("Authorization"), "Bearer wat_test");
  });

  it("does NOT attach Bearer to non-/api requests", async () => {
    const { fetch, calls } = recordedFetch(new Response("{}", { status: 200 }));
    restore = installAuthFetch({ baseFetch: fetch });
    await globalThis.fetch("/icons/foo.png");
    await globalThis.fetch("/manifest.json");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.headers.get("Authorization"), null);
    assert.equal(calls[1]!.headers.get("Authorization"), null);
  });

  it("does NOT attach Bearer to cross-origin requests", async () => {
    const { fetch, calls } = recordedFetch(new Response("{}", { status: 200 }));
    restore = installAuthFetch({ baseFetch: fetch });
    await globalThis.fetch("https://evil.example.com/api/v1/steal");
    assert.equal(calls[0]!.headers.get("Authorization"), null);
  });

  it("preserves existing Authorization header (no override)", async () => {
    const { fetch, calls } = recordedFetch(new Response("{}", { status: 200 }));
    restore = installAuthFetch({ baseFetch: fetch });
    await globalThis.fetch("/api/v1/sessions", {
      headers: { Authorization: "Bearer custom-override" },
    });
    assert.equal(calls[0]!.headers.get("Authorization"), "Bearer custom-override");
  });

  it("does nothing when token is missing (e.g. logged out)", async () => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    const { fetch, calls } = recordedFetch(new Response("{}", { status: 200 }));
    restore = installAuthFetch({ baseFetch: fetch });
    await globalThis.fetch("/api/v1/sessions");
    assert.equal(calls[0]!.headers.get("Authorization"), null);
  });

  it("on 401 from /api/*, clears token and redirects to /login", async () => {
    const { fetch } = recordedFetch(new Response("{}", { status: 401 }));
    let redirectedTo: string | null = null;
    restore = installAuthFetch({
      baseFetch: fetch,
      onUnauthorized: (url) => {
        redirectedTo = url;
      },
    });
    await globalThis.fetch("/api/v1/sessions");
    assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), null);
    assert.equal(redirectedTo, "/login");
  });

  it("does NOT clear token on 401 from non-/api", async () => {
    const { fetch } = recordedFetch(new Response("{}", { status: 401 }));
    let redirected = false;
    restore = installAuthFetch({
      baseFetch: fetch,
      onUnauthorized: () => {
        redirected = true;
      },
    });
    await globalThis.fetch("https://other.com/something");
    assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), "wat_test");
    assert.equal(redirected, false);
  });

  it("does NOT clear or redirect on 200 response", async () => {
    const { fetch } = recordedFetch(new Response("{}", { status: 200 }));
    let redirected = false;
    restore = installAuthFetch({
      baseFetch: fetch,
      onUnauthorized: () => { redirected = true; },
    });
    await globalThis.fetch("/api/v1/sessions");
    assert.equal(localStorage.getItem(TOKEN_STORAGE_KEY), "wat_test");
    assert.equal(redirected, false);
  });

  it("returns the response unchanged on success", async () => {
    const original = new Response(JSON.stringify({ x: 1 }), { status: 200 });
    const { fetch } = recordedFetch(original);
    restore = installAuthFetch({ baseFetch: fetch });
    const res = await globalThis.fetch("/api/v1/sessions");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { x: 1 });
  });

  it("works with Request object input (not just string)", async () => {
    const { fetch, calls } = recordedFetch(new Response("{}", { status: 200 }));
    restore = installAuthFetch({ baseFetch: fetch });
    const req = new Request("http://localhost:6801/api/v1/sessions");
    await globalThis.fetch(req);
    assert.equal(calls[0]!.headers.get("Authorization"), "Bearer wat_test");
  });

  it("works with URL object input", async () => {
    const { fetch, calls } = recordedFetch(new Response("{}", { status: 200 }));
    restore = installAuthFetch({ baseFetch: fetch });
    await globalThis.fetch(new URL("/api/v1/sessions", "http://localhost:6801"));
    assert.equal(calls[0]!.headers.get("Authorization"), "Bearer wat_test");
  });

  it("uninstallAuthFetch restores the original fetch", async () => {
    const { fetch, calls } = recordedFetch(new Response("{}", { status: 200 }));
    restore = installAuthFetch({ baseFetch: fetch });
    await globalThis.fetch("/api/v1/sessions");
    assert.equal(calls[0]!.headers.get("Authorization"), "Bearer wat_test");
    uninstallAuthFetch();
    // Subsequent calls go through the original (which would be jsdom's, but
    // we just confirm globalThis.fetch is no longer our wrapper).
    assert.equal(globalThis.fetch === fetch, false);
  });
});
