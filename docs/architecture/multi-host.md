# Multi-host task collaboration

A Task id is an address, not an authorization grant. Each WebAgent instance owns
its SQLite database and any ACP process that executes its local Tasks. A host
connection carries requests between those owners without sharing storage or
copying execution state.

## Addresses and relation facts

`agent@host` is browser UI syntax, parsed at the UI boundary. Protocol requests
carry separate `agentId` and `host` fields. The hub resolves `host` from its
`[hosts.<name>]` configuration, sends the short agent id to that owner, and then
continues to address the created Task by its stable Task id.

`remote_tasks` records the cross-instance relation on both sides:

| Fact | Hub row | Owner row |
| --- | --- | --- |
| Local Task | parent id | remote-created Task id |
| Remote Task | child id | external parent id |
| Role | `child` | `parent` |
| Link name | configured host name | authenticated host token name |

The owner Task remains a parentless archived top in its local tree. Local
`parent_id` structure is authoritative; the external relation is used when no
local parent exists. Links are durable decisions. Reachability is in memory
and never becomes a Task fact; there is no remote-child mirror.

Every host call authenticates with an owner-issued `host`-scoped token. Host
scope reaches only `auth/verify`, the three link routes, task create, and the
per-Task status and events reads; it has no task list, no browser SSE,
and no `/tasks/:id/messages`. Per-Task reads are further limited to Tasks whose
`parent` row names the authenticated token.

There is no multi-host protocol version. Owner and hub must be upgraded
together; malformed current-wire responses fail as invalid responses.

## Two paths for every remote call

A hub talks to an owner in exactly two ways. Anything that changes collaboration
state and must not be lost travels on the **link**; everything else is a
**request**.

```text
                 hub                                              owner
 +--------------------------------------+               +--------------------------+
 | link (durable, ordered, receipts)    |               |                          |
 |   task_send to R1  -> hub outbox  ---|--- PUSH ----->| POST /api/v1/link/entries|
 |   receipts         -> hub outbox  ---|               |                          |
 |   reports, receipts <- consumer   <--|--- WATCH -----| GET  /api/v1/link/watch  |
 |                                   <--|--- READ  -----| GET  /api/v1/link/outbox |
 +--------------------------------------+               |                          |
 | request (shared/sync/request)        |               |                          |
 |   create (opId, bounded retry)    ---|-------------->| POST /api/v1/tasks       |
 |   task_list / REST list status    ---|-------------->| GET  /tasks/:id/status   |
 |   task_query / task_read          ---|-------------->| GET  /tasks/:id/events   |
 +--------------------------------------+               +--------------------------+
```

| Path | Guarantees | Result on failure |
| --- | --- | --- |
| link | committed locally first; delivered once, in order; outcome comes back as a receipt | stays queued; resumes after reconnect |
| request | one call, three results: success, rejected (owner `4xx`), unknown (network, timeout, `5xx`, unreadable body) | rejected is returned; unknown is retried only when the operation has an op id, otherwise returned |

## Idempotent operations

Every state-changing operation takes a required `opId: string | null` in its
TypeScript interface (`TaskOps.create`, `sendSyncRequest`). A string promises
that retrying with the same value is safe; `null` explicitly opts out and is
never retried. On the wire the op id is `X-Client-Op-Id`; no header means
`null`.

Idempotency is built into the fact the operation writes, not into a result
cache. A created Task's id is derived from the op id:

```text
 taskId = opIdentity(owner Root id, caller scope, opId)      UUIDv5, computed by the owner
 caller scope = host:<token name> | token:<token name> | agent:<parent Task id>
```

```text
 hub                                              owner
  |-- POST /tasks  X-Client-Op-Id: K ------------>|  id = opIdentity(root, host:hubA, K)
  |      x  response lost (unknown)               |  writes Task id + parent row (one tx)
  |-- POST /tasks  X-Client-Op-Id: K (retry) ----->|  Task id exists, same parent edge + agent
  |<----------------------- 201, same Task id ----|  nothing written; current Task returned
  | record child edge (already there: no-op)      |
```

A replay compares only facts fixed at creation (the parent edge or link and the
agent); it returns the Task as it is now, so a later rename does not turn a
retry into a conflict. A different parent or agent under the same op id is
`409 create_op_conflict`; a soft-deleted Task is `404 target_deleted`. A Task
hard-deleted inside the retry window is recreated by a replay (see Known
issues). Link pushes follow the same rule: the inbound delivery id is the
outbox entry id. The remaining mutating REST routes still use the `client_ops`
result cache until plan step 5.

## Link transport

