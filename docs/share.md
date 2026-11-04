# Share Links

WebAgent can expose a **read-only, sanitized snapshot** of a task at a
public URL so you can send a conversation to a reviewer, teammate, or
public audience without giving them any access to the live task.

## Quick start

```
/share                       # list active shares · Enter creates a new preview
/share <token>               # open viewer for a public token in a new tab
/share by <name>             # set default display_name for new shares (owner-wide, persisted)
/share revoke <token>        # kill a link
```

Inside a preview, the input area enters **preview mode** and exposes two
buttons (and matching shortcuts):

- **`^P` (Ctrl+P)** — publish the preview, freeze the snapshot, print the
  public `/s/<token>` URL.
- **`^C` (Ctrl+C)** — cancel the preview locally. The unused preview row
  is deleted by the next preview-GC sweep; the slash channel is otherwise
  inert in preview mode (free-form text routes to the agent, not to share
  ops).

The workflow has two explicit gates:

1. **Preview.** `/share` produces a *preview* that only the owner can
   fetch. It runs the sanitizer eagerly and reports staleness.
2. **Publish.** `^P` freezes the snapshot (`shared_at` is set) and
   returns the public `/s/<token>` URL. Publishing is a separate,
   conscious step so you can inspect the preview first.

A published share is a **frozen snapshot**: new task events after
`shared_at` are not visible to viewers. To refresh, create a new share.

## What viewers see (and don't)

| | Preview (owner) | Public viewer |
|-|-|-|
| URL | — (token in header) | `/s/<token>` |
| Task ID | yes | **no (never exposed)** |
| Events up to snapshot | ✅ | ✅ (re-sanitized per request) |
| Events after snapshot | flagged as stale | hidden |
| Live updates | — | — |
| Fork into new task | — | deferred to v2 |

Viewers see only: task title (if any), `display_name` set at publish,
`shared_at`, and the sanitized event stream. No `task_id`, cwd, file
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

The sanitizer re-runs on **every** public fetch, so a post-publish
rule update is picked up without any migration. There is no
projection cache: sanitize is a pure O(events) regex sweep, and we
prefer "fresh on every read" over a cache that could mask stale
secret-pattern updates.

## Security model

- **CSP-strict:** the viewer page (`/s/<token>`) sets
  `default-src 'self'; script-src 'self'; ...`. No inline scripts, no
  CDNs, no remote fetches. The viewer bundle ships `marked` and
  `DOMPurify` as self-hosted ESM.
- **Token is the capability.** 144-bit random (`randomBytes(18)` →
  24 base64url chars). There is no per-viewer identity; knowledge
  of the token is sufficient. Treat the URL like a password.
- **Frame-ancestors deny:** the viewer cannot be embedded.
- **Referrer-Policy no-referrer**, **X-Robots-Tag noindex, nofollow**.
- **No task_id in public JSON.** The public events endpoint
  (`/api/v1/shared/<token>/events`) strips task_id from its
  response. Viewers have no way to find the original task.
- **Image proxy:** images are served from
  `/s/<token>/attachments/<file>`. Filenames are validated against
  `[A-Za-z0-9._-]+` and the final path must stay under
  `<data_dir>/tasks/<task_id>/attachments/`.
- **Revoke is immediate and destructive:** `DELETE /api/v1/tasks/<id>/share`
  hard-deletes the row from the `shares` table; subsequent viewer hits
  get HTTP 410. There is no `revoked_at` audit column — revoke is a
  tombstone-free delete by design, to keep the public surface as small
  as possible. Image proxy and JSON endpoint both enforce the same check.
- **Owner-side share writes authorize on the share row, not on an execution
  binding.** The gate is that the task row exists and that the token's row
  belongs to the task in the URL; creating a preview and publishing one
  additionally need that row to be live. A binding says *which agent runs a
  task*; it never says who may manage the task's shares. The case that makes
  the difference concrete is the **tombstone**: deleting a task that still has
  an active share keeps the row, events, and attachments for viewers and
  removes the binding. Because the gate is the row, the owner can still revoke
  those shares — and revoking the **last** one reaps the tombstone: the task
  row, its events, its attachment rows, and `<data_dir>/tasks/<id>/` are
  deleted. A hard-deleted task has no row at all, so it still answers 404;
  widening the gate never resurrects one. Reaping is also the one place where
  the DELETE's idempotency is bounded by the task: replaying the same request
  after its tombstone was reaped answers 404, not 200.
