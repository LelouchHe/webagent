# Features

## Chat

- Real-time streaming responses with Markdown rendering + syntax highlighting
- LaTeX math rendering: inline `$E=mc^2$` and display `$$\sum_i x_i$$` (Temml → MathML, lazy-loaded). Display math must be on its own line (`$$\n…\n$$`), per GitHub/Obsidian/Jupyter convention. CSP-safe (no inline styles).
- Collapsible thinking process display
- Tool call display (status animation, expandable details, diff rendering)
- Agent execution plan display (pending `[ ]` / in-progress `[~]` / done
  `[x]`) with a pinned, scrollable panel above the input. The current plan is
  kept in server memory across turns and page refreshes, then cleared when all
  entries complete or the agent bridge/service restarts.
- Permission confirmation dialog for sensitive operations (Allow / Deny), synced across devices; auto-approved in autopilot mode
- Smart scroll: force-scrolls on load/switch/send, soft auto-scroll during streaming

## Attachments

- Upload any file (button or `^U` shortcut), not just images
- Paste images from clipboard (non-image clipboard items must use the file picker)
- Preview before sending + removable, supports multiple files; images get an inline thumbnail and other files render as a name chip
- Streaming multipart upload — no base64 in the browser
- Server-side storage under `<data_dir>/sessions/<sid>/attachments/`, classified as `image` or `file` from sniffed MIME (drives size cap and per-prompt auto-approve gating)
- Image attachments are referenced by `attachmentId` in the wire protocol; the browser never sees raw bytes after upload, and the server resolves the on-disk path itself

## File Viewer

- `/view` opens a live picker rooted at the current task cwd; type a path to
  filter, tap a folder to enter one level, or use the `..` row to go back
- Absolute `/...` and `~/...` paths can browse anywhere available to the
  single-operator WebAgent process
- Markdown and code/text up to 1 MiB render with the existing chat pipeline,
  syntax highlighting, and line numbers; supported images render inline
- Larger text/images and unknown binaries use the same signed URL for an
  immediate, complete, streaming browser download
- Full-screen viewer with a top-right close button on mobile; responsive
  right-side split keeps chat visible on desktop
- Read-only throughout: special files are rejected, mutable content is not
  cached, and public share links cannot access the local file API

## Bash Execution

- `!<command>` to run shell commands directly
- Real-time output streaming (stderr in red)
- Collapsible output with exit code display
- Cancel running processes
- Cancel is task-scoped inside WebAgent: it requests cancellation of the current ACP turn and stops WebAgent-owned task work (like local `!` bash), but it cannot stop host-level tasks started outside the WebAgent server/runtime
- Agent cancellation remains visibly pending until the agent acknowledges it. If acknowledgement times out, the cancel button stays retryable instead of reporting a false success.
- An unconfirmed agent cancel can also be recovered with `/reload`, which restarts the shared agent bridge and interrupts in-flight work in every task. On POSIX, repeating cancel for a still-running local bash process escalates from `SIGINT` to `SIGKILL`; Windows uses forced `taskkill` immediately.

## Task Management

- Auto-resumes last task on page open, no manual switching needed
- After server restart, restores task context via ACP `loadTask` so conversations can continue
- Auto-generated titles (async, using a fast model)
- Task history persisted in SQLite, survives restarts
- `/switch` lists all tasks (git-branch style, `*` marks current in green)
- Switching tasks replays full message history

## Slash Commands

Type `/` to trigger an autocomplete menu with arrow keys to navigate, Esc to close.

| Key       | In menu                       | Without menu       |
| --------- | ----------------------------- | ------------------ |
| `Tab`     | Fill selected item into input | —                  |
| `Enter`   | Send current input            | Send current input |
| Click/Tap | Fill and send (Tab + Enter)   | —                  |

Commands with submenus (`/model`, `/mode`, `/think`, `/notify`, `/switch`, `/new`, `/clear`, `/view`, `/inbox`, `/log`, `/plan`) show a picker after typing the command and a space. Tab completes the selection into the input so you can review or edit before pressing Enter to send.

