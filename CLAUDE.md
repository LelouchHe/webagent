# WebAgent

A web UI for any ACP-compatible agent, accessed remotely via the browser.

Tech stack: Node.js + TypeScript (`--experimental-strip-types`), WebSocket (`ws`), SQLite (`better-sqlite3`), Zod validation.

Core modules:
- `server.ts` — HTTP/WebSocket server bootstrap
- `routes.ts` — HTTP request handlers (static files, REST API, image upload)
- `ws-handler.ts` — WebSocket message dispatch + broadcast
- `session-manager.ts` — Session state (live sessions, buffers, bash procs, model cache)
- `bridge.ts` — ACP bridge, manages agent subprocess
- `store.ts` — SQLite persistence (sessions + events tables)
- `title-service.ts` — Async session title generation (dedicated Haiku session)
- `types.ts` — Shared types + Zod schemas for WS messages
- `public/index.html` — HTML shell (imports CSS + JS modules)
- `public/styles.css` — all CSS
- `public/js/` — frontend ES modules (state, render, events, commands, images, input, connection, app)

Production runs as a macOS launchd service (port 6800).

## Service Management

Use npm scripts for prod service control:

```bash
npm run svc:restart   # restart prod (also rebuilds assets)
npm run svc:stop      # stop prod
npm run svc:status    # check status
npm run build         # rebuild assets only (no restart needed for frontend-only changes)
```

For frontend-only changes (CSS/JS/HTML), `npm run build` is sufficient — the server reads files on each request, and the new build stamp in filenames busts Cloudflare/browser cache. Server restart is only needed for backend (src/) changes.

Do NOT use `start.sh` directly.

## Development

```bash
npm run dev           # dev server on port 6801, uses data-dev/
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

## ACP Scope and Current Limits

- **Core ACP surface only**: WebAgent currently relies on ACP for session lifecycle (`newSession`, `loadSession`, `prompt`, `cancel`), permission requests, session updates, model selection, and text file read/write.
- **Narrow event mapping**: The UI/store layer only maps a subset of ACP updates today: assistant text, thinking text, tool calls, tool call updates, and plans.
- **No MCP forwarding**: Sessions are created with `mcpServers: []`, so WebAgent does not currently pass user/editor MCP servers through to the agent.
- **No ACP terminal integration**: Although the bridge advertises terminal capability, the app's `!<command>` path is implemented separately over WebSocket + local `bash`, not ACP `terminal/*`.
- **Browser UI, not full CLI parity**: Direct CLI surfaces such as `/plan`, `/fleet`, `/mcp`, `/agent`, `/skills` are not mirrored as first-class WebAgent controls. The app only renders the ACP events it receives. Autopilot mode is supported via server-side auto-approval of permissions.
- **Silent internal session**: Title generation uses a dedicated silent ACP session and intentionally suppresses normal event emission for that session.
- **Agent-dependent model switching**: Model switching depends on agent support and currently goes through the SDK's unstable session-model API.

Keep this distinction clear in docs and code discussions: some missing capabilities are ACP/product-specific, but several current gaps are implementation choices in this repo rather than hard protocol limits.

## Frontend Conventions

- **No build step** — ES modules (`<script type="module">`) + external CSS, served directly by Node. No bundler.
- **Build step for production** — `scripts/build.js` copies `public/` → `dist/`, appending a timestamp to JS/CSS filenames and rewriting imports/HTML references. Production serves from `dist/`; dev serves from `public/` directly.
- **Module structure** — `public/js/state.js` (shared state + DOM refs), `render.js` (UI helpers + theme), `events.js` (WS event dispatch + history), `commands.js` (slash commands + autocomplete), `images.js` (attach/paste), `input.js` (send/keyboard), `connection.js` (WS lifecycle), `app.js` (boot entry).
- **Terminal aesthetic** — monospace fonts, `^C` / `^U` style button labels, `*` git-branch-style session markers.
- **Keyboard shortcuts** — `Ctrl+C` cancel, `Ctrl+U` upload. Enter only sends (never cancels).
- **Theme** — dark/light/auto, persisted to localStorage.
- **Escape key** — `inputEl` keydown listener cannot reliably capture Escape (browser default behavior / IME may consume it first). Use `document.addEventListener('keydown', ...)` instead for Escape handling.
- **Prefer CSS for animations** — Use CSS `@keyframes` + pseudo-elements for UI animations (spinners, pulses) instead of JS `setInterval`. JS timers cause issues in test environments (JSDOM) by keeping the event loop alive.
- **Autopilot mode** — In autopilot mode, permissions are auto-approved server-side (`allow_once` only, not `allow_always`, to avoid persisting across mode switches). New sessions always start in agent mode (mode is not inherited).

## Git Commit Tips

- Avoid `!` in double-quoted commit messages — bash interprets it as history expansion and the command will hang. Use single quotes instead.
- Don't commit until a feature/fix is fully working and verified. Avoid partial or incremental commits for incomplete changes.

## Testing

```bash
npm test              # run all tests
```

When adding features or fixing bugs, check whether corresponding tests need to be added or updated.

## TODO

- [ ] Add multi-client WS integration tests (e.g. two WS clients: verify `session_created` broadcast doesn't cause unintended session switching; test `awaitingNewSession` guard logic end-to-end)
