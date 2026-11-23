# Multi-host task operations

WebAgent's multi-host model is planned to let a Task live on another WebAgent
instance while callers continue to use its Task id. A Task id is an address, not an
authorization grant: every entrypoint must establish the caller's authority
before it performs a command. Each instance owns its own SQLite database;
instances do not share database files or treat another instance's database as a
local store.

## Goals and non-goals

The goal is that clients and agents do not care where a Task runs. The HTTP
API (for the browser and other clients) and the MCP tools (for agents) keep
their shapes; with hosts configured, a remote Task is addressed and operated
exactly like a local one. Inside the server, every entrypoint converges on one
server interface (see [Architecture](README.md)); below it, a host layer selects
local or remote execution.

This document describes that direction and the parts that exist today: the
`TaskOps` port and the connection layer. Remote Task resolution, routing,
cross-instance idempotency, and delivery are not implemented yet. Instances
never share storage.

## Architecture

```text
Entry points
  MCP [now]: capability authenticates the caller; principal frozen
  Browser REST create/cancel [now]: bearer-authenticated HTTP adapters
  Other browser REST commands [plan]
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

Today MCP and the general REST task-create route call the local adapter through
the same `TaskOps.create()` command, and REST task cancellation and MCP
`task_cancel` share `TaskOps.cancel()`. There is no `resolve(id)` step yet, and
the other REST routes still call the local domain code directly.
`src/api/tasks.ts` and `src/host/local/adapter.ts` exist now.
`src/host/remote/` currently contains the cross-instance connection only; the
resolver, remote Task adapter, Task router, and delivery transport are planned.

## Scope of the host layer (planned)

The host layer is an execution library: it hides where execution happens. A
capability belongs to it when its result depends on which instance executes
it and it is extended to remote instances:

| Capability | Why it depends on location |
| --- | --- |
| Task operations: create, list, history, cancel, messages and updates, prompt, configuration, bash, attachments, permissions, events | They run where the Task lives |
| Agent catalog: configured agents, models, commands | Each instance configures its own agents |
| Recent paths and file browsing | They describe that instance's file system |

Capabilities that do not depend on location stay in the server: tokens, SSE
tickets, push and client visibility, the inbox, shares, host status. A
cross-instance call is an ordinary operation whose other side is on another
instance: it enters the peer through the peer's existing entrypoints with a
host credential, and the peer runs it as an ordinary local operation. There is
no separate host protocol.

## Connections

A hub keeps one independent, in-memory connection per configured
`[hosts.<name>]` entry. The owner does not need matching configuration. Each hub
host connection uses an owner-issued Bearer token and exposes no raw token or
token-command output through the API or logs.

```text
hub                                      owner
 |-- GET /api/v1/version ------------------->| host protocol
 |<------------------------------------------|
 |-- GET /api/v1/auth/verify --------------->| token hash + scope
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

