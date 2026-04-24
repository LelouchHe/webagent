# Share Links

WebAgent can expose a **read-only, sanitized snapshot** of a session at a
public URL so you can send a conversation to a reviewer, teammate, or
public audience without giving them any access to the live session.

## Quick start

```
/share                       # create a preview (owner-only)
/share publish               # freeze + publish → public URL
/share list                  # enumerate your live shares
/share revoke <token>        # kill a link
/share label <token> <text>  # rename (private owner label)
```

The workflow has two explicit gates:

1. **Preview.** `/share` produces a *preview* that only the owner can
   fetch. It runs the sanitizer eagerly and reports staleness.
2. **Publish.** `/share publish` freezes the snapshot (`shared_at` is
   set) and returns the public `/s/<token>` URL. Publishing is a
   separate, conscious step so you can inspect the preview first.

A published share is a **frozen snapshot**: new session events after
`shared_at` are not visible to viewers. To refresh, create a new share.

## What viewers see (and don't)

| | Preview (owner) | Public viewer |
|-|-|-|
| URL | — (token in header) | `/s/<token>` |
| Session ID | yes | **no (never exposed)** |
| Events up to snapshot | ✅ | ✅ (re-sanitized per request) |
| Events after snapshot | flagged as stale | hidden |
| Live updates | — | — |
| Fork into new session | — | deferred to v2 |

Viewers see only: session title (if any), `display_name` set at publish,
`shared_at`, and the sanitized event stream. No `session_id`, cwd, file
paths, or tool metadata leaks through the sanitizer.

## Sanitizer

Every published event pass through a multi-layer sanitizer before it
reaches a viewer:

- **Layer 1a (hard reject):** if any event contains a detected secret
  (API key, private key, OAuth token, etc.) the share is **refused**
  with HTTP 400 and an `event_id` + `rule` for debugging. The owner
  sees this on `/share`; no public link is ever generated.
- **Layer 1c (soft redact):** paths outside the project cwd, absolute
  `/Users/...` / `/home/...` prefixes, and internal hostnames are
  replaced with placeholders.
- **Projection cache:** sanitized output is keyed by
  `session_id + snapshot_seq + SANITIZER_VERSION` and cached in a
  LRU(100). Bumping the sanitizer version invalidates everything.

The sanitizer re-runs on **every** public fetch (cache-backed), so a
post-publish rule update is picked up without any migration.

## Security model

- **CSP-strict:** the viewer page (`/s/<token>`) sets
  `default-src 'self'; script-src 'self'; ...`. No inline scripts, no
  CDNs, no remote fetches. The viewer bundle ships `marked` and
  `DOMPurify` as self-hosted ESM.
- **Token is the capability.** 144-bit random (`randomBytes(18)`,
  base64url). There is no per-viewer identity; knowledge of the token
  is sufficient. Treat the URL like a password.
- **Frame-ancestors deny:** the viewer cannot be embedded.
- **Referrer-Policy no-referrer**, **X-Robots-Tag noindex, nofollow**.
- **No session_id in public JSON.** The public events endpoint
  (`/api/v1/shared/<token>/events`) strips session_id from its
  response. Viewers have no way to find the original session.
- **Image proxy:** images are served from
  `/s/<token>/images/<file>`. Filenames are validated against
  `[A-Za-z0-9._-]+` and the final path must stay under
  `<data_dir>/images/<session_id>/`.
- **Revoke is immediate:** `DELETE /api/v1/sessions/<id>/share` flips
  `revoked_at`; subsequent viewer hits get HTTP 410. Image proxy and
  JSON endpoint both enforce the same check.
- **Owner label validation:** `owner_label` and `display_name` reject
  control characters (except `\t`), DEL, unpaired surrogates, and bidi
  override codepoints (`U+202A..U+202E`, `U+2066..U+2069`). UTF-8
  byte-length capped at 1024 / 256.

## Configuration

`config.toml`:

```toml
[share]
enabled = false                # set true to expose /share + /s routes
ttl_hours = 0                  # 0 = no auto-expiry; >0 = hours, capped at 168
csp_enforce = true             # false switches to Content-Security-Policy-Report-Only
viewer_origin = ""             # override base URL in public_url response (e.g. https://share.example.com)
internal_hosts = []             # sanitizer will scrub these hostnames
```

## HTTP surface

| Route | Auth | Purpose |
|-|-|-|
| `POST /api/v1/sessions/:id/share` | owner | Create (or reuse) preview |
| `GET  /api/v1/sessions/:id/share/preview` | owner + X-Share-Token | Read preview events |
| `POST /api/v1/sessions/:id/share/publish` | owner | Activate |
| `DELETE /api/v1/sessions/:id/share` | owner | Revoke (idempotent) |
| `PATCH /api/v1/sessions/:id/share` | owner | Update owner_label / display_name |
| `GET  /api/v1/shares` | owner | List live shares |
| `GET  /s/:token` | public | Viewer HTML (strict CSP) |
| `GET  /s/:token/images/:file` | public | Image proxy |
| `GET  /api/v1/shared/:token/events` | public | Viewer JSON |

All owner routes go through `assertOwner()` which requires either
`Sec-Fetch-Site: same-origin` OR an Origin/Host match. All tokens in
owner reads use the `X-Share-Token` header; tokens never appear in
owner-side URLs.

## Known limitations (v1)

- **No inline fork:** viewers cannot "continue this conversation". The
  viewer footer is static — fork needs `unstable_forkSession` support
  and is deferred.
- **No background image purge:** revoke blocks access at the route
  edge; images remain on disk until a future GC pass.
- **No CSP violation reporting endpoint yet:** `csp_enforce=false`
  logs to `Content-Security-Policy-Report-Only` but we don't ingest
  reports. The browser console shows violations for development.
- **No rate limiting:** unauth public fetches are served directly from
  the projection cache. Put a reverse proxy rate-limit in front of
  `/s/*` + `/api/v1/shared/*` for production exposure.
