# ACP Integration

WebAgent uses ACP for the core agent loop: session creation / restore, prompt turns, permission requests, streaming updates, model selection, and text file read/write.

## Core ACP Surface

- Session lifecycle goes through ACP (`newSession`, `loadSession`, `prompt`, `cancel`)
- WebAgent exposes its own stable UUID in REST/SSE and stores the agent's opaque
  ACP session ID in an internal mapping keyed by the `agent_cmd` executable
  token (normally an absolute path). Switching backends hides sessions belonging to other agents;
  switching back restores their original WebAgent URLs.
- ACP cancel is a notification rather than an acknowledgement. WebAgent keeps
  the prompt active until its prompt response supplies the terminal stop reason;
  timeout only marks the request unconfirmed.
- The UI renders a subset of ACP session updates: assistant text, thinking text, tool calls, tool call updates, and plans
- Session history is persisted locally and restored after server restart

## Client Extensions

ACP allows the client to inject extra capabilities into the agent on top of its native baseline. WebAgent currently provides:

| Extension                           | Status                 | Notes                                                                                                                  |
| ----------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `fs` (readTextFile / writeTextFile) | ✅ Implemented         | Agent can read/write files through the client                                                                          |
| `terminal`                          | Declared but not wired | `!<command>` runs via the app's own local bash bridge, not ACP `terminal/*`                                            |
| `mcpServers`                        | `[]` (no extras)       | Agent's own MCP servers (e.g. GitHub MCP) work normally; passing `[]` means the client isn't providing additional ones |

Passing `mcpServers: []` does **not** disable MCP — the agent loads its own configured MCP servers independently. The parameter is for the client to provide _additional_ servers the agent wouldn't have on its own.

## Current Limits

- The web UI does not expose native CLI command surfaces such as `/plan`, `/fleet`, `/mcp`, `/agent`, or `/skills`
- Autopilot mode is supported: permissions are auto-approved server-side using `allow_once`
- Event handling is intentionally narrower than a native CLI client; only selected ACP updates are rendered/persisted, and the silent title-generation session suppresses normal UI events
- Model switching depends on the agent's ACP implementation and currently uses the SDK's unstable session-model API
- ACP does not expose context window usage, token counts, or remaining capacity
- No method to compact or clear session context; only option is to create a new session

In practice, this means WebAgent provides a browser UI for the core ACP chat/session workflow, but not the full product surface of direct Copilot CLI or Claude Code in a terminal.

## Known Copilot CLI Artifacts

Copilot CLI may emit `Info: Operation cancelled by user` even when neither the
user nor WebAgent requested cancellation. This is an agent-output artifact, not
a reliable ACP cancellation signal:

- affected turns end with `prompt_done.stopReason = end_turn`, not `cancelled`;
- WebAgent service logs have no matching `cancel requested` entry;
- the text can occur twice consecutively in one assistant message;
- tools may all report `completed`, or a command may finish successfully while
  its final `tool_call_update.status = completed` is absent;
- browser locking/backgrounding only updates client visibility and never calls
  the cancel endpoint.

Copilot sub-agent results also commonly use `<final_answer>` as a one-sided
opening marker rather than a balanced HTML/XML element. This marker is not part
of ACP; it is text emitted by Copilot CLI's task wrapper. The wrapper result is
then commonly echoed into the following assistant stream, sometimes with parent
agent narration appended directly after it.

A 2026-08-08 dogfood database scan found:

| Sample                                                    | Count |
| --------------------------------------------------------- | ----: |
| Sessions scanned                                          |     8 |
| Sessions containing leading `<final_answer>` messages     |     5 |
| Leading-marker assistant messages                         |   207 |
| Missing `</final_answer>`                                  |   193 |
| Balanced markers                                          |    14 |
| Safely recognized by lifecycle prefix or closing boundary |   202 |
| Conservatively left unfolded                              |     5 |
| Observed reconstruction mismatches                        |     0 |

