# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.5.1] - 2026-05-29

### Fixed

- CI E2E tests now use the runner-provided Chrome browser and fail fast if it is missing, avoiding Playwright browser install/extract hangs during release validation.

## [0.5.0] - 2026-05-29

### Added

- **LaTeX math rendering** — render inline and display math with Temml/MathML, lazy-loaded and compatible with the existing CSP.
- **Configurable bind host** — new `host` config option controls the server listen address, defaulting to loopback.
- **Mobile input focus recovery** — detects stale focused inputs on iOS/PWA and recovers from the "focused but keyboard closed" state.
- Backend diagnostics for prompt requests rejected before persistence, to help investigate optimistic messages that disappear after replay.

### Changed

- **Streaming Markdown rendering is now incremental and memoized** — reduces per-chunk re-render cost, coalesces live updates with `requestAnimationFrame`, and adds slow-render diagnostics.
- Static asset handling now serves `.wasm` with the correct MIME type and treats vendored `/lib/**` assets as immutable.
- Plan events are collapsible and expose clearer accessible status labels.
- Frontend log level preference persists locally and can be reset.
- Slash command menus are sorted more consistently.

### Fixed

- JPEG/image attachments now persist dimensions correctly and avoid layout shifts while loading.
- Streamed Markdown edge cases involving display math, fenced code blocks, lists, tables, and reference links.
- Cross-client push notification visibility tracking now uses the shared client registry for more consistent suppression.

## [0.4.0] - 2026-05-07

### ⚠️ BREAKING

- **Bearer token auth is required.** Server refuses to start without a token in `data/auth.json`; first run mints an admin token and prints a clickable login URL. All `/api/**` endpoints require `Authorization: Bearer <token>`. See [`docs/security.md`](docs/security.md).

### Added

- **Zero-config first-run deployment** — `webagent` with no flags Just Works: auto-detects an installed ACP agent in `PATH` (Copilot / Claude Code / Codex / Gemini / OpenCode / Qwen Code), runs preflight (port, writeability, agent reachability), mints the admin token, prints the login URL.
- **Daemon mode** — `webagent start` / `stop` / `status` / `restart` with crash recovery, exponential backoff, and atomic `SIGHUP` reload. PID file lives in `data_dir` so multiple instances coexist from the same shell.
- **Config CLI** — `webagent config init` (copy starter `config.toml`) and `webagent config show` (print effective merged config).
- **Share links** (off by default) — public read-only session snapshots via `/share` + `/s/<token>`, with secret hard-reject + path/host soft-redact sanitizer. See [`docs/share.md`](docs/share.md).
- **Attachments** — drag/paste/upload any file type into the input area; storage under `<data_dir>/sessions/<sid>/attachments/`, real MIME sniffing, 10 MB cap.
- **Inbox** — `/inbox` cross-session message picker for "build done" / "tests failed" style notifications. New `messages` table + REST + push.
- **Cross-agent mode classifier** — mode pill (plan / autopilot / read-only) renders correctly across every ACP agent, not just Copilot CLI.
- **Title generation works on third-party / litellm models** — `[title] model` picks a cheap model from the agent's `availableModels` via substring match (default `["haiku", "flash-lite", "nano", "mini", "flash", "lite"]`); empty array inherits agent default.
- Slash commands: `/clear`, `/logout`, `/token`, `/debug`, `/inbox`, `/share`.
- Inline conversation-flow log records driven by `config.debug.level` / `?debug=<level>` / `/debug`.
- Auto-resume last active session on page open.

### Changed

- **Frontend bundling** — `marked` + `dompurify` + `highlight.js` are bundled via esbuild instead of loaded from CDN. Hashed assets serve `Cache-Control: immutable`; HTML / SW / icons serve `no-cache`.
- Mode pill colors distinguish read-only / plan / agent / autopilot.
- TypeScript strict mode enforced; CI gates on `typecheck` + full-tree lint.
- Node 24 CI baseline (was 22).

### Fixed

- Daemon SIGHUP race that left a zombie child crashing with `EADDRINUSE`.
- Daemon supervisor no longer infinite-restarts on `EX_CONFIG` (78).
- Port preflight now probes `0.0.0.0` (matches `server.listen`).
- Bridge subprocess death surfaced as a user error instead of hanging input.
- Cold-cache `GET /api/v1/sessions/:id` blocks on restore so the frontend doesn't race the bridge.
- Assistant / thinking messages no longer duplicate on SSE reconnect.
- iOS WebKit busy-state double-glyph race on the input chevron.
- Misc: `/switch` untitled-session id, `/inbox` consumed-message switch, `/clear` wrong-session race, attach chip clipping, visibility endpoint bearer, `formatLocalTime` epoch input, `from_ref` orphans on boot.

### Removed

- ACP `fs` client capability handlers (no observed agent uses them).
- `/prune` slash command.

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

[0.5.1]: https://github.com/LelouchHe/webagent/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/LelouchHe/webagent/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/LelouchHe/webagent/compare/v0.3.0...v0.4.0
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
