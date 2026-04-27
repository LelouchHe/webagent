# Security

webagent is designed for **single-operator self-hosting**: one human, one or more devices, one ACP agent. The threat model is:

- **Network**: the server may be reachable on a LAN, behind a reverse proxy, or directly on the open internet via Cloudflare Tunnel. Untrusted clients must not be able to issue prompts, read history, or run shell commands.
- **Browser**: the only legitimate client is a browser the operator controls. Token theft via XSS, third-party scripts, or stale CDN content is treated as a real risk.
- **Process boundary**: the agent subprocess (Copilot CLI, Claude, etc.) is trusted with anything the operator can do — there is no sandbox between the server and the agent.

This document covers the auth model, data layout, and operational practices that protect against the first two threats. The third is by design and not in scope.

## Bootstrap

webagent **refuses to serve unauthenticated traffic.** On startup, if `data/auth.json` has zero tokens, the server logs a recovery message and exits:

- Foreground (TTY): exit 1 immediately.
- Daemon (no TTY): sleep 60s then exit 78 (`sysexits.h: configuration error`). The 60s pause throttles supervisor restart loops so logs stay readable.

First-time setup:

```sh
webagent --create-token <name>
# prints the raw token ONCE — paste into /login on first browser visit
```

The CLI prints the raw token to stdout exactly once. If you lose it, revoke and recreate. Tokens are stored hashed; they cannot be recovered from `auth.json`.

## Token Storage

`data/auth.json` (mode `0600`) holds:

```json
{
  "tokens": [
    {
      "name": "macbook",
      "scope": "admin",
      "hash": "ec5cd2f9c3a66c309c12e306791fa67e067fc7f92c0bea71aafa4b134c7e4ee9",
      "createdAt": 1777097538082,
      "lastUsedAt": 1777098000123
    }
  ]
}
```

- **`hash`**: SHA-256 of the raw token. The raw value never persists server-side.
- **`name`**: free-form label, unique per file. Used by the CLI and `/tokens` API to address a token.
- **`scope`**: `admin` (full access, including token CRUD) or `api` (everything except `/tokens/**`). `webagent --create-token` always creates `admin`. `POST /api/v1/tokens` always creates `api`.
- **`lastUsedAt`**: updated on every successful auth, but buffered in memory and flushed every 60s (and on `SIGTERM`) to avoid hot-write churn. Reads from disk return the last-flushed value.
- **File locking**: `proper-lockfile` guards every read-modify-write so the CLI (which mutates `auth.json` while the daemon is running) and the daemon's flush timer cannot interleave and lose updates.

Token format: `wat_` + 32 random URL-safe bytes (base64url). Constant-time comparison via SHA-256 hash equality.

## Auth Flow

Every HTTP request flows through `src/auth-middleware.ts`:

1. If the path matches a whitelist entry → pass through unauthenticated.
2. Otherwise extract `Authorization: Bearer <token>` from the request header.
3. Hash the token, look up in `AuthStore`. On match, attach `principal: TokenRecord` to the request and continue. On any failure, return `401 Unauthorized`.

Whitelisted paths (no auth required):

