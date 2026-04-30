# Features

## Chat

- Real-time streaming responses with Markdown rendering + syntax highlighting
- Collapsible thinking process display
- Tool call display (status animation, expandable details, diff rendering)
- Agent execution plan display (pending ○ / in-progress ◉ / done ●)
- Permission confirmation dialog for sensitive operations (Allow / Deny), synced across devices; auto-approved in autopilot mode
- Smart scroll: force-scrolls on load/switch/send, soft auto-scroll during streaming

## Attachments

- Upload any file (button or `^U` shortcut), not just images
- Paste images from clipboard (non-image clipboard items must use the file picker)
- Preview before sending + removable, supports multiple files; images get an inline thumbnail and other files render as a name chip
- Streaming multipart upload — no base64 in the browser
- Server-side storage under `<data_dir>/sessions/<sid>/attachments/`, classified as `image` or `file` from sniffed MIME (drives size cap and per-prompt auto-approve gating)
- Image attachments are referenced by `attachmentId` in the wire protocol; the browser never sees raw bytes after upload, and the server resolves the on-disk path itself

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

| Key       | In menu                       | Without menu       |
| --------- | ----------------------------- | ------------------ |
| `Tab`     | Fill selected item into input | —                  |
| `Enter`   | Send current input            | Send current input |
| Click/Tap | Fill and send (Tab + Enter)   | —                  |

Commands with submenus (`/model`, `/mode`, `/think`, `/notify`, `/switch`, `/new`, `/clear`, `/inbox`, `/log`) show a picker after typing the command and a space. Tab completes the selection into the input so you can review or edit before pressing Enter to send.

| Command               | Description                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `/help` (or `?`)      | Show help                                                                                                                     |
| `/new [cwd]`          | Create new session — shows recent paths picker (paths persist across session exits, auto-cleaned by TTL)                      |
| `/model [name]`       | Switch model (fuzzy match, e.g. `/model opus`)                                                                                |
| `/mode [name]`        | Switch mode (Agent / Plan / Autopilot)                                                                                        |
| `/think [level]`      | Set thinking effort (low / medium / high)                                                                                     |
| `/notify [on\|off]`   | Toggle push notifications                                                                                                     |
| `/inbox`              | Manage inbox — pick a pending message to consume (opens a new session) or ack (dismiss). See [Messages / Inbox](messages.md). |
| `/log [level]`        | Set log level (`off`, `debug`, `info`, `warn`, `error`). Log records render inline as system messages.                        |
| `/cancel`             | Cancel current response                                                                                                       |
| `/clear [cwd]`        | Clear current session and start fresh, optionally in another cwd (model/think inherited)                                      |
| `/switch <title\|id>` | Switch session (match by title or ID prefix)                                                                                  |
| `/rename <new title>` | Rename session                                                                                                                |
| `/exit`               | End current session (delete + switch to previous)                                                                             |
| `/reload`             | Reload agent subprocess (pick up CLI upgrades, new skills)                                                                    |
| `/logout`             | Log out — clear local token and return to login page                                                                          |
| `/token`              | Manage API tokens (list, create, revoke) — see [Auth & Security](security.md)                                                 |
| `/share`              | List active public shares · Enter creates a read-only snapshot (preview → `^P` publish / `^C` cancel). See [Share Links](share.md). |

Type `?` for inline help listing all commands and shortcuts.

## Keyboard Shortcuts

| Shortcut      | Action                                                      |
| ------------- | ----------------------------------------------------------- |
| `Enter`       | Send message                                                |
| `Shift+Enter` | New line                                                    |
| `Ctrl+C`      | Cancel current response (native copy when text is selected) |
| `Ctrl+M`      | Cycle mode (Agent → Plan → Autopilot)                       |
| `Ctrl+U`      | Attach file (any type)                                      |

Tap the `❯` prompt indicator to cycle mode.

## Theme

- Dark / light / system, toggle with `◑`
- Terminal-style UI (monospace font, `>_` logo)
- Preference saved to localStorage

## Other

- PWA support (installable to home screen)
- Web Push notifications — background alerts when no browser tab is visible (use `/notify on`)
- Inbox (`/inbox`) — a structured-notification primitive for cron jobs, webhooks, and other local tools. External senders `POST` to `/api/v1/messages`; the user engages on their own terms. See [Messages / Inbox](messages.md).
- SSE auto-reconnect (3s retry on disconnect)
- 15s SSE heartbeat keepalive (also drives push visibility refresh — see [architecture](client-architecture.md#visibility-sync--push-suppression))
- Auto-expanding input box
- Mobile-friendly layout
- Multi-client broadcast (events synced across devices)
