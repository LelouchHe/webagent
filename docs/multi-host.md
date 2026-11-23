# Multi-host task operations

WebAgent's multi-host model is planned to let a Task live on another WebAgent
instance while callers continue to use its Task id. A Task id is an address, not an
authorization grant: every entrypoint must establish the caller's authority
before it performs a command. Each instance owns its own SQLite database;
instances do not share database files or treat another instance's database as a
local store.

## Goals and non-goals

The goal is to separate Task commands from the question of which WebAgent
instance owns a Task. MCP and future clients can address a Task by id, then
hand the command to a host layer that resolves the owner and selects the local
or remote execution path.

This document describes the architecture and the connection layer that exists
today. It does not add remote Task resolution, Task routing, shared storage,
cross-instance idempotency, or a new public MCP/REST Task shape. Browser and REST
operations that need owner-local execution facts remain local.

## Architecture

```text
Entry points
  MCP [now]: capability authenticates the caller; principal frozen
  Browser REST [plan: via a gateway]: bearer token scope, already
    enforced today on the local routes
                         |
                         v
                TaskOps port [now]
              (neutral types; 7 commands)
                         |
                         v
           Host layer: resolve(id) [plan]
                 synchronous, read-only,
             persistent facts only; no network
                         |
             +-----------+-----------+
             |                       |
             v                       v
     local/ adapter.ts [now]    remote/ connection [now]
             |                       |
             v                       +-- remote/ adapter.ts [plan]
   local TaskManager + Store             |
                                         v
                                  Task transport [plan]
```

Today MCP calls the local adapter directly through `TaskOps`; there is no
`resolve(id)` step yet, and browser REST routes still call the local domain code
directly. `src/host/task-ops.ts` and `src/host/local/adapter.ts` exist now.
`src/host/remote/` currently contains the cross-instance connection only; the
resolver, remote Task adapter, Task router, and delivery transport are planned.

## Connections

A hub keeps one independent, in-memory connection per configured
`[hosts.<name>]` entry. The owner does not need matching configuration. Each hub
host connection uses an owner-issued Bearer token and exposes no raw token or
token-command output through the API or logs.

```text
hub                                      owner
 |-- GET /api/v1/host ---------------------->| describe + credential fingerprint
 |<------------------------------------------|
 |-- POST /api/v1/sse-ticket --------------->| short-lived stream ticket
 |<------------------------------------------|
 |-- GET /api/v1/events/stream?ticket=… ---->| persistent global SSE
 |<============ connected + heartbeat =======|
 |                                           |
 |           reconnect with capped backoff after EOF, timeout, or failure
```

The connection becomes `connected` after the SSE handshake. Each owner heartbeat
refreshes liveness; three missed 15-second heartbeat intervals disconnect the
stream, so heartbeat failure is detected after about 45 seconds plus at most
one polling interval. A disconnected host retries independently with capped
exponential backoff. Every successful connection invokes an empty catch-up
hook; later delivery work will replace that hook without changing the connection
mechanism.
Connection state never writes to SQLite and never changes Task facts.

`GET /api/v1/host` is the owner identity endpoint. It reports protocol version,
server version, and the authenticated caller's token name, scope, and SHA-256
fingerprint. `GET /api/v1/hosts` reports the hub's connection state. See
[the API reference](api.md#hosts) for exact response shapes and
[configuration](configuration.md#multi-host-connection) for token commands.

## Directories and dependencies

| Location | Responsibility |
| --- | --- |
| `src/mcp/` | MCP protocol handling, tool registration, capabilities, tool descriptions, and adaptation of protocol input/output |
| `src/host/task-ops.ts` | The neutral `TaskOps` interface, command DTOs, and caller |
| `src/host/local/adapter.ts` | The local `TaskOps` implementation over this instance's TaskManager and Store |
| `src/host/local/` | Local projection and error helpers; cannot depend on remote implementations |
| `src/host/remote/` | Current hub connection, credential hashing, retry/backoff, and in-memory status; the remote `adapter.ts` and Task delivery transport are planned |
| `src/server.ts` | The only assembly point; it creates the local `TaskOps` and injects it into MCP |

ESLint's `no-restricted-imports` guards the direct static dependencies:
`src/mcp/**` cannot import Store, TaskManager, or a host module other than
`src/host/task-ops.ts`, and `src/host/task-ops.ts` cannot import Store or
TaskManager. `src/host/remote/**` cannot import Store, TaskManager, or
`src/host/local/**`; owner-side local commands will be injected through
`TaskOps`. `src/host/local/**` cannot import `src/host/remote/**`. Static value
and type imports and re-exports are covered, and `npm run lint` fails on a
violation. The rule does not follow the module graph, dynamic `import()`, or
inline `import("…").Type` references; those indirect paths are left to review.

## `TaskOps` port

All methods retain their current parameters and result shapes.

| Method | Current caller | Result |
| --- | --- | --- |
| `list(principal)` | MCP `task_list` | Synchronous `TaskListItem[]` |
| `query(principal, input)` | MCP `task_query` | Synchronous `TaskQueryResult` |
| `read(principal, input)` | MCP `task_read` | Synchronous `TaskReadResult` |
| `cancel(principal, targetTaskId, reason)` | MCP `task_cancel` | `Promise<TaskCancelOutcome>` |
| `create(principal, input)` | MCP `task_create` | `Promise<TaskCreateResult>` |
| `send(principal, targetTaskId, body)` | MCP `task_send` | `Promise<void>` |
| `update(principal, status, body)` | MCP `task_update` | `Promise<{ note?: string }>` |

Authorization is split between the two sides of the port today. The MCP entry
(`src/mcp/server.ts`) authenticates the capability, checks that the task is
active, and freezes the caller principal; it does not decide what that caller
may do to a target. Each `TaskOps` command in `src/host/local/adapter.ts` then checks
the principal's current execution generation and its relation to the target
before any side effect, and re-checks at the write fences after each await. An
authenticated principal is therefore not yet an authorized action. For planned cross-instance
forwarding, transport must carry trusted host action context, and the owning
host must verify that context before executing the command. Possession of a
Task id alone never grants access.

The port still uses the MCP tool result contract: snake_case fields such as
`task_id` and `max_seq`, and the current byte limits. `TaskCaller.initializing`
also names a concept from the MCP handshake period. These couplings remain
while MCP is the only caller; a second caller is the point at which they
should be separated.

## Owner-local facts

The port does not expose or virtualize ACP processes, ACP sessions, execution
bindings, execution generations, leases, capabilities, timers, bash processes,
files, or garbage collection. Those are facts and effects of the instance that
owns the Task. REST archive checks, Store failure observers, and related
owner-local lifecycle behavior also remain outside the port.

## Delivery model (planned)

Sending a message or reporting a typed update is a synchronous local commit on
the caller's own instance: the call returns once that instance has durably
accepted it. Moving the message to another instance is background transport
that persists and retries its own facts; network delivery, reachability, and
the remote outcome are never part of the synchronous result.

The obligation account is maintained on the side that executes the Task. A
remote caller can submit the command, but the owner records delivery and
reporting effects in its own database and applies the existing account
semantics there.

## Verifying unchanged behavior

The external regression suite records REST, MCP, SSE, ACP, and SQL-visible
behavior in golden fixtures. Its operation and workflow are documented in
[`test/regression/README.md`](../test/regression/README.md). Multi-host
changes must keep existing single-instance behavior unchanged, so they pass
that suite without changing an existing golden. New cross-instance behavior
adds its own scenarios; an intended change to local behavior shows up as a
reviewed golden diff.