### Principles

- **One transport per link, symmetric on both sides.** Every instance has the
  same three parts for each link: an outbox, one inbound apply, and one receipt
  primitive. Only *who dials* differs: the dialer pushes its outbox and pulls
  the peer's; the dialed side serves both requests.
- **Business state lives only in `deliveries`.** Messages and reports are
  written as `message` + `delivery` exactly like local collaboration; the
  outbox only carries them.
- **Outbox rows are immutable.** Progress in either direction is a per-link
  cursor, never a row update.
- **No acknowledgements, no skip markers.** The puller remembers its own
  position; business outcomes travel back as receipts.
- **Deduplicate by persisted facts.** A replayed entry is recognized by the
  delivery it already produced, not by a separate operation log.

### Link identity

A link is identified inside an instance by `(remote_role, remote_host)`. Each
side names the other in its own namespace; the two names are never exchanged
or compared.

```text
 hub instance                                    owner instance
 config  [hosts.webagent2] token=<T>             token table  name="hubA", hash(T)

 remote_tasks                                    remote_tasks
 local  remote  role    remote_host              local  remote  role    remote_host
 P      R1      child   webagent2                R1     P       parent  hubA

 link = (child, "webagent2")                     link = (parent, "hubA")
        "I dial it"                                     "it dials me"
```

The hub writes its configured host name; the owner writes the name of the host
token that authenticated the create request, in the same transaction as the
external-parent row. Every host route selects the link from the authenticated
token name and never from a client-supplied name.

Because the two namespaces are independent, one instance can hold a dial-out
link and a dial-in link with the same text. They are still two links with
separate outbox partitions and cursor rows:

```text
 instance X
   (child,  "Y")   X dials Y; "Y" is X's config name      -> partition A, cursor row A
   (parent, "Y")   Y dials X; "Y" is a token X issued     -> partition B, cursor row B
```

An edge always uses the link on which its remote Task was created. URL,
connection state, and the external Task id never reselect a link.

### Per-link structure

```text
          hub (dialer)                                     owner (dialed)
 +-------------------------------------+         +-------------------------------------+
 | outbox (child,"webagent2")          |  PUSH   | inbound apply                       |
 |   immutable rows, pos / prev        |-------->|   dedup: (link, entry id)           |
 |                                     |   202   |   -> inbound delivery + receipts    |
 | cursor.pushed_pos  <----------------|---------|                                     |
 |                                     |         |                                     |
 | inbound apply                       |  PULL   | outbox (parent,"hubA")              |
 |   -> inbound delivery + receipts    |<--------|   immutable rows, pos / prev        |
 | cursor.applied_pos (same tx)        | watch / |                                     |
 |                                     |  read   |                                     |
 | receipt loop (local, same tx):      |         | receipt loop (local, same tx):      |
 |   inbound delivery state change     |         |   inbound delivery state change     |
 |   -> append receipt to own outbox   |         |   -> append receipt to own outbox   |
 +-------------------------------------+         +-------------------------------------+
```

| Part | Stored in | Meaning |
| --- | --- | --- |
| outbox | `outbox` | Ordered, immutable entries this instance sends on one link. `pos` is the SQLite rowid; `prev` is the previous `pos` of the same link, `0` for the first entry; both are fixed in the insert transaction. |
| `applied_pos` | `outbox_cursors` | How far this instance has applied the peer's outbox (pull). Advanced in the same transaction as the business write. |
| `pushed_pos` | `outbox_cursors` | How far the peer has durably accepted this instance's outbox (push). Unused on a link this instance does not push. |
| business state | `deliveries` | `queued` / `delivered` / `failed` plus reason, for local, outbound, and inbound collaboration alike. |

A wire entry is `{id, category, data}` plus its `pos` / `prev` on a feed.
`category` is `message`, `report`, or `receipt`; the envelope is a
schema-derived discriminated union (`src/shared/link-envelope.ts`).

### Push: hub to owner

The hub's outbox pump sends the entries after `pushed_pos`, one at a time, in
order. The operation id is the entry id. The owner handles a push in this
order:

1. The HTTP layer authenticates the host token; its name selects the link.
2. Parse and canonicalize the envelope. Invalid input is an explicit `400`.
3. Look for the persisted fact. For a message or report, that is the inbound
   delivery with the same `(link, entry id)`: identical canonical content
   rebuilds the original `202`; different content is `409`. For a receipt, it
   is the original outbound row named by the receipt; the delivery CAS is
   idempotent.
4. Only when no fact exists, inspect the current Task and apply.

`202` means *durably applied*, including a definite failure. It does not mean
the agent has seen the message.

