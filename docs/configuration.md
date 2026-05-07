# Configuration & Operations

## ACP-Compatible Agents

WebAgent works with any agent that implements the [Agent Client Protocol](https://agentclientprotocol.com/). On startup, when `agent_cmd = "auto"` (the default), WebAgent scans `PATH` for known ACP-ready binaries in priority order and uses the first one it finds. To override, set `agent_cmd` explicitly in `config.toml`.

### Native ACP support

These agents speak ACP directly — install one and `webagent` picks it up:

| Agent                                                     | Command          | Install                            |
| --------------------------------------------------------- | ---------------- | ---------------------------------- |
| [Copilot CLI](https://github.com/github/copilot-cli)      | `copilot --acp`  | `npm i -g @github/copilot`         |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `gemini --acp`   | `npm i -g @google/gemini-cli`      |
| [OpenCode](https://opencode.ai/)                          | `opencode acp`   | `npm i -g opencode-ai`             |

### Via ACP adapter

These agents need a separate adapter package that wraps the underlying CLI into an ACP-compatible process. Install the adapter — its binary is what WebAgent talks to.

| Agent                                                                | Adapter binary       | Install                                            |
| -------------------------------------------------------------------- | -------------------- | -------------------------------------------------- |
| [Claude Code](https://docs.anthropic.com/en/docs/agents/claude-code) | `claude-agent-acp`   | `npm i -g @agentclientprotocol/claude-agent-acp`   |
| [Codex](https://github.com/openai/codex)                             | `codex-acp`          | `npm i -g @zed-industries/codex-acp`               |
| [Qwen Code](https://github.com/QwenLM/qwen-code)                     | `qwen --acp`         | `npm i -g @qwen-code/qwen-code`                    |

To pin an agent explicitly:

```toml
agent_cmd = "claude-agent-acp"
```

See the [ACP Registry](https://agentclientprotocol.com/get-started/registry) for the full list (30+ agents).

### Per-agent caveats

Different agents implement ACP with different conventions. Things that have surprised us in dogfood:

**Codex (`@zed-industries/codex-acp`) — agent's shell tool uses process cwd.**
Codex runs normally under WebAgent — session listing, file edits, and permission scoping all honor the per-session `cwd` from ACP `newSession`. The only subtle point is **Codex's own internal shell tool** (the `/bin/bash -lc` calls the LLM makes via codex-rs) uses the **process working directory** of `codex-acp` itself, not the per-session cwd:

- Inside the agent's shell tool, `pwd`, `ls *.md`, `cat a.txt`, `find .` all resolve from the directory where you launched `webagent`, not from the session's chosen cwd.
- Absolute paths and file-edit tools (which take absolute paths anyway) work correctly per-session, including permission boundary checks against `session.cwd`.
- In practice the agent uses absolute paths most of the time, so this is rarely visible. If you want `pwd` and shell-relative paths to also match the session cwd, launch `webagent` from your project directory (`cd ~/myproject && webagent`).

**This does NOT affect WebAgent's own `!command` shell** — that always honors the current session's cwd (`spawn(..., { cwd: session.cwd })` in `routes.ts`), regardless of which agent is in use. The caveat above is purely about the shell tool that the Codex *agent itself* invokes.

This is by design in `codex-rs` (Zed's editor spawns one `codex-acp` per project, so process cwd ≡ session cwd by construction). Copilot CLI and Claude Code instead honor ACP `session.cwd` in their own shell tools too.

**Codex mode names differ from Copilot/Claude/Gemini/OpenCode:**

| Concept           | Copilot CLI | Claude Code         | Codex          | Gemini CLI         | OpenCode               |
| ----------------- | ----------- | ------------------- | -------------- | ------------------ | ---------------------- |
| Default           | `agent`     | `default`           | `read-only`    | `default`          | `build`                |
| Plan-only         | `plan`      | `plan`              | `read-only`*   | `plan`             | `plan`                 |
| Auto-allow (full) | `autopilot` | `bypassPermissions` | `full-access`  | `yolo`             | (configurable agent)   |
| Other built-ins   | —           | `acceptEdits`, `dontAsk`, `auto` | `auto` | `autoEdit`         | `general` + user-defined |

*Codex doesn't have a separate plan mode; `read-only` is both the default and the read-only mode. WebAgent shows the `READ-ONLY` pill for it (as a meaningful safety state), not as a hidden default.

**OpenCode modes are user-extensible.** Beyond the built-in `build` / `plan` / `general`, anything the user defines under `~/.config/opencode/` as a non-subagent, non-hidden agent will appear as a selectable mode. WebAgent treats them as default-bucket modes (shown in the pill, no auto-approve).

In auto-allow modes (`bypassPermissions`, `full-access`, `yolo`), the agent itself skips emitting `permission_request` entirely — the agent self-handles it. WebAgent's auto-approve code path is therefore mostly relevant to Copilot-style agents that still emit permission requests in autopilot. Gemini's `autoEdit` is a partial autopilot (auto-approves edits only, still prompts for shell/web) — WebAgent treats it as a default-bucket mode and forwards permission requests as-is.

## Configuration

Configuration is via TOML files, passed with `--config`:

```bash
webagent --config config.toml
```

If no `--config` is provided, all settings use built-in defaults. See `config.toml` for the checked-in default settings and `config.dev.toml` for development.

| Key                                  | Default                     | Description                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port`                               | `6800`                      | HTTP server port                                                                                                                                                                                                                                                                                                     |
| `data_dir`                           | `data`                      | SQLite + uploads directory                                                                                                                                                                                                                                                                                           |
| `default_cwd`                        | `process.cwd()`             | Working directory for new sessions                                                                                                                                                                                                                                                                                   |
| `public_dir`                         | `dist`                      | Static assets directory                                                                                                                                                                                                                                                                                              |
| `agent_cmd`                          | `auto`                      | ACP agent command. `auto` scans PATH for known ACP-ready binaries; otherwise the literal command (binary + args, space-separated).                                                                                                                                                                                   |
| `limits.bash_output`                 | `1048576` (1 MB)            | Max bash output stored in DB per command                                                                                                                                                                                                                                                                             |
| `limits.image_upload`                | `10485760` (10 MB)          | Max image upload size                                                                                                                                                                                                                                                                                                |
| `limits.file_upload`                 | `52428800` (50 MB)          | Max non-image attachment upload size. Server picks the cap from sniffed MIME (`image/*` → `image_upload`, otherwise → `file_upload`).                                                                                                                                                                                |
| `limits.cancel_timeout`              | `10000` (10s)               | Cancel timeout in ms; 0 disables                                                                                                                                                                                                                                                                                     |
| `limits.recent_paths`                | `10`                        | Max recent paths shown in `/new` menu; 0 = show all                                                                                                                                                                                                                                                                  |
| `limits.recent_paths_ttl`            | `30`                        | Days to keep unused paths before auto-cleanup; 0 = keep forever                                                                                                                                                                                                                                                      |
| `push.vapid_subject`                 | `mailto:webagent@localhost` | VAPID subject for Web Push (email or URL). **Note:** iOS/APNs rejects `localhost` domains — use a real-looking address (e.g. `mailto:noreply@example.com`) in production.                                                                                                                                            |
| `push.global_visibility_suppression` | `true`                      | When `true`, a single client viewing session X suppresses push for session X on **all** endpoints/devices. Set to `false` to disable cross-device suppression as an emergency rollback without code change. See [Visibility Sync & Push Suppression](client-architecture.md#visibility-sync--push-suppression).      |
| `title.model`                        | `claude-haiku-4.5`          | Model ID for the async title-generation sub-session. Set to empty string `""` to skip `setConfigOption` and inherit the main session model (useful for CLIs without Haiku, e.g. Copilot / Gemini).                                                                                                                   |
| `messages.unprocessed_ttl_days`      | `30`                        | Days before an unprocessed unbound inbox message is auto-cleaned. `0` = keep forever. Bound messages attached to sessions are not affected. See [Messages / Inbox](messages.md).                                                                                                                                     |
| `debug.level`                        | `"off"`                     | Inline log level — one of `off \| debug \| info \| warn \| error`. When `level != "off"`, frontend `log.*` records above that level emit both to the DevTools console and inline into the conversation flow (as system messages). Override per page via `?debug=<level>` URL param or at runtime via `/log <level>`. |
| `share.enabled`                      | `false`                     | Master kill switch for the share-link feature. When `false`, all `/api/v1/sessions/*/share*` and `/s/*` routes return 410 and `/share` slash commands are hidden. See [Share Links](share.md).                                                                                                                       |
| `share.ttl_hours`                    | `0`                         | Auto-expiry for activated shares. `0` = no expiry; `>0` = hours (capped at 168 / 7d).                                                                                                                                                                                                                                |
| `share.csp_enforce`                  | `true`                      | When `true`, the viewer page sets `Content-Security-Policy`. When `false`, sets `Content-Security-Policy-Report-Only` (browser logs violations to console without blocking — for development).                                                                                                                       |
| `share.viewer_origin`                | `""`                        | Override the base URL returned in `public_url` (e.g. `https://share.example.com`). Empty = same host as the API server.                                                                                                                                                                                              |
| `share.internal_hosts`               | `[]`                        | Hostnames the sanitizer scrubs from outgoing event text (replaced with placeholders). Set to your private domains so internal URLs don't leak to viewers.                                                                                                                                                            |

To use a different ACP-compatible agent backend:

```toml
agent_cmd = "claude-agent-acp"
```

## Generating a Config

WebAgent runs zero-config by default — no `config.toml` is required. Generate one only when you want to override defaults (custom port, data directory, etc.):

```bash
webagent config init                  # write ./config.toml (well-commented template)
webagent config init --force          # overwrite an existing config.toml

webagent config show                          # print the effective merged config (defaults + any overrides) as TOML
webagent config show --config /path/to.toml   # show what a specific config file resolves to
```

`config init` copies the package's bundled `config.toml` — the single source of truth that documents every key with its default and a one-line description. `config show` is useful for "what is actually in effect right now" — handy for debugging an override that isn't taking.

## Service Management

WebAgent includes a built-in daemon with crash recovery:

```bash
webagent start --config config.toml   # start as background daemon
webagent stop                          # stop the daemon
webagent restart                       # atomic restart (Unix) / stop+start (Windows)
webagent status                        # show running state
```

The daemon writes a PID file (`webagent.pid`) and log file (`webagent.log`) in the current directory. Run all commands from the same directory.

For auto-start on boot, see [Auto-Start on Boot](autostart.md) (launchd, systemd, crontab, and Windows Task Scheduler examples).

## Upgrading the Agent CLI

WebAgent spawns the agent as a child process (e.g. `copilot --acp`). When the agent releases a new version, the running process still uses the old binary. To pick up the update:

1. Update the agent CLI (e.g. `copilot update`, `npm update -g`, etc.)
2. Restart WebAgent — the new process will spawn the updated agent

You can verify versions after restart via `GET /api/v1/version` or the `?` help command in the UI.

## Troubleshooting: Agent Shell Environment

The agent (Copilot CLI) runs its bash tool in a bash session that does **not** source user shell config files (`~/.bashrc`, `~/.zprofile`, `~/.zshrc`, etc.). Instead, the agent's bash sessions inherit the environment of the **parent process** — i.e. the WebAgent server.

If tools like `docker`, `node`, or other CLI programs work in your terminal but not through the agent, it means the WebAgent server process was started without those entries in its PATH.

**Fix**: Ensure the WebAgent startup script (e.g. `run.sh` in the service directory) sets up the required PATH and tool initialization before launching the server. A convenient pattern is to maintain a `~/.bashrc` with environment-only setup (no aliases or interactive config) and `source ~/.bashrc` at the top of the startup script. Restart the service after changes.