The public version endpoint advertises `hostProtocol`; the authenticated
verify endpoint reports the caller's token name, scope, and SHA-256 `hash`.
`GET /api/v1/hosts` reports the hub's connection state for diagnostics and
regression observation. The browser UI does not consume it yet. See
[the API reference](../api.md#hosts) for exact response shapes and
[configuration](../configuration.md#multi-host-connection) for token commands.

## Directories and dependencies

| Location | Responsibility |
| --- | --- |
| `src/mcp/` | MCP protocol handling, tool registration, capabilities, tool descriptions, and adaptation of protocol input/output |
| `src/http/` | HTTP entrypoint, including the main request/auth/router order, REST/SSE presentation, and the migrated REST task create and cancel calls to `TaskOps` |
| `src/api/tasks.ts` | The neutral `TaskOps` interface, command DTOs, and caller |
| `src/host/local/adapter.ts` | The local `TaskOps` implementation over this instance's TaskManager and Store |
| `src/host/local/` | Local projection and error helpers; cannot depend on remote implementations |
| `src/host/remote/` | Current hub connection, token hash verification, retry/backoff, and in-memory status; the remote `adapter.ts` and Task delivery transport are planned |
| `src/server.ts` | The only assembly point; it creates the local `TaskOps` and injects the same instance into the HTTP router and MCP |

ESLint's `no-restricted-imports` guards direct static dependencies:
`src/http/**` and `src/mcp/**` cannot import each other or a Host module and
use `src/api/tasks.ts` for the task command contract; MCP also cannot import
Store or TaskManager.
Core and host modules cannot import HTTP or MCP entrypoints. `src/server.ts` is
the assembly exception, and `src/task-manager.ts` retains only its two named
legacy MCP imports (`buildMcpServerEntry` and the `CapabilityStore` type).
`src/api/tasks.ts` cannot import entrypoints, Host modules, Store, or
TaskManager. `src/host/remote/`
cannot import Store, TaskManager, or `src/host/local/`; owner-side local commands
are injected through `TaskOps`. `src/host/local/` cannot import
`src/host/remote/`. Static value and type imports and re-exports at any nested
depth are covered, and `npm run lint` fails on a violation. The rules do not
follow the module graph, dynamic `import()`, or inline `import("…").Type`
references; those indirect paths are left to review.
The moved main router has one line-level exception for the legacy host
protocol version import. It remains until that protocol fact lives in a
neutral host contract; the route's registry dependency is structural rather
than a direct `HostRegistry` implementation import.

## `TaskOps` port

The existing MCP-only methods retain their parameters and result shapes. Create
has been neutralized for its first REST caller.

| Method | Current caller | Result |
| --- | --- | --- |
| `list(principal)` | MCP `task_list` | Synchronous `TaskListItem[]` |
| `query(principal, input)` | MCP `task_query` | Synchronous `TaskQueryResult` |
| `read(principal, input)` | MCP `task_read` | Synchronous `TaskReadResult` |
| `cancel(command)` | MCP `task_cancel`, REST `POST /api/v1/tasks/:id/cancel` | `Promise<TaskCancelOutcome>` |
| `create(caller, input)` | MCP `task_create`, REST `POST /api/v1/tasks` | `Promise<TaskCreateResult>` |
| `send(principal, targetTaskId, body)` | MCP `task_send` | `Promise<void>` |
| `update(principal, status, body)` | MCP `task_update` | `Promise<{ note?: string }>` |

Authorization is split between the two sides of the port today. The MCP entry
(`src/mcp/server.ts`) authenticates the capability, checks that the task is
active, and freezes the caller principal; it does not decide what that caller
may do to a target. REST cancellation authenticates with the existing HTTP
bearer gate, checks task existence, and applies client-op replay before calling
the shared command. Each agent `TaskOps` command in `src/host/local/adapter.ts` then checks
the principal's current execution generation and its relation to the target
before any side effect, and re-checks at the write fences after each await. An
authenticated principal is therefore not yet an authorized action. For planned cross-instance
forwarding, transport must carry trusted host action context, and the owning
host must verify that context before executing the command. Possession of a
Task id alone never grants access.

Create keeps caller kind separate from the requested parent and inheritance
source. An agent caller maps to its own parent and cwd context and is
generation-fenced; a user caller carries the authenticated REST route's
independent `parentId` and `inheritFromTaskId`. The user result carries complete activation facts, which REST exposes directly;
the MCP projection remains the existing `{ taskId }` result.

Cancellation keeps the two caller policies separate. An agent command requires
a direct-child relation, carries a generation-fenced principal and reason, and
writes the existing source/target audit rows after re-checking that principal.
A user command carries only the target Task id: HTTP owns its authorization and
replay policy, and cancellation keeps the existing REST behavior of writing no
agent cancellation audit rows. Both commands resolve only an existing local
execution and therefore do not warm an agent process.

Other operations still use the MCP tool result contract: snake_case fields such as
`task_id` and `max_seq`, and the current byte limits. `TaskCaller.initializing`
also names a concept from the MCP handshake period. These couplings remain
until each operation gains a second caller.

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
[`test/regression/README.md`](../../test/regression/README.md). Multi-host
changes must keep existing single-instance behavior unchanged, so they pass
that suite without changing an existing golden. New cross-instance behavior
adds its own scenarios; an intended change to local behavior shows up as a
reviewed golden diff.
