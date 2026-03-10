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
- **Web Push**: VAPID-based push notifications via `web-push`. Only fires when no WS client is visible (zero clients or all backgrounded). 5-minute per-session merge window prevents spam. Subscriptions stored in SQLite; stale endpoints (410 Gone) auto-cleaned. Notifiable events: `permission_request`, `prompt_done`, `bash_done`.

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
- **Keyboard shortcuts** — `Ctrl+X` cancel, `Ctrl+U` upload. Enter only sends (never cancels).
- **Theme** — dark/light/auto, persisted to localStorage.
- **Escape key** — `inputEl` keydown listener cannot reliably capture Escape (browser default behavior / IME may consume it first). Use `document.addEventListener('keydown', ...)` instead for Escape handling.
- **Prefer CSS for animations** — Use CSS `@keyframes` + pseudo-elements for UI animations (spinners, pulses) instead of JS `setInterval`. JS timers cause issues in test environments (JSDOM) by keeping the event loop alive.
- **Autopilot mode** — In autopilot mode, permissions are auto-approved server-side (`allow_once` only, not `allow_always`, to avoid persisting across mode switches). New sessions always start in agent mode (mode is not inherited).
- **Push notifications** — `/notify` slash command with on/off submenu. First `prompt_done` triggers a one-time tip (localStorage-gated). Permission denied state shows manual-settings guidance. Service worker handles push display + notificationclick → session navigation.

## Git Commit Tips

- Avoid `!` in double-quoted commit messages — bash interprets it as history expansion and the command will hang. Use single quotes instead.
- Don't commit until a feature/fix is fully working and verified. Avoid partial or incremental commits for incomplete changes.
- Once a feature or fix has reached a complete checkpoint, make a commit so the work stays traceable and easy to roll back. "Complete" means the full TDD cycle is done, the relevant tests pass, broader existing tests pass, and any required E2E coverage for that feature has been run and confirmed.
- Keep commits tightly scoped: each commit should capture one coherent, fully verified piece of work. Prefer multiple smaller complete commits over bundling unrelated fixes, tests, and refactors together.
- Write commit messages with enough context to make later log review useful: the subject should say what changed, and the body should briefly capture the problem and the fix/approach. Avoid overly terse messages that hide why the change was needed, especially for bug fixes and test additions.

## Testing

```bash
npm test                                   # run all tests
npm run test:e2e                          # run Playwright browser E2E
npm run test:e2e -- test/e2e/foo.spec.ts # run a specific Playwright spec via the npm script
```

Prefer npm scripts over calling tool binaries directly. For targeted Playwright runs, pass file paths or extra Playwright args after `--` instead of using `npx playwright ...` directly.

For any bug fix or new feature, follow full TDD by default:

1. First study the existing test coverage and identify the right place to add or update tests.
2. Add the test that captures the bug or desired behavior before changing implementation code.
3. Run the relevant test(s) and confirm they fail for the expected reason.
4. Only then change the implementation to make the test pass.
5. Run the relevant tests again, then run the broader existing test suite (`npm test`) before considering the work done.

Do not treat tests as an afterthought. A bug fix or feature is incomplete unless the corresponding automated test coverage is added or updated as part of the same change.

- Keep `TEST_SCENARIOS.md` in sync when the suite meaningfully expands or when the documented coverage boundaries change, so future review does not require reverse-engineering intent from test names alone.

### Lessons

- **Behavior changes must update all callers** — When changing a UI element's behavior (e.g. a button going from direct action to filling a command), search for ALL test helpers and E2E specs that depend on that behavior, not just the closest unit test. A single missed caller can silently break dozens of downstream tests.
- **Flaky tests are usually real bugs** — Don't dismiss intermittent failures as test fragility. Event ordering races (e.g. `prompt_done` arriving before `permission_resolved`) are real production bugs that tests happen to expose under timing pressure.
- **Optimistic UI and server broadcasts must agree** — When a client action triggers both an optimistic DOM update and a server broadcast back to the same client, the two must produce identical text/state. Mismatches (e.g. "Deny" vs "denied") cause flaky assertions and confusing UX.
- **E2E helpers should use the most stable path** — Shared test helpers (like `createNewSession`) should use the most direct, UI-independent code path (e.g. slash command) rather than simulating complex UI flows (button click → menu → submit). Reserve UI-specific interaction testing for dedicated specs.

## Response Clarity

- When a task or sub-task is actually finished, end with an explicit completion statement (for example: `Done.`, `This is fixed.`, `Build succeeded; you can refresh now.`, or `Tests passed; ready for the next step.`).
- Do not end on process narration that sounds mid-stream (for example: `I'm running...`, `I'll verify...`, `I’m checking...`) without a follow-up conclusion in the same response.
- If the UI may already be interactive again, make the current state explicit so the user knows whether work is complete, still running, or waiting on them.

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
