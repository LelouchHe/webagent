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

   root anchor: never deleted; a reset clears it in place → unmaterialized
```

| State | Means |
| --- | --- |
| **live** | Bound to exactly one current execution `(agentId, sessionId)`; prompts and events run against it. |
| **unmaterialized** | The binding agent is decided and the row exists, but there is no execution yet: the binding holds the reserved empty execution slot. The next use materializes one. Only a Root that *was* bound can be in this state; a Root that never had a binding is simply unbound and attaches on first use. |
| **tombstone** | Soft-deleted (`deleted_at` set) because at least one active public share still points at it. Row, events, attachments, and shares survive; the binding is gone. |
| **hard-deleted** | Rows are gone (events, attachments, binding) and the task directory on disk is removed. |
| **root anchor** | The literal `root`. A normal task in every other respect, but never deleted or garbage collected. |

## Transitions

| Trigger | Keeps | Drops / changes |
| --- | --- | --- |
| **Birth** — `POST /api/v1/tasks`, MCP `task_create` | — | Mints the task's MCP capability *before* `newSession`, then writes the task row and its binding in one transaction. A failure past minting discards the unbound ACP session and revokes the token; a persistence failure rolls the row back. |
| **Rotation** — `/clear` (optionally naming a configured `agentId`), `/compact`, implicit takeover when the binding agent left configuration | Task id, `parent_id`, events, attachments, shares, runtime `seq`, the obligation record with its attempts, stored config, cwd unless a new one is given | Runtime state resets; the old transport is truncated (claimed dispatch retries, unfinished delivery rows); generation +1; the displaced execution is retired through the agent recorded on the old binding; an `agent_rotation` transcript line records the trigger. A pending compact handoff survives `/compact` and is cleared by a plain `/clear`. |
| **Implicit takeover** — the binding agent is no longer in configuration | Everything a rotation keeps | The binding moves to `default_agent`'s reserved empty slot (Root: `""`, ordinary task: `no-execution:<taskId>`), leaving the task **unmaterialized**. A configured agent that is merely not running, dead, or unavailable is *not* a trigger; only removing it from configuration is. |
| **Materialization** — first use (resume, prompt, explicit clear) of an unmaterialized task | Everything | A fresh ACP session replaces the empty slot. All first-use paths share the same per-task single-flight. |
| **Delete** — `DELETE /api/v1/tasks/:id`, `/exit` off Root | Nothing | The **whole task tree**, whatever agent owns each descendant: rows gone, executions retired through each agent's adapter, directories removed. |
| **Delete with an active share** | Row, events, attachments, shares | Soft delete: `deleted_at` set, binding removed, re-parented under Root (detached when Root is missing or a live sibling-title collision exists). |
| **Tombstone reap** — last active share revoked | The row, until reaped | Hard-deleted. |
| **Empty-task GC** | The task's children | Only zero-event tasks older than 60 s, never Root, whatever agent carries them. Each removed execution is retired through the agent in its record. Children are re-parented under Root, not deleted. |
| **Process restart** | Bindings, history, shares, tree | Every execution is gone (its session id is dead); no agent process starts until a task needs one; the generation ledger starts empty and is re-adopted on the first restore; clients rebuild from a snapshot with a fresh `lastSeq`, because `seq` is process-local. |

## Three operations that look alike

| Operation | Scope | What happens |
| --- | --- | --- |
| `/clear` | One task | Rotates the execution. Task, history, and tree position are unchanged. |
| Root reset — `/exit` on Root, or `DELETE /api/v1/tasks/root` | Root and its whole subtree | Deletes the descendant tree, clears Root's own events, attachments, client ops, compact summary, and previews, leaves the Root row with Root's empty execution slot, bumps the generation. Root's identity and `parent_id = null` survive, and the reset is DB-only, so it works with the agent offline. |
| `/exit` | The current task | Deletes that task and its subtree; on Root it is the reset above. |

## Two irregularities worth knowing

- **Root is never deleted.** Generic deletion, empty-task GC, and tombstone
  reaping all refuse the literal `root`; only the reset clears it in place.
- **A tombstone exists only for an active public share.** Without one, deletion
  is immediate and complete. Survivors of a parent's deletion are therefore
  share tombstones and, for the empty-task GC only, the GC'd task's children.

## Where the details live

- Normative rules ("must"): [Implementation Invariants](implementation-invariants.md#execution-is-replaceable-the-task-is-not).
- Columns, indexes, foreign keys, delete SQL: [Database Schema](schema.md#cascade--lifecycle).
- Debt, delivery outcomes, obligation state machine: [Task Obligations](task-obligations.md#rotation-does-not-end-the-debt).
- User-facing command semantics: [Features](features.md) and [Task Manual](task-manual.md).
