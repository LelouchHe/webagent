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
  ├── workflow status (running | blocked | done — S3)
  ├── delivery / approval endpoints (S3)
  └── current execution binding (internal, rotatable)

session (execution layer, internal)
  = the ACP session and the corresponding CLI session/process
  ── owned by the configured agent, opaque, freely replaced by clear/rotate
```

- `task` never disappears because of `clear`, execution rotation, or server
  restart. The reserved Root task (id `root`) is the canonical clean URL.
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
| DB | execution binding | `agent_sessions.web_session_id` | `agent_sessions.task_id` (still references `tasks(id)`; `NULL` = no product entity, e.g. title generation) |
| REST | API | `/api/v1/sessions` family | `/api/v1/tasks` family |
| SSE | product events | `session_created`, `session_deleted`, `session_busy`, `session_expired`, `session_title_updated`, `session_not_found`, `session_manager_unavailable` | `task_*` equivalents |
| SSE | payload field | payload `session_id` identifying the product entity | `task_id` |
| Frontend | URL hash | `#<uuid>` (Root: no hash) | unchanged — the hash carries only the id, so bookmarks and deep links survive |
| Frontend | modules | `session-actions.ts`, `session-navigation.ts`, `session-state.ts`, `sessions-anchor.ts` | `task-actions.ts`, `task-navigation.ts`, `task-state.ts`, `tasks-anchor.ts` |
| Backend | module | `src/session-manager.ts` | `src/task-manager.ts` (class `SessionManager` → `TaskManager`) |
| Backend | identifiers | `clearSession`, `loadSession`, `deleteEmptySessions`, `session title generation` | `clearTask`, `loadTask`, `deleteEmptyTasks`, `task title generation` |
| Commands | slash menu | `/new /switch /rename /exit /clear /compact` | unchanged (no `session` in the words); help copy says "task" |
| MCP (S2) | control plane | (pending `session_*` vs `task_*`) | `task_list`, `task_query`, `task_send`, `task_propose`, `task_update` |
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
- The attachment data directory is **`<data_dir>/tasks/<sid>/`** — it
  follows the rename. A one-time boot migration
  (`Store.migrateAttachmentsDataDir`) moves a pre-rename
  `<data_dir>/sessions/` directory to `tasks/` and rewrites persisted
  `attachments.realpath` rows; it is idempotent and runs before the
  server starts listening.

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

- SQLite renames are non-destructive (`ALTER TABLE … RENAME [COLUMN …]`);
  the dogfood DB is migrated in place, Root (`root`) keeps its reserved id,
  and no data is deleted.
- The REST and SSE rename is a hard break with **no alias** (pre-1.0; the
  frontend and API move together). Route docs are validated by
  `test/doc-coverage.test.ts`, so `docs/api.md` must move in the same
  commit as `src/routes.ts`.
- URL hashes stay `#<uuid>` / hashless Root — bookmarks survive unchanged.
- Sweep: `docs/schema.md`, `docs/api.md`, `docs/share.md`, `docs/features.md`,
  `docs/client-architecture.md`, `docs/performance.md`, `README.md`,
  `CLAUDE.md`, `TEST_SCENARIOS.md`, and the unit/e2e suites.
- Log each ambiguity (`rotateAgentSession`-style judgments) against this
  document; the rule is: **primary subject is the product entity → `task`,
  primary subject is the ACP/CLI execution → `session`.**