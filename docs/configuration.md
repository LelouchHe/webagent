# Configuration & Operations

## ACP-Compatible Agents

WebAgent works with any agent that implements the [Agent Client Protocol](https://agentclientprotocol.com/). Not all coding CLIs support ACP natively — some require a wrapper or adapter.

### Native ACP support

These agents have built-in ACP and work directly with `agent_cmd`:

| Agent | Command | Notes |
|---|---|---|
| [Copilot CLI](https://github.com/github/copilot-cli) | `copilot --acp` | Default. GitHub's AI pair programmer |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `gemini --acp` | Google's Gemini models (also `--experimental-acp`) |
| [OpenCode](https://opencode.ai/) | `opencode acp` | Open-source, extensible (note: subcommand, not flag) |

### Via ACP adapter

These agents do not have a native `--acp` flag. Use a community adapter that wraps the CLI into an ACP-compatible process:

| Agent | Adapter | Install |
|---|---|---|
| [Claude Code](https://docs.anthropic.com/en/docs/agents/claude-code) | [`@zed-industries/claude-code-acp`](https://www.npmjs.com/package/@zed-industries/claude-code-acp) | `npm i -g @zed-industries/claude-code-acp` |

To use Claude Code with WebAgent via the adapter:

```toml
agent_cmd = "claude-code-acp"
```

See the [ACP Registry](https://agentclientprotocol.com/get-started/registry) for the full list of agents and adapters.

## Configuration

Configuration is via TOML files, passed with `--config`:

```bash
webagent --config config.toml
```

If no `--config` is provided, all settings use built-in defaults. See `config.toml` for the checked-in default settings and `config.dev.toml` for development.

| Key | Default | Description |
|---|---|---|
| `port` | `6800` | HTTP server port |
| `data_dir` | `data` | SQLite + uploads directory |
| `default_cwd` | `process.cwd()` | Working directory for new sessions |
| `public_dir` | `dist` | Static assets directory |
| `agent_cmd` | `copilot --acp` | ACP agent command (binary + args, space-separated) |
| `limits.bash_output` | `1048576` (1 MB) | Max bash output stored in DB per command |
| `limits.image_upload` | `10485760` (10 MB) | Max image upload size |
| `limits.cancel_timeout` | `10000` (10s) | Cancel timeout in ms; 0 disables |
| `push.vapid_subject` | `mailto:webagent@localhost` | VAPID subject for Web Push (email or URL) |

To use a different ACP-compatible agent backend:

```toml
agent_cmd = "claude --acp"
```

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