```text
 hub                                              owner
  |  pushed_pos = 4                                 |
  |-- POST entry U (pos 5), op = U ---------------->|  no fact for U: apply
  |<-------------------------------------- 202 -----|  inbound delivery U (queued)
  |  pushed_pos = 5, send pos 6                      |
  |                                                  |
  |-- POST entry V (pos 6) ------------------------->|  apply V
  |      x  response lost                            |
  |-- POST entry V again (same op) ----------------->|  fact for V exists, same content
  |<-------------------------------------- 202 -----|  rebuilt, nothing written
  |  pushed_pos = 6                                  |
  |                                                  |
  |-- POST entry W (pos 7) ------------------------->|  apply W, claim W at a turn boundary
  |      ... response held                           |  receipt(W: delivered) in owner outbox
  |<========= PULL: receipt(W) =====================|
  |  receipt for the head: pushed_pos = 7            |
  |  late 202 / 4xx for W: ignored                   |
```

| Push outcome | `pushed_pos` | Entry |
| --- | --- | --- |
| exact `202` | advances to this entry | handed off |
| receipt for the head arrives first | advances to this entry | handed off |
| owner rejection with a link `code` (`link_op_conflict`, `link_protocol_error`) of a message or report | advances | referenced delivery becomes `failed` |
| owner rejection of a receipt | does not advance | kept; logged as a link fault |
| any other `4xx` (no link `code`, e.g. a proxy `404`) | does not advance | kept; logged as a link fault |
| credential failure (`401`, `403`) | does not advance | kept; retried with the same op id once authorization recovers |
| network error, timeout, `5xx` | does not advance | kept; bounded backoff, same op id |

Push failures are logged; they never change the host's reachability state, which only the watch owns. After a restart the pump resumes after `pushed_pos`. Re-pushing an entry the
owner already accepted is safe: step 3 replays its `202`.

### Pull: owner to hub

The hub opens one `watch(after = applied_pos)` per configured owner. The owner
registers the subscription first, then pages committed entries after `after`
from its outbox and keeps one serial pump for later commits, so catch-up and
live delivery have no gap between them. Heartbeats keep the stream alive.

```text
 hub  applied_pos = 5                              owner
  |-- watch(after = 5) ----------------------------->|  register, then page
  |<-------------------------- entry pos 7, prev 5 --|
  |  prev == applied: apply 7, applied = 7 (one tx)  |
  |<-------------------------- entry pos 9, prev 8 --|  (pos 8 was lost, e.g. a frame
  |  prev 8 != applied 7: gap                        |   on a stream that was replaced)
  |-- read(after = 7) ------------------------------>|
  |<--------------------------------- [8, 9] --------|
  |  apply 8, applied = 8; apply 9, applied = 9      |
  |<-------------------------- entry pos 9, prev 8 --|  overlap
  |  pos <= applied: ignore                          |
  |      x  stream drops; owner commits 10, 11       |
  |-- watch(after = 9) ----------------------------->|
  |<-------------------- 10 (prev 9), 11 (prev 10) --|
```

Consumer rule (one implementation in `src/shared/sync/feed.ts`):

```text
 receive entry e                  (applied = durable local position)
   e.pos <= applied            -> ignore overlap
   e.prev == applied           -> apply; commit applied = e.pos with the business write
   otherwise                   -> read(after = applied) page by page until e is
                                  applicable or covered
 new watch generation          -> frames, reads, and retries of the old one are void
 temporary apply failure       -> stop on that entry, back off, re-read; never skip
 protocol error                -> stop this link's reconnect; applied unchanged
```

### Inbound apply

Push and pull call the same apply with the authenticated link and envelope:

| Category | Apply |
| --- | --- |
| message, report | Write `message` + inbound `delivery` (`queued`) carrying the source link, entry id, category, and the sender's label snapshot; then local drain delivers it like any collaboration message. |
| receipt | CAS the sender delivery referenced by the original entry; never becomes agent work and never produces another receipt. |

| Outcome | Durable effect | Transfer progress |
| --- | --- | --- |
| persistent receive | business write | advances (`applied_pos`, or the push replay fact) |
| definite failure: target Task missing (`target_deleted`) or the referenced relation does not exist here (`link_mismatch`, e.g. the owner created R1 but the hub never recorded the child edge) | `message` + inbound delivery written directly as `failed`, plus its receipt | advances; does not block later entries |
| temporary failure | rolled back | does not advance; retried serially |
| protocol error: invalid envelope or unknown category | nothing | does not advance; push returns `400` with `code: "link_protocol_error"`, pull stops the link |

