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
| `/cwd` | Show current working directory |
| `/model [name]` | View or switch model (fuzzy match, e.g. `/model opus`) |
| `/cancel` | Cancel current response |
| `/sessions` | List all sessions |
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
                        ↕
                    store.ts (SQLite)
```

- **server.ts** — HTTP static files + WebSocket + image upload API
- **bridge.ts** — ACP bridge, manages agent subprocess, handles permissions and file I/O
- **store.ts** — SQLite persistence (sessions + events tables, WAL mode)

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
