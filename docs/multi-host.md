# Multi-host delivery

Multi-host moves a Task message across WebAgent instances without moving the
task's local semantics. There is no shared database, cursor, sequence, or
instance id. The initiating host is a normal authenticated client of the owner
host: it holds one owner-issued token and keeps one SSE connection.

## Flows

Single-host delivery:

```text
agent P --task_send--> local messages + deliveries(queued)
                              |
                         turn boundary
                              v
                    local drain -> agent R1 ACP
                              |
                       task_update(done)
                              |
                    messages + deliveries(queued)
                              |
                         turn boundary
                              v
                    local drain -> agent P ACP
```

Multi-host, with P on the initiator and R1 on the owner:

```text
initiator (P)                                  owner (R1)
+--------------------------------------+      +----------------------------+
| task_send(P -> R1)                    |      |                           |
|   local message + delivery(queued)   |      |                           |
|   per-edge POST /host/messages ------|----->| dedup + bind + local row  |
|   202 => delivered/handed off         |      |     -> delivery drain     |
|                                      |      |     -> R1 ACP             |
|                                      |      |     -> account / update   |
|                                      |      |                           |
| GET /host/messages <- hint by token  |<-----| R1 -> P queued outbound   |
|   persist local row + receipt        |      | SSE sends a pending hint   |
|   POST /:id/ack ---------------------|----->| queued -> delivered       |
|   local drain -> P ACP               |      +----------------------------+
+--------------------------------------+
```

The owner has no configuration for the initiator. The initiating host resolves
its configured token, describes the owner, opens a ticket-authenticated global
SSE stream, and then performs a baseline `GET`. The `host_message_pending`
frame carries only its event type, not a message id or payload. Disconnection
changes no business state; reconnect performs another pull. A report is ACKed
only after the initiator transaction commits. The committed receipt is also
the restart/wake fact: P is kicked immediately, independent of whether the ACK
response is observed. There is no separate ACK outcome table.

## Layer boundary

```text
upper layer: task ids only
  TaskManager / MCP / ObligationController / TaskLocator / DeliveryQueue
       |
       | parentOf / childrenOf / labelOf / hasChildWakeSource
       | enqueue(source task id, target task id, kind, body)
       v
local SQLite: messages + deliveries + projections
====================== delivery-row boundary ======================
       ^
       | lower components
       +-- host/routes.ts: POST create/dispatch, GET outbox, ACK
       +-- host/registry.ts: persistent SSE, ordered POST, pull, retry
       +-- host/store.ts: bindings/edges/receipts/deduplication
       +-- host/protocol.ts + host/create.ts
```

`TaskLocator` and `DeliveryQueue` are the boundary modules. The upper modules
see only task ids and four delivery kinds (`dispatch`, `message`, `update`,
`notice`). `DeliveryQueue.enqueue` commits a status mutation and its report in
one transaction when needed, then emits one generic `deliveries committed`
signal. The composition root passes that signal to the lower layer, which
decides whether the target is local, an outbound edge, or an owner outbox.

The owner endpoint never calls MCP/account business functions: it writes a
local queued delivery through the Store's raw row primitive. The normal local
drain is scheduled by `src/task-manager.ts`; it opens the account and hands
that row to ACP. In `src/task-manager.ts`,
local `claim -> arm -> ACP` contains no locator lookup or I/O; generic claim
metadata is copied inside the claim transaction only when persisted host facts
exist.

The import direction is lint-enforced. Files outside `src/host/` cannot import
that directory; only `src/server.ts` composes it. Files inside `src/host/`
cannot import TaskManager, obligation, or MCP business modules. The one remote
create exception is one injected lower-layer `CrossHostTaskCreator.create`
call; it owns coordinate parsing, network work, and edge/event commit.

## File map

| Layer | Files | Interface |
|---|---|---|
| Upper | `src/task-manager.ts`, `src/mcp/`, `src/obligation-controller.ts` | task ids, five locator reads, `DeliveryQueue.enqueue`, generic committed signal |
| Boundary | `src/task-locator.ts`, `src/delivery-queue.ts`, core `src/store.ts` | task descriptions, route, atomic row writes |
| Lower | `src/host/store.ts`, `registry.ts`, `routes.ts`, `protocol.ts`, `create.ts` | host tables, owner routes, client connection, cross-host create |
| Composition | `src/server.ts` | constructs both sides and wires callbacks/SSE hints |

An edge's transport state and wake hint are separate facts. A typed terminal
owner report consumes only the conservative wake hint; it does not mark another
pending POST as delivered. A request-level `400`/`409` also does not consume the
hint. A typed `target_not_found`, by contrast, removes the
edge and terminalizes its still-untransferred rows plus the one local
`target_removed` notice in one transaction.

## External endpoints

- `remote child`: a `host_edges` row on the initiator. No placeholder is added
  to `tasks`.
- `external parent`: a `host_external_sources` row on the owner. It becomes
  the R1 parent only while R1 is an archived top; it is never a `tasks.parent_id`
  foreign key.
- A local dispatch and an inbound external dispatch both open an account at
  ACP handoff. An account opened for an external parent records that parent id
  until settlement, even if R1 is later unarchived.
- `done` and `blocked` persist status, event, message, delivery, and external
  ownership together. Runtime notices use the same owner outbox with a
  structured kind and reason.
- Transport `202` means the owner committed the row. It does not mean ACP has
  accepted it. A typed `target_not_found` business response is the only remote
  deletion proof.

## Configuration and operations

See [Configuration](./configuration.md#multi-host) for `[hosts.<name>]`, token
commands, issuance, and trust boundaries. See [API](./api.md#host-to-host) for
the five interfaces and [Schema](./schema.md) for the additive tables.