Apply returns post-commit effects (drain a Task, publish a delivery status,
wake the outbox, move `pushed_pos`). They run only after the transaction
commits; replays return no effects. ACP never starts inside the transaction.

### Deliveries and receipts

```text
                     claim at a turn boundary
        queued  ----------------------------------->  delivered
          |                                               |
          | resume failure, clear, Task deleted,          | ACP rejects the prompt
          | archive edge cut, target missing              |
          v                                               v
        failed  <------------------------------------------
        (terminal)
```

- On the **receiving** instance, every real transition of an inbound delivery
  appends exactly one receipt `{originalEntryId, status, failureReason?}` to
  the source link's outbox in the same transaction. All write points use one
  primitive: claim, ACP rejection, resume failure, clear or rebind, delete,
  share reaper, empty-Task GC, and archive.
- On the **sending** instance, a receipt CASes the delivery that the original
  outbox row points to, along the same edges. `failed` is terminal; repeated,
  late, or non-advancing receipts are consumed without change. Receipt
  application publishes the delivery status but does not fire the sender-side
  failure notice (notices are a later contract).
- **Outbox-owned deliveries** (the sender side of a message or report) belong
  to the transport: local claim, drain, archive cut, clear, resume, delete,
  reaper, and GC skip them. Only receipts and authenticated rejection change
  their state.

Round trip of a message:

```text
 hub                                   owner                                R1
  | tx: message U + delivery U(queued)   |                                   |
  |     + outbox entry U                 |                                   |
  |-- PUSH U --------------------------->| tx: inbound delivery U(queued)    |
  |<---------------------------- 202 ----|                                   |
  | pushed_pos -> U                      |-- drain at turn boundary -------->|
  |                                      | tx: U queued -> delivered          |
  |                                      |     + receipt(U, delivered)       |
  |<== PULL receipt(U) ==================|                                   |
  | tx: delivery U queued -> delivered   |                                   |
  |     + applied_pos                    |                                   |
```

Round trip of a report, the mirror image:

```text
 hub                                   owner                                R1
  |                                      |<-------- task_update(done) -------|
  |                                      | tx: message R + delivery R(queued)|
  |                                      |     + outbox entry R              |
  |<== PULL R ===========================|                                   |
  | tx: inbound delivery R(queued)       |                                   |
  |     + applied_pos                    |                                   |
  | drain to P; R queued -> delivered    |                                   |
  |   + receipt(R, delivered)            |                                   |
  |-- PUSH receipt(R) ------------------>| tx: delivery R queued -> delivered|
  |<---------------------------- 202 ----|                                   |
```

## The loop at a glance

P is a Task on the hub; R1 is its child created on the owner. Each instance
keeps one `remote_tasks` row for the edge and its own outbox and cursors per
link.

```text
 P (hub agent)          hub server                         owner server              R1 (owner Task)
   |                        |                                   |                         |
 0 link up (once per owner, not per Task)                       |                         |
   |                        |== watch(after = applied_pos) ====>|  catch-up, then live     |
   |                        |   connected = handshake ok        |                         |
 1 create                   |                                   |                         |
   |-- task_create -------->|-- request: POST /tasks, op K ---->| tx: R1 (id from K)      |
   |                        |<------------------- 201 R1 -------|     + parent row        |
   |                        | tx: child row + Created task row  |  no ACP until first turn|
   |<------------ R1 id ----|                                   |                         |
 2 list / read              |                                   |                         |
   |-- task_list ---------->|-- request: GET status (parallel, ~2 s) -->|                 |
   |<-- family + remote ----|   unreachable if the read fails or the watch is down        |
   |-- task_query/read ---->|-- request: GET /tasks/R1/events ->|  pure read            |
 3 dispatch                 |                                   |                         |
   |-- task_send R1 ------->| tx: message U + delivery U(queued)|                         |
   |<- {accepted: true} ----|     + outbox entry U              |                         |
   |                        |== PUSH U ========================>| tx: inbound delivery U  |
   |                        |<=========================== 202 ==|-- drain at boundary --->| account opens
   |                        |<== WATCH receipt(U, delivered) ===|                         |
 4 report                   |                                   |<--- task_update(done) --|
   |                        |                                   | tx: message R + delivery|
   |                        |<== WATCH R =======================|     R + outbox entry R  |
   |                        | tx: inbound delivery R + applied  |                         |
   |<--- drain wakes P -----|== PUSH receipt(R, delivered) ====>|                         |
```

## Create

