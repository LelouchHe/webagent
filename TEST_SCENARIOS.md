# Test Scenarios

Last updated: 2025-07-25

This file is a scenario-level map of the current automated test suite.
It is intentionally higher-level than raw test names so we can review coverage,
spot gaps, and decide what still needs to be added without reading every spec.

## Coverage Snapshot

- Unit / integration tests: `test/*.test.ts`
- Browser E2E tests: `test/e2e/*.spec.ts`
- Current focus of the suite:
  - session lifecycle and restore behavior
  - cross-client synchronization
  - permission and cancel lifecycles
  - config persistence / inheritance / sync
  - bash execution lifecycle
  - slash command and picker UX
  - REST API surface (sessions, prompt, bash, permissions, ops, SSE, push)

## Unit / Integration Scenarios

### ACP bridge and backend orchestration

- `test/bridge.test.ts`
  - prompt success / failure / cancellation
  - silent prompt buffering for title generation
  - permission request resolution ordering
  - targeted cancellation of pending permission requests
  - config-option update return path
  - ACP session update event translation
  - ACP text file read/write callbacks

- `test/server-event-handler.test.ts`
  - event routing: message_chunk, thought_chunk, tool_call, prompt_done, session_created, error
  - thinking↔assistant buffer flush transitions
  - restoring-session event suppression
  - autopilot auto-approval with allow_once
  - autopilot fallback when no allow_once option exists
  - normal permission_request broadcast in non-autopilot mode

- `test/session-manager.test.ts`
  - session title hydration
  - session deletion cleanup
  - inherited config application for new sessions
  - non-inherited mode reset behavior
  - returned config options for inherited sessions
  - assistant / thinking buffer flush behavior
  - busy-kind reporting
  - cwd lookup fallback
  - auto-retry of interrupted turns
  - deduplicated resume (ensureResumed)

- `test/store.test.ts`
  - session creation / deletion / updates
  - config persistence
  - title persistence
  - fractional-second `last_active_at` precision for stable ordering
  - deleteEmptySessions age gating
  - hasInterruptedTurn detection
  - migration idempotency

- `test/title-service.test.ts`
  - silent title-session creation
  - title cleanup / truncation
  - title-session reuse
  - setup failure handling
  - callback emission only when a title is produced
  - cancellation of in-flight title generation for the matching source session
  - in-flight title-generation deduplication and retry after cancellation
  - user-set title wins over in-flight generation

- `test/daemon.test.ts`
  - subcommand recognition
  - `resolveArgs` config-path resolution
  - PID file round-trip / stale cleanup / corrupt handling
  - supervisor lifecycle: PID file write, SIGTERM exit, SIGHUP restart

### REST API layer

- `test/sessions.test.ts`
  - session CRUD (create / get / delete / list)
  - config update (model, mode) and broadcast
  - source filter on session list
  - gzip compression for events endpoint
  - streaming buffer flush on events endpoint
  - auto-resume of non-live sessions
  - input validation and bridge-not-ready errors

- `test/prompt.test.ts`
  - prompt acceptance and bridge forwarding
  - user_message storage and broadcast
  - last_active_at update and active-prompt tracking
  - busy-state conflict (409) for agent and bash
  - events endpoint: listing, thinking filter, after pagination
  - title generation trigger for untitled sessions
  - image support in prompts
  - input validation and bridge-not-ready errors

- `test/bash.test.ts`
  - bash command execution and event storage / broadcast
  - bash output streaming and completion
  - bash cancel (kill) and idempotent cancel
  - busy-state reporting during bash
  - conflict (409) for concurrent bash
  - non-zero exit code handling
  - input validation and unknown-session errors

- `test/permissions.test.ts`
  - pending permission listing and session scoping
  - permission approval / denial with event storage and broadcast
  - idempotent resolution for already-resolved permissions
  - input validation and bridge-not-ready errors

- `test/ops.test.ts`
  - cancel: active prompt, running bash, idle session (idempotent)
  - status: idle / busy-agent / busy-bash
  - `GET /api/v1/config` endpoint
  - bridge-not-ready error handling

- `test/sse.test.ts`
  - SSE client ID generation and tracking
  - global SSE stream (connected event, broadcast from all sessions)
  - per-session SSE stream (session filtering, Last-Event-ID replay)
  - `POST /api/beta/clients/:clientId/visibility` (update, sessionId, validation)
  - heartbeat delivery

- `test/quick-prompt.test.ts`
  - session creation and prompt forwarding
  - custom cwd and source=auto marking
  - input validation and bridge-not-ready errors

### Frontend state and UI event flow