The five unresolved records were cancelled, truncated, or lacked both a closing
marker and an adjacent completed wrapper result. WebAgent deliberately leaves
those records unfolded rather than risk hiding parent-agent narration.

Live ACP chunk order cannot be reconstructed from SQLite row order because
assistant chunks are buffered before storage. The assistant echo may therefore
start before the wrapper's completed `tool_call_update` arrives. WebAgent folds
a leading marker provisionally while streaming, confirms its exact boundary
when the completed wrapper arrives, and restores ordinary assistant rendering
if the text diverges or the turn ends unverified. Replay and share rendering use
the same pure boundary matcher. Raw stored events are unchanged.

Balanced closing markers from the upstream agent would remove the ambiguous
boundary even when the wrapper completion is late or absent: WebAgent can fold
exactly through `</final_answer>` and leave following parent narration visible.
It would not remove the duplicate tool-result/assistant representation itself,
but it would make display handling deterministic without lifecycle correlation.

WebAgent preserves the emitted assistant text and normalized projections of the
supported ACP events in SQLite; it does not retain every complete ACP
notification. Display egress removes the unverified `by user` attribution, but
does not convert the artifact into a real session cancel. Further deduplication
and upstream tracking are recorded in [issue
#10](https://github.com/LelouchHe/webagent/issues/10).

## ACP vs Vendor SDKs

Each major agent vendor ships its own SDK for programmatic embedding:

| Vendor         | SDK                                                                                    | Languages                       |
| -------------- | -------------------------------------------------------------------------------------- | ------------------------------- |
| GitHub Copilot | [`@github/copilot-sdk`](https://github.com/github/copilot-sdk)                         | Node.js, Python, Go, .NET, Java |
| Claude Code    | [`@anthropic-ai/claude-code`](https://www.npmjs.com/package/@anthropic-ai/claude-code) | Node.js, Python                 |
| Codex CLI      | [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk)                 | Node.js, Python                 |

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

### ACP limitations

ACP is a protocol-level abstraction. The trade-off for agent-agnosticism is a thinner surface:

**Protocol gaps:**

- **Context visibility** — no token counts, context usage, or remaining capacity. The agent's context is a black box.
- **Context management** — no compact, summarize, or fork-session operations. The only reset path is creating a new session.
- **Cost / usage tracking** — no token usage or cost-per-request data. Users cannot tell how much a prompt costs.
- **Capability discovery** — `initialize` returns agent name/version but not what tools, models, or features the agent supports. WebAgent's `configOptions` relies on undocumented fields (`(session as any).configOptions`).
- **Model discovery** — no standard method to query available models. Currently uses the SDK's unstable session-model API.
- **Progress / phase signals** — no structured "thinking", "searching", "editing" stage indicators. Only raw streaming chunks; phase information depends on agent-specific event content.
- **Error semantics** — agent errors have no structured classification (rate limit vs. model error vs. tool failure). All failures are opaque.
- **Session portability** — sessions remain bound to the backend that created
  them. Switching agents hides rather than converts them; switching back makes
  them available again. ACP provides no export/import of context between
  different backends.
- **Permission granularity** — binary allow/deny only. No scoped permissions ("allow reads in this directory") or conditional approval.
- **Agent behavior configuration** — beyond capability declarations, the client cannot set temperature, system prompt, safety settings, or other agent parameters.
- **Streaming backpressure** — no flow control when the agent outputs faster than the client can process. WebAgent mitigates this with `limits.bash_output` but the protocol has no mechanism for it.

**Practical pain points:**

- **Event schema variance** — different agents may emit different structures for the same concept (e.g., tool call metadata). WebAgent maps only a defensive subset to stay cross-agent compatible.
- **Testing difficulty** — no standard mock agent. Integration tests require a real agent process with auth and network access, or a custom NDJSON mock.
- **CLI lifecycle is DIY** — spawning, restarting, health-checking, and version management are all the client's responsibility.

### Vendor SDK limitations

SDKs offer deeper integration but come with their own costs:

**Architecture constraints:**

- **Single-agent lock-in** — each SDK only drives its own CLI. Supporting multiple agents in one app means integrating multiple SDKs, each with its own process management, auth, and session state — essentially re-inventing ACP.
- **CLI version coupling** — SDKs bundle or pin specific CLI versions. New CLI features require waiting for a matching SDK release. The Copilot SDK docs explicitly warn "you must ensure version compatibility."
- **Heavy dependency** — SDKs pull in the entire CLI binary. `@github/copilot-sdk` includes the full Copilot CLI. Compare with `@agentclientprotocol/sdk` which is a lightweight protocol library.
- **Customization ceiling** — SDKs provide opinionated APIs for permissions, events, and sessions. Building custom UX (WebAgent's permission UI, multi-client broadcast, SQLite persistence) means fighting the SDK's design choices.
- **No web UI story** — SDKs target programmatic embedding, not UI. Session rendering, event dispatch, and multi-client sync still need to be built from scratch on top.

**Operational constraints:**

- **Multi-user complexity** — built-in auth works for single-user local apps but becomes complex server-side. Copilot SDK's scaling guide covers CLI-per-user isolation and token forwarding. WebAgent's one-bridge-many-sessions model is simpler.
- **Debugging through a wrapper** — SDK manages CLI process lifecycle, adding indirection when things go wrong. ACP gives direct access to the raw stdin/stdout stream.
- **SDK release dependency** — bugs in the SDK require waiting for a vendor fix. With ACP, protocol-level issues can often be worked around client-side.
- **Testing still needs real CLI** — SDK makes mocking the client easier, but integration tests still require a real CLI process with auth and API quota.

**Fundamental limits (shared with ACP):**

- **Agent behavior is still opaque** — even with SDKs, the core agent loop (planning, tool selection, execution strategy) is a black box. SDKs add more knobs (model selection, tool configuration) but the difference from ACP is degree, not kind.

### Trade-off summary

|                            | Vendor SDK                         | WebAgent (ACP)                  |
| -------------------------- | ---------------------------------- | ------------------------------- |
| Agent support              | Single vendor only                 | Any ACP-compatible agent        |
| Multi-agent in one app     | Requires multiple SDK integrations | One protocol, swap `agent_cmd`  |
| Setup effort               | Low (SDK manages CLI)              | Medium (manual CLI + config)    |
| Context visibility/compact | Available (vendor-dependent)       | Not available (protocol gap)    |
| Cost / token tracking      | Available                          | Not available                   |
| Auth handling              | Built-in                           | Relies on CLI's own auth        |
| Depth of integration       | Deep (vendor-specific features)    | Protocol surface only           |
| Customization freedom      | Constrained by SDK opinions        | Full control                    |
| Vendor lock-in             | Yes                                | No                              |
| Dependency weight          | Heavy (bundles CLI binary)         | Light (protocol library only)   |
| Ecosystem alignment        | Vendor ecosystem                   | ACP / Zed / JetBrains ecosystem |

### When to use which

- **Use a vendor SDK** if you are building an app tightly coupled to one specific agent and need deep integration with its runtime (context management, auth flows, cost tracking, agent-specific hooks).
- **Use ACP (WebAgent's approach)** if you want a single UI that works across agents, value customization freedom, or if agent swappability matters more than depth of integration with any one vendor.

The core trade-off: SDKs give you **depth** (more knobs, more data, tighter integration) at the cost of **breadth** (single vendor). ACP gives you **breadth** (any agent, full UX control) at the cost of **depth** (thinner protocol surface, less visibility into agent internals).

## Agent Compatibility

Not all coding CLIs support ACP natively. See [Configuration — ACP-Compatible Agents](configuration.md#acp-compatible-agents) for which agents work out of the box and which need an adapter.
