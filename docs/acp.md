# ACP Integration

WebAgent uses ACP for the core agent loop: session creation / restore, prompt turns, permission requests, streaming updates, model selection, and text file read/write.

## Core ACP Surface

- Session lifecycle goes through ACP (`newSession`, `loadSession`, `prompt`, `cancel`)
- The UI renders a subset of ACP session updates: assistant text, thinking text, tool calls, tool call updates, and plans
- Session history is persisted locally and restored after server restart

## Client Extensions

ACP allows the client to inject extra capabilities into the agent on top of its native baseline. WebAgent currently provides:

| Extension | Status | Notes |
|---|---|---|
| `fs` (readTextFile / writeTextFile) | ✅ Implemented | Agent can read/write files through the client |
| `terminal` | Declared but not wired | `!<command>` runs via the app's own local bash bridge, not ACP `terminal/*` |
| `mcpServers` | `[]` (no extras) | Agent's own MCP servers (e.g. GitHub MCP) work normally; passing `[]` means the client isn't providing additional ones |

Passing `mcpServers: []` does **not** disable MCP — the agent loads its own configured MCP servers independently. The parameter is for the client to provide _additional_ servers the agent wouldn't have on its own.

## Current Limits

- The web UI does not expose native CLI command surfaces such as `/plan`, `/fleet`, `/mcp`, `/agent`, or `/skills`
- Autopilot mode is supported: permissions are auto-approved server-side using `allow_once`
- Event handling is intentionally narrower than a native CLI client; only selected ACP updates are rendered/persisted, and the silent title-generation session suppresses normal UI events
- Model switching depends on the agent's ACP implementation and currently uses the SDK's unstable session-model API
- ACP does not expose context window usage, token counts, or remaining capacity
- No method to compact or clear session context; only option is to create a new session

In practice, this means WebAgent provides a browser UI for the core ACP chat/session workflow, but not the full product surface of direct Copilot CLI or Claude Code in a terminal.
