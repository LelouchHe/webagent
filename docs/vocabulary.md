# Vocabulary Contract

> **Status**: confirms the two-layer naming model for the product and the codebase.
> Last updated: 2026-09-04.

## Purpose

WebAgent is evolving from a chat tool into a workflow runtime. The user faces
exactly **one durable entity** per unit of work — history, attachments, config,
status, relationships, and message delivery all belong to it. This document
pins down what that entity is called and how it is separated from the
execution layer underneath.

Rule in one line: **`task` is the product entity; `session` means only the
execution unit (the ACP session and its matching CLI session).**

## The two-layer model

```text
task (product layer, stable, user-facing)
  ├── history / attachments / title / cwd / config
  ├── parent_id (Root / child task relationships)
  ├── workflow status (running | idle | waiting | blocked | done)
  ├── delivery / approval endpoints (S3)
  └── current execution binding (internal, rotatable)

session (execution layer, internal)
  = the ACP session and the corresponding CLI session/process
  ── owned by the configured agent, opaque, freely replaced by clear/rotate
```

- `task` never disappears because of `clear`, execution rotation, or server
  restart. The workspace has exactly one reserved Root task, with a
  per-database UUID (named by the `workspace` row) and `parent_id = NULL`. Like
  every task it is addressed as `#<task-id>` in the URL.
- `session` is an implementation detail. It is never user-visible and never
  leaks into product vocabulary, UI copy, or the public API naming.

The historical term "WebAgent Session" is **obsolete**; it means `task`.

## Term mapping

| Layer | Where | Was (WebAgent Session era) | Is |
|---|---|---|---|
| Concept | product entity | WebAgent Session | **task** |
| DB | table | `sessions` | `tasks` |
| DB | hierarchy column | `sessions.parent_session_id` | `tasks.parent_id` |
| DB | event lineage | `events.session_id` | `events.task_id` |
| DB | attachment lineage | `attachments.session_id` | `attachments.task_id` |
| DB | share tokens | `shares.session_id` | `shares.task_id` |
| DB | compact handoff | `sessions.pending_compact_summary` (column on `sessions`) | column stays on `tasks` |
| DB | execution binding | `agent_sessions.web_session_id` | `agent_sessions.task_id` (still references `tasks(id)`; `NULL` = no product entity) |
| REST | API | `/api/v1/sessions` family | `/api/v1/tasks` family |
| SSE | product events | `session_created`, `session_deleted`, `session_busy`, `session_expired`, `session_title_updated`, `session_not_found`, `session_manager_unavailable` | `task_*` equivalents |
| SSE | payload field | payload `session_id` identifying the product entity | `task_id` |
| Frontend | URL hash | `#<task-id>` (Root included) | unchanged — the hash carries only the id, so bookmarks and deep links survive |
| Frontend | modules | `session-actions.ts`, `session-navigation.ts`, `session-state.ts`, `sessions-anchor.ts` | `task-actions.ts`, `task-navigation.ts`, `task-state.ts`, `tasks-anchor.ts` |
| Backend | module | `src/session-manager.ts` | `src/task-manager.ts` (class `SessionManager` → `TaskManager`) |
| Backend | identifiers | `clearSession`, `loadSession`, `deleteEmptySessions`, `session title generation` | `clearTask`, `loadTask`, `deleteEmptyTasks`, `silent compact summary` |
| Commands | slash menu | `/new /switch /archive /rename /exit /clear /compact` | unchanged (no `session` in the words); help copy says "task" |
| MCP | control plane | `task_*` | `task_list`, `task_query`, `task_read`, `task_cancel`, `task_create`, `task_send`, `task_update` |
| Docs | product prose | "session", "WebAgent Session", "conversation" | **task** |

## What keeps `session` (reserved, by definition)

`sessions` here always means the execution unit. Allowed:

- **ACP protocol vocabulary**: `session/prompt`, `session/cancel`,
  `session/update`, `session/delete`, `session/close`, attach/detach — the
  wire terms in [`docs/acp.md`](./acp.md).
- **`agent_sessions` table and its columns** `agent_key`,
  `agent_session_id` (opaque ACP session ID); the table is the
  WebAgent ↔ ACP identity boundary and `web_session_id` becomes `task_id`.
- **CLI session**: the subprocess/session invoked by the configured agent
  CLI (e.g. `copilot --acp ...`).
- Backend identifiers whose primary subject *is* the ACP session
  (e.g. `rotateAgentSession` rotates an ACP binding). Identifiers whose
  primary subject is the product entity must become `task` (e.g.
  `clearSession` → `clearTask`).
