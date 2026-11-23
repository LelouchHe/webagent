# Server Architecture

The server holds WebAgent's logic. Clients stay thin: the browser and any other
REST client reach it through the HTTP API, and agents reach it through MCP
tools. The design principle is that **the server is neutral**: a capability
behaves the same whichever entrypoint invoked it, and the entrypoints only
parse, authenticate, and present.

This document describes the server **as it is built today**, including the
places where it is not yet neutral (see
[Where the server is not yet neutral](#where-the-server-is-not-yet-neutral)).
The entrypoint contracts live in [Client Architecture](client.md) and
[Task MCP Control Plane](mcp.md); the cross-instance direction lives in
[Multi-host](multi-host.md). Rules that every change must keep are in
[Implementation Invariants](../implementation-invariants.md).

## Overview

```text
 Browser / REST clients                     ACP agents
   REST + SSE  (/api/v1/**)                  MCP tools  (/mcp, Streamable HTTP)
          |                                          |
          v                                          v
 +-------------------------------+     +----------------------------------+
 | HTTP entry  (routes.ts)       |     | MCP entry  (mcp/server.ts)       |
 |  request boundary             |     |  capability token -> TaskCaller  |
 |  auth gate (auth-middleware)  |     |  tool registration (mcp/tools.ts)|
 |  share / files sub-routers    |     +----------------+-----------------+
 |  /api/v1 route handlers       |                      |
 +---------------+---------------+                      v
                 |                       TaskOps port (host/task-ops.ts)
                 |                       local adapter (host/local/adapter.ts)
                 |                                      |
                 v                                      v
 +--------------------------------------------------------------------------+
 | Domain core                                                              |
 |  TaskManager (task-manager.ts): tasks, prompts, buffers, deliveries,     |
 |    bash processes, rotation, deletion                                    |
 |  Store (store.ts): SQLite persistence of tasks and raw ACP events        |
 |  ExecutionAuthority, TaskState, ObligationController, TaskTreeLock       |
 +------------------------------------+-------------------------------------+
                                      |
                                      v
 +--------------------------------------------------------------------------+
 | Execution: AgentRegistry -> ExecutionAdapter -> AgentBridge              |
 |            (one ACP subprocess per started agent, started on demand)     |
 +------------------------------------+-------------------------------------+
                                      | ACP events
                                      v
 +--------------------------------------------------------------------------+
 | Egress: handleAgentEvent (event-handler.ts) -> Store + TaskState         |
 |         -> SseManager (sse-manager.ts) -> clients; PushService           |
 +--------------------------------------------------------------------------+

 Host layer (src/host/remote/): outbound connections to other instances
```

MCP reaches the domain core through the `TaskOps` port. REST route handlers
call `TaskManager` and `Store` directly. Both paths end in the same domain
core, but they do not yet share one command surface.

## Entrypoints

### HTTP

`createRequestHandler()` in `src/routes.ts` handles every request in this
order:

1. **MCP** — `/mcp` is claimed first; that endpoint authenticates with its own
   per-session capability, not with a Bearer token.
2. **Auth gate** — any `/api/**` path outside the public whitelist in
   `src/auth-middleware.ts` requires a Bearer token. A `read`-scope token is
   further limited to an allowlist checked before any route runs, so a new
   endpoint is denied to `read` until it is deliberately opened.
3. **Share routes** (`src/share/routes.ts`) — public viewer paths and owner
   share endpoints, claimed before the generic API branch.
4. **File routes** (`src/files/routes.ts`) — task-less, read-only access to
   local paths (`/api/v1/files/{info,list,content}`); `content` is served only
   through an HMAC-signed URL.
5. **`/api/v1` routes** — tasks, messages, permissions, config, recent paths,
   tokens, bash, attachments, SSE streams, inbox, and the rest of the
   [API Reference](../api.md).
6. **Static files** — the app shell and hashed bundles; HTML entrypoints are
   registered in `HTML_ENTRYPOINTS`.

`withRequestErrorBoundary()` (`src/request-boundary.ts`) wraps the handler so a
malformed request or an unexpected throw answers with an error instead of
crashing the process. An `EventSource` cannot send a header, so SSE streams
authenticate with a short-lived single-use ticket minted by
`POST /api/v1/sse-ticket` (`src/sse-ticket.ts`). Token, ticket, signed-URL, and
CSP rules are in [Security](../security.md).

### MCP

`src/mcp/server.ts` serves the MCP control plane to ACP sessions over
Streamable HTTP. WebAgent mints a capability token for each session it starts
(`src/mcp/capability.ts`) and injects the `lelouchhe_webagent` server into that
session. Each request authenticates with the capability; the endpoint checks
that the task is active and freezes the caller as a `TaskCaller` (the task, its
agent, and the execution generation the capability was promoted for).
`src/mcp/tools.ts` registers the `task_*` tools and calls the `TaskOps` port;
the `task_create` description is rebuilt per request from the running
configuration. The tool contracts are in [Task MCP Control Plane](mcp.md).

### Composition root

`src/server.ts` is the only place that assembles the server. It loads the
configuration, constructs the Store, TaskManager, AgentRegistry, SseManager,
PushService, ClientRegistry, AuthStore, TicketStore, and HostRegistry, wires the
broadcast callbacks, creates the local `TaskOps` adapter and the MCP endpoint,
builds the request handler, and creates one transport per agent with its event
listener. It also owns graceful shutdown. `src/startup-checks.ts` and
`src/preflight.ts` run before any of this on every launch path, and
`src/daemon.ts` implements the background service commands
([Configuration & Operations](../configuration.md)).

## Domain core

| Module | Responsibility |
| --- | --- |
| `src/task-manager.ts` | Live task runtime: creation (one entry point for REST create, quick prompt, inbox consume, and `task_create`), prompt submission slots, chunk buffers, collaboration delivery drain, bash processes, compaction and clear rotation, deletion and Root replacement. Broadcasts through callbacks injected by `server.ts`. |
| `src/store.ts` | SQLite persistence: tasks, bindings, raw ACP events, messages and deliveries, attachments, shares, push subscriptions, client op results, recent paths. See [Database Schema](../schema.md). |
| `src/execution-authority.ts` | Which execution may still write to a task: the binding, the per-task generation (not persisted), and the lease validated at the write boundaries. |
| `src/task-state.ts` | Per-task runtime state (busy, streaming, pending permissions, plan): a snapshot on connect plus incremental `state_patch` events. |
| `src/obligation-controller.ts`, `src/task-collaboration.ts`, `src/collaboration-message.ts` | Directed-dispatch accounts, reminders, and notices; the arming policy; runtime message titles. See [Task Obligations](../task-obligations.md). |
| `src/task-tree-lock.ts` | In-process hierarchical lock for structural tree mutations. |

The task model — states, transitions, and what each keeps or drops — is in
[Task Lifecycle](../task-lifecycle.md); naming is in
[Vocabulary](../vocabulary.md).

## Execution

| Module | Responsibility |
| --- | --- |
| `src/agent-registry.ts` | Which agents exist, and a started adapter for one on demand. Starts and reloads share a single-flight slot per agent, so one agent never has two live processes. |
| `src/execution-adapter.ts` | One agent-scoped execution environment: the facts that belong to the process driving ACP sessions for one configured agent (config schema, agent identity), not to any task. |
| `src/bridge.ts` | `AgentBridge`: one ACP subprocess per started agent, multiplexing that agent's sessions; handshake, session create/restore/prompt/cancel, permission responses, and event emission. |
| `src/attachment-dispatch.ts`, `src/attachment-interceptor.ts` | Turning uploaded attachments into ACP prompt blocks; auto-approving agent reads of known attachment paths. |

A task's execution comes from its binding. No agent process starts at boot;
the first operation that needs a task's execution resolves its agent through
the registry. ACP compatibility and extensions are in
[ACP Integration](../acp.md).

## Events and egress

`AgentBridge` emits `AgentEvent`s. `handleAgentEvent()` in
`src/event-handler.ts` is the single consumer: it aggregates streamed chunks,
persists events to the Store, updates `TaskState`, and hands frames to the
`SseManager`. `PushService` receives the notifiable events.

- **SSE** — `SseManager.broadcast()` sends an event to every client that is not
  filtered to a different task; `broadcastGlobal()` ignores the task filter for
  application-wide state. A named heartbeat frame every 15 seconds keeps
  proxies from closing idle streams and re-checks token revocation.
- **Egress rewrites** — the internal lease stamp is dropped before an event
  leaves the server; attachment paths are relabeled and image URLs are signed at
  egress, never in storage
  ([Attachment label egress rewrite](../implementation-invariants.md#attachment-label-egress-rewrite)).
- **Push** — Web Push with global per-task visibility suppression, tracked by
  `src/client-registry.ts` (details below).

The SSE frame formats and replay rules are in the
[API Reference](../api.md#sse-event-reference); the client side of the stream
is in [Client Architecture](client.md#connection-lifecycle).

## Cross-cutting mechanisms

- **Idempotency** — the browser sends `X-Client-Op-Id` with user actions.
  Five REST routes replay a cached result from `client_ops`, keyed by
  `(task_id, client_op_id)`: permission responses, cancel, collaboration
  messages, prompt, and message ingress. Task create and delete only echo the op
  id into their broadcasts for correlation. MCP tools carry no op id.
- **Errors** — REST answers with an HTTP status and a JSON `{ error }` body;
  MCP answers with tool-error text written for the calling agent
  (`src/host/local/create-errors.ts` for `task_create`).
- **Logging** — runtime code uses `src/log.ts`, the mirror of the frontend
  logger; one `debug.level` setting controls both.
- **Configuration** — TOML parsed and validated in `src/config.ts`
  ([Configuration & Operations](../configuration.md)).
- **Timestamps** — storage and API use ISO-8601 UTC
  ([API Reference](../api.md#timestamps)).

## Request paths

**A browser creates a task** (`/new`, `+`): `POST /api/v1/tasks` → the route
chooses the target agent (explicit, else the parent's binding, else the
default) and resolves its transport through the registry →
`TaskManager.createTask()` → the task row, binding, and creation record are
persisted → `task_created` is broadcast.

**An agent creates a task** (`task_create`): MCP → `TaskOps.create()` → the
local adapter checks the caller's generation, resolves the target agent and cwd
relative to the caller → `TaskManager.createTask()` → the caller's transcript
records the creation.

**A user sends a prompt**: `POST /api/v1/tasks/:id/prompt` → the route reserves
the task's submission slot, resolves its execution (resuming it if needed), and
submits through `AgentBridge` → ACP events stream back through
`handleAgentEvent()` → SSE.

**An agent dispatches to a child** (`task_send`): MCP → `TaskOps.send()` → the
message and its delivery are committed → the recipient is kicked → the
delivery is drained into the child's next turn, and an obligation account opens
when it is handed over.

**An agent asks for permission**: a `permission_request` event is persisted,
broadcast, and pushed → `POST /api/v1/tasks/:id/permissions/:reqId` answers
through the transport that holds the pending request.

## Module boundaries

ESLint's `no-restricted-imports` enforces direct static dependencies:
`src/mcp/**` may import only `src/host/task-ops.ts` from the host layer and
never Store or TaskManager; `src/host/task-ops.ts` is neutral; `src/host/local/`
and `src/host/remote/` cannot import each other; `src/host/remote/` cannot
import Store or TaskManager. `src/routes.ts` has no such restriction. See
[Multi-host](multi-host.md#directories-and-dependencies) for the exact scope of
the rules.

## Where the server is not yet neutral

- **Two command surfaces.** MCP goes through `TaskOps`; REST handlers call the
  domain core directly, and some handlers orchestrate it themselves (the prompt
  route reserves, resumes, submits, and releases through several
  `TaskManager` calls).
- **Entry-specific behavior.** Creating a task chooses the agent and cwd by
  different rules on the two entrypoints, and an MCP cancel writes source and
  target audit rows that a REST cancel does not.
- **Entry-specific mechanisms.** Idempotency exists only for REST and is keyed
  by task; errors have two presentations.

[Multi-host](multi-host.md) describes the direction: every entrypoint converges
on one server interface, below which execution is dispatched to the local
instance or another one.

## Runtime notes

Operational behavior of the runtime, moved here from Implementation Invariants.

- **One bridge per started agent**: Each configured agent that has been started has one `AgentBridge` (one ACP subprocess), and that agent's tasks are multiplexed over it.
- **Handshake protocol version is checked**: `bridge.start()` refuses an agent whose `InitializeResponse.protocolVersion` is not exactly `PROTOCOL_VERSION`, on the same path as a refused handshake — the child process is reaped, the bridge stays not-ready, and the error names the version the agent reported. *Why:* `protocolVersion` is the only signal that says which event stream we will be reading, so an unknown version means every later render and persisted row would be an interpretation we cannot defend; a failed start is diagnosable, a silent mis-read is not. Capability gates (below) describe drift *within* v1; this refuses a different protocol.
- **Busy→idle unfinished-work recovery**: `TaskManager.syncBusy()` is the single normal state edge for recovery. When a task transitions from busy to idle, it schedules one microtask through its private `scheduleUnfinishedWorkRecovery()` helper if queued collaboration deliveries remain; the recovery drains deliveries and never submits a handoff reminder. Per-task deduplication prevents re-entry loops, and deletion/reset/rotation guards prevent work from being started during cleanup. The condition is intentionally independent of which busy source just ended, so new busy sources cannot silently strand work. **Reload exception:** `bridge.restart()` intentionally clears busy state directly while the ACP bridge is unavailable and cancels pending submissions; it does not submit recovery during restart, and queued work waits for the next explicit interaction/drain after the bridge is ready.
- **Directed dispatch closure**: The directed-dispatch obligation mechanism — the one-account rule, the arming predicate, the record's identities and fact vocabulary, settlement, recovery, and notices — is documented in [`task-obligations.md`](../task-obligations.md). The runtime records and reports facts and never concludes for the accountable party; see [Task semantic authority](../implementation-invariants.md#task-semantic-authority) above.
- **Agent reload**: `bridge.restart()` kills and re-spawns the agent subprocess without restarting the server. Cancels active prompts, flushes buffers, cleans up state. Tasks restore lazily via `ensureResumed()`. Triggered by `/reload` slash command or `POST /api/v1/bridge/reload`. Retries start 3× with exponential backoff.
- **Task restore**: `bridge.loadSession()` restores ACP context after server restart, preferring advertised `session/resume` over advertised `session/load`. Capability gates come from `InitializeResponse.agentCapabilities`, with resume/retirement under `sessionCapabilities`; neither restore capability means a user-actionable failure, never a fresh session. During restore, `restoringTasks` Set suppresses duplicate transcript storage/broadcast.
- **On-demand tasks**: No pre-warming. Tasks created via `+` / autocomplete, auto-resumed on page open.
- **Model inheritance**: A newly created task inherits the current task's saved model when available; restored tasks keep their own persisted model. Mode is NOT inherited — new tasks always start in agent mode.
- **Auto-resume**: Frontend resumes the most recent task with user-originated input on page open (no hash → fetch `/api/v1/tasks` → choose the first `hasUserInput` task); Root is the fallback when no task has user input.
- **Event aggregation**: `message_chunk` / `thought_chunk` are buffered in memory, flushed to DB as full `assistant_message` / `thinking` on boundaries (tool_call, plan, prompt_done).
- **Silent sessions**: The bridge's silent-session variant suppresses normal UI events for internally created sessions and for the temporary text capture behind compact summarization. Silence is an execution property, not a creation property: a session mapped to a real Task is never silent, so a persisted, user-visible Task keeps streaming and persisting from its first prompt. Suppressing a Task's *creation announcement* is a separate decision (`announce: false`, used by inbox consume); it must not also mute the execution. `promptForText` restores whatever silence a session already had instead of unmuting it when the capture ends. Automatic task-title generation was removed; titles come from creation (`+<title>`, `/rename`) or default to the task id.
- **Multi-client broadcast**: Events broadcast to all SSE clients. Permission responses, user messages, bash output sync across devices. `broadcast()` supports sender exclusion.
- **PWA**: Minimal service worker (no offline cache), manifest.json, installable to home screen.
- **Web Push**: VAPID-based push notifications via `web-push`. Global task-level visibility suppression: if any client is actively viewing a task, push is suppressed for that task across all endpoints/devices. Subscriptions stored in SQLite. Notifiable events: `permission_request`, `prompt_done`, `bash_done`. Note: Web Push is browser-specific; other client types would need their own notification mechanism. These endpoints live under `/api/beta/` to reflect their experimental, browser-specific nature.
  - **Global task visibility**: Each SSE client registers its push endpoint via `/api/beta/push/register-client` on connect and reports its current task via `POST /api/beta/clients/:clientId/visibility` with `{ visible: boolean, taskId?: string }`. `sendToAll()` checks globally whether **any** client is both visible and viewing the notification's task — if so, push is suppressed for **all** endpoints. This means: laptop viewing task A → phone also won't buzz for task A. But task B completing in the background still pushes to all devices.
  - **Visibility reporting**: The frontend reports visibility on three occasions: (1) SSE connect, (2) `visibilitychange` event, (3) task switch (`task_created` handler). All three include the current `state.taskId`. A client with no task set does not suppress any push.
  - **Subscription cleanup**: Stale endpoints are auto-removed in two ways: (1) 410 Gone responses are removed immediately; (2) any other error that occurs 5 consecutive times removes the subscription (`MAX_CONSECUTIVE_FAILURES` in `push-service.ts`). A single successful send resets the counter. This prevents expired tokens (e.g. WNS returning 403) from spamming logs indefinitely.
  - **Troubleshooting lost notifications**: If a client stops receiving push notifications, run `/notify off` then `/notify on` to re-subscribe with a fresh endpoint. Old endpoints may have been auto-cleaned after repeated failures.
  - **Activating push on a new device**:
    1. **iOS**: Install PWA to home screen (Add to Home Screen) — Safari tabs don't support Push API.
    2. Open the app and type `/notify on`. The browser will prompt for notification permission — allow it.
    3. If notifications stop working after a server update or VAPID key change, re-install the PWA (delete from home screen, re-add), then `/notify on` again. Simply toggling `/notify off` → `/notify on` may not be enough if the Service Worker cache is stale.
  - **iOS PWA quirks**: Apple's push service (`web.push.apple.com`) rejects VAPID subjects with `localhost` domains (`403 BadJwtToken`) — use a real-looking email like `mailto:noreply@example.com`. When changing `push.vapid_subject`, delete `data/vapid.json` to regenerate keys, then all clients must re-subscribe.
