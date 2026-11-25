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

03a builds the durable transport foundations without switching production
traffic. The new owner read/watch/push handlers and hub consumer are direct-test
surfaces only: they are not registered with the HTTP server, and no worker runs
them. The existing host ticket, host SSE, synchronous dispatch, and report
mirror path described below remain live. 03b will rewrite dispatch and report
flows onto this transport.

### Link identity

A link is identified on each instance by `(remote_role, remote_host)`. The hub
records its configured name in a `child` row; the owner records the
authenticated host token name in a `parent` row. These names are managed in
separate domains. If one instance dials out and another dials in under the same
textual name, the two links remain distinct because their roles differ.

```text
+-------------------- hub --------------------++------------------- owner --------------------+
|                                                |                                                |
|  [remote_role=child, remote_host="desk"]  ---->|  [remote_role=parent, remote_host="hub-a"]      |
|       one configured outbound link              |       one authenticated inbound link            |
|                                                |                                                |
|  [remote_role=parent, remote_host="desk"] <----|  [remote_role=child,  remote_host="desk"]       |
|       a different inbound link                  |       a different outbound link                 |
+-------------------------------------------------+-------------------------------------------------+
```

Each `remote_tasks` edge keeps the link on which it was created. URL, current
connection state, and the external Task id do not reselect a link.

### Per-link state

Each instance has the same storage and apply shape. Only the transport differs:
the hub pushes toward the owner, while the owner publishes entries that the hub
pulls.

```text
+------------------------------- hub -------------------------------+
|                                                                    |
|  +-------------------+       +----------------------------------+  |
|  | outbox             |       | outbox_cursors                   |  |
|  | role/name/pos/prev |       | owner outbox positions I applied |  |
|  +---------+---------+       +----------------+-----------------+  |
|            | PUSH                               ^                    |
|            v                                    | watch/read         |
|  +-------------------+                          |                    |
|  | inbound apply     |<-------------------------+                    |
|  | message/report/   |                                               |
|  | receipt           |                                               |
|  +---------+---------+                                               |
|            |                                                        |
|            v                                                        |
|  +-------------------+                                              |
|  | receipt primitive |-- enqueue receipt --> same outbox            |
|  +-------------------+                                              |
+---------------------------------------------------------------------+
                                  |
                    durable HTTP wire, no shared DB
                                  |
+------------------------------- owner -----------------------------+
|  +-------------------+       +----------------------------------+  |
|  | inbound apply     |       | outbox                           |  |
|  | message/report/   |       | role/name/pos/prev -> hub        |  |
|  | receipt           |       | cursor source for watch/read      |  |
|  +---------+---------+       +----------------+-----------------+  |
|            ^                                    |                   |
|            | PUSH                               | watch/read        |
|  +---------+---------+                          v                   |
|  | receipt primitive |<--------- hub outbox receipt goes back -------|
|  +-------------------+                                             |
+---------------------------------------------------------------------+
```

The wire entry contains only immutable facts: entry id, category, and data.
`pos` and `prev` describe position in the sender's link outbox and are computed
in the same insertion transaction.

### Push: hub to owner

The operation id is the outbox entry id. The owner first parses the envelope
and authenticated link, then looks for the persisted inbound delivery. Matching
canonical content rebuilds the original `202`; different content is `409`.
Only when no business fact exists does the owner inspect the current task.

```text
hub                                      owner
 |                                         |
 | POST entry U, op=U -------------------->|
 |   (durable local outbox row)            |
 |                                         | 1. authenticate link
 |                                         | 2. parse envelope
 |                                         | 3. find inbound delivery by U
 |                                         | 4. otherwise apply U
 |                                         |    (business + durable result)
 |<-------------------------------- 202 ---|
 | hand-off: retire this attempt           |
 | and release the next outbox row         |
 |                                         |
```

`202` means the owner durably applied the entry, including a definite-failure
result. It is not proof that ACP has completed. A receipt may overtake the POST
response; the first durable hand-off releases the head, and a late `202` or
`4xx` cannot move the outbox backwards or release a later entry twice.

### Pull: owner to hub

The hub starts `watch(after)` once for each configured owner link. The owner
registers the observer, pages committed entries after `after`, and then keeps
one serial pump for live additions. The consumer persists progress in
`outbox_cursors`.

```text
hub                                           owner
 |                                               |
 | watch(after=5) ------------------------------>|
 |                                               | register subscription
 |<---------------- page pos 7 prev 5 ------------|
 |  apply 7 + cursor=7 in one transaction        |
 |                                               | enqueue live pos 9
 |<---------------- live pos 9 prev 7 ------------|
 |                                               |  (gap: pos 8 is missing)
 | read(after=7) -------------------------------->|
 |<---------------- page pos 8 prev 7 ------------|
 |  apply 8 + cursor=8                           |
 |  apply queued pos 9 + cursor=9                |
 |                                               |
 |<---------------- live/heartbeat --------------|
```

`pos` is the row position in one link; `prev` is that link's immediately
previous position. An entry with `pos <= applied` is overlap and is ignored.
When `prev != applied`, the consumer loops `read(after=applied)` pages until
the live entry is applicable or covered. Broken chains, no page progress, and
an unexplainable `prev` are explicit protocol failures for that link.

### Business state, hand-off state, and apply results

Business state lives only in `deliveries`: `queued`, `delivered`, or `failed`,
plus the failure reason. A message or report outbox row points at its delivery
with `delivery_id`. A receipt has no delivery of its own. Hand-off state is
separate local transport metadata on `outbox` (`pending`, `handed_off`,
`rejected`); it is never part of the immutable wire data.

One authenticated link apply has four outcomes:

| Outcome | Durable effect | Transfer progress |
| --- | --- | --- |
| persistent receive | write message/report delivery and business facts with progress | advance |
| definite failure | write a failed inbound delivery for the message/report and enqueue a failure receipt | advance |
| temporary failure | roll back and retry serially | do not advance |
| protocol error | stop that link without skip or acknowledgement | do not advance |

Push protocol errors return an explicit `4xx`. Pull protocol errors stop the
one link's automatic reconnect path; other links and temporary retry remain
independent. Apply returns concrete post-commit effects, such as a target to
drain or an outbox entry to publish; ACP is never started inside the Store
savepoint.

### Receipts

An inbound delivery status transition emits one receipt in the same
transaction. The receipt identifies the original outbox entry and the new
delivery status. On the sender, receipt apply CASes the referenced delivery:
`queued -> delivered`, `queued -> failed`, or `delivered -> failed`. Repeated,
late, or non-advancing receipts are still consumed but do not rewrite terminal
business state or generate another receipt.

Receipt application publishes delivery status after commit without going
through the normal sender-side failure notice hook. Task deletion, clear,
restore failure, archive, reaper, and empty-task GC all use the same receipt
primitive.

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
catch-up collapse to one wake. No cursor, ACK, receipt, or outbound-state table
exists.

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
