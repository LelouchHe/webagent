# WebAgent

A web UI for any ACP-compatible agent, accessed remotely via the browser.

Tech stack: Node.js + TypeScript (`--experimental-strip-types`, no build step), real-time WebSocket communication, SQLite persistence.

## Features

### Chat

- Real-time streaming responses with Markdown rendering + syntax highlighting
- Collapsible thinking process display
- Tool call display (status animation, expandable details, diff rendering)
- Agent execution plan display (pending ○ / in-progress ◉ / done ●)
- Permission confirmation dialog for sensitive operations (Allow / Deny), synced across devices

### Images

- Upload images (button or `^U` shortcut)
- Paste images (Ctrl+V / Cmd+V)
- Preview before sending + removable, supports multiple images
- Server-side storage, displayed inline in chat

### Bash Execution

- `!<command>` to run shell commands directly
- Real-time output streaming (stderr in red)
- Collapsible output with exit code display
- Cancel running processes

### Session Management

- Auto-resumes last session on page open, no manual switching needed
- After server restart, restores session context via ACP `loadSession` so conversations can continue
- Auto-generated titles (async, using a fast model)
- Session history persisted in SQLite, survives restarts
- `/sessions` lists all sessions (git-branch style, `*` marks current in green)
- Switching sessions replays full message history

### Slash Commands

Type `/` to trigger an autocomplete menu (arrow keys to navigate, Tab to select, Esc to close).

| Command | Description |
|---|---|
| `/new [cwd]` | Create new session (optionally specify working directory) |
| `/pwd` | Show current working directory |
| `/model [name]` | View or switch model (fuzzy match, e.g. `/model opus`) |
| `/cancel` | Cancel current response |
| `/switch <title\|id>` | Switch to a session (match by title or ID prefix) |
| `/delete <title\|id>` | Delete a session |
| `/help` | Show help |

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Ctrl+C` | Cancel current response |
| `Ctrl+U` | Upload image |

### Theme

- Dark / light / system, toggle with `◑`
- Terminal-style UI (monospace font, `>_` logo)
- Preference saved to localStorage

### Other

- PWA support (installable to home screen)
- WebSocket auto-reconnect (3s retry on disconnect)
- 30s heartbeat keepalive
- Auto-expanding input box
- Auto-scroll to bottom
- Mobile-friendly layout

## Architecture

```
Browser ←WebSocket→ server.ts ←ACP→ copilot CLI
                     ├── routes.ts (HTTP handlers)
                     ├── ws-handler.ts (WS dispatch)
                     ├── session-manager.ts (state)
                     ├── title-service.ts (auto-title)
                     └── store.ts (SQLite)
```

- **server.ts** — HTTP/WebSocket server bootstrap
- **routes.ts** — HTTP request handlers (static files, REST API, image upload)
- **ws-handler.ts** — WebSocket message dispatch + broadcast
- **session-manager.ts** — Session state management (live sessions, buffers, bash procs, model cache)
- **bridge.ts** — ACP bridge, manages agent subprocess, handles permissions and file I/O
- **store.ts** — SQLite persistence (sessions + events tables, WAL mode)
- **title-service.ts** — Async session title generation (dedicated Haiku session)
- **types.ts** — Shared types + Zod schemas for WS messages

## ACP Scope and Current Limits

WebAgent uses ACP for the core agent loop: session creation / restore, prompt turns, permission requests, streaming updates, model selection, and text file read/write.

Current scope in this repo:

- Session lifecycle goes through ACP (`newSession`, `loadSession`, `prompt`, `cancel`)
- The UI renders a subset of ACP session updates: assistant text, thinking text, tool calls, tool call updates, and plans
- Session history is persisted locally and restored after server restart

Current limits:

- MCP servers are not forwarded to the agent; sessions are created with an empty `mcpServers` list
- ACP terminal APIs are not used; `!<command>` runs through the app's own local `bash` bridge instead of an ACP-managed terminal session
- The web UI does not expose native CLI command surfaces such as `/plan`, `/fleet`, `/mcp`, `/agent`, `/skills`, or autopilot mode
- Event handling is intentionally narrower than a native CLI client; only selected ACP updates are rendered/persisted, and the silent title-generation session suppresses normal UI events
- Model switching depends on the agent's ACP implementation and currently uses the SDK's unstable session-model API

In practice, this means WebAgent provides a browser UI for the core ACP chat/session workflow, but not the full product surface of direct Copilot CLI or Claude Code in a terminal.

## Prerequisites

- [fnm](https://github.com/Schniz/fnm) + Node.js 22.6+ (requires `--experimental-strip-types`)
- An ACP-compatible agent (e.g. [Copilot CLI](https://github.com/github/copilot-cli)) installed and authenticated

## Install

```bash
npm install
```

## Run

### Production (launchd service)

Managed by macOS launchd with auto-start on boot + auto-restart on crash, port 6800.

```bash
npm run svc:status    # check status
npm run svc:restart   # restart (after code changes)
npm run svc:stop      # stop

# view logs
tail -f webagent.log
```

First-time setup:
```bash
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.lelouch.webagent.plist
```

### Development

```bash
npm run dev           # port 6801, uses data-dev/, auto-restarts on file changes
```
