# WebAgent

A terminal-style web UI for ACP-compatible agents.

Tech stack: Node.js + TypeScript (`--experimental-strip-types`), REST + SSE real-time communication, SQLite persistence (`better-sqlite3`), Zod validation, esbuild (frontend bundling).

Core modules:

- `server.ts` — HTTP server bootstrap
- `routes.ts` — HTTP request handlers (static files, REST API, image upload)
- `event-handler.ts` — ACP event routing + SSE broadcast
- `session-manager.ts` — Session state (live sessions, buffers, bash procs, model cache)
- `bridge.ts` — ACP bridge, manages agent subprocess
- `store.ts` — SQLite persistence (sessions + events tables)
- `title-service.ts` — Async session title generation (dedicated Haiku session)
- `push-service.ts` — Web Push notifications (VAPID keys, subscriptions, visibility-gated delivery)
- `daemon.ts` — Background service management (start/stop/status/restart) with supervisor
- `types.ts` — Shared types + Zod schemas for WS messages
- `public/js/constants.ts` — Display constants (tool icons, plan status icons)
- `public/js/event-interpreter.ts` — Pure ACP event data transformation (zero DOM dependency)
- `public/index.html` — HTML shell (imports CSS + bundled JS)
- `public/styles.css` — all CSS
- `public/js/` — frontend TypeScript source (state, render, events, commands, images, input, connection, app), bundled via esbuild

The default runtime configuration uses port 6800.

## Build and Run

Use the normal app commands:

```bash
npm run build         # rebuild assets only (no restart needed for frontend-only changes)
npm start             # run with config.toml
```

For frontend-only changes (CSS/TS/HTML), `npm run build` is sufficient — the server reads files on each request, and content-hashed filenames bust Cloudflare/browser cache. If backend (src/) changes are involved, restart the process using whatever service manager or workflow the environment already uses.

## Development

```bash
npm run dev           # dev server on port 6801, uses config.dev.toml
```

## Configuration

Configuration is via TOML files, passed with `--config`:

```bash
node --experimental-strip-types src/server.ts --config config.toml
```

If no `--config` is provided, all settings use built-in defaults. See `config.toml` for production settings and `config.dev.toml` for development.

| Key                       | Default            | Description                                                     |
| ------------------------- | ------------------ | --------------------------------------------------------------- |
| `port`                    | `6800`             | HTTP server port                                                |
| `data_dir`                | `data`             | SQLite + uploads directory                                      |
| `default_cwd`             | `process.cwd()`    | Working directory for new sessions                              |
| `public_dir`              | `dist`             | Static assets directory                                         |
| `agent_cmd`               | `copilot --acp`    | ACP agent command (binary + args, space-separated)              |
| `limits.bash_output`      | `1048576` (1 MB)   | Max bash output stored in DB per command                        |
| `limits.image_upload`     | `10485760` (10 MB) | Max image upload size                                           |
| `limits.cancel_timeout`   | `10000` (10s)      | Cancel timeout in ms; 0 disables                                |
| `limits.recent_paths`     | `10`               | Max recent paths shown in `/new` menu; 0 = show all             |
| `limits.recent_paths_ttl` | `30`               | Days to keep unused paths before auto-cleanup; 0 = keep forever |

To use a different ACP-compatible agent backend:

```toml
agent_cmd = "my-agent --acp"
```

## Architecture Notes

