# `shared/sync`

Platform-neutral synchronization primitives. This directory knows positions,
requests, streams, retries, and injected persistence/transport ports. It does
not know Tasks, links, delivery rules, or WebAgent storage.

```text
 module          uses              caller injects
 ------------    --------------    ------------------------------------------
 request         -                 transport, Clock/Timer
 outbox          request           next() / finish() persistence port
 feed consumer   -                 read / watch transport, applied() / apply()

 request         one call: operation id + timeout
                 -> success | explicit 4xx | unknown (network, timeout, 5xx)

 outbox          one active entry at a time
                 retry the same entry with the same operation id
                 release the next entry only after the caller reports hand-off

 feed consumer   read(after) / watch(after); entries carry pos + prev
                 serial apply; overlap ignored; gaps filled by read pages;
                 a new watch generation voids the old one's work
```

The module only decides *when* to send, retry, read, or stop. What an entry
means, how it is stored, and what counts as hand-off are the caller's: for
links, `src/host/link-sync.ts` and the `Store` implement those ports.

## Request

`sendSyncRequest` sends one typed request with an operation id and bounded
wait. The neutral result has three classes: success, explicit `4xx`, and
unknown (transport failure, timeout, or server error). A caller that implements
an operation-level durability contract owns how those classes affect the entry.

## Feed consumer

The consumer applies one feed serially:

```text
applied = durable local position

receive entry:
  pos <= applied       -> ignore overlap
  prev == applied      -> apply and commit applied=pos atomically
  prev != applied      -> read(after=applied), page by page, apply chain

new watch generation:
  stale frames, reads, retries, and abort-delayed continuations are invalid
```

Every data frame and heartbeat calls `activity()` without re-running
`connected()`. A protocol failure stops that feed's supervisor; a temporary
failure and retry remain per link. The caller's persistence port is the only
code allowed to advance `applied`.

## Outbox

The outbox primitive keeps one active entry, retries it with the same operation
id, and separates request state from the local result. A normal wake does not
clear an active retry. `handedOff(entryId)` or stop invalidates the current
generation and clears its timer before the next entry can start. In the
injected persistence port, hand-off is a monotonic `pushed_pos` update rather
than mutable outbox-row state. A response
that arrives after hand-off reaches the old callback but cannot call `finish`
for that entry.

## Dependency boundary

All transport, credentials, persistence, and timers are injected narrow ports.
The module must not import Node-only APIs, SQLite, `Store`, `TaskManager`, or a
Host implementation. `eslint.config.js` enforces this for
`src/shared/sync/**/*.ts`; the direct lint-boundary test injects a forbidden
`Store` import and asserts that `no-restricted-imports` rejects it.
