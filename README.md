# WebAgent

[![CI](https://github.com/LelouchHe/webagent/actions/workflows/ci.yml/badge.svg)](https://github.com/LelouchHe/webagent/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@lelouchhe/webagent)](https://www.npmjs.com/package/@lelouchhe/webagent)

A terminal-style web UI for [ACP](https://agentclientprotocol.com/)-compatible agents — Copilot CLI, Claude Code, Gemini CLI, and [more](docs/configuration.md#acp-compatible-agents).

WebAgent is a thin browser client + Node.js server that lets you drive any ACP agent from a desktop browser, phone, or PWA. Sessions, permissions, and notifications stay in sync across devices; nothing leaves your machine.

## Highlights

- **Zero-config first run** — `npx @lelouchhe/webagent` and you're online. Auto-detects the ACP agent on your `PATH`, mints an admin token on first start, persists everything in `./data/`.
- **Multi-device, real-time** — REST + SSE keeps sessions, permissions, and bash output synced. Approve a permission on your laptop, see it confirmed on your phone.
- **Web Push notifications** — Get pinged on `prompt_done`, `permission_request`, or `bash_done` when the tab isn't focused. Smart per-session suppression: if any device is actively viewing session X, no buzz from session X.
- **PWA + mobile-friendly** — Installable to iOS / Android home screen. Mobile-first input, attach via paste/upload, dark-mode native.
- **Attachments** — Drag, paste, or `^U` any file (images, code, PDFs, …). Server sniffs real MIME from content, so agents reliably read it.
- **Inline bash** — `!ls -la` runs directly in your session's cwd, output streams in real time, cancellable.
- **Sessions that survive everything** — SQLite-persisted history, auto-resume on page open, auto-restore via ACP `loadSession` after server restart, auto-generated titles via a fast model.
- **Rich slash menu** — `/new`, `/switch`, `/model`, `/mode`, `/think`, `/notify`, `/inbox`, `/share`, `/token`, `/log` — autocomplete with Tab, submenus for pickable values.
- **Public share links** — `/share` snapshots a session into a sanitized read-only viewer at `/s/<token>` for show-and-tell.
- **Daemon mode with crash recovery** — `webagent start` runs as a background service with PID file, log rotation, and exponential-backoff restart on crash.
- **Built-in security** — Bearer token auth, per-device tokens, signed image URLs, strict CSP, single-operator threat model.

See [Features](docs/features.md) for the full tour.

<table>
  <tr>
    <td width="60%">
      <img src="docs/images/chat-desktop.png" alt="Desktop chat with tool calls and diffs" />
    </td>
    <td width="40%">
      <img src="docs/images/mobile-chat.png" alt="Mobile layout" />
    </td>
  </tr>
</table>

<details>
<summary>More screenshots</summary>

<table>
  <tr>
    <td width="50%">
      <img src="docs/images/permission.png" alt="Permission dialog" />
      <br /><sub>Inline permission prompts, synced across devices.</sub>
    </td>
    <td width="50%">
      <img src="docs/images/slash-menu.png" alt="Slash command menu" />
      <br /><sub>Slash command autocomplete menu.</sub>
    </td>
  </tr>
</table>

</details>

## Quick Start

**Prerequisites:** Node.js 22.6+, an ACP-compatible agent installed and authenticated (Copilot CLI, Claude Code adapter, Gemini CLI, etc.).

```bash
npx @lelouchhe/webagent      # zero-install, runs on port 6800
# — or —
npm install -g @lelouchhe/webagent && webagent
```

On first run, the server prints a one-time admin token in the startup
diagnostic. Open `http://localhost:6800`, paste the token into the
login form, done. The token persists in `data/auth.json` — subsequent
runs skip the prompt.

Other ways to start:

```bash
webagent start                               # background daemon (same first-run UX in your terminal)
webagent --config /path/to/config.toml       # custom config (`webagent config init` to scaffold one)
webagent --create-token laptop               # mint extra tokens for other devices / CI
```

Data (SQLite database, uploaded files) lives in `./data/` by default. See [Configuration & Operations](docs/configuration.md) for daemon mode, TOML settings, and agent setup.

## Architecture

```
Browser ←── REST + SSE ──→ Server ←── ACP ──→ Agent CLI
  (thin client)            (Node.js)           (copilot/claude/gemini)
```

The frontend is a standard browser client that talks to the server over REST + SSE. The API is the boundary — anyone can build their own client.

| Module               | Role                                                        |
| -------------------- | ----------------------------------------------------------- |
| `routes.ts`          | REST API + static files ([full API reference](docs/api.md)) |
| `event-handler.ts`   | ACP event routing → SSE broadcast                           |
| `session-manager.ts` | Session state, buffers, bash processes                      |
| `bridge.ts`          | ACP bridge — agent subprocess lifecycle                     |
| `store.ts`           | SQLite persistence (WAL mode)                               |
| `daemon.ts`          | Background service with crash recovery                      |

Tech stack: Node.js + TypeScript (`--experimental-strip-types`), SQLite (`better-sqlite3`), Zod validation, esbuild bundling.

Frontend source lives in `public/js/*.ts`, bundled by esbuild into a single content-hashed JS file. See [Client Architecture](docs/client-architecture.md).

## Documentation

| Document                                                | Contents                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **[Features](docs/features.md)**                        | Chat, attachments, bash, sessions, slash commands, keyboard shortcuts, themes  |
| **[Configuration & Operations](docs/configuration.md)** | TOML config, daemon commands, agent setup, upgrading                           |
| **[Security](docs/security.md)**                        | Bearer auth, token storage, SSE ticket, signed image URLs, CSP, data layout    |
| **[API Reference](docs/api.md)**                        | REST endpoints, SSE events, implementation details                             |
| **[Attachments](docs/uploads.md)**                      | Upload pipeline, on-disk layout, lifecycle, permission auto-approve, observability |
| **[ACP Integration](docs/acp.md)**                      | Client extensions, protocol scope, current limits                              |
| **[Client Architecture](docs/client-architecture.md)**  | Frontend modules, data flow, conventions                                       |
| **[Streaming Render Performance](docs/performance.md)** | rAF coalescing, incremental lex, per-block memo, single-token fast path        |
| **[Slash Menu](docs/slash-menu.md)**                    | Walker pipeline, `CmdNode` tree, Tab/Enter/Click contract, how to add commands |
| **[Messages / Inbox](docs/messages.md)**                | `/inbox` slash command, POST ingress, bound vs unbound messages                |
| **[Share Links](docs/share.md)**                        | Public read-only session snapshots via `/share` + `/s/<token>`                 |
| **[Database Schema](docs/schema.md)**                   | SQLite tables, indexes, FK policy, cascade/lifecycle rules, migrations         |
| **[Development](docs/development.md)**                  | Building from source, dev mode, testing, publishing                            |
| **[Auto-Start on Boot](docs/autostart.md)**             | launchd, systemd, crontab, Windows Task Scheduler                              |
