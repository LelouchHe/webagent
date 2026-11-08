# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.13.0] - 2026-11-08

### ⚠️ BREAKING

- **Reset the data directory before upgrading.** There is now exactly one Root per database, and its id is a UUID recorded in the `workspace` row instead of one Root derived per agent. Startup refuses a pre-multi-agent database read-only, before any write: a Root still carrying the old literal or `root-<hash>` identity, a task with no Root to attach to, or an `agent_sessions.agent_key` holding a command path. Back up first, remove the data directory (or just the database), and let WebAgent create the single-Root schema. There is no in-place conversion, and startup never edits an old database. See [pre-1.0 reset policy](docs/schema.md#pre-10-reset-policy).
- **Rewrite `config.toml`: agents are declared tables, and a config file is required.** `agent_cmd` is rejected, including `auto`. Declare each agent as `[agents.<id>]` with `cmd = "…"` — the key is both the id and the display name — and name one as the required `default_agent`. There is no implicit PATH detection any more, so a binary that used to be found automatically must now be configured explicitly. A config file must declare at least one agent; `webagent config init` scaffolds one. Agent tables are strict: a typo such as `cmdd` fails startup instead of being ignored. See [ACP-compatible agents](docs/configuration.md#acp-compatible-agents).
- **Node 24 or later is required.** The floor moves from 22.6 to 24, and CI publishes on 24 as well.
- **`/exit` on Root replaces the Root instead of resetting it in place.** The whole tree is deleted (the old Root included, tombstoned when a share still points at it) and a fresh Root with a new id takes its place in one transaction, keeping the directory, title, saved model, and agent, and starting in agent mode with no history. Its execution is created before the response, so the client lands on a live, idle task; an agent that cannot start refuses the exit with `503` and leaves the tree untouched. See [Task lifecycle](docs/task-lifecycle.md#three-operations-that-look-alike).
- **Update REST and SSE integrations for the multi-agent contract.** Root identity is a per-database UUID reported once by `GET /api/v1/config`, which now also returns the configured `agents` directory (`{ id }[]`, configuration order) and `defaultAgentId`. Task entries report `agentId` (`null` when the task has no binding) and `isRoot`. `POST /api/v1/tasks` and `POST /api/v1/tasks/:id/clear` accept an `agentId`, and their failures name the agent that was actually attempted. The task-delete response and its `task_deleted` event carry `replacedBy` for a Root exit, replacing the old `reset` field and the `task_reset` event; `task_deleted` also names the removed execution's agent, activation payloads carry `parentAgentId`, `task_runtime_warmed` is new, and the SSE handshake no longer carries `rootTaskId`. A share revoke response reports `revoked`. See [API](docs/api.md).
- **Update tool names for the injected MCP server.** The server is now named `lelouchhe_webagent` rather than `webagent`, because some clients namespace tools by it and refuse a generic name (Claude Code rejects `webagent`). Agents that expose MCP tools as `mcp__<server>__<tool>` now see `mcp__lelouchhe_webagent__task_*`; update any allowlist, prompt, or skill that names the old form, including Pi's documented setup. See [Task MCP Control Plane](docs/task-mcp.md#the-server-name).
- **An agent that answers `initialize` with another protocol version is refused.** WebAgent is fixed at ACP v1 and fails the start instead of running against a stream it cannot interpret, so an agent that speaks only v2 is reported as unavailable rather than silently mis-rendered. The transport moves to `@agentclientprotocol/sdk` 2.4.0; the protocol on the wire stays v1. See [ACP surface](docs/acp.md).

### Added

- **One server drives several ACP agents at once.** Each `[agents.<id>]` table is an agent, and every Task records the agent it was created for. There is still one task tree, not one per agent: every list, search, and `@` reference spans all of them. Choose the agent at creation with an `<agent>:` coordinate (`/new copilot:~/repo`, `+docs copilot:~/repo`); without it a Task inherits the current Task's agent, and a coordinate with no path starts in the current cwd. Rotate an existing Task in place with `/clear copilot:`: the Task, its history, attachments, cwd, and tree position stay, the new agent starts a fresh ACP session, and the transcript records the rotation. The create and clear menus suggest the configured agent ids and fold the settled coordinate into the status bar. `task_create` accepts `agent`, so a parent on one agent can dispatch to a child on another. Agents come and go independently: a missing CLI makes only that agent's Tasks unavailable. See [Multiple agents](docs/features.md#multiple-agents).
- **Dispatched work runs unattended.** A turn opened by an agent's message or by a runtime reminder is delegated — nobody is watching that Task's own page — so the host answers its tool-permission requests itself (`allow_once`, otherwise `allow_always`) and stores each answer as a `permission_response`, leaving a complete audit without a prompt that would never be seen. Your own turns are untouched: they still ask, still respect the Task's mode, and still notify. `task_cancel` (from either side) ends the current execution while keeping the Task and its history, writes one transcript row on each side of the edge naming who cancelled what and why, and leaves the edge quiet until new work arrives; a cancelled turn owes no closing reminder, a settled edge is never reopened, and a late account still settles. See [Unattended dispatched work](docs/features.md#unattended-dispatched-work).
- **Agent images render in the transcript.** Inline image blocks in tool results render inline, open in the lightbox, survive a reload, and appear in the public share viewer. Each image is stored as an ordinary attachment and referenced by a signed URL resolved at egress, so the page never receives raw bytes after upload and the live SSE frame carries no image payload; a failed or oversized image degrades to a placeholder rather than to a pass-through. A Copilot image tool that returns only a file path is recovered as a documented workaround. See [Tool result images](docs/acp.md#tool-result-images).
- **`webagent config init` scaffolds a configuration file.** It writes the commented `./config.toml` template, so the now-required agent table and `default_agent` start from a working example.

### Changed

- **Agents start on demand, and a read never starts one.** Server boot starts zero agent processes, and so does listing Tasks, reading a Task or its snapshot, `/config`, `/version`, shares, or deletion. An agent's process starts the first time a Task bound to it has to execute, with one flight owning that process: concurrent demand shares one start attempt, a reload runs inside it, and demand arriving during a reload waits. A missing or broken binary is a runtime condition — the service and the other agents keep working, and the first use returns the real reason as a `503` instead of tripping a startup gate. Nothing is probed at boot. See [Configuration](docs/configuration.md#startup-laziness-and-availability).
- **A Task's execution is replaceable; the Task is not.** `/clear` keeps the id, history, attachments, shares, cwd, and tree position and swaps only the ACP execution. Rotating onto a different agent clears the stored `model`, `mode`, and `reasoning_effort`, because they describe the environment that no longer runs the Task; a same-agent rotation replays them. Execution config never crosses agents: a cross-agent child starts from the target's own defaults, and explicit values are validated by the session that will run them. See [Task lifecycle](docs/task-lifecycle.md#three-operations-that-look-alike).

### Fixed

- **Cancelling a local `!` command is bounded and always collectable.** Stopping used to send `SIGINT` and immediately drop the only tracked handle, so a command that ignored the signal kept running with nothing able to reach it, and its late close could delete whatever handle the Task had by then. Stopping now escalates once — `SIGINT`, then `SIGKILL` if the same process is still alive after a grace period (forced `taskkill` on Windows) — and the handle stays registered until the run actually closes, so a repeated cancel, a reload, or a teardown can always reach it.
- **A tombstoned Task's last share can be revoked.** Revoking required a live execution binding, but deleting a Task that still has an active share keeps the row as a tombstone and removes the binding, so the owner could never revoke the last share: the tombstone, its events, and its attachment directory leaked for good. Owner-side share writes now gate on the Task row, with the existing token-to-task match as the authorization, so revoking the last share reaps the row, its events, its attachment rows, and `tasks/<id>/`.
- **A refused configuration write no longer reports success.** The model picker, the typed config command, and the `Ctrl+M` mode cycle printed their transcript line before the `PUT` and swallowed failures, so a refused or lost write (rotation, dead process, shutdown mid-request) claimed the change had happened while the Task kept its old value. Each writer now awaits the write, prints only on success, and on failure reports the error, rolls the selector back, and repaints.
- **Outcome notices reach the parent as readable prose.** A notice's body used to be `JSON.stringify(payload)` while every other collaboration message was prose, and its live title came from a different formatter than the persisted twin, so the same notice read differently before and after a reload. The body is now a `reason:` / `message:` / `openingMessageId:` block; the machine payload stays on the `task_outcome_notice` event, and the title comes from the one formatter the store uses.
- **A remote repaint no longer closes the iOS keyboard.** Writing `disabled` on the focused textarea makes iOS drop focus and the software keyboard even when the value does not change, and every redraw caused by a remote event landed while the user was tapping the input. Availability now has a single writer that does nothing on an equal value.

## [0.12.0] - 2026-10-04

### ⚠️ BREAKING

- **Reset the data directory before upgrading.** Back up first (a consistent copy, or `sqlite3 .backup`), then remove the existing data directory and let WebAgent create a fresh one. Pre-1.0, a reset is the supported baseline and the simplest upgrade: it avoids every conversion below. Keeping the history is possible — the timestamp migration runs in place at startup, with the verification and rollback steps in the runbook — but the previous shared literal `root` identity does not migrate, so old Root links stay dead either way.
- **Update timestamp readers before upgrading.** Timestamp columns now store INTEGER unix milliseconds, and every JSON egress timestamp renders ISO-8601 UTC with an explicit `Z`, for example `2026-10-04T12:00:00.000Z`. REST and MCP consumers must accept this string form instead of bare UTC strings or integer timestamps; durations and sequence counters remain numeric. The timestamp migration runs automatically at startup and refuses malformed values rather than coercing them. Reverting the binary alone cannot undo it: rollback requires the full pre-deploy database backup. Startup also rejects duplicate Task event sequences. See [API timestamps](docs/api.md#timestamps) and the [migration and rollback runbook](docs/schema.md#migration-and-rollback).
- **Discover Root identity instead of hardcoding `root`.** Each Agent backend now has a derived Root id: `root-` plus the first 32 lowercase SHA-256 hex characters of its `agent_key`. REST and SSE supply the current backend's `rootTaskId`; only that exact Root is hashless. The old literal `root` and foreign Root ids are not compatibility aliases. Existing shared literal-Root data is not automatically converted to the new identity; its conversion or reset must be planned separately. See [database upgrade policy](docs/schema.md#pre-10-reset-policy) and the [API contract](docs/api.md).
- **Update MCP history calls to the flat-index and batch-read contract.** `task_query` replaces `cursor`/`limit` pagination with inclusive sequence `range` values, including negative tail indexes, and returns `{ task_id, max_seq, rows }`. It indexes thinking rows as well as other events and supports fixed-string search with ASCII case folding. `task_read({ seqs: [...] })` replaces `task_get_record` with no alias, returning complete decoded event payloads in sequence order. Both tools default to the current Task and reject oversized responses rather than returning partial history. See [Task MCP Control Plane](docs/task-mcp.md).
- **Use the returned canonical model values in integrations.** Model values encoded by an Agent as a JSON provider/model pair now appear as `provider/model-id` in Task configuration, REST, and SSE, and existing saved values are normalized. Other opaque model values retain their identity; group labels are display text, not model ids. WebAgent translates canonical selections back to the exact ACP value for the owning execution. See [ACP model selection](docs/acp.md#current-limits).

### Added

- **Compaction handoffs can trace their own summary chain.** New `/compact` summaries carry their persisted event sequence and a link to the preceding summary. The next execution receives a directly callable `task_read` pointer, so an Agent can recover a summary verbatim and follow older handoffs without loading the entire transcript. Handoffs are explicitly self-reports: the persisted event log outranks them. Existing pending plain-text summaries remain readable.
- **Tool source code has its own expandable view.** Tool calls with `rawInput.code` show the exact multiline source in a collapsed `code` disclosure, including when source arrives in a later metadata update. The app and public share viewer use the same rendering.

### Changed

- **Switching Agent backends keeps their Root histories and resources separate.** Returning to a backend restores its own Root, Task URLs, history, and attachments. Root reset and descendant deletion are scoped to the current backend; surviving shared Tasks are preserved under their unambiguous owner's Root or detached when safe ownership cannot be established. Agent-session bindings are now unique per backend and Task rather than globally per Task. See [Task lifecycle](docs/schema.md#cascade--lifecycle).
- **Pi setup now uses its built-in MCP support.** The documented setup requires Pi 0.99 or later and the `LelouchHe/pi-acp` fork. Remove MCP-replacement extensions such as `pi-mcp-adapter`, which disable Pi's built-in support and prevent the injected Task server from attaching. See [Pi configuration](docs/configuration.md).
- **ACP transport uses SDK 1.7.0 with an explicit inbound message limit.** WebAgent allows individual ACP messages up to 128 MiB rather than the SDK's 32 MiB default, leaving room for tool results from the default 50 MiB uploads. An oversized message closes the Agent connection and reports that a restart is required instead of leaving Tasks apparently connected and repeatedly failing. The cap applies to serialized ACP messages, not just file size, and does not grow with the configured upload limit. See [ACP limits](docs/acp.md#current-limits).

### Fixed

- **Tasks restore on Agents that support `session/resume` without `session/load`.** Restoration now reads advertised ACP capabilities and prefers `session/resume`, avoiding transcript replay; `session/load` is used when resume is unavailable and load is advertised. Saved configuration and preferences are retained. When neither is supported, WebAgent gives a `/new` recovery message instead of silently creating a replacement execution.
- **Grouped ACP choices work throughout model selection.** Model pickers flatten grouped choices with group-qualified labels, show the canonical model id in the status bar, and preserve selections across restore and child creation. Config updates and writes use the current execution's choices, preventing stale or retired executions from supplying model mappings.
- **Bare-text tool output is no longer dropped by the app and share viewer.** It is recognized alongside nested text content, terminal references, and structured diffs.

## [0.11.0] - 2026-09-14

### Added

- **The parent now learns what happened to delegated work.** When an Agent-authored parent Task dispatches work directly to a child Task, WebAgent keeps one supervised obligation for that edge and reports its outcome to the source: the child's typed `task_update(done|blocked)` account, or a factual notice that the runtime stopped its own attempts. A parent can receive a notice when no account arrived after the delivered reminders (`no_account`), when the dispatch could not be delivered at all (`delivery_failed`), or when a running turn has gone quiet (`no_activity`), plus non-terminal still-waiting advisories at one hour and four hours. Every notice carries its evidence, and none of them is a verdict: no timer's expiry concludes anything, and an edge the runtime stopped waiting on still settles if a late account arrives. Settlement needs no correlation token — `task_update(done|blocked)` closes the edge when it comes from the Task's current active turn. See [Task Obligations](docs/task-obligations.md).
- **Task status and activity are visible to Agents without reading history.** `task_list` reports each Task's `workflowStatus` (per turn, not a lifecycle terminal), its live `executionState` (`agent`, `bash`, or `idle`), and its activity timestamps, so an Agent can tell a busy Task from a silent one.
- **Pi is a supported Agent, with its install requirement documented.** Pi needs the `LelouchHe` forks of `pi-acp` and `pi-mcp-adapter` — upstream closes the previous session and ignores ACP session MCP servers, and the forks are not published to npm — so it is built from a checkout rather than installed from the registry. See [configuration](docs/configuration.md).

### Changed

- **Task creation is recorded once, by the server.** `POST /api/v1/tasks` now writes and broadcasts the same persisted `Created task @<title>` row the Agent's `task_create` tool writes, so a user-created child survives a reload and looks identical to an agent-created one. The web client no longer fabricates its own creation or send acknowledgements. An untitled child (bare `/new`) records nothing, since there is no name to reference.

### Fixed

- **Queued collaboration work is delivered while a Task runs a shell command, and drains when a Task goes idle.** A Task executing a user shell command no longer blocks queued delivery or its closing reminder, and pending deliveries are retried when the Task becomes idle instead of waiting for the next interaction.

### Removed

- **`brief` and one-step child creation.** `+` is `+<title> [<cwd>]` and the first instruction is a separate `@<title> <message>`; the REST `brief` parameter, the `tasks.brief` column, and the initial-message path it fed are gone. An existing database drops the column on startup — no data reset is required.

## [0.10.0] - 2026-09-11

### ⚠️ BREAKING

- **Reset the data directory before upgrading.** The durable product entity and its schema are now Tasks: the old `sessions` table is rejected at startup rather than migrated, and the Task schema adds the collaboration tables. Back up and remove the existing data directory before restarting, then let WebAgent create a fresh one. Attachment storage also moves from `<data_dir>/sessions/` to `<data_dir>/tasks/<sid>/`.
- **Update REST and SSE integrations.** The `/api/v1/sessions` endpoint family is now `/api/v1/tasks`; product SSE event names and their `session_id` payload field likewise use `task_*` and `task_id`. Scripts and custom clients must update; there is no compatibility alias.
- **Use the new child-Task creation forms.** `+` now means `+<title> [<cwd>]`: it creates a named child without switching to it and takes no brief. Send the first instruction separately with `@<title> <message>`. `/new` is again the unnamed child-Task command and switches to the new Task.

### Added

- **Task-first workflow and collaboration** — a Task is now the durable unit of work, with its own history, attachments, working directory, lifecycle, and parent/child relationships. Use filesystem-style `@` paths to navigate among related Tasks or send a durable message to a reachable parent, child, or sibling; collaboration messages appear in the participating Task timelines.
- **Task control plane for Agents** — compatible ACP Agents receive a scoped WebAgent MCP server for coordinating local Task families. It supports creating a child (`task_create`), sending durable instructions and follow-ups (`task_send`), and handing off blocked or completed work (`task_update`), plus bounded history lookup and child cancellation.
- **Explicit Task lifecycle and handoffs** — delegated Tasks can report `blocked` or `done` without being deleted, and WebAgent reminds an Agent-created child when its collaboration turn ends without the expected typed handoff. User-created interactive Tasks remain user-controlled.
- **Expandable Task and collaboration notices** — structured system messages (child created, collaboration sends, lifecycle handoffs) collapse to a summary line and expand to the full body, so ids, working directories, and message text no longer fill the transcript inline.

### Changed

- **Tasks remain durable while execution changes** — the reserved Root Task provides the clean starting point, and `/clear` rotates only the underlying ACP execution while retaining the Task’s history, identity, and place in the tree. On a hashless open, WebAgent resumes the most recently user-active Task rather than one changed only by background activity.
- **`/exit` leaves the tree properly** — it ends the current Task and returns to its parent instead of falling back to whichever Task was most recently active; on Root it resets Root and removes its descendant tree.
- **Compaction can follow your direction** — `/compact` now accepts optional guidance for the summary that prepares the next active context.

### Fixed

- **Unreadable image formats no longer break an Agent prompt** — images an Agent cannot decode are sent as ordinary file links, while the browser falls back to a file link if it cannot preview an uploaded image.
- **Child creation keeps its original context** — a delayed `/new <cwd>` now resolves the directory, parent, and inherited settings against the Task where the command was submitted, even if you navigate elsewhere while it is checking. If that source Task disappears, the visible fallback Task is preserved and a useful error is shown instead of leaving the app blank.
- **Task navigation and recovery are more reliable** — reconnecting preserves the current Task, `@` requires an exact path rather than guessing a target, and a Task created from an invalid or inaccessible cwd reports the underlying problem promptly.

### Removed

- **Automatic title generation** — WebAgent no longer opens a background Agent task to generate titles or exposes the `[title]` model configuration. Name a Task with `+<title>` or `/rename`; unnamed Tasks use their stable ID.

## [0.9.0] - 2026-09-01

### Added

- **Local file viewer** — `/view` opens a live path picker rooted in the session's working directory. Type to filter, tap a folder to descend one level, or use the `..` row to go back; absolute `/…` and home-relative `~/…` paths can browse anywhere the server process can read. Markdown reuses the chat renderer, code and text get syntax highlighting with line numbers, images render inline, and unknown binaries fall back to a metadata + download view. Desktop keeps the chat in a responsive split pane; mobile opens the viewer full-screen. Read-only throughout — special files are rejected, mutable content is never cached, and public share links cannot reach the file API. Backed by a new signed content-URL API (`GET /api/v1/files/info|list|content`) so `<img>` and download links keep the token auth model.
- **Raw tool output inspector** — each tool call now has a collapsible *raw* section showing the agent's unformatted `rawOutput` JSON, bounded and safely rendered, previewed live as updates stream in.
- **Structured diffs for tool output** — ACP tool content of type `diff` renders as a proper unified diff (file header, hunks, per-line add/remove colors) instead of a text blob that is hard to scan.
- **Context usage in the status bar** — the status bar now shows the session's token usage (`used/size`, with `k`/`m` abbreviations) and the model by its short name, so heavy contexts are visible at a glance.
- **Home-relative session paths** — `~/…` paths are accepted when opening or switching sessions and displayed abbreviated everywhere they appear, including the recent-paths picker, instead of the full home-directory prefix.
- **Turn termination reasons** — when a turn ends the transcript says why: cancelled, token limit reached, agent refusal, turn-request limit, or an unknown stop reason. Session-scoped agent errors are now persisted and appear in the transcript after a reload instead of only in logs.

### Changed

- **Sessions are scoped to their agent backend** — WebAgent session IDs and the agent's internal ACP session IDs are now stored separately and keyed by the configured `agent_cmd`. Switching agents hides sessions belonging to other agents; switching back restores them with their original URLs. Upgrading is in-place and non-destructive: the new mapping is backfilled automatically from your existing data on first boot, so current session IDs and share URLs stay exactly the same. Internal title-generation sessions stay hidden from the UI.
- **Status bar layout reworked** — model, context usage, and cwd are now separate segments with consistent spacing; long working directories truncate in the middle instead of pushing the model label off-screen.

### Fixed

- **Agent output outside the foreground turn is no longer dropped** — tool calls, assistant, and thinking chunks triggered by background or unsolicited agent work while the turn is idle now render as normal transcript entries, and a tool update arriving before its tool-call row exists is buffered and replayed once the row renders (including after reconnect pagination).
- **Tool-call labels now track progressive metadata** — title, kind, and raw input that agents send in later updates update the rendered row instead of leaving the original placeholder label.
- **UTF-8 text cut mid-character no longer force-downloads** — MIME sniffing reads only a 4096-byte prefix and treated a trailing character sliced in half as invalid UTF-8, so content dense with Chinese/emoji (e.g. Markdown notes) was misclassified as binary and downloaded instead of previewed.
- **Downloading a file no longer leaves the PWA stuck** — binary downloads now open in a new tab instead of navigating the standalone window into the raw response, where there is no address bar or back button to return from.
- **Interrupted turns require explicit continuation** — after an interruption or a server/agent restart, sending a message no longer auto-continues the interrupted turn (which could repeat non-idempotent tool actions); the restored state is shown and you explicitly tell the agent to continue.
- **Thinking effort survives resume for more agents** — the saved `/think` setting is re-applied across all thinking-option IDs (`reasoning_effort` / `thought_level`) when restoring a session, and `/think` resolves the correct option for agents that advertise `thought_level`.
- **iOS keyboard recovery** — double-tapping the input now recovers a half-open keyboard that still shrinks the visual viewport; recovery no longer interferes with text selection/long-press menus and works when tapping over status-bar content.
- **SSE recovery after background suspension** — reconnecting after the app was suspended forces a fresh incremental catch-up that supersedes stale in-flight requests, so no events are lost and old responses cannot overwrite newer state.
- **Concurrent session bootstrap is serialized** — when several clients open the app at once, startup recovery shares one get-or-create session instead of racing to create duplicates, and the shared session-created broadcast is no longer attributed to the first caller.
- **Slash menu polish** — empty folder/command menus no longer show a redundant "no results" placeholder row beneath the freeform action.

## [0.8.0] - 2026-08-08

### Added

- **Pinned plan panel** — the agent's current plan stays visible above the input instead of scrolling away with the transcript. Toggle it with `/plan`; entries show per-step status markers with the active step highlighted, the panel scrolls independently when the plan is long, and it clears when the turn ends so finished work cannot linger as if still in progress.
- **Pending message count in the header** — the inbox badge now shows how many messages are waiting, and tapping a push notification opens the session that produced it.
- **Sub-agent answers are folded in the transcript** — a `<final_answer>` block from a sub-agent is collapsed into a summary you can expand, so a long delegated result no longer buries the parent agent's own narration.

### Fixed

- **Transcript stopped updating live after `^C`** — cancelling a turn and immediately sending another interleaved the two, and the abandoned turn's completion was applied to the live one. That silently gated every subsequent message, thought, tool call and permission request until the next message was sent, while a refresh revealed the content had been persisted all along. Turns now carry an identity and a completion is only honoured by the turn it belongs to.
- **A dropped connection could go unnoticed indefinitely** — the event stream can stay open with no traffic and no error after a network handoff or an OS resume, and nothing reconnected because only an explicit error triggered it. Silence past three missed heartbeats now forces a reconnect.
- **A stalled request could freeze the transcript until reload** — no client request had a timeout, so one that never completed left the replay gate armed and poisoned every later catch-up on that session, including reconnects. All requests now run under a deadline.
- **Background catch-up never ran for most sessions** — the resync that recovers missed messages when returning to the app was gated on a marker that only history loading sets, so a session created in-app never qualified for it.
- **Duplicated and out-of-order messages with multiple clients open** — replayed history and live events could render the same user message twice, attribute a turn boundary to the wrong turn, or drop a plan update that arrived during a session switch.
- **An in-flight message could disappear while attachments uploaded** — its bubble existed only on screen until the upload finished, and a background catch-up in that window discarded it.
- **Cancellation left work running or state stuck** — cancelling now also stops the session's own bash and permission work, survives an agent reload, and no longer strands the busy indicator when the agent finishes on its own first.

### Changed

- Event-stream connections are now logged with the reason they ended, and a client-side forced reconnect is reported in the conversation at `warn` level, so a transport fault can be told apart from a rendering one without attaching a debugger.

## [0.7.0] - 2026-07-10

### Added

- **Agent-specific slash commands** — type `//` to discover and run commands advertised dynamically by the current ACP Agent. Commands are session-scoped, support autocomplete and input hints, preserve their original text in conversation history, and are validated before execution.

### Changed

- Model picker entries now show both the friendly model name and model ID.
- Inline help and feature documentation now clarify that `//` commands are agent-specific and may not synchronize CLI-only state such as cwd with WebAgent.

## [0.6.0] - 2026-07-07

### Added

- **Generic ACP config updates** — new API support for updating arbitrary ACP config option IDs, including boolean options, so frontend controls are no longer limited to the built-in model/mode/think fields.

### Changed

- Upgraded `@agentclientprotocol/sdk` to `0.25.0`.

### Fixed

- **Message history scrolling is more stable on iOS** — loading older history now preserves the visible anchor, avoids immediate retry loops, ignores stale pagination responses, and does not fight user scrolling during stabilization.
- **Multiline input keeps the conversation pinned** — growing the textarea, including the max-height/internal-scrollbar case, now preserves the conversation bottom when the user was already following it, without adding artificial spacer gaps or pulling users back down after they scroll away.
- iPad input long-press recovery no longer interferes with normal text selection/context menu behavior.
- Streaming tool-call output now shows the latest output snapshot instead of getting stuck on the first rendered frame.

## [0.5.1] - 2026-05-29

### Fixed

- CI E2E tests now use the runner-provided Chrome browser and fail fast if it is missing, avoiding Playwright browser install/extract hangs during release validation.

## [0.5.0] - 2026-05-29

### Added

- **LaTeX math rendering** — render inline and display math with Temml/MathML, lazy-loaded and compatible with the existing CSP.
- **Configurable bind host** — new `host` config option controls the server listen address, defaulting to loopback.
- **Mobile input focus recovery** — detects stale focused inputs on iOS/PWA and recovers from the "focused but keyboard closed" state.
- Backend diagnostics for prompt requests rejected before persistence, to help investigate optimistic messages that disappear after replay.

### Changed

- **Streaming Markdown rendering is now incremental and memoized** — reduces per-chunk re-render cost, coalesces live updates with `requestAnimationFrame`, and adds slow-render diagnostics.
- Static asset handling now serves `.wasm` with the correct MIME type and treats vendored `/lib/**` assets as immutable.
- Plan events are collapsible and expose clearer accessible status labels.
- Frontend log level preference persists locally and can be reset.
- Slash command menus are sorted more consistently.

### Fixed

- JPEG/image attachments now persist dimensions correctly and avoid layout shifts while loading.
- Streamed Markdown edge cases involving display math, fenced code blocks, lists, tables, and reference links.
- Cross-client push notification visibility tracking now uses the shared client registry for more consistent suppression.

## [0.4.0] - 2026-05-07

### ⚠️ BREAKING

- **Bearer token auth is required.** Server refuses to start without a token in `data/auth.json`; first run mints an admin token and prints a clickable login URL. All `/api/**` endpoints require `Authorization: Bearer <token>`. See [`docs/security.md`](docs/security.md).

### Added

- **Zero-config first-run deployment** — `webagent` with no flags Just Works: auto-detects an installed ACP agent in `PATH` (Copilot / Claude Code / Codex / Gemini / OpenCode / Qwen Code), runs preflight (port, writeability, agent reachability), mints the admin token, prints the login URL.
- **Daemon mode** — `webagent start` / `stop` / `status` / `restart` with crash recovery, exponential backoff, and atomic `SIGHUP` reload. PID file lives in `data_dir` so multiple instances coexist from the same shell.
- **Config CLI** — `webagent config init` (copy starter `config.toml`) and `webagent config show` (print effective merged config).
- **Share links** (off by default) — public read-only session snapshots via `/share` + `/s/<token>`, with secret hard-reject + path/host soft-redact sanitizer. See [`docs/share.md`](docs/share.md).
- **Attachments** — drag/paste/upload any file type into the input area; storage under `<data_dir>/sessions/<sid>/attachments/`, real MIME sniffing, 10 MB cap.
- **Inbox** — `/inbox` cross-session message picker for "build done" / "tests failed" style notifications. New `messages` table + REST + push.
- **Cross-agent mode classifier** — mode pill (plan / autopilot / read-only) renders correctly across every ACP agent, not just Copilot CLI.
- **Title generation works on third-party / litellm models** — `[title] model` picks a cheap model from the agent's `availableModels` via substring match (default `["haiku", "flash-lite", "nano", "mini", "flash", "lite"]`); empty array inherits agent default.
- Slash commands: `/clear`, `/logout`, `/token`, `/debug`, `/inbox`, `/share`.
- Inline conversation-flow log records driven by `config.debug.level` / `?debug=<level>` / `/debug`.
- Auto-resume last active session on page open.

### Changed

- **Frontend bundling** — `marked` + `dompurify` + `highlight.js` are bundled via esbuild instead of loaded from CDN. Hashed assets serve `Cache-Control: immutable`; HTML / SW / icons serve `no-cache`.
- Mode pill colors distinguish read-only / plan / agent / autopilot.
- TypeScript strict mode enforced; CI gates on `typecheck` + full-tree lint.
- Node 24 CI baseline (was 22).

### Fixed

- Daemon SIGHUP race that left a zombie child crashing with `EADDRINUSE`.
- Daemon supervisor no longer infinite-restarts on `EX_CONFIG` (78).
- Port preflight now probes `0.0.0.0` (matches `server.listen`).
- Bridge subprocess death surfaced as a user error instead of hanging input.
- Cold-cache `GET /api/v1/sessions/:id` blocks on restore so the frontend doesn't race the bridge.
- Assistant / thinking messages no longer duplicate on SSE reconnect.
- iOS WebKit busy-state double-glyph race on the input chevron.
- Misc: `/switch` untitled-session id, `/inbox` consumed-message switch, `/clear` wrong-session race, attach chip clipping, visibility endpoint bearer, `formatLocalTime` epoch input, `from_ref` orphans on boot.

### Removed

- ACP `fs` client capability handlers (no observed agent uses them).
- `/prune` slash command.

## [0.3.0] - 2026-04-15

### Added

- Recent paths for `/new` menu — tracks session working directories with LRU cleanup. New config options: `limits.recent_paths` (max shown, default 10) and `limits.recent_paths_ttl` (days before auto-cleanup, default 30)
- `GET /api/v1/recent-paths` endpoint — returns recent working directories, supports `?limit=N`
- `/help` slash command (also shown as `?` shortcut hint)
- HH:MM:SS timestamps in server console output; daemon truncates logs on start

### Fixed

- `/exit` sometimes created a new session instead of switching to an existing one — URL hash still pointed to the deleted session during async load, causing SSE reconnects to 404 and fall back to session creation

### Changed

- TOC coverage guard for `docs/api.md`

## [0.2.6] - 2026-04-03

### Added

- Code block syntax highlighting with copy button
- `/reload` command to restart agent subprocess without server restart
- Dual `theme-color` meta tags for automatic light/dark status bar

### Fixed

- Bridge connected event swallowed by SSE handshake guard
- Shutdown race condition and silent session cleanup during restart
- Streamed code block enhancement rendering
- Unified `permission_resolved` into `permission_response` for consistency
- Preserve session cwd across `/new` and `session_expired`

### Changed

- Moved one-shot prompt endpoint from `/api/v1/` to `/api/beta/`

## [0.2.5] - 2026-03-15

No functional changes (version bump only).

## [0.2.4] - 2026-03-15

### Fixed

- Hide console window for daemon process on Windows

## [0.2.3] - 2026-03-15

### Fixed

- Flaky `/prune` command: await all deletes before reporting success

## [0.2.2] - 2026-03-15

### Fixed

- npm publish missing `compile` step in `prepublishOnly`

## [0.2.1] - 2026-03-15

### Fixed

- Merge consecutive assistant/thinking events during replay to eliminate duplicates

### Changed

- Moved screenshot capture script to `scripts/`, excluded from E2E suite

## [0.2.0] - 2026-03-15

### Added

- Image lightbox: click chat images to view full-size with zoom
- `GET /api/v1/version` endpoint, shown in `/help` output
- Full content display for new files in diff view
- Playwright screenshot capture script
- `task_complete` summary shown directly instead of collapsed

### Changed

- Cancel shortcut changed from `Ctrl+X` to smart `Ctrl+C` (respects text selection)
- Removed new-session button from input area
- Push and visibility APIs moved to `/api/beta/`
- Restructured README into concise overview with separate docs

### Fixed

- Global session visibility suppression: if any client views a session, push is suppressed for all endpoints/devices
- Strip base64 image data from stored `user_message` events (reduce DB bloat)
- Restore input placeholder after session load
- Skip auto-title when user has manually set a session title

## [0.1.10] - 2026-03-14

### Changed

- Simplified build pipeline: deduplicated test/build across CI and publish workflows
- Added `tsc` type check to `npm test` script
- Removed deprecated positional overload of `createRequestHandler`

## [0.1.9] - 2026-03-14

### Fixed

- Strict `tsc` errors in `bridge.ts` and `routes.ts`

## [0.1.8] - 2026-03-14

This is a major infrastructure release: WebSocket transport replaced with SSE, REST API migrated to `/api/v1/`, and significant multi-client improvements.

### Added

- `/rename` slash command for session title renaming
- `/exit` command replacing `/delete` (close current session in one step)
- Cursor-based pagination for events API
- Per-session push visibility filtering
- Auto-retry interrupted agent turns after server restart
- Sync missed events on iOS PWA foreground return
- Show auto-approved permissions in autopilot mode
- Auto-remove push subscriptions after 5 consecutive failures
- Status bar below input area showing mode, model, and cwd

### Changed

- **Breaking**: Removed WebSocket transport layer, replaced with SSE + REST
- Migrated all API endpoints to `/api/v1/` namespace
- Removed legacy `/data/images/` route
- Renamed `after_seq` param to `after` for consistency
- Dropped `.rest.` suffix from test filenames
- Refactored push notification title to use session title directly
- Performance: Map index during replay instead of `querySelector` on `DocumentFragment`
- Performance: Deferred `scrollToBottom` via `rAF` to avoid synchronous layout reflow

### Fixed

- Cross-client message ordering and stuck busy state after cancel
- Ghost session accumulation on server restart
- Auto-resume for no-hash opens, notify menu highlight
- Cancel timeout bypassed by agent streaming events after cancel
- Decouple ACP resume from GET so session switch never blocks
- Suppress SSE echo of own `bash_command` to prevent duplicate blocks
- Notification click navigating to wrong session
- Prevent duplicate thinking blocks on reconnect during active streaming
- Drop session-specific events during mid-switch null window
- Notification-click race: stale `initSession` overriding session switch
- Fix `charset=utf-8` on text MIME types
- Fix v1 image URLs instead of legacy `/data/` paths
- Guard against empty sessionId in visibility endpoint
- Empty session cleanup: use time-based threshold instead of `liveSessions` exclusion

### Removed

- `/delete` command (replaced by `/exit`)
- `/sessions` command (merged into unified session menu)

## [0.1.7] - 2026-03-11

### Added

- Status bar below input area showing mode, model, and cwd

### Fixed

- Cross-client message ordering and stuck busy state after cancel

## [0.1.6] - 2026-03-10

### Changed

- CI publish workflow gates on test suite via reusable workflow

## [0.1.5] - 2026-03-10

### Added

- **Push notifications** (Phases 1–5): VAPID infrastructure, REST API, service worker, visibility tracking, frontend `/notify` command
- Daemon commands: `start`, `stop`, `status`, `restart` with supervisor
- Major unit/integration test coverage expansion
- iOS safe-area support for PWA input area

### Changed

- Unified slash menu key behavior: Tab fills, Enter sends, Click does both
- Updated README with missing modules and stale content fixes

### Fixed

- iOS keyboard not appearing due to programmatic auto-focus
- Push notification click navigation
- VAPID subject rejection by Apple Push for localhost domains
- Permission revert on reconnect with dedup + retry for unconfirmed permissions
- Message loss when connection is disconnected
- `/notify` status now checks actual push subscription, not just permission

## [0.1.4] - 2026-03-09

### Fixed

- E2E tests broken by new-button behavior change
- Flaky permission-deny test and `cancelPendingTurnUI` race condition

## [0.1.3] - 2026-03-09

### Added

- Windows shell support for bash execution
- List of ACP-compatible agents in README

### Fixed

- Windows signal compatibility
- CI skips tag pushes (only runs on code changes)

## [0.1.2] - 2026-03-09

### Changed

- Enabled TypeScript strict mode with `noEmitOnError`
- Fixed all type errors uncovered by strict mode

## [0.1.1] - 2026-03-09

### Changed

- Compiled TypeScript to JavaScript for npm distribution (fixes `node_modules` type-stripping errors)
- Added CI and npm badges to README

### Fixed

- E2E removed from CI (requires agent backend, not available in CI)

## [0.1.0] - 2026-03-09

Initial release of WebAgent — a terminal-style web UI for ACP-compatible agents.

### Features

- **Chat interface**: Terminal-aesthetic monospace UI with dark/light/auto themes
- **ACP integration**: Full session lifecycle (create, load, prompt, cancel) with event streaming
- **Tool call rendering**: Collapsible tool call details with diff view
- **Image support**: Upload via attach button or paste, stored on filesystem, forwarded through ACP
- **Bash execution**: `!command` syntax for direct shell execution from chat
- **Session management**: SQLite persistence, LLM-generated titles, session restore on reconnect
- **Slash commands**: `/new`, `/switch`, `/delete`, `/prune`, `/model`, `/mode`, `/think`, `/pwd`, `/help` with autocomplete and keyboard navigation
- **Model selection**: Per-session model persistence, picker menu with fuzzy search, model inheritance for new sessions
- **Autopilot mode**: Auto-approve permissions with mode cycling via `Ctrl+M` or prompt tap
- **Multi-client support**: Event broadcast across all connected clients, permission sync, session state coordination
- **PWA**: Manifest, service worker, installable to home screen with iOS icon support
- **Keyboard shortcuts**: `Ctrl+C` (cancel), `Ctrl+U` (upload), `Ctrl+M` (mode cycle), `Tab` (autocomplete fill)
- **Smart scroll**: Force-to-bottom on load/switch/send, soft follow during streaming
- **Incremental reconnect**: Skip DOM wipe on same-session reconnect
- **Modular architecture**: Server split into focused modules (server, routes, event-handler, session-manager, bridge, store, title-service)
- **Build pipeline**: esbuild bundling with content-hashed filenames for cache busting
- **TOML configuration**: Configurable port, data directory, agent command, limits
- **CI/CD**: GitHub Actions for CI (unit + E2E tests) and npm publishing on tag push
- **npm package**: Published as `@lelouchhe/webagent`

[0.13.0]: https://github.com/LelouchHe/webagent/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/LelouchHe/webagent/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/LelouchHe/webagent/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/LelouchHe/webagent/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/LelouchHe/webagent/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/LelouchHe/webagent/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/LelouchHe/webagent/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/LelouchHe/webagent/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/LelouchHe/webagent/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/LelouchHe/webagent/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/LelouchHe/webagent/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/LelouchHe/webagent/compare/v0.2.6...v0.3.0
[0.2.6]: https://github.com/LelouchHe/webagent/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/LelouchHe/webagent/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/LelouchHe/webagent/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/LelouchHe/webagent/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/LelouchHe/webagent/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/LelouchHe/webagent/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/LelouchHe/webagent/compare/v0.1.10...v0.2.0
[0.1.10]: https://github.com/LelouchHe/webagent/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/LelouchHe/webagent/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/LelouchHe/webagent/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/LelouchHe/webagent/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/LelouchHe/webagent/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/LelouchHe/webagent/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/LelouchHe/webagent/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/LelouchHe/webagent/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/LelouchHe/webagent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LelouchHe/webagent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/LelouchHe/webagent/releases/tag/v0.1.0
