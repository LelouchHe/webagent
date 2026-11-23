# Architecture

WebAgent is a thin-client, heavy-server system. Two kinds of callers reach one
server through two entrypoints, and the server holds the logic.

## Principle

- **The external interfaces stay stable.** The browser and any other client use
  the HTTP API (REST + SSE); agents use MCP tools. Each is shaped for its
  caller, and neither needs to know how the server works inside.
- **The server is neutral.** A request from the HTTP API, from MCP, or from any
  future entrypoint reaches the same server capability and behaves the same.
  Entrypoints only parse input, authenticate the caller, and present the
  result.
- **Execution location is the server's concern.** With
  [multi-host](multi-host.md), a task may run on another WebAgent instance.
  Clients and agents still address it the same way; the server decides where
  the work runs.

## Parts

```text
  Browser / REST clients                          ACP agents
          |                                            |
          | Client entry: REST + SSE                   | Agent entry: MCP tools
          |   (client.md, ../api.md)                   |   (mcp.md)
          v                                            v
  +------------------------------------------------------------------+
  | Server (server.md): entry adapters, domain core, execution,      |
  | events and egress                                                |
  |                                                                  |
  |   below the server interface: local or remote execution          |
  |   (multi-host.md)                                                |
  +------------------------------------------------------------------+
          |                                            |
          v                                            v
   SQLite, attachments, files                  ACP agent subprocesses
```

| Part | Document | Covers |
| --- | --- | --- |
| Client entry | [Client Architecture](client.md) | The browser client: modules, connection lifecycle, data flow, task switching, event handling |
| Agent entry | [MCP](mcp.md) | The MCP endpoint as the agent entry: how it reaches sessions, authenticates the caller, and hands commands to the server |
| Server | [Server Architecture](server.md) | Entrypoint handling, domain core, execution, events and egress, cross-cutting mechanisms, request paths |
| Multi-host | [Multi-host](multi-host.md) | Instances connected to each other; the `TaskOps` port and the local / remote split |

The server is not yet fully neutral: today MCP and the migrated REST create and
cancel commands reach the domain core through the `TaskOps` port while other
REST handlers call it directly.
[Server Architecture](server.md#where-the-server-is-not-yet-neutral) lists the
gaps, and [Multi-host](multi-host.md) describes how they close.

## Document map

| Part | Reference documents |
| --- | --- |
| Client entry | [API Reference](../api.md), [Features](../features.md), [Task UX](../task-ux.md), [Slash Menu](../slash-menu.md), [Streaming Render Performance](../performance.md), [Agent image rendering](../image-rendering.md) |
| Agent entry | [Task MCP Control Plane](../task-mcp.md) (tool reference), [Task Manual](../task-manual.md), [Task Examples](../task-examples.md) |
| Server | [Task Lifecycle](../task-lifecycle.md), [Task Obligations](../task-obligations.md), [Database Schema](../schema.md), [ACP Integration](../acp.md), [Attachments](../uploads.md), [Messages / Inbox](../messages.md), [Share Links](../share.md), [Security](../security.md) |
| All parts | [Implementation Invariants](../implementation-invariants.md), [Vocabulary](../vocabulary.md), [Known Issues](../known-issues.md) |
| Operations | [Configuration & Operations](../configuration.md), [Auto-Start on Boot](../autostart.md), [Development](../development.md) |
