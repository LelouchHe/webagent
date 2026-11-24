# Task Lifecycle

One page for "what state is this task in, and what does each transition keep or
drop". It is the authority for the task **state machine**. The normative rules,
the SQL mechanics, and the debt state machine live in their own documents (see
[Where the details live](#where-the-details-live)).

## States

```text
   creation (POST /tasks, MCP task_create)
        │
        ▼
   ┌─────────┐   rotation: /clear, /compact     ┌─────────────┐
   │  live   │ ───────────────────────────────► │    live     │
   │(bound)  │   same task, new execution       │ (new exec)  │
   └────┬────┘ ◄─────────────────────────────── └─────────────┘
        │
        │  binding agent removed from configuration
        ▼
   ┌───────────────┐   next use / explicit clear
   │ unmaterialized│ ─────────────────────────► live
   └───────────────┘   (lazy materialization)

   Root only: never bound ──first use──► live (attach, no empty slot ever existed)

   live ──delete (no active share)──────────────► hard-deleted
   live ──delete (active share)──► tombstone ──last share revoked──► hard-deleted
   live ──empty-task GC─────────────────────────► hard-deleted (children re-parented)

   root anchor: never deleted on its own; an exit replaces it with a new Root
```

| State | Means |
| --- | --- |
| **live** | Bound to exactly one current execution `(agentId, sessionId)`; prompts and events run against it. |
| **unmaterialized** | The binding agent is decided and the row exists, but there is no execution yet: the binding holds the reserved empty execution slot. The next use materializes one. A Root an exit created is in this state until its execution exists; a Root that never had a binding is simply unbound and attaches on first use. |
| **tombstone** | Soft-deleted (`deleted_at` set) because at least one active public share still points at it. Row, events, attachments, and shares survive; the binding is gone. |
| **hard-deleted** | Rows are gone (events, attachments, binding) and the task directory on disk is removed. |
| **root anchor** | The Root: the task the `workspace` row names (a per-database UUID). A normal task in every other respect, but never deleted or garbage collected on its own: only an exit removes it, and only by replacing it. |

## Transitions

| Trigger | Keeps | Drops / changes |
| --- | --- | --- |
| **Birth** — `POST /api/v1/tasks`, MCP `task_create` | — | Mints the task's MCP capability *before* `newSession`, then writes the task row and its binding in one transaction. A failure past minting discards the unbound ACP session and revokes the token; a persistence failure rolls the row back. |
| **Rotation** — `/clear` (optionally naming a configured `agentId`), `/compact`, implicit takeover when the binding agent left configuration | Task id, `parent_id`, events, attachments, shares, runtime `seq`, the open account, stored config (only when the agent stays the same; another agent's execution starts from its own defaults), cwd unless a new one is given | Runtime state resets; the old transport is truncated (unfinished delivery rows fail); generation +1; the displaced execution is retired through the agent recorded on the old binding; an `agent_rotation` transcript line records the trigger. A pending compact handoff survives `/compact` and is cleared by a plain `/clear`. |
| **Implicit takeover** — the binding agent is no longer in configuration | Everything a rotation keeps | The binding moves to `default_agent`'s reserved empty slot (`no-execution:<taskId>`, Root included), leaving the task **unmaterialized**. A configured agent that is merely not running, dead, or unavailable is *not* a trigger; only removing it from configuration is. |
| **Materialization** — first use (resume, prompt, explicit clear) of an unmaterialized task | Everything | A fresh ACP session replaces the empty slot. All first-use paths share the same per-task single-flight. |
| **Unarchive** — `POST /api/v1/tasks/:id/unarchive` | Task id, subtree, events, attachments, shares, binding, runtime | `parent_id` is set to the original parent recorded by the latest `task_archive` message when that parent is still live in the active tree; otherwise it is set to the current Root (deleted/missing parent, old Root after a Root exit, or no archive record). One `system_message` (`task_unarchive`) names the destination and, on fallback, the missing original id. Refused only when the original parent is itself archived or the destination has a live title collision. Cut obligation/delivery edges are not restored. |
| **Delete** — `DELETE /api/v1/tasks/:id`, `/exit` off Root | Nothing | The **whole task tree**, whatever agent owns each descendant: rows gone, executions retired through each agent's adapter, directories removed. |
| **Archive** — `POST /api/v1/tasks/:id/archive`, `/archive` | Task id, subtree, events, attachments, shares, binding, runtime | `parent_id` is cleared, detaching the task and its whole subtree from the tree as one **archived tree**. One `system_message` (`task_archive`) naming the former parent's path and id is appended to the detached task; children get no rows. A pending account to the former parent is dropped from the controller and the former parent receives one `target_removed` notice, so a later `task_update` is recorded but not delivered to the parent it left. Not-yet-handed-over collaboration between the archived subtree and **anything outside it** — a queued message in either direction — is marked failed (`archived_edge_cut`) and kept as a record; messages wholly inside the subtree are untouched, and rows already `delivered` or `failed` keep their own status and reason. Work already handed to ACP is not recalled. These persistent writes commit with the detach and the system message in one transaction; the account is dropped only after that commit. No row, column, or event type marks the tree; the structure is the fact. |
| **Delete with an active share** | Row, events, attachments, shares | Soft delete: `deleted_at` set, binding removed, re-parented under Root (detached when Root is missing or a live sibling-title collision exists). |
| **Tombstone reap** — last share revoked (the revoke route is the only caller) | The row, until reaped | Hard-deleted: task row, events, attachment rows (cascaded), and `tasks/<id>` on disk. Repeating the reap is a no-op, and a tombstone that still has an activated share is never reaped. |
| **Empty-task GC** | The task's children | Only zero-event tasks older than 60 s, never Root, whatever agent carries them. Each removed execution is retired through the agent in its record. Children are not deleted: outside an archived tree they are re-parented under Root; inside one they detach and become their own archived tops, so GC never pulls archived history back into the Root tree. |
| **Process restart** | Bindings, history, shares, tree | Every execution is gone (its session id is dead); no agent process starts until a task needs one; the generation ledger starts empty and is re-adopted on the first restore; clients rebuild from a snapshot with a fresh `lastSeq`, because `seq` is process-local. |

## Archived Trees

An **archived tree** is a live, parentless, non-Root task and its whole
subtree. There is no `archived_at`, no table, and no state flag: a task is
archived exactly when it is live, `parent_id IS NULL`, and not Root. Any
parentless subtree produced elsewhere — for example an orphan detached by
`reparentChildrenToRoot` when Root is missing or a sibling title collides —
falls under the same definition and is therefore reachable from `/archive`.

- **Unarchive goes back to the original parent, or to Root when it is gone.**
  A live archived tree top can be re-attached under the parent recorded by its
  latest `task_archive` message (`POST .../unarchive`). If that parent was
  deleted, is not found, or was the old Root removed by a Root exit — or if no
  archive record exists — the top is attached under the current Root. A parent
  that is itself inside an archived tree, a live title collision at the
  destination, Root, and deeper archived tasks are refused. The whole subtree
  follows the top; the account and delivery edges cut by the archive stay
  cut. While archived, the task can be opened, prompted, executed, and accounted
  like any live task, but it does not appear in `/switch`.
- **Archive is not delete.** `/exit` remains the delete operation. To delete an
  archived task, enter it from `/archive` and exit there; Root exit deletes only
  the Root tree, so archived trees are untouched.
- **Internal collaboration is unchanged.** The MCP surface is self, parent, and
  direct children. An archived top has no parent, so different archived trees
  cannot see each other through MCP; collaboration inside one archived tree
  works as before. A human send over REST may cross trees.
- **List visibility is a read filter.** `GET /api/v1/tasks` excludes archived
  trees by default and can select them with `archived=true`.
  No read depends on execution, and a `read`-scope token never warms one.
  Task detail and snapshot warm only when the caller explicitly sends
  `warm=1`; event buffers flush only with `flush=1`.

## Three operations that look alike

| Operation | Scope | What happens |
| --- | --- | --- |
| `/clear` | One task | Rotates the execution. Task, history, and tree position are unchanged; `model` / `mode` / `reasoning_effort` are kept only when the agent stays the same. |
| Root exit — `/exit` on Root, or `DELETE /api/v1/tasks/<root id>` | Root and its whole subtree | An ordinary delete of the whole tree (the old Root included, tombstoned if shared) plus a fresh Root, in one transaction. The new Root has a new id and keeps the directory, title, saved model, and agent; it starts in agent mode with no history. Its execution is created before the request returns, so the client lands on a task that is already live and idle, the same state a freshly created task is in. The agent is checked first: one that cannot start refuses the exit (`503`) with the tree untouched. Two roots have nothing to create and stay lazy: one that was never bound (its first prompt attaches) and one whose recorded agent left the configuration (an operation rotates it). Only a session that fails *after* the commit leaves the empty execution slot, which the next use then materializes. |
| `/exit` | The current task | Deletes that task and its subtree; on Root it is the exit above. |

## Two irregularities worth knowing

- **Root is never deleted on its own.** Generic deletion, empty-task GC, and
  tombstone reaping all refuse the Root; only an exit removes it, and always
  together with the Root that replaces it.
- **A tombstone exists only for an active public share.** Without one, deletion
  is immediate and complete. Survivors of a parent's deletion are therefore
  share tombstones and, for the empty-task GC only, the GC'd task's children.

## Where the details live

- Normative rules ("must"): [Implementation Invariants](implementation-invariants.md#execution-is-replaceable-the-task-is-not).
- Columns, indexes, foreign keys, delete SQL: [Database Schema](schema.md#cascade--lifecycle).
- Accounts, reminders, and notices: [Task Obligations](task-obligations.md); rotation keeps the account: [Implementation Invariants](implementation-invariants.md#execution-is-replaceable-the-task-is-not).
- User-facing command semantics: [Features](features.md) and [Task Manual](task-manual.md).