- `test/state.test.ts`
  - DOM wiring
  - config helpers
  - busy-state button / prompt UI
  - mode-class updates
  - new-session request payloads (with custom cwd)
  - reset-session cleanup (messages, input, title, metadata)
  - global session cancel payloads
  - hash routing and session info updates

- `test/input.test.ts`
  - normal prompt send flow
  - `!` bash routing
  - image upload send flow
  - global `Ctrl+X` cancel
  - `Ctrl+U` upload
  - `Ctrl+M` mode cycle
  - slash command bypass while busy
  - send-button label switching (↵ vs ^X) while busy
  - not-connected and not-ready warnings

- `test/events.test.ts`
  - session creation / busy-state restoration
  - user / assistant / thinking rendering
  - tool-call render and completion state
  - task_complete summary rendering (visible, not collapsed) with ✔ icon
  - plan render
  - permission request / response / resolution handling
  - bash command / output / completion handling
  - prompt completion rules
  - cancelled-turn cleanup for tool calls and permissions
  - late-event suppression after prompt_done (tool_call, permission_request)
  - cancel timeout firing and warning
  - config update application
  - session deletion and title update handling
  - cross-session event filtering
  - history replay for all major stored event types (incl. task_complete with visible summary)
  - paginated loadHistory (limit param, hasMoreHistory)
  - loadOlderEvents prepend and sentinel removal
  - loadNewEvents incremental sync and orphan cleanup
  - replay queue: dedup on reconnect for tool_call, permission_request, thought_chunk, message_chunk
  - retryUnconfirmedPermissions after reconnect

- `test/commands.test.ts`
  - `/new`, `/pwd`, `/switch`, `/exit`, `/prune`, `/cancel`, `/rename`
  - `/model`, `/mode`, `/think` query / fuzzy match / ambiguity handling
  - help output and shortcut listing
  - version display in `?` / help command

- `test/connection.test.ts`
  - hash-based session resume
  - last-session auto-resume
  - new-session creation when no previous session exists
  - reconnect behavior without duplicate history replay
  - incremental sync on reconnect when session matches
  - visibility-change sync (hidden→visible)
  - session-switch abort on generation change
  - no-op sync when no new events

### Supporting frontend / backend modules

- `test/routes.test.ts`
  - static file / API route basics
  - events endpoint: limit/before pagination, backward-compat without limit
  - image upload: valid PNG, size limit enforcement, non-image MIME rejection, invalid session, JPEG normalization
  - push API routes (`/api/beta/push/*`): VAPID key, subscribe, unsubscribe, validation, no-push-service fallback

- `test/render.test.ts`
  - HTML escaping
  - local time formatting
  - patch diff rendering (patch string, old_str/new_str, new file full content)
  - message and system message rendering
  - assistant / thinking finish helpers
  - waiting indicator lifecycle
  - detail panel click-through (no collapse on content click)
  - scroll-to-bottom follow / manual / forced modes
  - bash block creation and running state

- `test/images.test.ts`
  - attach preview and image-management behavior
  - file picker and paste handling

- `test/api-module.test.ts`
  - frontend API client: all REST endpoints (sessions, prompt, cancel, permissions, bash, config, visibility, status)
  - error handling (ApiError, non-JSON responses)

- `test/slash-menu.test.ts`
  - Tab fills input without executing (top-level, notify submenu, config submenu)
  - Tab uses option name not value for config items
  - click on submenu item executes the command

- `test/push-frontend.test.ts`
  - `/notify` command: current state, on/off toggling, permission handling
  - visibility reporting on document visibility change

- `test/push-service.test.ts`
  - push_subscriptions store: save, upsert, remove, migration
  - VAPID key generation, loading, and permissions
  - notification formatting (permission_request, prompt_done, bash_done, fallback title)
  - visibility tracking: client registration, per-subscription, global session suppression
  - maybeNotify event-type filtering
  - sendToAll: consecutive failure cleanup, 410 Gone removal, session-based suppression

- `test/doc-coverage.test.ts`
  - staleness guard: asserts all endpoints in routes.ts are documented in docs/api.md

- `test/config.test.ts`
  - config parsing / defaults / invalid-file handling

- `test/types.test.ts`
  - errorMessage helper (Error, string, object, null)

## Playwright E2E Scenarios

### Basic session and messaging flow

- `session-bootstrap.spec.ts`
  - app connects and creates / resumes a usable session

- `session-send-message.spec.ts`
  - normal prompt / assistant reply round-trip

- `session-reload-history.spec.ts`
  - reload restores the same session and replays chat history

### Bash lifecycle

- `bash-command.spec.ts`
  - `!<command>` runs and streams output

- `bash-cancel.spec.ts`
  - running bash command can be cancelled from the UI

