# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

### Added — Share links (default off)

Public read-only session snapshots via `/share` + `/s/<token>`. **Off by
default** (`[share] enabled = false`); flip to `true` to expose the routes.
See [`docs/share.md`](docs/share.md) for the full surface.

- **Owner CLI** — `/share` lists active shares (Enter creates a preview);
  `/share by <name>` sets a default `display_name` for new shares;
  `/share <token>` opens a share's viewer in a new tab; `/share revoke
  <token>` hard-deletes a published share.
- **Preview mode** — creating a preview puts the input area in preview
  mode with `^P` (publish) and `^C` (cancel) buttons; the textarea is
  disabled so the next interaction is intentional.
- **Public viewer** — `/s/<token>` is a separate HTML entry (`viewer.[hash].js`)
  with strict CSP (`default-src 'self'`, no inline scripts, no third-party
  origins). Frame-ancestors deny, `noindex, nofollow`, and `Referrer-Policy:
  no-referrer`. Tokens are 144-bit `randomBytes(18)` base64url; knowledge of
  the token is the entire capability.
- **Multi-layer sanitizer** — secrets (API keys, private keys, OAuth tokens)
  hard-reject the share with HTTP 400 + `event_id`/`rule`. Paths outside
  cwd, `/Users/...` / `/home/...` prefixes, and `share.internal_hosts`
  hostnames are soft-redacted. Sanitized output is cached by `session_id +
  snapshot_seq + SANITIZER_VERSION` (LRU 100); bumping the version
  invalidates everything.
- **Image proxy** — `/s/<token>/images/<file>` enforces filename
  `[A-Za-z0-9._-]+` and a chroot check to `<data_dir>/images/<session_id>/`.
  Viewer rewrites image URLs in `user_message.path` automatically.
- **Preview GC** — when `enabled=true`, a 24h interval deletes preview
  rows (`shared_at IS NULL AND created_at < now - 24h`). Activated rows
  are never swept; `/share revoke` is the only way to remove them.
- **Config** — new `[share]` section: `enabled`, `ttl_hours` (cap 168),
  `csp_enforce`, `viewer_origin`, `internal_hosts`. Detail in
  [`docs/configuration.md`](docs/configuration.md).
- **Build invariant** — chunk prune in `scripts/build.js` is now
  reachability-aware **and transitive** (BFS over chunk → chunk imports),
  so lazy `import()` chunks reachable only via shared chunks (e.g. hljs
  via `highlight.ts`) are never deleted during deploy. Regression test:
  `test/build-split.test.ts`.

### ⚠️ BREAKING — 0.4.0

**Bearer token auth is now required.** webagent will refuse to start without
at least one token in `data/auth.json`. Existing installs upgrading from
0.3.x must seed a token before the next start:

```sh
webagent --create-token <name>
# prints the raw token ONCE — paste it into the new login page
```

Notes:

- All `/api/**` endpoints (except `/api/v1/version` and `/api/beta/push/vapid-key`) require `Authorization: Bearer <token>`.
- Browsers store the token in `localStorage` under `wa_token`.
- SSE streams use a short-lived ticket (`POST /api/v1/sse-ticket`) instead of carrying the bearer.
- Image URLs are HMAC-signed with a 1h expiry. The HMAC secret regenerates on every server restart, invalidating any previously rendered URLs.
- Strict CSP (`default-src 'self'`, no `unsafe-inline` for scripts) is now applied to every HTML response. `highlight.js` is vendored (12 common languages) so no third-party origin is needed at runtime.
- Multi-token CRUD is exposed via `GET/POST /api/v1/tokens` and `DELETE /api/v1/tokens/:name` (admin scope only). The `/token` slash command provides a UI.
- `SIGHUP` reloads `auth.json` without dropping live sessions.

### Changed

- Frontend assets are now fully self-hosted: `marked` and `dompurify` are bundled into `dist/js/app.[hash].js` via esbuild instead of loaded from `cdn.jsdelivr.net`. Enables offline PWA, removes third-party SRI risk, and lets CSP drop `script-src https://cdn.jsdelivr.net`.
- Production builds keep the 2 newest hashed bundles (`app.*.js` / `styles.*.css`) in `dist/` so in-flight page loads during an upgrade can still fetch their pinned version.
- Static file handler in `routes.ts` now sets `Cache-Control`:
  - Hashed assets (`*.[8+ hex].{js,css}`): `public, max-age=31536000, immutable`
  - `index.html`, `manifest.json`, `sw.js`, icons, favicon: `no-cache` (revalidate every request)

## [0.3.0] - 2026-04-15

### Added

- Recent paths for `/new` menu — tracks session working directories with LRU cleanup. New config options: `limits.recent_paths` (max shown, default 10) and `limits.recent_paths_ttl` (days before auto-cleanup, default 30)
- `GET /api/v1/recent-paths` endpoint — returns recent working directories, supports `?limit=N`
- `/help` slash command (also shown as `?` shortcut hint)
- HH:MM:SS timestamps in server console output; daemon truncates logs on start

### Fixed

- `/exit` sometimes created a new session instead of switching to an existing one — URL hash still pointed to the deleted session during async load, causing SSE reconnects to 404 and fall back to session creation

### Changed

- TOC coverage guard for `docs/api.md`

## [0.2.6] - 2026-04-03

### Added

- Code block syntax highlighting with copy button
- `/reload` command to restart agent subprocess without server restart
- Dual `theme-color` meta tags for automatic light/dark status bar

### Fixed

- Bridge connected event swallowed by SSE handshake guard
- Shutdown race condition and silent session cleanup during restart
- Streamed code block enhancement rendering
- Unified `permission_resolved` into `permission_response` for consistency
- Preserve session cwd across `/new` and `session_expired`

### Changed

- Moved one-shot prompt endpoint from `/api/v1/` to `/api/beta/`

## [0.2.5] - 2026-03-15

No functional changes (version bump only).

## [0.2.4] - 2026-03-15

### Fixed

- Hide console window for daemon process on Windows

## [0.2.3] - 2026-03-15

### Fixed

- Flaky `/prune` command: await all deletes before reporting success

## [0.2.2] - 2026-03-15

### Fixed

- npm publish missing `compile` step in `prepublishOnly`

## [0.2.1] - 2026-03-15

### Fixed

- Merge consecutive assistant/thinking events during replay to eliminate duplicates

### Changed

- Moved screenshot capture script to `scripts/`, excluded from E2E suite

## [0.2.0] - 2026-03-15

### Added

- Image lightbox: click chat images to view full-size with zoom
- `GET /api/v1/version` endpoint, shown in `/help` output
- Full content display for new files in diff view
- Playwright screenshot capture script
- `task_complete` summary shown directly instead of collapsed

### Changed

- Cancel shortcut changed from `Ctrl+X` to smart `Ctrl+C` (respects text selection)
- Removed new-session button from input area
- Push and visibility APIs moved to `/api/beta/`
- Restructured README into concise overview with separate docs

### Fixed

- Global session visibility suppression: if any client views a session, push is suppressed for all endpoints/devices
- Strip base64 image data from stored `user_message` events (reduce DB bloat)
- Restore input placeholder after session load
- Skip auto-title when user has manually set a session title

## [0.1.10] - 2026-03-14

### Changed

- Simplified build pipeline: deduplicated test/build across CI and publish workflows
- Added `tsc` type check to `npm test` script
- Removed deprecated positional overload of `createRequestHandler`

## [0.1.9] - 2026-03-14

### Fixed

- Strict `tsc` errors in `bridge.ts` and `routes.ts`

## [0.1.8] - 2026-03-14

This is a major infrastructure release: WebSocket transport replaced with SSE, REST API migrated to `/api/v1/`, and significant multi-client improvements.

### Added

- `/rename` slash command for session title renaming
- `/exit` command replacing `/delete` (close current session in one step)
- Cursor-based pagination for events API
- Per-session push visibility filtering
- Auto-retry interrupted agent turns after server restart
- Sync missed events on iOS PWA foreground return
- Show auto-approved permissions in autopilot mode
- Auto-remove push subscriptions after 5 consecutive failures
- Status bar below input area showing mode, model, and cwd

### Changed

- **Breaking**: Removed WebSocket transport layer, replaced with SSE + REST
- Migrated all API endpoints to `/api/v1/` namespace
- Removed legacy `/data/images/` route
- Renamed `after_seq` param to `after` for consistency
- Dropped `.rest.` suffix from test filenames
- Refactored push notification title to use session title directly
- Performance: Map index during replay instead of `querySelector` on `DocumentFragment`
- Performance: Deferred `scrollToBottom` via `rAF` to avoid synchronous layout reflow

### Fixed

- Cross-client message ordering and stuck busy state after cancel
- Ghost session accumulation on server restart
- Auto-resume for no-hash opens, notify menu highlight
- Cancel timeout bypassed by agent streaming events after cancel
- Decouple ACP resume from GET so session switch never blocks
- Suppress SSE echo of own `bash_command` to prevent duplicate blocks
- Notification click navigating to wrong session
- Prevent duplicate thinking blocks on reconnect during active streaming
- Drop session-specific events during mid-switch null window
- Notification-click race: stale `initSession` overriding session switch
- Fix `charset=utf-8` on text MIME types
- Fix v1 image URLs instead of legacy `/data/` paths
- Guard against empty sessionId in visibility endpoint
- Empty session cleanup: use time-based threshold instead of `liveSessions` exclusion

### Removed

- `/delete` command (replaced by `/exit`)
- `/sessions` command (merged into unified session menu)

## [0.1.7] - 2026-03-11

### Added

- Status bar below input area showing mode, model, and cwd

### Fixed

- Cross-client message ordering and stuck busy state after cancel

## [0.1.6] - 2026-03-10

### Changed

- CI publish workflow gates on test suite via reusable workflow

## [0.1.5] - 2026-03-10

### Added

- **Push notifications** (Phases 1–5): VAPID infrastructure, REST API, service worker, visibility tracking, frontend `/notify` command
- Daemon commands: `start`, `stop`, `status`, `restart` with supervisor
- Major unit/integration test coverage expansion
- iOS safe-area support for PWA input area

### Changed

- Unified slash menu key behavior: Tab fills, Enter sends, Click does both
- Updated README with missing modules and stale content fixes

### Fixed

- iOS keyboard not appearing due to programmatic auto-focus
- Push notification click navigation
- VAPID subject rejection by Apple Push for localhost domains
- Permission revert on reconnect with dedup + retry for unconfirmed permissions
- Message loss when connection is disconnected
- `/notify` status now checks actual push subscription, not just permission

## [0.1.4] - 2026-03-09

### Fixed

- E2E tests broken by new-button behavior change
- Flaky permission-deny test and `cancelPendingTurnUI` race condition

## [0.1.3] - 2026-03-09

### Added

- Windows shell support for bash execution
- List of ACP-compatible agents in README

### Fixed

- Windows signal compatibility
- CI skips tag pushes (only runs on code changes)

## [0.1.2] - 2026-03-09

### Changed

- Enabled TypeScript strict mode with `noEmitOnError`
- Fixed all type errors uncovered by strict mode

## [0.1.1] - 2026-03-09

### Changed

- Compiled TypeScript to JavaScript for npm distribution (fixes `node_modules` type-stripping errors)
- Added CI and npm badges to README

### Fixed

- E2E removed from CI (requires agent backend, not available in CI)

## [0.1.0] - 2026-03-09

Initial release of WebAgent — a terminal-style web UI for ACP-compatible agents.

### Features

- **Chat interface**: Terminal-aesthetic monospace UI with dark/light/auto themes
- **ACP integration**: Full session lifecycle (create, load, prompt, cancel) with event streaming
- **Tool call rendering**: Collapsible tool call details with diff view
- **Image support**: Upload via attach button or paste, stored on filesystem, forwarded through ACP
- **Bash execution**: `!command` syntax for direct shell execution from chat
- **Session management**: SQLite persistence, LLM-generated titles, session restore on reconnect
- **Slash commands**: `/new`, `/switch`, `/delete`, `/prune`, `/model`, `/mode`, `/think`, `/pwd`, `/help` with autocomplete and keyboard navigation
- **Model selection**: Per-session model persistence, picker menu with fuzzy search, model inheritance for new sessions
- **Autopilot mode**: Auto-approve permissions with mode cycling via `Ctrl+M` or prompt tap
- **Multi-client support**: Event broadcast across all connected clients, permission sync, session state coordination
- **PWA**: Manifest, service worker, installable to home screen with iOS icon support
- **Keyboard shortcuts**: `Ctrl+C` (cancel), `Ctrl+U` (upload), `Ctrl+M` (mode cycle), `Tab` (autocomplete fill)
- **Smart scroll**: Force-to-bottom on load/switch/send, soft follow during streaming
- **Incremental reconnect**: Skip DOM wipe on same-session reconnect
- **Modular architecture**: Server split into focused modules (server, routes, event-handler, session-manager, bridge, store, title-service)
- **Build pipeline**: esbuild bundling with content-hashed filenames for cache busting
- **TOML configuration**: Configurable port, data directory, agent command, limits
- **CI/CD**: GitHub Actions for CI (unit + E2E tests) and npm publishing on tag push
- **npm package**: Published as `@lelouchhe/webagent`

[0.3.0]: https://github.com/LelouchHe/webagent/compare/v0.2.6...v0.3.0
[0.2.6]: https://github.com/LelouchHe/webagent/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/LelouchHe/webagent/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/LelouchHe/webagent/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/LelouchHe/webagent/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/LelouchHe/webagent/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/LelouchHe/webagent/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/LelouchHe/webagent/compare/v0.1.10...v0.2.0
[0.1.10]: https://github.com/LelouchHe/webagent/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/LelouchHe/webagent/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/LelouchHe/webagent/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/LelouchHe/webagent/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/LelouchHe/webagent/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/LelouchHe/webagent/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/LelouchHe/webagent/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/LelouchHe/webagent/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/LelouchHe/webagent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LelouchHe/webagent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/LelouchHe/webagent/releases/tag/v0.1.0
