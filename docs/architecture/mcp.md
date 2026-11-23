# MCP in the Architecture

MCP is the agent entry into the server, as the HTTP API is the client entry.
An agent running in an ACP session reaches WebAgent through an MCP server that
WebAgent injects into that session. This document describes where that entry
sits and what it is responsible for. The tools it exposes today — the task
tools — are documented in [Task MCP Control Plane](../task-mcp.md).

## Position

```text
 ACP agent session                               WebAgent server
 +----------------------+   session/new, load   +-----------------------------+
 | agent's MCP client   |<-- mcpServers entry --| AgentBridge (bridge.ts)     |
 |                      |    (URL + capability) |                             |
 |                      |                       |                             |
 |  tool call --------------- POST /mcp -------->| MCP entry (mcp/server.ts)   |
 |                      |  Bearer <capability>  |   authenticate capability   |
 |                      |                       |   freeze caller (TaskCaller)|
 |                      |                       |   tools (mcp/tools.ts)      |
 |                      |<-- tool result -------|        |                    |
 +----------------------+                       |        v                    |
                                                | TaskOps port -> domain core |
                                                +-----------------------------+
```

The MCP entry is a thin adapter, the counterpart of the REST route handlers:
it handles the protocol, authenticates the caller, validates input, and
presents results. The server capabilities it calls are the same ones the
client entry reaches; see [Server Architecture](server.md).

## How an agent reaches it

WebAgent does not write an agent's MCP configuration. When it creates or
restores an ACP session, it attaches the `lelouchhe_webagent` server to the
session request through ACP's `mcpServers` field, with a capability minted for
that session. The agent's own MCP implementation connects to it. An agent that
does not use the field still works normally; it just has no WebAgent tools.
Details and agent compatibility are in
[Task MCP Control Plane](../task-mcp.md#how-the-server-reaches-the-agent).

## Authentication and the caller

- **Capability** (`src/mcp/capability.ts`): one token per session, naming one
  task and the agent whose execution it belongs to. It starts initializing while
  the session is being created and is promoted when the task's binding commits,
  pinned to that commit's execution generation. Rotation, deletion, and a Root
  reset revoke it.
- **Caller**: `src/mcp/server.ts` authenticates each request with the
  capability, checks that the task is active, and freezes a `TaskCaller` — the
  task, its agent, and the generation. The entry does not decide what that
  caller may do to a target; each `TaskOps` command checks the caller's
  generation and family relation before any side effect.

The MCP endpoint is claimed before the HTTP auth gate: it does not accept
Bearer API tokens, and a capability grants nothing on `/api/**`.

## What the entry does and does not do

| Does | Does not |
| --- | --- |
| Serve MCP over Streamable HTTP at `/mcp` | Import Store or TaskManager (enforced by ESLint) |
| Register tools and validate their input schemas | Decide authorization against a target |
| Build tool descriptions from the running configuration (the `task_create` agent list) | Execute work or start agents |
| Advertise the cross-tool model at `initialize` (`MCP_SERVER_INSTRUCTIONS`) | Persist anything of its own |
| Present results and errors as tool output written for the calling agent | Share result shapes with REST |

## Tools today

The task tools (`task_list`, `task_query`, `task_read`, `task_create`,
`task_send`, `task_update`, `task_cancel`) are the only group today, and they
call the `TaskOps` port. The entry itself is not specific to tasks: a new group
of agent-facing tools would register in the same way and call the server
through the same kind of port.

## Relation to the client entry

Both entries reach the same domain core, but today they do not share one
command surface: MCP goes through `TaskOps`, while REST handlers call the
domain core directly, and a few behaviors differ by entry.
[Server Architecture](server.md#where-the-server-is-not-yet-neutral) lists the
differences; [Multi-host](multi-host.md) describes how every entry converges
on one server interface.
