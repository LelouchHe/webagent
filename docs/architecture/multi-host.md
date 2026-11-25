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
local parent exists. Links are durable decisions. Host connection state and the
hub's remote-child display mirror are in memory and never become Task facts.

Connections use an owner-issued `host`-scoped token. The hub verifies scope
before opening global SSE. The ticket request carries the hub's
subscribed local parent ids; the owner returns a connection id and keeps the
set only for that live connection. Per-Task host SSE is refused.

There is no multi-host protocol version. Owner and hub must be upgraded
together; malformed current-wire responses fail as invalid responses.

## Link transport (foundations)

> **Status (03a).** Everything in this section is built and tested, but
> **dormant**: the owner read/watch/push handlers and the hub consumer are not
> registered with the HTTP server and no worker runs them. Production traffic
> still uses the host ticket, host SSE, synchronous dispatch, and report mirror
> described in the later sections. The cutover (03b) switches dispatch and
> reports onto this transport and removes the old path. Flows marked
> *(active from 03b)* describe how the pieces compose once wired.

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
| authenticated rejection (`4xx` after link auth) of a message or report | advances | referenced delivery becomes `failed` |
| authenticated rejection of a receipt | does not advance | kept; reported as a link fault |
| credential / link failure (`401`, scope) | does not advance | kept; retried with the same op id once authorization recovers |
| network error, timeout, `5xx` | does not advance | kept; bounded backoff, same op id |

After a restart the pump resumes after `pushed_pos`. Re-pushing an entry the
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
| definite failure, e.g. target Task missing | `message` + inbound delivery written directly as `failed`, plus its receipt | advances; does not block later entries |
| temporary failure | rolled back | does not advance; retried serially |
| protocol error, e.g. link mismatch or unknown envelope | nothing | does not advance; push returns `4xx`, pull stops the link |

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

Round trip of a message *(active from 03b)*:

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

Round trip of a report *(active from 03b)*, the mirror image:

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
keeps one `remote_tasks` row; nothing else is shared.

```text
 P (hub agent, MCP)      hub server                     owner server               R1 (owner Task)
                         link: child P -> R1@owner      link: parent R1 <- P,
                         mirror: in memory              external parent id
   |                          |                               |                          |
 1 create                     |                               |                          |
   |-- task_create(mock, owner)>                               |                          |
    |                          |-- POST /tasks (host token,    | LocalHost creates R1     |
    |                          |   connection id) ----------->| + subscribe P            |
    |                          |                               | + parent link, no ACP    |
    |                          |<----- 201 + create facts -----|                          |
    |                          | Core: write child link,       |                          |
    |                          | sender-side Created task row  |                          |
   |<----------------- R1 id -|                               |                          |
   |                          |                               |                          |
 2 discover (every connect)   |                               |                          |
   |                          |-- SSE ticket parentIds ------>| remember set, return id  |
   |                          |-- subscribe global SSE ------>| forwards only Tasks whose|
   |                          |-- snapshot detail/status/ --->| external parent is in set|
   |                          |<== live events: title, =======|                          |
   |                          |    state, activity            |                          |
   |-- task_list ------------>| local family + mirrored       |                          |
   |<-------------------------| remote children               |                          |
   |                          | {host, ...};                  |                          |
   |                          | last values + unreachable     |                          |
   |                          | while the owner is down       |                          |
   |                          |                               |                          |
 3 read                       |                               |                          |
   |-- task_query/task_read ->| check child link (database)   |                          |
   |                          |-- GET /tasks/R1/events ------>| pure read, no ACP        |
   |                          |<------------------- rows -----|                          |
   |<------- MCP shapes ------| shared task-history projection|                          |
   |                          |                               |                          |
 4 dispatch                   |                               |                          |
   |-- task_send R1 --------->| check child link              |                          |
   |                          |-- POST /tasks/P/messages ---->| P is R1's parent link    |
   |                          |   X-Client-Op-Id, sourceLabel | and parent id matches    |
   |                          |                               | -> agent dispatch queued |
   |                          |<---------------------- 202 ---|-- drain --------------->| account opens
   |                          | Core records P's sender row   |                          | (source: external P)
   |<----- 202 + message id --| queues hub delivery row       |                          |
   |                          |                               |                          | ... works ...
 5 report                     |                               |<---- task_update(done) --|
   |                          |                               | external source: persist |
   |                          |                               | the task_update event    |
   |                          |                               | only, no local message   |
   |                          |<===== SSE task_update ========|                          |
   |                          | target == P: local message    |                          |
   |                          | into P, idempotency key       |                          |
   |                          | remote-report:owner:R1:<seq>  |                          |
   |<-- drain wakes P --------|                               |                          |
```

The hub decides routing, authorization, and wake sources from the durable
links only; the mirror feeds `task_list` and nothing else. The owner authorizes
every push and dispatch against its `parent` link and the request's source id.
A `202` means the owner enqueued the message and returned its message id. The
hub starts its delivery row as `queued`; the owner's `collaboration_prompt`
event moves it to `delivered` live or through reconnect catch-up.

## Create

