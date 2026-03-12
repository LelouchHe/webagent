# WebAgent

A terminal-style web UI for ACP-compatible agents.

Tech stack: Node.js + TypeScript (`--experimental-strip-types`), real-time WebSocket communication (`ws`), SQLite persistence (`better-sqlite3`), Zod validation.

Core modules:
- `server.ts` — HTTP/WebSocket server bootstrap
- `routes.ts` — HTTP request handlers (static files, REST API, image upload)
- `ws-handler.ts` — WebSocket message dispatch + broadcast
- `session-manager.ts` — Session state (live sessions, buffers, bash procs, model cache)
- `bridge.ts` — ACP bridge, manages agent subprocess
- `store.ts` — SQLite persistence (sessions + events tables)
- `title-service.ts` — Async session title generation (dedicated Haiku session)
- `push-service.ts` — Web Push notifications (VAPID keys, subscriptions, visibility-gated delivery)
- `daemon.ts` — Background service management (start/stop/status/restart) with supervisor
- `types.ts` — Shared types + Zod schemas for WS messages
- `public/index.html` — HTML shell (imports CSS + JS modules)
- `public/styles.css` — all CSS
- `public/js/` — frontend ES modules (state, render, events, commands, images, input, connection, app)

The default runtime configuration uses port 6800.

## Build and Run

Use the normal app commands:

```bash
npm run build         # rebuild assets only (no restart needed for frontend-only changes)
npm start             # run with config.toml
```

For frontend-only changes (CSS/JS/HTML), `npm run build` is sufficient — the server reads files on each request, and the new build stamp in filenames busts Cloudflare/browser cache. If backend (src/) changes are involved, restart the process using whatever service manager or workflow the environment already uses.

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

| Key | Default | Description |
|---|---|---|
| `port` | `6800` | HTTP/WebSocket server port |
| `data_dir` | `data` | SQLite + uploads directory |
| `default_cwd` | `process.cwd()` | Working directory for new sessions |
| `public_dir` | `dist` | Static assets directory |
| `agent_cmd` | `copilot --acp` | ACP agent command (binary + args, space-separated) |
| `limits.bash_output` | `1048576` (1 MB) | Max bash output stored in DB per command |
| `limits.image_upload` | `10485760` (10 MB) | Max image upload size |
| `limits.cancel_timeout` | `10000` (10s) | Cancel timeout in ms; 0 disables |

To use a different ACP-compatible agent backend:

```toml
agent_cmd = "my-agent --acp"
```

## Architecture Notes

- **Single bridge**: One bridge instance per server, multiple sessions multiplexed over it.
- **Session restore**: `bridge.loadSession()` restores ACP context after server restart. During restore, `restoringSessions` Set suppresses duplicate event storage/broadcast.
- **On-demand sessions**: No pre-warming. Sessions created on `/new`, auto-resumed on page open.
- **Model inheritance**: A newly created session inherits the current session's saved model when available; restored sessions keep their own persisted model. Mode is NOT inherited — new sessions always start in agent mode.
- **Auto-resume**: Frontend auto-resumes last active session on page open (no hash → fetch `/api/sessions` → resume most recent).
- **Event aggregation**: `message_chunk` / `thought_chunk` are buffered in memory, flushed to DB as full `assistant_message` / `thinking` on boundaries (tool_call, plan, prompt_done).
- **Title generation**: Uses a dedicated silent session with fast model (Haiku), async and non-blocking.
- **Multi-client broadcast**: Events broadcast to all WS clients. Permission responses, user messages, bash output sync across devices. `broadcast()` supports sender exclusion.
- **PWA**: Minimal service worker (no offline cache), manifest.json, installable to home screen.
- **Web Push**: VAPID-based push notifications via `web-push`. Only fires when no WS client is visible (zero clients or all backgrounded). Subscriptions stored in SQLite. Notifiable events: `permission_request`, `prompt_done`, `bash_done`.
  - **Subscription cleanup**: Stale endpoints are auto-removed in two ways: (1) 410 Gone responses are removed immediately; (2) any other error that occurs 5 consecutive times removes the subscription (`MAX_CONSECUTIVE_FAILURES` in `push-service.ts`). A single successful send resets the counter. This prevents expired tokens (e.g. WNS returning 403) from spamming logs indefinitely.
  - **`/notify off`**: Unsubscribes on both sides — calls `pushManager.unsubscribe()` in the browser and DELETEs the endpoint from the DB via `POST /api/push/unsubscribe`. After this, no push will be sent until the user runs `/notify on` again.
  - **Troubleshooting lost notifications**: If a client stops receiving push notifications, run `/notify off` then `/notify on` to re-subscribe with a fresh endpoint. Old endpoints may have been auto-cleaned after repeated failures.
  - **iOS (Safari/PWA)**: Must be installed to home screen (Add to Home Screen) — Safari tabs don't support Push API. Apple's push service (`web.push.apple.com`) rejects `mailto:` VAPID subjects with localhost or invalid-looking domains (`403 BadJwtToken`). Use a real-looking email like `mailto:noreply@example.com`. Changing VAPID subject requires deleting `{data_dir}/vapid.json` to regenerate keys, then all clients must re-subscribe (`/notify off` → `/notify on`).
  - **iOS PWA quirks**: Push only works when installed to home screen (not Safari tabs). Apple's push service (`web.push.apple.com`) rejects VAPID subjects with `localhost` domains (`403 BadJwtToken`) — use a real-looking email like `mailto:noreply@example.com`. When changing `push.vapid_subject`, delete `data/vapid.json` to regenerate keys, then have all clients re-subscribe (`/notify off` → `/notify on`).