- **Single bridge**: One bridge instance per server, multiple sessions multiplexed over it.
- **Agent reload**: `bridge.restart()` kills and re-spawns the agent subprocess without restarting the server. Cancels active prompts, flushes buffers, cleans up state, invalidates title session. Sessions restore lazily via `ensureResumed()`. Triggered by `/reload` slash command or `POST /api/v1/bridge/reload`. Retries start 3× with exponential backoff.
- **Session restore**: `bridge.loadSession()` restores ACP context after server restart. During restore, `restoringSessions` Set suppresses duplicate event storage/broadcast.
- **On-demand sessions**: No pre-warming. Sessions created on `/new`, auto-resumed on page open.
- **Model inheritance**: A newly created session inherits the current session's saved model when available; restored sessions keep their own persisted model. Mode is NOT inherited — new sessions always start in agent mode.
- **Auto-resume**: Frontend auto-resumes last active session on page open (no hash → fetch `/api/v1/sessions` → resume most recent).
- **Event aggregation**: `message_chunk` / `thought_chunk` are buffered in memory, flushed to DB as full `assistant_message` / `thinking` on boundaries (tool_call, plan, prompt_done).
- **Title generation**: Uses a dedicated silent session with fast model (Haiku), async and non-blocking.
- **Multi-client broadcast**: Events broadcast to all WS clients. Permission responses, user messages, bash output sync across devices. `broadcast()` supports sender exclusion.
- **PWA**: Minimal service worker (no offline cache), manifest.json, installable to home screen.
- **Web Push**: VAPID-based push notifications via `web-push`. Global session-level visibility suppression: if any client is actively viewing a session, push is suppressed for that session across all endpoints/devices. Subscriptions stored in SQLite. Notifiable events: `permission_request`, `prompt_done`, `bash_done`. Note: Web Push is browser-specific; other client types would need their own notification mechanism. These endpoints live under `/api/beta/` to reflect their experimental, browser-specific nature.
  - **Global session visibility**: Each SSE client registers its push endpoint via `/api/beta/push/register-client` on connect and reports its current session via `POST /api/beta/clients/:clientId/visibility` with `{ visible: boolean, sessionId?: string }`. `sendToAll()` checks globally whether **any** client is both visible and viewing the notification's session — if so, push is suppressed for **all** endpoints. This means: laptop viewing session A → phone also won't buzz for session A. But session B completing in the background still pushes to all devices.
  - **Visibility reporting**: The frontend reports visibility on three occasions: (1) SSE connect, (2) `visibilitychange` event, (3) session switch (`session_created` handler). All three include the current `state.sessionId`. A client with no session set does not suppress any push.
  - **Subscription cleanup**: Stale endpoints are auto-removed in two ways: (1) 410 Gone responses are removed immediately; (2) any other error that occurs 5 consecutive times removes the subscription (`MAX_CONSECUTIVE_FAILURES` in `push-service.ts`). A single successful send resets the counter. This prevents expired tokens (e.g. WNS returning 403) from spamming logs indefinitely.
  - **Troubleshooting lost notifications**: If a client stops receiving push notifications, run `/notify off` then `/notify on` to re-subscribe with a fresh endpoint. Old endpoints may have been auto-cleaned after repeated failures.
  - **Activating push on a new device**:
    1. **iOS**: Install PWA to home screen (Add to Home Screen) — Safari tabs don't support Push API.
    2. Open the app and type `/notify on`. The browser will prompt for notification permission — allow it.
    3. If notifications stop working after a server update or VAPID key change, re-install the PWA (delete from home screen, re-add), then `/notify on` again. Simply toggling `/notify off` → `/notify on` may not be enough if the Service Worker cache is stale.
  - **iOS PWA quirks**: Apple's push service (`web.push.apple.com`) rejects VAPID subjects with `localhost` domains (`403 BadJwtToken`) — use a real-looking email like `mailto:noreply@example.com`. When changing `push.vapid_subject`, delete `data/vapid.json` to regenerate keys, then all clients must re-subscribe.

## Auth (0.4.0+)

Bearer token authentication is **required**. Server refuses to start when `data/auth.json` has zero tokens. See [docs/security.md](./docs/security.md) for the full model — bootstrap, token storage, scopes, SSE ticket flow, signed image URLs, CSP invariants, data directory layout, E2E setup, and what's deliberately not protected.

Quick reference for code-level work:

- Whitelist lives in `src/auth-middleware.ts` (`WHITELIST` array). Adding a new public path = appending an entry there.
- HTML entrypoint registry in `src/routes.ts` (`HTML_ENTRYPOINTS`) drives both static-file serving AND CSP injection. Adding a new HTML page means adding to that array; the three guard tests (`test/csp.test.ts`, `test/html-entrypoints.test.ts`, `test/inline-assets.test.ts`) will fail loudly otherwise.
- Frontend token storage key is `wa_token`, exported as `TOKEN_STORAGE_KEY` from `public/js/login-core.ts`. Never hardcode the literal — import the constant.
- Production bundle invariant: `grep -E 'wat_[A-Za-z0-9_-]{30,}' dist/` must return nothing. The literal `wat_` alone is OK (placeholder text in `login.html`).

## ACP Client Extensions

ACP `clientCapabilities` (`fs`, `terminal`) and `mcpServers` are **opt-in capability offers** from client to agent. The agent retains all its native abilities regardless; whether it actually calls the offered capability is per-agent and varies wildly.

