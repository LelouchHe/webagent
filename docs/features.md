# Features

## Chat

- Real-time streaming responses with Markdown rendering + syntax highlighting
- Collapsible thinking process display
- Tool call display (status animation, expandable details, diff rendering)
- Agent execution plan display (pending ○ / in-progress ◉ / done ●)
- Permission confirmation dialog for sensitive operations (Allow / Deny), synced across devices; auto-approved in autopilot mode
- Smart scroll: force-scrolls on load/switch/send, soft auto-scroll during streaming

## Images

- Upload images (button or `^U` shortcut)
- Paste images (Ctrl+V / Cmd+V)
- Preview before sending + removable, supports multiple images
- Server-side storage, displayed inline in chat

## Bash Execution

- `!<command>` to run shell commands directly
- Real-time output streaming (stderr in red)
- Collapsible output with exit code display
- Cancel running processes
- Cancel is session-scoped inside WebAgent: it stops the current ACP turn plus WebAgent-owned session work (like local `!` bash), but it cannot stop host-level tasks started outside the WebAgent server/runtime

## Session Management

- Auto-resumes last session on page open, no manual switching needed
- After server restart, restores session context via ACP `loadSession` so conversations can continue
- Auto-generated titles (async, using a fast model)
- Session history persisted in SQLite, survives restarts
- `/switch` lists all sessions (git-branch style, `*` marks current in green)
- Switching sessions replays full message history

## Slash Commands

Type `/` to trigger an autocomplete menu with arrow keys to navigate, Esc to close.

| Key | In menu | Without menu |
|---|---|---|
| `Tab` | Fill selected item into input | — |
| `Enter` | Send current input | Send current input |
| Click/Tap | Fill and send (Tab + Enter) | — |

Commands with submenus (`/model`, `/mode`, `/think`, `/notify`, `/switch`, `/new`) show a picker after typing the command and a space. Tab completes the selection into the input so you can review or edit before pressing Enter to send.

| Command | Description |
|---|---|
| `/new [cwd]` | Create new session (optionally specify working directory) |
| `/pwd` | Show current working directory |
| `/model [name]` | View or switch model (fuzzy match, e.g. `/model opus`) |
| `/mode [name]` | View or switch mode (Agent / Plan / Autopilot) |
| `/think [level]` | View or switch reasoning effort (low / medium / high) |
| `/notify [on\|off]` | Toggle push notifications for background alerts |
| `/cancel` | Cancel current response |
| `/switch <title\|id>` | Switch to a session (match by title or ID prefix) |
| `/rename <new title>` | Rename current session |
| `/exit` | Close current session (delete + switch to previous) |
| `/prune` | Delete all sessions except current |

Type `?` for inline help listing all commands and shortcuts.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Ctrl+X` | Cancel current response |
| `Ctrl+M` | Cycle mode (Agent → Plan → Autopilot) |
| `Ctrl+U` | Upload image |

Tap the `❯` prompt indicator to cycle mode.

## Theme

- Dark / light / system, toggle with `◑`
- Terminal-style UI (monospace font, `>_` logo)
- Preference saved to localStorage

## Other

- PWA support (installable to home screen)
- Web Push notifications — background alerts when no browser tab is visible (use `/notify on`)
- SSE auto-reconnect (3s retry on disconnect)
- 30s heartbeat keepalive
- Auto-expanding input box
- Mobile-friendly layout
- Multi-client broadcast (events synced across devices)