| Command               | Description                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `/help` (or `?`)      | Show help                                                                                                                     |
| `/new [cwd]`          | Create new task — shows recent paths picker (paths persist across task exits, auto-cleaned by TTL)                      |
| `/model [name]`       | Switch model (fuzzy match, e.g. `/model opus`)                                                                                |
| `/mode [name]`        | Switch mode (Agent / Plan / Autopilot)                                                                                        |
| `/think [level]`      | Set thinking effort (low / medium / high)                                                                                     |
| `/notify [on\|off]`   | Toggle push notifications                                                                                                     |
| `/inbox`              | Manage inbox — pick a pending message to consume (opens a new task), or use `/inbox dismiss` to ack it. See [Messages / Inbox](messages.md). |
| `/log [level]`        | Set local log level (`off`, `debug`, `info`, `warn`, `error`, `reset`). Log records render inline as system messages.         |
| `/plan [show\|hide]`  | Toggle, show, or hide the current pinned plan panel                                                                           |
| `/cancel`             | Cancel current response                                                                                                       |
| `/clear [cwd]`        | Clear current task and start fresh, optionally in another cwd (model/think inherited)                                      |
| `/compact`            | Summarize the current conversation; the visible history stays and the next message continues with a compacted context         |
| `/reset`              | Reset local frontend state for this device (keeps login token)                                                                |
| `/switch <title\|id>` | Switch task (match by title or ID prefix)                                                                                  |
| `/rename <new title>` | Rename task                                                                                                                |
| `/exit`               | End current task (delete + switch to previous)                                                                             |
| `/reload`             | Reload agent subprocess (pick up CLI upgrades, new skills)                                                                    |
| `/logout`             | Log out — clear local token and return to login page                                                                          |
| `/token`              | Manage API tokens (list, create, revoke) — see [Auth & Security](security.md)                                                 |
| `/share`              | List active public shares · Enter creates a read-only snapshot (preview → `^P` publish / `^C` cancel). See [Share Links](share.md). |
| `/view [path]`        | Browse local folders; preview supported files up to their cap or directly download larger/unknown files                               |

Type `?` for inline help listing all commands and shortcuts.

### Agent commands (`//`)

Agent commands are agent-specific: they are advertised and implemented by the
current Agent, not by WebAgent. Type `//` to see the commands available for the
current task. WebAgent sends the selected command as a normal Agent turn, so
it cannot run while that task is busy. Command names, arguments, and behavior
may differ between Agent implementations or versions.

WebAgent stores and displays the original `//command` text, then converts it to
the Agent's canonical `/command` form only at the ACP boundary. Commands are
validated against the latest command list before they are sent.

Some commands may conflict with WebAgent's own state or may not work fully when
they depend on CLI-only UI or behavior that ACP does not expose. WebAgent can
synchronize a change only when the Agent reports it through ACP. For example,
model changes normally arrive through a configuration update and appear in the
status bar. ACP currently has no task working-directory update, so an Agent
command that changes cwd can leave the Agent's internal cwd different from
WebAgent's status bar, local `!` bash cwd, persisted task cwd, and
restart/restore cwd. Prefer WebAgent's local command when an equivalent exists;
otherwise treat the Agent command as an agent-side operation whose effects may
not be reflected everywhere in WebAgent.

## Keyboard Shortcuts

| Shortcut      | Action                                                      |
| ------------- | ----------------------------------------------------------- |
| `Enter`       | Send message                                                |
| `Shift+Enter` | New line                                                    |
| `Ctrl+C`      | Cancel current response (native copy when text is selected) |
| `Ctrl+M`      | Cycle mode (Agent → Plan → Autopilot)                       |
| `Ctrl+U`      | Attach file (any type)                                      |

Tap the `❯` prompt indicator to cycle mode.

### iOS PWA keyboard recovery

iOS WebKit can rarely leave the input focused while the keyboard is unusable.
If the keyboard is completely hidden, tap the input once to clear the stale
focus, then tap it again to reopen the keyboard. If the keyboard accessory bar
is still visible but the main keys are missing, double-tap the bottom status
bar (`model · cwd`), then tap the input. The status-bar gesture avoids
interfering with native double-tap text selection inside the textarea.

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