| Path                                                             | Why                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/v1/version`                                            | Public probe; no PII                                                      |
| `GET /api/beta/push/vapid-key`                                   | Public probe; subscribing requires auth                                   |
| `GET /`                                                          | HTML shell — `app.ts` redirects to `/login` if no token in `localStorage` |
| `GET /login`, `/login.html`                                      | Login page                                                                |
| `GET /manifest.json`, `/sw.js`, `/favicon.ico`, `/theme-init.js` | PWA + early-paint helpers needed before login                             |
| `GET /js/*.js`, `/styles*.css`, `/icons/*`                       | Static bundles (content-hashed)                                           |
| `GET /api/v1/events/stream`                                      | SSE — auth via short-lived ticket in query string instead (see below)     |
| `GET /api/v1/images/*`                                           | Auth via HMAC signature in query string instead (see below)               |

Anything else (chat history, prompt submission, model selection, bash, push subscriptions) requires a Bearer token.

### Frontend wiring

- Token persists in `localStorage` under `wa_token`. Key is exported as `TOKEN_STORAGE_KEY` from `public/js/login-core.ts` so the login page and the API wrapper agree.
- `public/js/api.ts` exposes `request()` which auto-attaches `Authorization: Bearer ...` to every API call.
- `app.ts` does an early pre-bootstrap check (line 5-10): if no token in `localStorage`, immediately `location.replace('/login')` before any other module loads.
- On any 401 from `request()`, the wrapper clears `wa_token` and bounces to `/login`.

### Login page

`/login` is its own HTML entrypoint (separate from `/`) for clarity and easier testing:

- `<input type="password">` with `autocomplete="current-password"`, `autocorrect="off"`, `autocapitalize="none"`, `spellcheck="false"`. `type=password` masks natively cross-browser; `spellcheck=false` prevents Chrome's Enhanced Spellcheck from uploading the token to a cloud spellchecker.
- Form submits on Enter or via the Sign in button (mobile: Sign in button is essential since iOS soft keyboards may not fire form-submit on virtual Enter).
- On 200, store token + `location.replace('/')`. On 401, show error in `#error` and stay on `/login`.

## SSE Ticket

`EventSource` cannot set custom headers, so SSE auth uses a short-lived ticket:

1. Client `POST /api/v1/sse-ticket` with `Authorization: Bearer <token>` → server generates a 32-byte random ticket, stores `{ticket, principal, exp: now+60s}` in memory, returns `{ticket}`.
2. Client opens `EventSource('/api/v1/events/stream?ticket=' + ticket)`. Server consumes the ticket (single-use, deleted on first match) and binds the SSE connection to the resolved principal.
3. The 15s heartbeat doubles as a recheck: if the underlying token is revoked (and `auth.json` reloaded via `SIGHUP`), the next heartbeat write fails and the SSE stream closes.

Tickets are in-memory only; restarting the server invalidates all of them. Clients reconnect automatically and re-issue.

## Signed Image URLs

Images uploaded to a session render as `<img src="/api/v1/images/sess/abc/xyz.png?sig=...&exp=...">`. The image route is whitelisted; auth is in the URL itself:

- The server holds a per-restart HMAC secret (random 32 bytes, never persisted).
- When an image event is serialized for history or SSE, the path is signed: `sig = HMAC-SHA256(secret, "<path>|<exp>")` with `exp = now + 1h`.
- The image route verifies signature + expiry before serving.
- Every server restart rotates the secret, invalidating all previously rendered URLs. Clients re-fetch the parent event to get fresh signed URLs.

This trades occasional "broken image" reloads after restart for a hard guarantee: a stolen image URL is useless after at most 1h, and after restart instantly.

## Content Security Policy

Every HTML entrypoint response carries a strict CSP:

```
default-src 'self';
img-src 'self' data: blob:;
script-src 'self';
style-src 'self';
connect-src 'self';
object-src 'none';
frame-ancestors 'none';
base-uri 'self';
form-action 'self'
```

No `unsafe-inline` for scripts. No third-party origins. Notable consequences:

- The early-paint theme bootstrap is in a separate file (`/theme-init.js`) and loaded with `<script src="...">` instead of being inline.
- `marked` and `dompurify` are bundled into `app.[hash].js`. `highlight.js` common (36 languages) is dynamically imported into a separate `chunk.[hash].js`, preloaded via `<link rel="modulepreload">` — still all served from `'self'`, no `cdn.jsdelivr.net` at runtime.
- `frame-ancestors 'none'` prevents any other site from embedding webagent in an `<iframe>`.

The HTML entrypoint set is the **single source of truth** in `src/routes.ts`:

```ts
export const HTML_ENTRYPOINTS = [
  { urlPath: "/", file: "index.html" },
  { urlPath: "/login", file: "login.html" },
] as const;
```

Three invariant tests guard CSP correctness so future changes don't regress silently:

| Test                            | Asserts                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `test/csp.test.ts`              | Every HTML entrypoint response includes `Content-Security-Policy` matching the documented policy    |
| `test/html-entrypoints.test.ts` | Every HTML file under `public/` is registered in `HTML_ENTRYPOINTS` (no orphan HTML pages)          |
| `test/inline-assets.test.ts`    | No `<script>...</script>` or `<style>...</style>` blocks with inline content in any HTML entrypoint |

## Operations

### Multi-device

Create one token per device:

```sh
webagent --create-token macbook
webagent --create-token phone
webagent --create-token cli-laptop
```

Or after the first admin token, use the `/token` slash command (or `POST /api/v1/tokens`) from an authenticated session — those default to `api` scope.

### Revocation

`/token` slash command lists tokens (with last-used timestamps) and supports revoke. Or `DELETE /api/v1/tokens/:name` directly. Both routes require `admin` scope.

The CLI does **not** currently expose `--list-tokens` or `--revoke-token`; use the running daemon's API. (If the daemon is offline you can edit `auth.json` directly — it's just JSON — and `SIGHUP` the process when it comes back.)

### Hot reload

`SIGHUP` reloads `auth.json` from disk. Use this after editing the file by hand, or after CLI mutations on a system where another process has the file:

```sh
kill -HUP $(pgrep -f "webagent.*--config")
```

Existing SSE connections are NOT dropped. Tokens that were revoked are kicked at the next 15s heartbeat (when the in-memory cache rechecks).

### Rotation

There is no built-in expiry. Tokens live until revoked. To rotate:

1. Create a new token.
2. Update the device's `localStorage` (or paste into `/login` again — the new token replaces the old).
3. Revoke the old token.

### Audit

`lastUsedAt` (visible in `/token` and `GET /api/v1/tokens`) is the only built-in usage signal. There is no per-request audit log. Rely on reverse-proxy access logs if you need request-level tracking.

## Data Directory

```
data/
├── auth.json          # tokens (0600, JSON, hashed) — see "Token Storage"
├── webagent.db        # sessions, events, messages — SQLite
├── webagent.db-shm    # SQLite shared-memory (transient)
├── webagent.db-wal    # SQLite write-ahead log (transient)
├── vapid.json         # VAPID keypair for Web Push (regenerated if deleted)
└── images/
    └── sess/<sessionId>/<eventId>.<ext>   # uploaded images, no per-image metadata
```

- All paths are inside `data_dir` (defaults to `./data`). The dev config uses `./data-dev`. The E2E suite uses `./test/e2e-data`.
- `auth.json` is the only file with mode `0600`. The SQLite files inherit umask defaults — that is intentional: SQLite holds session content, not credentials, and tightening the mode breaks `litecli`-style introspection. If your OS user is shared, restrict the parent directory instead.
- **Backup**: `auth.json` + `webagent.db` are sufficient. The WAL/SHM are transient. Image files in `images/` are referenced by events but the app degrades gracefully (renders broken-image placeholder) if they're missing.
- **Reset**: `rm -rf data/` and start over. The server will refuse to serve until you `--create-token` again.

## E2E Test Setup

`test/e2e/seed.ts` runs at Playwright config-load time. It:

1. Wipes `test/e2e-data/`.
2. Generates one admin-scope token via `AuthStore.addToken("e2e", "admin")`.
3. Writes `auth.json` (server-side), `storage-state.json` (Playwright loads into every page's `localStorage` for origin `127.0.0.1:6802`), and `.token` (raw value for specs that need it).

The seed is idempotent — workers reload the config but skip seeding if `.token` exists. The npm `test:e2e` script wipes the dir once before invoking Playwright.

`playwright.config.ts` sets `extraHTTPHeaders: { Authorization: 'Bearer <token>' }` so direct `page.request.*` API calls are pre-authenticated. Specs that test rejection paths (e.g. `login-bad-token.spec.ts`) opt out via `test.use({ extraHTTPHeaders: {} })`.

## Production Bundle Invariant

No literal token must ever be shipped in `dist/`. Verify with:

```sh
grep -E 'wat_[A-Za-z0-9_-]{30,}' dist/    # must produce no matches
```

The string `wat_` alone is fine — it appears as the placeholder text in `login.html` (`placeholder="wat_..."`). Only actual token-shaped strings (30+ chars after the prefix) are forbidden.

## What's NOT Protected

These are explicit non-goals — single-user self-hosting trades them away for simplicity:

- **No per-request audit log.** No "who ran this prompt at what time" trail.
- **No agent sandbox.** Anything you can do in a terminal, the agent can do via permission requests. `autopilot` mode auto-approves everything; only enable it when you trust the prompt source.
- **No CSRF token on state-changing requests.** `Authorization: Bearer` is set explicitly by the frontend; cross-origin requests cannot read or send it back. With strict CSP `frame-ancestors 'none'` we don't allow embedding either.
- **No rate limiting.** A leaked token grants the same throughput as a legitimate one. Rotate immediately if you suspect leakage.
- **No multi-user RBAC.** `admin` vs `api` is the entire authorization surface; both can read all sessions and run all commands.

If you need any of the above, terminate webagent at a reverse proxy that adds them. The Bearer model is compatible with proxy-injected `Authorization` headers.