## ACP Client Extensions

ACP parameters like `mcpServers`, `terminal`, and `fs` are **client-to-agent capability injections** — the client offers extra capabilities on top of the agent's own baseline. The agent (CLI) retains all its native abilities regardless of what the client provides.

| Parameter | What it means | WebAgent currently provides |
|---|---|---|
| `clientCapabilities.terminal` | "I can act as your terminal" — agent can ask the client to run shell commands | `true` — declared but not wired to ACP `terminal/*`; the app's `!<command>` runs via its own local bash bridge instead |
| `clientCapabilities.fs` | "I can read/write files for you" — agent can ask the client to access the filesystem | `{ readTextFile: true, writeTextFile: true }` — fully implemented |
| `mcpServers` | "Here are additional MCP servers for you to use" — agent connects to these on top of its own configured servers | `[]` — no extra MCP servers from the client; the agent's own MCP config (e.g. GitHub MCP) still works |

Passing `mcpServers: []` does **not** disable MCP — it means the client isn't providing extras. The agent loads its own MCP servers independently. Same pattern as `terminal`: declaring the capability is an offer, not a requirement for the agent to function.

**Future extension point**: To give the agent access to MCP servers it doesn't natively have (e.g. project-specific tools, non-project-directory services), add them to the `mcpServers` array in `config.toml` and forward through `newSession`/`loadSession`.

## ACP Scope and Current Limits

- **Core ACP surface only**: WebAgent currently relies on ACP for session lifecycle (`newSession`, `loadSession`, `prompt`, `cancel`), permission requests, session updates, model selection, and text file read/write.
- **Narrow event mapping**: The UI/store layer only maps a subset of ACP updates today: assistant text, thinking text, tool calls, tool call updates, and plans.
- **Session cancel, not host-task cancel**: ACP `cancel` only stops the current session prompt/turn. In this repo we extend that to the session's own local bash/permission/title work, but WebAgent still cannot cancel host-level tasks started outside the server's runtime (for example external Copilot CLI tool invocations or subprocesses it owns).
- **Browser UI, not full CLI parity**: Direct CLI surfaces such as `/plan`, `/fleet`, `/mcp`, `/agent`, `/skills` are not mirrored as first-class WebAgent controls. The app only renders the ACP events it receives. Autopilot mode is supported via server-side auto-approval of permissions.
- **Silent internal session**: Title generation uses a dedicated silent ACP session and intentionally suppresses normal event emission for that session.
- **Agent-dependent model switching**: Model switching depends on agent support and currently goes through the SDK's unstable session-model API.

- **No context visibility**: ACP does not expose context window usage, token counts, or remaining capacity. The agent's context state is a black box — no way to query how full the context is.
- **No compact/clear**: ACP has no method to compact, summarize, or clear session context. The only way to reset context is to create a new session. `unstable_forkSession` exists but is experimental.

Keep this distinction clear in docs and code discussions: some missing capabilities are ACP/product-specific, but several current gaps are implementation choices in this repo rather than hard protocol limits.

## Frontend Conventions