MCP `task_create` and REST `POST /api/v1/tasks` use the same Core command with
separate `agentId` and `host` fields and a required `opId`. MCP generates a new
op id per call; REST passes `X-Client-Op-Id` or `null`. Core authorizes the
caller and calls either LocalHost or the RemoteHost transport. A Host returns
the created Task's stable id, title, effective agent, cwd, model, and thinking;
it does not record the caller-side transcript row.

The remote transport sends one request through `shared/sync/request` with an
8-second timeout. An unknown result is retried up to twice with the same op id;
a still-unknown result is returned to the caller. The owner accepts a Host
create only with a non-empty opaque external `parentId`, derives the Task id
from the op id (see Idempotent operations), creates a deferred Task with an
empty execution slot, and commits the `parent` row in the same transaction. It
does not start ACP. After a `201`, Core records the `child` row through a
caller-generation fence and writes the same `Created task` row as a local
create; recording an edge that already exists is a no-op, a different edge is a
conflict. A concurrent duplicate that loses the primary-key race simply fails,
cleaning up only what it created.

## Read

`TaskOps.list/query/read` are asynchronous. `task_list` includes the hub's local
family plus its remote children marked by `host`. REST `GET /api/v1/tasks`
appends the same remote children after their listed local parents; the browser
uses them only so a reference to a remote child is not shown as removed.

Remote fields come from a live status read, not a mirror: the hub reads
`GET /api/v1/tasks/:id/status` for every remote child in parallel under one
shared ~2-second deadline that includes credential resolution and parsing.
Status carries `title`, `workflowStatus`, `executionState`, `lastEventAt`, and
`lastAgentActivityAt` alongside busy and pending-permission facts. Two facts
are kept apart: fields from a successful read are shown as read, and
`unreachable: true` is added when that read fails or the owner's watch is not
connected.

The owner applies the reverse relation to the same list read: for each listed
local Task with a `parent` row, it appends that external parent as
`{host: null, id, parent_id: null, title: null}`. This is a reference
existence fact, not a browsable local topology.

`task_query` and `task_read` call `GET /api/v1/tasks/:id/events` on the owner
and use the shared history projector, bounds, and MCP response shapes. These
reads never start ACP. The hub restricts targets to its own `child` rows; the
owner authorizes status and events reads by matching the target's `parent` row
to the authenticated host token name. Search cold-reads the complete owner
history because the owner has no server-side search endpoint.

## Dispatch

MCP `task_send` to a linked child writes, in one hub transaction, the message
(id U), a sender delivery addressed to the remote Task id, and outbox entry U.
It returns `{accepted: true}`, meaning *queued on this instance*; the owner
need not be reachable. The pump pushes U (see Push), the owner's inbound apply
writes a `queued` inbound delivery with the sender's label snapshot, and the
owner's normal drain hands it to R1 at a turn boundary, opening the
collaboration account exactly as a local dispatch. The hub's delivery moves to
`delivered` or `failed` only through receipts.

## Report

An owner `task_update(done|blocked)` follows the existing report route: the
open account's actual source, else a local parent, else the external parent.
When the route ends at the external parent, the owner writes the report message,
its delivery, and outbox entry R in the same transaction as the update; a write
failure rolls back and the update is not reported as successful. The hub's
watch pulls R, applies it as an inbound delivery to P with `applied_pos` in the
same transaction, and P's drain wakes P. `task_update(waiting)` is not
delivered; it does make a Task with a remote-child row count as having a
visible possible wake source.

Restarts need no catch-up pass: the outbox, cursors, and deliveries are durable.

```text
 hub restart                          owner restart
   watch(after = applied_pos)           un-pushed entries stay in the outbox
   -> only entries after the cursor     account lost: report falls back to the
   pump resumes after pushed_pos           external parent row, enqueued as entry R
```

## Current status

| Flow | Implemented |
| --- | --- |
| UI `agent@host` create address | Yes |
| Remote create | Yes, idempotent by op id, bounded retry on unknown |
| Remote `task_list` fields | Yes, live status reads; `unreachable` on failure or watch down |
| Remote `task_query` / `task_read` | Yes, cold owner history |
| Remote `task_send` | Yes, link outbox; queued locally, receipts update state |
| Remote `done` / `blocked` report | Yes, owner outbox pulled by the hub watch |
| Restart and reconnect | Yes, from durable cursors; no full catch-up |
| Failure notices for remote outcomes, R1 → P ordinary messages, offline timeout | No (contract-04) |
| Remote cancel/rename/archive/delete | No |
| Browser task routing | No |
| Server-side search | No |

See [Known issues](../known-issues.md) for limits and closing conditions.