- `bash-truncation-reload.spec.ts`
  - oversized bash output is truncated in storage and reloaded correctly

### Permission lifecycle

- `permission-flow.spec.ts`
  - manual approval completes a permission-gated turn

- `permission-deny.spec.ts`
  - deny path is rendered and completes correctly

- `permission-cancel.spec.ts`
  - cancel interrupts a pending permission turn

- `permission-reload-pending.spec.ts`
  - unresolved permission remains actionable after reload

- `permission-resolved-reload.spec.ts`
  - resolved permission reloads as collapsed history without buttons

### Cancel / busy-state regressions

- `cancel-flow.spec.ts`
  - normal in-flight prompt cancellation

- `cancel-after-tool-call.spec.ts`
  - cancellation after a tool call has already started

### Session isolation and cleanup

- `new-session-isolation.spec.ts`
  - creating a new session in one tab does not switch the other tab

- `cross-session-isolation.spec.ts`
  - events from one session do not leak into another

- `session-switch-isolation.spec.ts`
  - switching sessions reloads the right history without message mixing

- `session-delete-broadcast.spec.ts`
  - deleting the current session disables peer clients correctly

- `session-delete-command.spec.ts`
  - `/exit` deletes current session and switches to previous

- `session-prune-command.spec.ts`
  - `/prune` removes all non-current sessions

### Resume / reconnect / restart recovery

- `auto-resume-last-session.spec.ts`
  - root page resumes the most recently active session

- `sse-reconnect-recovery.spec.ts`
  - SSE reconnect restores the active session without duplicate replay

- `server-restart-recovery.spec.ts`
  - full server restart restores session context and history

- `expired-session-recovery.spec.ts`
  - expired hash session falls back to a new session with a warning

### Image handling

- `image-upload-reload.spec.ts`
  - uploaded images are sent and restored after reload

- `image-lightbox.spec.ts`
  - clicking an image opens the lightbox overlay
  - backdrop click and Escape close the lightbox
  - mouse wheel zooms the lightbox image

### Slash menu and picker UX

- `slash-menu-escape.spec.ts`
  - Escape dismisses the slash menu

- `slash-menu-switch.spec.ts`
  - slash-menu session switch works from keyboard navigation

- `slash-menu-new-picker.spec.ts`
  - `/new` path picker creates a session from a selected cwd

- `model-picker.spec.ts`
  - `/model` picker changes the selected model

- `slash-menu-think-picker.spec.ts`
  - `/think` picker changes reasoning effort

### Mode / config persistence / inheritance / sync

- `mode-cycle-shortcut.spec.ts`
  - `Ctrl+M` cycles Agent → Plan → Autopilot

- `new-session-mode-reset.spec.ts`
  - new sessions do not inherit autopilot mode

- `plan-reload-persistence.spec.ts`
  - plan mode survives reload

- `autopilot-permission.spec.ts`
  - autopilot auto-approves permissions

- `autopilot-multi-permission.spec.ts`
  - autopilot auto-approves multiple permissions in one turn

- `autopilot-reload-persistence.spec.ts`
  - autopilot behavior still works after reload

- `model-reload-persistence.spec.ts`
  - selected model survives reload

- `new-session-model-inherit.spec.ts`
  - new sessions inherit selected model

- `think-reload-persistence.spec.ts`
  - selected reasoning effort survives reload

- `new-session-think-inherit.spec.ts`
  - new sessions inherit selected reasoning effort

### Multi-client synchronization

- `multi-client-sync.spec.ts`
  - user / assistant messages sync across two clients

- `multi-client-permission-sync.spec.ts`
  - permission resolution syncs across two clients

- `multi-client-mode-sync.spec.ts`
  - mode changes sync across two clients

- `multi-client-model-sync.spec.ts`
  - model changes sync across two clients

- `multi-client-think-sync.spec.ts`
  - reasoning-effort changes sync across two clients

- `multi-client-autopilot-sync.spec.ts`
  - autopilot behavior syncs across two clients after one client changes mode

### API pagination

- `events-pagination.spec.ts`
  - events API supports limit/before pagination
  - backward-compat: no limit returns all events

### Session status bar

- `switch-status-bar.spec.ts`
  - status bar shows model and cwd after switching sessions

### Screenshots

- `screenshots.spec.ts`
  - capture desktop chat, slash menu, permission, and mobile screenshots

## Known Boundary

- WebAgent now treats cancel as a session-wide hard stop for ACP prompt work,
  pending permission work, local `!` bash work, and title-generation work that
  it owns inside the server runtime.
- Host-level tasks started outside WebAgent's own runtime are not covered by
  this cancel path. That limitation is part ACP integration boundary and part
  current host integration boundary, not just a missing UI hook in this repo.
