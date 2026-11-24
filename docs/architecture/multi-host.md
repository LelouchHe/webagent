# Multi-host task collaboration

A Task id is an address, not an authorization grant. Each WebAgent instance owns
its SQLite database and any ACP process that executes its local Tasks. A host
connection carries requests between those owners without sharing storage or
copying execution state.

## Addresses and relation facts

`agent@host` is a create-time address. The hub resolves `host` from its
`[hosts.<name>]` configuration, sends the short agent id to that owner, and then
continues to address the created Task by its stable Task id.

`remote_task_links` records the cross-instance relation on both sides:

| Fact | Hub row | Owner row |
| --- | --- | --- |
| Local Task | parent id | remote-created Task id |
| Remote Task | child id | external parent id |
| Role | `child` | `parent` |
| Credential | configured host name | owner-side peer token hash |

The owner Task remains a parentless archived top in its local tree. Local
`parent_id` structure is authoritative; the external relation is used when no
local parent exists. Links are durable decisions. Host connection state and the
hub's remote-child display mirror are in memory and never become Task facts.

Connections use an owner-issued `host`-scoped token. The hub verifies version,
token hash, and scope before opening global SSE. Host SSE sends heartbeat and
connected frames plus only events for Tasks whose `parent` link belongs to that
token hash. Per-Task host SSE is refused.

## Create

MCP `task_create` and REST `POST /api/v1/tasks` use the same Core command. Core
authorizes the caller and converts `agent@host` to a structured target. The host
selector calls either LocalHost or one RemoteHost transport.

The owner accepts a Host create only with a non-empty opaque external
`parentId`, creates a deferred Task with an empty execution slot, and commits the
`parent` link in the same transaction. It does not start ACP. After a peer `201`,
the hub records its `child` link through a caller-generation fence. A `4xx` is a
rejection; transport ambiguity is unknown, and owner success followed by local
link failure is partial success.

## Read

`TaskOps.list/query/read` are asynchronous. `task_list` includes the hub's local
family plus remote-child entries marked by `kind: "remote"` and `host`. The
mirror is display-only:

- the first connect subscribes to SSE, takes one cold snapshot through the
  owner's existing task read routes, then applies incremental events;
- a known Task keeps its last values when the owner is unreachable and gains
  `unreachable: true`;
- before the first successful snapshot, a remote child contains only its
  address and unreachable mark;
- `lastEventAt` and `lastAgentActivityAt` come from owner events.

`task_query` and `task_read` call `GET /api/v1/tasks/:id/events` on the owner and
use the shared history projector, bounds, and MCP response shapes. These reads
never start ACP. The owner does not authorize a read per linked task: the hub
restricts targets to its own `child` links for the calling Task's family, and
host scope is limited to task list/detail/events/status reads.

Remote egress may already contain display rewrites. Search cold-reads the
complete owner history because the owner has no server-side search endpoint.

## Dispatch

MCP `task_send` to a linked child synchronously POSTs to the owner's existing
`/api/v1/tasks/:parentId/messages` route with one `X-Client-Op-Id`. `202` is the
accepted result; a rejection or visible transport failure is returned to the
agent. Any retry inside one transport call keeps that operation id. An unknown
outcome is never retried automatically.

On the owner, host scope may use an external `sourceTaskId` only when it exactly
names the target's linked parent and the connection's token hash owns that
link. The owner creates an agent-authored target-side delivery, so the normal
drain opens the collaboration account at handoff exactly as a local dispatch.
There is no source projection on that instance.

After `202`, the hub persists the message, a source projection, and an event on
the local parent with the display state `accepted`. It intentionally has no
`deliveries` row: there is no local recipient, and a queued local delivery
would be consumed by the wrong instance's drain.

## Report

An owner `task_update` always persists its report event. If the obligation
source is an external parent, or a restart-lost account falls back to the
external parent link, the owner writes no local collaboration message. A local
parent remains the fallback when present.

The host stream forwards persisted `done` and `blocked` reports with Task-local
sequence ids. On every connect the hub also cold-reads each linked child's
events. For a report addressed to the corresponding local parent, it creates a
normal local collaboration message and queued delivery on the parent. The
delivery idempotency key is
`remote-report:<host>:<childId>:<seq>`, so online forwarding and reconnect
catch-up collapse to one wake. No cursor, ACK, receipt, or outbound-state table
exists.

`task_update(waiting)` is not delivered as a report. It does make a Task with a
remote-child link count as having a visible possible wake source.

## Current status

| Flow | Implemented |
| --- | --- |
| `agent@host` create | Yes |
| Remote discovery and `task_list` mirror | Yes, best-effort and in-memory |
| Remote `task_query` / `task_read` | Yes, cold owner history |
| Remote `task_send` | Yes, synchronous owner acceptance |
| Remote `done` / `blocked` report | Yes, event catch-up and local drain |
| Unreachable discovery and dispatch | Yes |
| Remote cancel/rename/archive/delete | No |
| Browser task routing | No |
| Owner external-source non-update/no-activity/removal notices | No |
| Incremental reconnect cursor or server-side search | No |

See [Known issues](../known-issues.md) for limits and closing conditions.