- **No build step** — ES modules (`<script type="module">`) + external CSS, served directly by Node. No bundler.
- **Build step for production** — `scripts/build.js` copies `public/` → `dist/`, appending a timestamp to JS/CSS filenames and rewriting imports/HTML references. Production serves from `dist/`; dev serves from `public/` directly.
- **Module structure** — `public/js/state.js` (shared state + DOM refs), `render.js` (UI helpers + theme), `events.js` (WS event dispatch + history), `commands.js` (slash commands + autocomplete), `images.js` (attach/paste), `input.js` (send/keyboard), `connection.js` (WS lifecycle), `app.js` (boot entry).
- **Terminal aesthetic** — monospace fonts, `^X` / `^U` style button labels, `*` git-branch-style session markers.
- **Keyboard shortcuts** — `Ctrl+X` cancel, `Ctrl+U` upload. Enter always sends input (never cancels, never selects menu item). Tab fills menu selection into input without executing. Click/tap on menu item = fill + send.
- **Theme** — dark/light/auto, persisted to localStorage.
- **Escape key** — `inputEl` keydown listener cannot reliably capture Escape (browser default behavior / IME may consume it first). Use `document.addEventListener('keydown', ...)` instead for Escape handling.
- **Prefer CSS for animations** — Use CSS `@keyframes` + pseudo-elements for UI animations (spinners, pulses) instead of JS `setInterval`. JS timers cause issues in test environments (JSDOM) by keeping the event loop alive.
- **Autopilot mode** — In autopilot mode, permissions are auto-approved server-side (`allow_once` only, not `allow_always`, to avoid persisting across mode switches). New sessions always start in agent mode (mode is not inherited).
- **Push notifications** — `/notify` slash command with on/off submenu. First `prompt_done` triggers a one-time tip (localStorage-gated). Permission denied state shows manual-settings guidance. Service worker handles push display + notificationclick → session navigation.
- **iOS Safari / PWA keyboard** — iOS requires `.focus()` to originate from a synchronous user gesture (tap, click, keydown) for the virtual keyboard to appear. Calling `.focus()` from async callbacks (WebSocket `onmessage`, `setTimeout`, Promise `.then()`) puts the textarea into a "focused but no keyboard" state where subsequent taps also fail. The HTML `autofocus` attribute triggers this on page load. **Rule: never call `.focus()` outside a direct user gesture handler; never use `autofocus` on mobile-targeted inputs.**
- **Bottom status bar** — There is a small read-only status bar below `#input-area`. Its purpose is to use the old bottom spacing for useful context, visually separate the input row from the bottom edge/home-indicator area, and show `model · cwd` without adding more buttons. Mode still belongs on the input row itself (`plan` / `autopilot` label + color), not in the status bar.
- **iOS PWA safe area / keyboard overlap** — The bottom home indicator on notch iPhones can overlap fixed/flex bottom bars in standalone PWA mode. In practice, a large `viewport-fit=cover` + `env(safe-area-inset-bottom)` treatment caused worse regressions here (for example the header being pushed into the system status area), so this app currently prefers modest fixed bottom spacing on the status bar instead of full safe-area padding. Also note that on iOS standalone PWAs the bottom status bar may intermittently sit above the keyboard or be hidden behind it depending on whether WebKit updates the visual viewport during focus; treat that as a likely platform/WebKit issue rather than something CSS alone can reliably eliminate (see also WebKit viewport/keyboard bugs such as #292603).

## Testing

```bash
npm test                                   # run all tests
npm run test:e2e                          # run Playwright browser E2E
npm run test:e2e -- test/e2e/foo.spec.ts # run a specific Playwright spec via the npm script
```

## Publishing

Published to npm as `@lelouchhe/webagent`. CI and release are handled by GitHub Actions:

- **CI** (`.github/workflows/ci.yml`): Runs `npm test` + Playwright E2E on every push to `main` and on PRs.
- **Publish** (`.github/workflows/publish.yml`): Triggers on `v*` tag push. Builds `dist/` and publishes to npm with provenance.

Release workflow:

```bash
npm version patch      # or minor / major — bumps version, creates commit + tag
git push --follow-tags # pushes commit + tag, triggers publish workflow
```

Requires `NPM_TOKEN` secret in GitHub repo settings (npmjs.com → Granular Access Token → Read and write on `@lelouchhe/webagent`).

## TODO

- [ ] Add multi-client WS integration tests (e.g. two WS clients: verify `session_created` broadcast doesn't cause unintended session switching; test `awaitingNewSession` guard logic end-to-end)