**Empirically observed cross-agent behavior** (don't re-research, just trust this table):

| Agent       | Calls `fs/readTextFile` | Calls `fs/writeTextFile` | Calls `terminal/*` |
| ----------- | ----------------------- | ------------------------ | ------------------ |
| Copilot CLI | no (uses native fs)     | no                       | no                 |
| OpenCode    | no                      | yes (edit-confirm only)  | no                 |
| Qwen Code   | yes (DI'd when capability set) | yes               | no                 |
| Claude Code | unverified              | unverified               | unverified         |
| Gemini CLI  | unverified              | unverified               | unverified         |

`fs` / `terminal` are protocol-designed for **editor-style clients** (Zed/VSCode) that have unsaved buffers or integrated terminal panels. WebAgent is a web UI with neither — even if an agent calls our handler, we'd just relay to local disk, identical to the agent calling fs itself.

**Current WebAgent declarations**:
- `clientCapabilities.fs = { readTextFile: false, writeTextFile: false }` — handlers removed (Copilot doesn't call them; if a future agent like Qwen Code needs them, flip flags + re-add handlers).
- `clientCapabilities.terminal = true` — declared but no handler wired. The app's `!<command>` runs via its own local bash bridge, not ACP `terminal/*`. No major agent calls it anyway.
- `mcpServers: []` — client doesn't inject MCP servers. Does **not** disable agent's own MCP config (e.g. GitHub MCP via `~/.copilot/mcp-config.json` still works).

**Extension points**:
- To inject project-specific MCP servers from the client, populate `mcpServers` in `newSession`/`loadSession`.
- To re-add fs handlers (for an agent that uses them), restore the `readTextFile` / `writeTextFile` entries in the `client` object in `bridge.ts` and flip the capability flags.

## ACP Scope and Current Limits

- **Core ACP surface only**: WebAgent currently relies on ACP for session lifecycle (`newSession`, `loadSession`, `prompt`, `cancel`), permission requests, session updates, and model selection.
- **Narrow event mapping**: The UI/store layer only maps a subset of ACP updates today: assistant text, thinking text, tool calls, tool call updates, and plans.
- **Session cancel, not host-task cancel**: ACP `cancel` only stops the current session prompt/turn. In this repo we extend that to the session's own local bash/permission/title work, but WebAgent still cannot cancel host-level tasks started outside the server's runtime (for example external Copilot CLI tool invocations or subprocesses it owns).
- **Browser UI, not full CLI parity**: Direct CLI surfaces such as `/plan`, `/fleet`, `/mcp`, `/agent`, `/skills` are not mirrored as first-class WebAgent controls. The app only renders the ACP events it receives. Autopilot mode is supported via server-side auto-approval of permissions.
- **Silent internal session**: Title generation uses a dedicated silent ACP session and intentionally suppresses normal event emission for that session.
- **Agent-dependent model switching**: Model switching depends on agent support and currently goes through the SDK's unstable session-model API.

- **No context visibility**: ACP does not expose context window usage, token counts, or remaining capacity. The agent's context state is a black box — no way to query how full the context is.
- **No compact/clear**: ACP has no method to compact, summarize, or clear session context. The only way to reset context is to create a new session. `unstable_forkSession` exists but is experimental.

Keep this distinction clear in docs and code discussions: some missing capabilities are ACP/product-specific, but several current gaps are implementation choices in this repo rather than hard protocol limits.

## Frontend Conventions

- **esbuild bundling** — Frontend source is TypeScript in `public/js/*.ts`. `scripts/build.js` bundles via esbuild with `splitting: true`, emitting `dist/js/app.[hash].js` + `chunk.[hash].js` (shared deps, including hljs which is dynamically imported). CSS is content-hashed. Dev mode (`--dev`) outputs to `dist-dev/` without minification on the entry but still produces hashed chunks (esbuild requires unique chunk names); `--watch` adds live rebuild. `marked` + `dompurify` are installed as npm deps and bundled into the app — no CDN scripts in `index.html`. Prod builds retain the 2 newest hashed `app.*.js` / `login.*.js` / `styles.*.css` in `dist/` so in-flight page loads during an upgrade can still fetch their pinned version. **Chunk prune is reachability-aware**: any `chunk.*.js` referenced by a retained app/login bundle is kept regardless of mtime — never delete chunks by mtime alone or in-flight tabs will 404 on lazy import. The build also injects `<link rel="modulepreload" href="/js/chunk.*.js">` into `index.html` for every chunk the app statically imports, so the browser fetches them in parallel with `app.js` (lazy `import()` of hljs hits the preload cache for near-zero perceived delay).
- **Cache-Control** — `routes.ts` static file handler serves hashed assets (`*.[8+ hex].{js,css}`) with `Cache-Control: public, max-age=31536000, immutable`; everything else (`index.html`, `manifest.json`, `sw.js`, icons, favicon) with `Cache-Control: no-cache` (revalidate every request).
- **Module structure** — `public/js/state.ts` (shared state + DOM refs), `render.ts` (UI helpers + theme), `events.ts` (WS event dispatch + history), `commands.ts` (slash commands + autocomplete), `images.ts` (attach/paste), `input.ts` (send/keyboard), `connection.ts` (WS lifecycle), `app.ts` (boot entry).
- **Shared code** — Frontend imports types (`AgentEvent`, `ConfigOption`) from `src/types.ts`. Display constants (`TOOL_ICONS`, `PLAN_STATUS_ICONS`) live in `public/js/constants.ts` alongside other frontend modules. esbuild resolves cross-directory type imports at bundle time.
- **Terminal aesthetic** — monospace fonts, `^C` / `^U` style button labels, `*` git-branch-style session markers.
- **Keyboard shortcuts** — `Ctrl+C` cancel (smart: native copy when text selected), `Ctrl+U` upload. Enter always sends input (never cancels, never selects menu item). Tab fills menu selection into input without executing. Click/tap on menu item = fill + send.
- **Theme** — dark/light/auto, persisted to localStorage.
- **Escape key** — `inputEl` keydown listener cannot reliably capture Escape (browser default behavior / IME may consume it first). Use `document.addEventListener('keydown', ...)` instead for Escape handling.
- **Prefer CSS for animations** — Use CSS `@keyframes` + pseudo-elements for UI animations (spinners, pulses) instead of JS `setInterval`. JS timers cause issues in test environments (JSDOM) by keeping the event loop alive.
- **Autopilot mode** — In autopilot mode, permissions are auto-approved server-side (`allow_once` only, not `allow_always`, to avoid persisting across mode switches). New sessions always start in agent mode (mode is not inherited).
- **Push notifications** — `/notify` slash command with on/off submenu. First `prompt_done` triggers a one-time tip (localStorage-gated). Permission denied state shows manual-settings guidance. Service worker handles push display + notificationclick → session navigation.
  - **iOS banner collapse is unreliable (known platform limitation)**: Same-`tag` pushes are supposed to replace each other in Notification Center, but on iOS 17 PWA they stack as two banners regardless. In dogfood we verified this survives **all** known workarounds combined: (1) matching `showNotification({tag})`, (2) RFC 8030 `Topic` header on the wire (APNs `apns-collapse-id`), (3) SW-side `getNotifications({tag})` + `close()` before every show. Root cause appears to be WebKit/APNs, outside our control. The code keeps all three mechanisms because they are correct and work on Chrome/Firefox/Android/FCM; do **not** re-investigate this for iOS without new evidence (e.g. iOS 18+ behavior change). See comments in `src/push-service.ts` (`tagToTopic`) and `public/sw.js` (`showNotify`).
- **Debug log (inline)** — `public/js/log.ts` exposes `log.debug/info/warn/error` (plus `log.scope('name')`). Frontend code should use `log.*` instead of `console.*` (enforced by ESLint `no-console` scoped to `public/js/**`). Log records render as inline `system-msg` rows in the conversation flow, not a floating panel. Single knob: `level` ∈ `off | debug | info | warn | error`. Set via `config.debug.level` (default `"off"`), `?debug=<level>` URL (page-session override), or `/log <level>` slash command (runtime). When `level != off`, records at/above that level emit to BOTH DevTools console AND the conversation-flow DOM. Logger always forwards to native `console.*` so DevTools preserves call-site line numbers.
- **Scope new CSS to the new class, never widen a shared base.** When polishing one UI element that shares CSS with siblings (e.g. `/inbox` menu items sharing `.slash-item` with `/switch`, `/new`, `/mode`), every new rule must land under a compound selector tied to the new variant (`.slash-item.inbox-item { … }`), not on the shared base. Modifying the shared class to make one element work is silent collateral damage — siblings change too, and the regression is only visible the next time you look at them. Applies to any shared styling system (plain CSS, Tailwind `@apply`, base component classes).
- **iOS Safari / PWA keyboard** — iOS requires `.focus()` to originate from a synchronous user gesture (tap, click, keydown) for the virtual keyboard to appear. Calling `.focus()` from async callbacks (`setTimeout`, Promise `.then()`) puts the textarea into a "focused but no keyboard" state where subsequent taps also fail. The HTML `autofocus` attribute triggers this on page load. **Rule: never call `.focus()` outside a direct user gesture handler; never use `autofocus` on mobile-targeted inputs.**
- **Bottom status bar** — There is a small read-only status bar below `#input-area`. Its purpose is to use the old bottom spacing for useful context, visually separate the input row from the bottom edge/home-indicator area, and show `model · cwd` without adding more buttons. Mode still belongs on the input row itself (`plan` / `autopilot` label + color), not in the status bar.
- **Hiding host text under a `::before` pseudo on iOS WebKit — every "obvious" trick leaks** — When you want a `::before` pseudo (e.g. an animated spinner) to visually replace the host element's text, the natural CSS tricks all have iOS-specific bugs. Documented timeline on the busy-state `#input-prompt` spinner (host text `❯`, pseudo content rotating Braille glyph):
  - `font-size: 0` on host → leaks `❯` at a "minimum readable" size on iOS Safari because WebKit's font-fallback path doesn't strictly honor `font-size: 0` for system-fallback glyphs (`9f4132f`).
  - `color: transparent` on host → also leaks a faint ghost on iOS Safari due to **WebKit bug 194204** (transparent text rendering with antialiasing leaves a sub-pixel shadow). Was tried in `9f4132f` and reverted in `3148046` (whose commit message was about /token but quietly carried the spinner CSS revert; this caused later confusion when CLAUDE.md still recommended the broken approach).
  - `visibility: hidden` on host + `visibility: visible` on pseudo → mostly works but has a **class-toggle frame race**: when `.busy` is added/removed, iOS WebKit composites the host visibility flip and the pseudo `content`/`animation` changes in different frames, so for one frame both `❯` and the spinner glyph render side-by-side. Symptom: brief double-glyph flash on cancel/start.
  - `opacity: 0` on host → same WebKit-194204-class issue, same frame race. Not better.
  - **What actually works: render BOTH states from the pseudo, leave the host text empty.** Move `❯` out of the host's textContent and into a `::before { content: "❯" }` rule; in the busy state, swap the pseudo's `content` to the spinner glyph. Single source of glyph → no host-vs-pseudo race, no host-text-hiding required. Costs: the host's textContent becomes `""` (callers reading `dom.prompt.textContent` need an audit), and per-mode color tweaks must be on the pseudo, not the host.
- **iOS PWA safe area / keyboard overlap** — The bottom home indicator on notch iPhones can overlap fixed/flex bottom bars in standalone PWA mode. In practice, a large `viewport-fit=cover` + `env(safe-area-inset-bottom)` treatment caused worse regressions here (for example the header being pushed into the system status area), so this app currently prefers modest fixed bottom spacing on the status bar instead of full safe-area padding. Also note that on iOS standalone PWAs the bottom status bar may intermittently sit above the keyboard or be hidden behind it depending on whether WebKit updates the visual viewport during focus; treat that as a likely platform/WebKit issue rather than something CSS alone can reliably eliminate (see also WebKit viewport/keyboard bugs such as #292603).

## Testing

```bash
npm run typecheck                          # tsc --noEmit over src/test/public/scripts
npm test                                   # run all tests
npm run test:e2e                          # run Playwright browser E2E
npm run test:e2e -- test/e2e/foo.spec.ts # run a specific Playwright spec via the npm script
```

`typecheck` is gated by both `.husky/pre-push` and CI, so a push that breaks types fails locally before it reaches the remote.

## Publishing

Published to npm as `@lelouchhe/webagent`. CI and release are handled by GitHub Actions:

- **CI** (`.github/workflows/ci.yml`): Runs `format:check`, `lint`, `typecheck`, `build`, `npm test`, and Playwright E2E on every push to `main` and on PRs.
- **Publish** (`.github/workflows/publish.yml`): Triggers on `v*` tag push. Builds `dist/` and publishes to npm with provenance.

Requires `NPM_TOKEN` secret in GitHub repo settings (npmjs.com → Granular Access Token → Read and write on `@lelouchhe/webagent`).

## TODO

- [ ] Add multi-client WS integration tests (e.g. two WS clients: verify `session_created` broadcast doesn't cause unintended session switching; test `awaitingNewSession` guard logic end-to-end)
