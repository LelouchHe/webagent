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

## ACP vs Vendor SDKs

Each major agent vendor ships its own SDK for programmatic embedding:

| Vendor | SDK | Languages |
|---|---|---|
| GitHub Copilot | [`@github/copilot-sdk`](https://github.com/github/copilot-sdk) | Node.js, Python, Go, .NET, Java |
| Claude Code | [`@anthropic-ai/claude-code`](https://www.npmjs.com/package/@anthropic-ai/claude-code) | Node.js, Python |
| Codex CLI | [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk) | Node.js, Python |

All three SDKs share the same pattern: they spawn their own CLI as a subprocess, communicate via JSON-RPC over stdio, and provide a high-level language-specific API on top. Each SDK is locked to its own CLI — there is no cross-SDK interoperability (you cannot use Copilot SDK to drive Claude Code, or vice versa).

WebAgent takes a different approach: it uses the [Agent Client Protocol](https://agentclientprotocol.com/) directly, which is a vendor-neutral protocol supported by 25+ agents via native support or community adapters.

### Architecture comparison

```
Vendor SDK approach (vertical, per-vendor):

  Your App → @github/copilot-sdk → Copilot CLI      (only Copilot)
  Your App → @anthropic-ai/claude-code → Claude Code  (only Claude)
  Your App → @openai/codex-sdk → Codex CLI            (only Codex)

ACP approach (horizontal, agent-agnostic):

  WebAgent → ACP protocol → copilot --acp
                           → claude-agent-acp
                           → codex-acp
                           → gemini --experimental-acp
                           → opencode acp
                           → ... any ACP agent
```

### What the SDKs provide that ACP does not

Vendor SDKs expose deeper integration with their specific agent runtime:

- **Context visibility** — some SDKs surface token counts, context usage, and remaining capacity. ACP treats the agent's context as a black box.
- **Context management** — SDKs may offer compact, summarize, or fork-session operations. ACP has no method to compact or clear context; the only reset path is creating a new session.
- **CLI lifecycle management** — SDKs auto-bundle the CLI binary, handle version checks, and manage the process lifecycle. WebAgent spawns the CLI manually and handles restart/reload itself.
- **Authentication flows** — SDKs provide built-in OAuth, BYOK (bring your own key), and environment variable auth. WebAgent relies on whatever auth the CLI already has configured.
- **Agent-specific features** — hooks, custom skills, fleet/cloud delegation, and other vendor-specific capabilities are exposed through the SDK API but may not surface through ACP events.
- **Streaming granularity** — SDKs may offer richer streaming events (e.g., per-token callbacks, cost tracking) beyond what ACP session updates provide.

### What ACP provides that vendor SDKs do not

- **Agent swappability** — change `agent_cmd` in config to switch agents without code changes. SDKs require rewriting integration code to switch vendors.
- **Protocol-level interop** — ACP is backed by the Linux Foundation (Agentic AI Foundation) alongside MCP and A2A. It is the same protocol used by Zed, JetBrains, and other editors for multi-agent support.
- **No vendor lock-in** — WebAgent's session management, permission UI, event routing, and persistence are all independent of the agent. Switching from Copilot to Claude Code is a one-line config change.
- **Custom client capabilities** — WebAgent implements its own file read/write, bash execution, and permission flows on the client side, giving full control over what the agent can do.

### Trade-off summary

| | Vendor SDK | WebAgent (ACP) |
|---|---|---|
| Agent support | Single vendor only | Any ACP-compatible agent |
| Setup effort | Low (SDK manages CLI) | Medium (manual CLI + config) |
| Context/compact | Available (vendor-dependent) | Not available |
| Auth handling | Built-in | Relies on CLI's own auth |
| Depth of integration | Deep (vendor-specific features) | Protocol surface only |
| Vendor lock-in | Yes | No |
| Multi-language | Yes (per SDK) | N/A (WebAgent is the client) |
| Ecosystem alignment | Vendor ecosystem | ACP / Zed / JetBrains ecosystem |

### When to use which

- **Use a vendor SDK** if you are building an app tightly coupled to one specific agent and need deep integration with its runtime (context management, auth flows, cost tracking, agent-specific hooks).
- **Use ACP (WebAgent's approach)** if you want a single UI that works across agents, or if agent swappability matters more than depth of integration with any one vendor.

In practice, the main pain point of the ACP approach is the lack of context visibility and management — there is no way to know how full the context window is, no way to compact it, and no way to fork or summarize a session. These are protocol-level gaps in ACP itself, not implementation gaps in WebAgent.

## Agent Compatibility

Not all coding CLIs support ACP natively. See [Configuration — ACP-Compatible Agents](configuration.md#acp-compatible-agents) for which agents work out of the box and which need an adapter.
