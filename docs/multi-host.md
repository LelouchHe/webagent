# Multi-host task operations

WebAgent's multi-host model lets a Task live on another WebAgent instance while
callers continue to use its Task id. A Task id is an address, not an
authorization grant: every entrypoint must establish the caller's authority
before it performs a command. Each instance owns its own SQLite database;
instances do not share database files or treat another instance's database as a
local store.

## Goals and non-goals

The goal is to separate Task commands from the question of which WebAgent
instance owns a Task. MCP and future clients can address a Task by id, then
hand the command to a host layer that resolves the owner and selects the local
or remote execution path.

This document describes architecture only. It does not add remote resolution,
routing, transport, shared storage, cross-instance idempotency, or a new public
MCP/REST shape. Browser and REST operations that need owner-local execution
facts remain local rather than being moved into this port.

## Architecture

```text
Entry points
  MCP: capability authorizes the request
  Browser REST: bearer token scope authorizes the request
                         |
                         v
                    TaskOps port
              (neutral types; 7 commands)
                         |
                         v
                 Host layer: resolve(id)
                 synchronous, read-only,
             persistent facts only; no network
                         |
             +-----------+-----------+
             |                       |
             v                       v
     local adapter [now]       remote adapter [plan]
     src/host/local.ts                 |
             |                       v
             |              router + transport [plan]
             v
   local TaskManager + Store
```

`src/host/types.ts` and the local adapter in `src/host/local.ts` exist now.
The remote adapter, router, and transport are planned; no production code in
this layer currently contacts another instance.

## Directories and dependencies

| Location | Responsibility |
| --- | --- |
| `src/mcp/` | MCP protocol handling, tool registration, capabilities, tool descriptions, and adaptation of protocol input/output |
| `src/host/types.ts` | The neutral `TaskOps` interface, command DTOs, and caller principal |
| `src/host/local.ts` | The local `TaskOps` implementation over this instance's TaskManager and Store |
| `src/host/` support modules | Projection and error helpers used only by the local implementation |
| `src/server.ts` | The only assembly point; it creates the local `TaskOps` and injects it into MCP |

The dependency direction is enforced by ESLint with
`no-restricted-imports`. `src/mcp/**` cannot import Store, TaskManager, or a host
module other than `src/host/types.ts`. `src/host/types.ts` cannot import Store
or TaskManager. The restrictions apply to value and type imports alike, and
`npm run lint` fails on a violation.

## `TaskOps` port

All methods retain their current parameters and result shapes.

| Method | Current caller | Result |
| --- | --- | --- |
| `list(principal)` | MCP `task_list` | Synchronous `McpTaskListItem[]` |
| `query(principal, input)` | MCP `task_query` | Synchronous `McpTaskQueryResult` |
| `read(principal, input)` | MCP `task_read` | Synchronous `McpTaskReadResult` |
| `cancel(principal, targetTaskId, reason)` | MCP `task_cancel` | `Promise<McpTaskCancelResult>` |
| `create(principal, input)` | MCP `task_create` | `Promise<McpTaskCreateResult>` |
| `send(principal, targetTaskId, body)` | MCP `task_send` | `Promise<void>` |
| `update(principal, status, body)` | MCP `task_update` | `Promise<{ note?: string }>` |

Authorization remains at the command entrypoint. The immutable principal is
part of the port because the local implementation must re-check execution
ownership at the write fences it already uses. For planned cross-instance
forwarding, transport must carry trusted host action context, and the owning
host must verify that context before executing the command. Possession of a
Task id alone never grants access.

## Owner-local facts

The port does not expose or virtualize ACP processes, ACP sessions, execution
bindings, execution generations, leases, capabilities, timers, bash processes,
files, or garbage collection. Those are facts and effects of the instance that
owns the Task. REST archive checks, Store failure observers, and related
owner-local lifecycle behavior also remain outside the port.

## Delivery model (planned)

At the owner, sending a message or reporting a typed update is a synchronous
local commit with the existing durability boundary: once accepted, the durable
fact exists before the call is reported complete. Cross-instance transport is a
background concern that persists and retries transport facts without changing
that local commit model.

The obligation account is maintained on the side that executes the Task. A
remote caller can submit the command, but the owner records delivery and
reporting effects in its own database and applies the existing account
semantics there.

## Verifying unchanged behavior

The external regression suite records REST, MCP, SSE, ACP, and SQL-visible
behavior in golden fixtures. Its operation and workflow are documented in
[`test/regression/README.md`](../test/regression/README.md). Multi-host
structural changes must pass that suite without changing a golden; any intended
external behavior change belongs to a later decision and a separate regression
update.