- The attachment data directory is **`<data_dir>/tasks/<sid>/`**. Pre-1.0
  releases may have used `<data_dir>/sessions/`; releases with this storage
  contract do not migrate that legacy path. Back up and remove the old data
  directory before restarting.

## Task obligation vocabulary

The directed-dispatch closure mechanism has its own terms
([Task Obligations](./task-obligations.md)). These do not rename the product
entity; they name the runtime's bookkeeping.

| Term | Means |
|---|---|
| **account** | The process-local record one source Task keeps for one target, opened when an agent-authored direct parent→child dispatch is delivered and settled by the target's `done` or `blocked`. Not a persisted entity, and not a Task. |
| **settlement** | The atomic step that records a `done` or `blocked`, updates the reported status, delivers the update to the stored source, and closes the open account. A result submission, not proof that the source accepted it. |
| **stored source** | The source Task recorded when the account was opened. A settlement routes there even if the task tree changed afterwards. |
| **runtime message** | A message the runtime queues for one Task about its own bookkeeping — a closing reminder or a fact notice. Delivered like any other message, but not correspondence: no source handle, no delivery mark, and its `kind` names the item instead of `collaboration`. Its title never uses the task-reference grammar, because a source title would repeat and would read as a Task talking. |
| **closing reminder** | A runtime message delivered as a runtime-injected closing turn that asks the target for a typed update after a turn that carried none. It is a recovery aid, not a lifecycle verdict. |

## Link transport vocabulary

| Term | Means |
|---|---|
| **link** | One directed connection identified inside an instance by `(remote_role, remote_host)`. The two names are managed independently on the two instances and may happen to be equal. |
| **outbox** | The immutable, durable sequence of transport entries an instance sends over one link. Message and report entries point to their sender-side `deliveries` row; receipt entries do not. |
| **feed** | The ordered view of one link's durable outbox, addressed by `pos` and `prev`. |
| **watch** | The live request for a feed. `watch(after)` registers first, catches up, and then pushes future committed entries without an acknowledgement protocol. |
| **outbox cursor** | This instance's durable `applied_pos` in the other instance's outbox, stored once per link in `outbox_cursors`. It is a feed position, not an acknowledgement. |
| **receipt** | A delivery-state fact sent back over the source link. It CASes the referenced sender delivery and never becomes agent delivery work. |
| **hand-off** | Push cursor advancement: an exact `202`, a current-head receipt, or an authenticated rejection advances the link's `pushed_pos`, so the pump may send the next immutable outbox row. It is distinct from business state in `deliveries`. |

The transport `outbox` is unrelated to the product **Inbox** exposed by
`/api/v1/messages`, whose external messages are consumed to create or address
tasks. Inbox holds those pending product messages; outbox is the internal
cross-instance transfer sequence.

**`handoff` stays reserved.** It continues to mean the provider/lifecycle handoff
and the session-compaction handoff (for example `pending_compact_summary`); it is
not another name for the account or settlement. Prefer *account*
or *settlement* for this mechanism. The reservation is about naming that record:
the act of reporting one is still a handoff in product prose, as the Task Manual
and the closing reminder's own text say, so a transcript row may be titled after
the act (`Task handoff required`, `Task handoff notice`).

## Execution authority vocabulary

