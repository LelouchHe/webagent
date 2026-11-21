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

An account opens only for an **agent-authored direct parent→child dispatch**:

```ts
message.source_actor === "agent" && target.parent_id === source.id
```

A user send (including a human message typed in the parent's session), a child
message, a typed update, and a runtime notice never open one. The predicate is
derived from the rows already stored; there is no classification field and no
body inspection. A target has at most one parent, so at most one account can be
open for it.

At most one account exists per `(source, target)` edge. A new dispatch while the
account is open keeps it open (coalesces); it does not create a second request
record and there is no correlation id. A `done` or `blocked` from the target
settles that one account, even if several requests arrived in the meantime.

## `task_update` statuses

| Status | Delivered to the requester? | Settles the account? |
|---|---|---|
| `done` | yes, wakes it | yes |
| `blocked` | yes, wakes it | yes |
| `waiting` | no | no |

`waiting` records that the target is still working and something will hand off
and wake it later, typically a child it dispatched. It is not delivered, does
not wake anyone, and does not settle; it only writes the Task's
`workflowStatus = waiting` and an event. It still satisfies the current turn's
update check (below). It is refused, with nothing recorded, unless something
will wake the Task: an open account it is the source of, or a delivery already
queued to it. A refused `waiting` does not count as the turn's update.

Waiting on a human, an external event, missing information, or a permission is
`blocked`, not `waiting`, because nothing will wake the Task by itself.

Runtime-set status stays separate: a drain sets `running`, and a finished turn
turns `running` into `idle`. A turn end never overwrites `waiting`.

`done` and `blocked` are delivered to the account's stored source, which wakes
it. A late update still settles. With no open account, they fall back to the
Task's current parent (or nowhere when it has none). `waiting` never routes.

## Turn-end check

Turn boundaries are the only clock:

1. A target turn ends while the account is open and the turn carried no
   `task_update` of any status: the target gets one closing reminder.
2. Another such turn ends: the source gets a `no_update` notice and the runtime
   stops reminding. The account stays open, so a later update still settles it.
3. A turn that carried any update resets the whole cycle, including `waiting`:
   both the miss count and the stop-reminding flag.
4. A cancelled turn triggers nothing.

The reminder is a runtime-injected turn that asks for one typed update: `done`,
`blocked`, or `waiting` when another Task will hand off and wake the target. It
is queued through the normal delivery path, so it is held while the target's
turn runs and drained at its boundary like any other item. Runtime items are
labeled as authored by the WebAgent runtime, not by the named task; the
recipient sees exactly one row, written at drain.

## Stuck turn

While the account is open, a running target turn with no agent activity for 15
minutes makes the source receive one `no_activity` notice for that turn. It
states the fact only: no state change, no reminder, no cancel. Activity resets
the window; a new turn gets its own notice.

## Target leaves the edge

While an account is open, if the target actually disappears — deleted, or
archive cut the edge from its parent — or the **qualifying dispatch delivery**
itself failed (a failed prompt, `/clear`, or an execution owner replacement),
the source gets one `target_removed` notice and the account is gone. An
unrelated delivery to the same target failing does not settle the account. A delivery that is queued to a deleted target is failed
with `target_deleted` by the delivery layer; the same account removal covers it.
This is the only notice that replaces the old separate delivery-failure notice.

## Persistence and scope

Reminders, notices, and settlements are persisted as Task events carrying
source, target, and reason so later statistics can read them. A settlement is
distinguishable from a fallback report to the current parent. Notices and
reminders are delivered like collaboration messages, in order, at the
recipient's turn boundary; a notice body names the target Task id (and title
when available) so two children with the same reason stay distinguishable. The account state
itself is process-local: a restart forgets open accounts, does not recover
reminders, and does not replay queued requests. Messages and delivery rows are
durable and unaffected.

## Known edges

Recorded, not guarded, in [Known issues](known-issues.md):

- One account per edge means several requests share it. One `done` or `blocked`
  settles all of them; the requester and target clarify the mapping in prose.
- Because accounts are process-local, after a restart a Task whose child is
  still working cannot report `waiting` until it dispatches again. The child's
  `done` or `blocked` still reaches it as the current parent.