- **Expiry is a read-time verdict, not a delete.** `ttl_hours` is evaluated
  on every fetch; an expired share answers 410 but keeps its row until it is
  revoked. Expiry therefore never makes a share row disappear and can never
  orphan a tombstone.
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
| `POST /api/v1/tasks/:id/share` | owner | Create (or reuse) preview |
| `GET  /api/v1/tasks/:id/share/preview` | owner + X-Share-Token | Read preview events |
| `POST /api/v1/tasks/:id/share/publish` | owner | Activate |
| `DELETE /api/v1/tasks/:id/share` | owner | Revoke (idempotent) |
| `PATCH /api/v1/tasks/:id/share` | owner | Update owner_label / display_name |
| `GET  /api/v1/shares` | owner | List live shares |
| `GET  /s/:token` | public | Viewer HTML (strict CSP) |
| `GET  /s/:token/attachments/:file` | public | Image proxy |
| `GET  /api/v1/shared/:token/events` | public | Viewer JSON |

All owner routes are gated by the global Bearer-token middleware (see
[Security](security.md)). There is no extra `Sec-Fetch-Site` /
Origin check on top — Bearer in `Authorization` is sufficient (it can't
be read cross-origin from `localStorage`, so CSRF can't reach these
routes). All tokens in owner reads use the `X-Share-Token` header;
tokens never appear in owner-side URLs.

## Operational notes

- **Preview GC**: when `[share] enabled = true`, the server arms a
  24-hour sweep on startup that deletes preview rows older than 24h
  which were never activated (`shared_at IS NULL AND created_at <
  now - 24h`). Activated shares (`shared_at IS NOT NULL`) are never
  swept — only an explicit `/share revoke <token>` removes them, and
  revoke is a hard delete with no audit trail. Reaping a tombstone stays on
  the revoke path: the sweep only removes previews, and a tombstone normally
  keeps an activated share. The one exception is a preview whose creation
  raced the delete (it lands after the delete dropped previews): the tombstone
  waits for that row to be swept, then for its token to be revoked. Log lines:
  - `[share] preview gc armed (24h interval)` on bootstrap
  - `[share] preview gc removed=N` whenever the sweep deletes rows
- **Manual prune**: `sqlite3 <data_dir>/wa.db "DELETE FROM shares WHERE
  shared_at IS NULL AND created_at < strftime('%s','now')*1000 - 86400000"`
- **Image GC (manual)**: shared files live under
  `<data_dir>/tasks/<task_id>/attachments/` (the same directory the image
  proxy serves from). Revoking one share does NOT delete them: the route edge
  refuses the token, and the bytes stay until the whole task goes away — a
  hard delete or a tombstone reap removes `tasks/<task_id>/`, including this
  directory. For a live task that keeps other shares, enumerate files not
  referenced by any live share and delete them manually; automated per-share
  image purge is a future hardening pass.

## Known limitations (v1)

- **No inline fork:** viewers cannot "continue this conversation". The
  viewer footer is static — fork needs `unstable_forkTask` support
  and is deferred.
- **No per-share image purge:** revoking one share blocks access at the
  route edge but leaves the task's attachments on disk (they belong to the
  whole task and to its other shares). They are removed with the task's
  directory on a hard delete or a tombstone reap, not per share.
- **No CSP violation reporting endpoint yet:** `csp_enforce=false`
  logs to `Content-Security-Policy-Report-Only` but we don't ingest
  reports. The browser console shows violations for development.
- **No rate limiting:** unauth public fetches re-sanitize on every
  request. Put a reverse proxy rate-limit in front of
  `/s/*` + `/api/v1/shared/*` for production exposure.
