# Task Obligations

This document describes WebAgent's **directed-dispatch closure**: when an
agent-authored parent Task dispatches work directly to a child Task, the
runtime keeps one process-local account for that edge and reports the outcome to
the source. Only that dispatch opens an account; not every `task_send` does. The
account is the child's typed report, `done` or `blocked`. Fact notices
(`no_update`, `no_activity`, `target_removed`) report the runtime's stopping
point and never conclude for the accountable party. The task-semantic boundary
is in [Task semantic authority](implementation-invariants.md#task-semantic-authority).

The mechanism is deliberately small. It guarantees one thing: **one dispatch
eventually produces at least one typed update**, and the update status says
whose turn it is. Everything else — how many requests share an account, whether
the work is really done, whether a notice is worth acting on — is left to the
Tasks and their prose.

## Opening an account

An account opens when an **agent-authored direct parent→child dispatch** is
handed to the target's agent, not when it is queued. A target cannot owe an
update for a request it has not received:

```ts
message.source_actor === "agent" && target.parent_id === source.id
```

A user send (including a human message typed in the parent's session), a child
message, a typed update, and a runtime notice never open one. The predicate is
derived from the rows already stored; there is no classification field and no
body inspection. A target has at most one parent, so at most one account can be
open for it. A host dispatch is the same fact with an external endpoint:
the owner records the credential-bound external parent and the dispatch kind
when the message is received, then opens the account only when that queued row
is handed to R1's ACP process. Human input, runtime reminders, `202` transport
handoff, progress messages, typed updates, and runtime notices do not open an
account.

At most one account exists per `(source, target)` edge. A dispatch handed over
while the account is open keeps it open (coalesces); it does not create a
second request record and there is no correlation id. A `done` or `blocked`
settles that one account, covering every request the target has received. A
dispatch still queued behind the target's running turn is not covered: it opens
a new account when it is handed over.

## `task_update` statuses

| Status | Delivered to the requester? | Settles the account? |
|---|---|---|
| `done` | yes, wakes it | yes |
| `blocked` | yes, wakes it | yes |
| `waiting` | no | no |

`waiting` records that the target is still working and something will wake it
later: a child it dispatched, or its own background work. It is not delivered,
does not wake anyone, and does not settle; it only writes the Task's
`workflowStatus = waiting` and an event. It still satisfies the current turn's
update check (below). The runtime can see two wake sources — an open account
the target is the source of, or a delivery already queued to it. With neither,
the target is watched for silence (below) and the tool result says so.

What each status means to the agent is the `status` parameter description in
[`src/mcp/tools.ts`](../src/mcp/tools.ts). In short: `waiting` means the work
continues without the requester; anything that needs the requester, a person,
or an external event is `blocked`.

Runtime-set status stays separate: a drain sets `running`, and a finished turn
turns `running` into `idle`. A turn end never overwrites `waiting`.

`done` and `blocked` are delivered to the account's stored source, which wakes
it. A late update still settles. With no open account, they fall back to the
Task's current parent. An archived owner task with no local parent falls back to
its persisted external parent; that message remains in the owner outbox until
the initiating credential fetches and acknowledges it. `waiting` never routes.
An update with an open external account writes the Task status, event, message,
delivery, and external ownership fact in one transaction. Only after commit
does the controller close the account and the host hint kick the pull loop.

## Turn-end check

Turn boundaries are the only clock:

1. A target turn ends while the account is open and the turn carried no
   `task_update` of any status: the target gets one closing reminder.
2. Another such turn ends: the source gets a `no_update` notice and the runtime
   stops reminding. The account stays open, so a later update still settles it.
3. A turn that carried any update resets the whole cycle, including `waiting`:
   both the miss count and the stop-reminding flag.
4. A cancelled turn triggers nothing.

For a remote child, `waiting` asks one `hasChildWakeSource(parentId)` fact:
the host-side equivalent of an outstanding local child dispatch is one
`host_wake_hints` row from enqueue until a terminal typed update or runtime
notice arrives. It is deliberately separate from `host_dispatches` transport
state: consuming the hint does not terminalize another pending or retrying
POST. `202` transport success does not consume the hint, and neither does a
normal progress message. This is a conservative presence signal, not a mirror
of the owner's account.

The reminder is a runtime-injected turn asking for one typed update; its text
is `handoffReminderText()` in [`src/task-manager.ts`](../src/task-manager.ts).
It is queued through the normal delivery path, so it is held while the target's
turn runs and drained at its boundary like any other message. A runtime message
is not correspondence: the recipient sees exactly one row, written at drain,
titled in the runtime's own voice (`Task handoff required` for a closing
reminder, `Task handoff notice` for a fact notice), and named in `kind` rather
than in the `collaboration` sentence. The delivery row carries no kind, so the
title is recovered from the audit event that queued it — the producer records
the message id there.

## Silence

While the account is open, the source receives one `no_activity` notice when
the target has had no agent activity for the silence threshold
(`limits.silence_timeout`, 15 minutes by default) in either window:

- a running turn, from its prompt submission until it ends;
- a `waiting` with no visible wake source, from the update (or the end of the
  turn that carried it) until the next update or turn.

Any agent activity resets the window, including activity the agent starts on
its own outside a prompt, such as a harness waking it after a background
command. Each window notifies at most once; a new turn or a new `waiting` opens
a new window. The notice states the fact only: no state change, no reminder,
no cancel.

## Undelivered messages and a target that leaves

Any agent-authored message that cannot be delivered — the target was deleted
or archived away, `/clear` or an execution replacement dropped it, a resume
failed, or the agent rejected the request — sends its sender one
`target_removed` notice naming the failure reason. If it was the dispatch
behind the target's open account, that account closes with the same notice.
A user or runtime message failing reports nothing, and an unrelated failure does
not close an account.

For a remote-child POST, a structured authenticated `target_not_found` makes
the initiating side produce one `target_removed`; every later pending row on
that edge becomes a distinguishable terminal transport fact. Edge removal,
trigger/remaining row termination, wake-hint deletion, and the one local
`target_removed` delivery commit in the same Store transaction. `400` and `409`
are terminal without a target-removed notice. Authentication failures,
server failures, malformed/unknown routes, and network loss remain retryable
and produce no notice. A rejection of a report on the initiating side never
feeds a reverse notice to the owner.

While an account is open, a target that is deleted or archived away with no
undelivered dispatch also sends the source one `target_removed` notice, and
the account is gone.

## Persistence and scope

Reminders, notices, and settlements are persisted as Task events carrying
source, target, and reason so later statistics can read them. A settlement is
distinguishable from a fallback report to the current parent. Notices and
reminders are delivered like collaboration messages, in order, at the
recipient's turn boundary; a notice body names the target Task id (and title
when available) so two children with the same reason stay distinguishable, and
states the fact in the `message` sentence. The machine `reason` stays on the
event: the delivered body repeats it in prose rather than as a field. The account state
itself is process-local: a restart forgets open accounts and does not recover
reminders. Messages and delivery rows are durable, so a dispatch still queued
at restart opens its account when it is handed over afterwards.

## Known edges

The limits of this mechanism (shared accounts per edge, process-local state)
are recorded in [Known issues](known-issues.md#collaboration-accounting-limits).
