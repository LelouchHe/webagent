# WebAgent

A web UI for any ACP-compatible agent, accessed remotely via the browser.

Tech stack: Node.js + TypeScript (`--experimental-strip-types`), WebSocket (`ws`), SQLite (`better-sqlite3`), Zod validation.

Core modules:
- `server.ts` — HTTP/WebSocket server + image upload API
- `bridge.ts` — ACP bridge, manages agent subprocess
- `store.ts` — SQLite persistence (sessions + events tables)
- `public/index.html` — single-file frontend (no build step)

Production runs as a macOS launchd service (port 6800).

## Service Management

Use npm scripts for prod service control:

```bash
npm run svc:restart   # restart prod
npm run svc:stop      # stop prod
npm run svc:status    # check status
```

Do NOT use `start.sh` directly.

## Development

```bash
npm run dev           # dev server on port 6801, uses data-dev/
```

## Architecture Notes

- **Single bridge**: One bridge instance per server, multiple sessions multiplexed over it.
- **Session restore**: `bridge.loadSession()` restores ACP context after server restart. During restore, `restoringSessions` Set suppresses duplicate event storage/broadcast.
- **On-demand sessions**: No pre-warming. Sessions created on `/new`, auto-resumed on page open.
- **Auto-resume**: Frontend auto-resumes last active session on page open (no hash → fetch `/api/sessions` → resume most recent).
- **Event aggregation**: `message_chunk` / `thought_chunk` are buffered in memory, flushed to DB as full `assistant_message` / `thinking` on boundaries (tool_call, plan, prompt_done).
- **Title generation**: Uses a dedicated silent session with fast model (Haiku), async and non-blocking.
- **Multi-client broadcast**: Events broadcast to all WS clients. Permission responses, user messages, bash output sync across devices. `broadcast()` supports sender exclusion.
- **PWA**: Minimal service worker (no offline cache), manifest.json, installable to home screen.

## Frontend Conventions

- **Single HTML file** — all JS/CSS inline, no build tools.
- **Terminal aesthetic** — monospace fonts, `^C` / `^U` style button labels, `*` git-branch-style session markers.
- **Keyboard shortcuts** — `Ctrl+C` cancel, `Ctrl+U` upload. Enter only sends (never cancels).
- **Theme** — dark/light/auto, persisted to localStorage.

## Testing

```bash
npm test              # run all tests
```

When adding features or fixing bugs, check whether corresponding tests need to be added or updated.

## TODO

- [ ] Add multi-client WS integration tests (e.g. two WS clients: verify `session_created` broadcast doesn't cause unintended session switching; test `awaitingNewSession` guard logic end-to-end)