MCP `task_create` and REST `POST /api/v1/tasks` use the same Core command with
separate `agentId` and `host` fields. Core authorizes the caller and builds the
target directly. The host selector calls either LocalHost or one RemoteHost transport. A Host returns the
created Task's stable id, title, effective agent, cwd, model, and thinking; it
does not record the caller-side transcript row.

The owner accepts a Host create only with a non-empty opaque external
`parentId`, creates a deferred Task with an empty execution slot, and commits the
`parent` link in the same transaction. It does not start ACP. After a peer `201`, Core records its `child` link through a caller-generation
fence and writes the same `Created task` row it writes for a local create. The
stored facts and display keep `agentId` and `host` separate. A live row proves the id to
the browser's reference marks; replay does not create that existence fact.

## Read

`TaskOps.list/query/read` are asynchronous. `task_list` includes the hub's local
family plus remote-child entries marked by `host`. REST
`GET /api/v1/tasks` appends the same remote children after their listed local
parents; the browser uses them only so a reference to a remote child is not
shown as removed. The mirror is display-only:

The owner applies the reverse relation to the same list read: for each listed
local Task with a `parent` link, it appends that external parent as
`{host: null, id, parent_id: null, title: null}`. This is a reference
existence fact, not a browsable local topology.

- the first connect subscribes to SSE, takes one cold snapshot through the
  owner's existing task read routes, then applies incremental events;
- a known Task keeps its last values when the owner is unreachable and gains
  `unreachable: true`;
- before the first successful snapshot, a remote child contains only its
  address and unreachable mark;
- `lastEventAt` and `lastAgentActivityAt` come from owner events.

`task_query` and `task_read` call `GET /api/v1/tasks/:id/events` on the owner
and use the shared history projector, bounds, and MCP response shapes. These
reads never start ACP. The hub restricts targets to its own `child` links. The
owner authorizes host detail, events, and status reads by matching the target's
`parent` link to the authenticated host token name; host scope has no task-list
route.

Remote egress may already contain display rewrites. Search cold-reads the
complete owner history because the owner has no server-side search endpoint.

## Dispatch

MCP `task_send` to a linked child synchronously POSTs to the owner's existing
`/api/v1/tasks/:parentId/messages` route with one `X-Client-Op-Id`. `202` is the
accepted result; a rejection or visible transport failure is returned to the
agent. Any retry inside one transport call keeps that operation id. An unknown
outcome is never retried automatically.

On the owner, host scope may use an external `sourceTaskId` only when it exactly
names the target's linked parent. The request carries P's `sourceLabel`. The owner keeps it in memory for
this message, creates an agent-authored target-side delivery, and uses the label
for both R's receiver row and its `From "…"` prompt. The normal drain opens the
collaboration account at handoff exactly as a local dispatch. There is no source
projection on that instance.

For local and remote dispatch, Host only enqueues. Core then writes the caller's
sender row. Both start `queued`; a remote row becomes `delivered` when the
owner's persisted `collaboration_prompt` event reports the same returned message
id. Restart catch-up replays that acknowledgment.

## Report

An owner `task_update` always persists its report event. If the obligation
source is an external parent, or a restart-lost account falls back to the
external parent link, the owner writes no local collaboration message. A local
parent remains the fallback when present.

The host stream forwards persisted `done` and `blocked` reports with Task-local
sequence ids. On every connect the hub also cold-reads each linked child's
events. Local `task_update` and a remote forwarded event both enter one Core
report operation: enqueue into P, then let the existing drain wake P. The
remote entry uses a normal local message and queued delivery on the parent. The
delivery idempotency key is
`remote-report:<host>:<childId>:<seq>`, so online forwarding and reconnect
catch-up collapse to one wake. This **old live host-SSE path** has no cursor,
ACK, receipt, or outbound-state table; the dormant 03a transport foundations do.

`task_update(waiting)` is not delivered as a report. It does make a Task with a
remote-child link count as having a visible possible wake source.

```text
 hub restart or reconnect
   -> for every child link: cold-read GET /tasks/R1/events
   -> each done/blocked addressed to P is inserted with the same idempotency key
   -> an undelivered report is delivered once; a delivered one is not repeated

 owner restart (in-memory account lost), then R1 calls task_update(done)
   -> no account: a local parent wins if R1 has one
   -> otherwise the external parent from the parent link (P)
   -> the persisted event reaches the hub live or through catch-up -> P wakes
```

## Current status

| Flow | Implemented |
| --- | --- |
| UI `agent@host` create address | Yes |
| Remote discovery and `task_list` mirror | Yes, best-effort and in-memory |
| Remote `task_query` / `task_read` | Yes, cold owner history |
| Remote `task_send` | Yes, synchronous owner acceptance |
| Remote `done` / `blocked` report | Yes, event catch-up and local drain |
| Unreachable discovery and dispatch | Yes |
| Per-connection parent subscriptions | Yes, rebuilt on reconnect |
| Remote cancel/rename/archive/delete | No |
| Browser task routing | No |
| Owner external-source non-update/no-activity/removal notices | No |
| Incremental reconnect cursor or server-side search | No |

See [Known issues](../known-issues.md) for limits and closing conditions.