The bookkeeping that keeps a task stable while its execution is replaced
([Implementation Invariants](./implementation-invariants.md#execution-is-replaceable-the-task-is-not)).
All three are internal: none of them is product copy, UI wording, or API naming.

| Term | Means |
|---|---|
| **generation** | The integer a task records for "which generation of writes I currently accept". Advanced by exactly one per committed binding change and never persisted — a restart kills every execution, so there is no earlier generation whose late writes could arrive. |
| **lease** | `{taskId, generation}`, captured when an operation starts and validated at the write boundaries (event entry, and before each synchronous commit). A missing or unknown generation is refused rather than filled in with the current one. |
| **empty execution slot** | A reserved placeholder session id meaning "the binding agent is decided, the execution is still to be materialized": `no-execution:<taskId>` for every task, Root included. See [`schema.md`](./schema.md#agent_sessions). |
| **current execution binding** | The one `(agent id, ACP session id)` pair that currently executes a task. A task has at most one, globally. |
| **binding agent** | The configured agent of that binding. Public fields call it `agentId`. It is *not* an owner of the task: the task is the product entity and survives every rotation. |
| **execution environment** | One configured agent's process and the state that dies with it (cached config schema, reported identity, command snapshots). One per agent, started on demand. |

**`owner` is reserved for shares and preferences.** A task has a *binding
agent*, never an "owner": the binding is replaceable, so calling the agent an
owner would imply the task changes hands when an execution rotates. `owner`
still names the operator in share vocabulary (`owner_label`, `owner_prefs`) and
in the ACP sense of "the agent owns this session" — a real, non-transferable
relationship.

## Turn vocabulary

The runtime facts about one ACP prompt submission. These name internal
bookkeeping and are never product copy.

| Term | Means |
|---|---|
| **turn** | One real ACP prompt submission and the work it drives, from `bridge.prompt` to its terminator or its failed `finally`. Not a stored entity, and not a Task. |
| **turn origin** | Who opened that turn: `interactive` (a person at this task's UI, `/compact`, the beta quick prompt) or `delegated` (an agent-authoured delivery batch, or a runtime closing reminder). It belongs to one turn and disappears with it. |
| **turn slot** | The one place a task's open turn lives: membership plus its origin. There is at most one per task, which is why "which turn is running" is not derived from scattered sets. `state.runtime.busy` stays a projection of it. |
| **ACP prompt slot** | The exclusive right to submit one prompt to a task's execution. Interactive prompts, the collaboration drain, the closing reminder, and `/compact` all acquire it before submitting. `bash` is not an exception to it: bash never submits a prompt at all — it is an app-local child process that runs beside the ACP session, so it neither takes nor blocks this slot. |

## Prose and UI rules

- User-facing copy, slash-help text, README, and `docs/*.md` describe the
  entity as **task** ("Root task", "child task", "this task blocks on …").
  Never use "会话 / session / conversation" for the product entity.
- `clear` is worded as clearing the task in place; it never implies a "new
  session" to the user, even though the internal ACP execution is rotated.
- **`thread` is an editorial metaphor only** ("the task thread" = the
  execution trail of one task). It is never a code, API, or schema term, so
  it cannot collide with mainstream "thread = execution flow within a
  session".
- ACP-layer concepts keep their protocol names even inside product docs
  (`docs/acp.md`, bridge notes); this is not a violation.

## Decision record

- 2026-09-04 (user): rename the product entity to `task`; `session` is
  reserved for the execution unit (ACP session + matching CLI session).
- Why `task` and not `session`: the lifecycle and coordination verbs that
  define the workflow — running / blocked / done, approve, deliver, task
  tree — are natural for `task` and awkward or misleading for `session`
  ("a blocked session" reads like a dropped connection). `session` also
  connotes transience (expires, times out, ends), which is exactly the
  opposite of the contract that this entity survives `clear`, rotation, and
  restart.
- Why not `thread`: `thread` scores for continuity and family trees but has
  no lifecycle semantics (`done thread`), and the term already means
  "execution flow inside a session" across the ecosystem (e.g. Claude Agent
  SDK `sessions` + `threads`). It stays an editorial metaphor only.
- Ecosystem alignment: the durable work unit across cord, AgentRQ, Claude
  Code agent teams, spur, and task-harness designs is consistently called
  **task**; `session` is consistently the execution container (ACP, Copilot
  CLI, Claude SDK). The two-layer split above mirrors that.

## Applying the contract

The rename is a mechanical-but-wide refactor (DB → backend → frontend →
docs → tests). When executing it:

- The single Root is an intentional pre-1.0 incompatible change. A
  pre-multi-agent database is refused at startup; there is no automatic or
  in-place conversion from that shape: back up the data directory, then
  explicitly re-initialize it by removing the old database and restarting.
  The Root was introduced with the literal id `root` and later became a
  per-database UUID; that change is breaking in the same way, with no in-place
  rename (see `docs/schema.md`).
- The REST and SSE rename is a hard break with **no alias** (pre-1.0; the
  frontend and API move together). Route docs are validated by
  `test/doc-coverage.test.ts`, so `docs/api.md` must move in the same
  commit as `src/http/routes.ts`.
- URL hashes stay `#<task-id>`, Root included; a hashless URL resumes the most
  recent task. Root identity is reported by `GET /api/v1/config`
  (`rootTaskId`) and by the task list's `isRoot` flag, nowhere else; clients
  never compare against a literal value or a prefix. Server code asks
  `Store.isRootTaskId`.
- Sweep: `docs/schema.md`, `docs/api.md`, `docs/share.md`, `docs/features.md`,
  `docs/architecture/client.md`, `docs/performance.md`, `README.md`,
  `CLAUDE.md`, `TEST_SCENARIOS.md`, and the unit/e2e suites.
- Log each ambiguity (`rotateAgentSession`-style judgments) against this
  document; the rule is: **primary subject is the product entity → `task`,
  primary subject is the ACP/CLI execution → `session`.**