# Test Scenarios

Last updated: 2026-03-09

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

- `test/event-handler.test.ts` (server-event-handler)
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

- `test/store.test.ts`
  - session creation / deletion / updates
  - config persistence
  - title persistence
  - fractional-second `last_active_at` precision for stable ordering

- `test/title-service.test.ts`
  - silent title-session creation
  - title cleanup / truncation
  - title-session reuse
  - setup failure handling
  - callback emission only when a title is produced
  - cancellation of in-flight title generation for the matching source session
  - in-flight title-generation deduplication and retry after cancellation

### Frontend state and UI event flow

- `test/state.test.ts`
  - DOM wiring
  - config helpers
  - busy-state button / prompt UI
  - mode-class updates
  - new-session request payloads
  - reset-session cleanup
  - global session cancel payloads
  - hash routing and session info updates

- `test/input.test.ts`
  - normal prompt send flow
  - `!` bash routing
  - image upload send flow
  - global `Ctrl+X` cancel
  - `Ctrl+U` upload
  - `Ctrl+M` mode cycle
  - `+` button new-session flow

- `test/events.test.ts`
  - session creation / busy-state restoration
  - user / assistant / thinking rendering
  - tool-call render and completion state
  - plan render
  - permission request / response / resolution handling
  - bash command / output / completion handling
  - prompt completion rules
  - cancelled-turn cleanup for tool calls and permissions
  - config update application
  - session deletion and title update handling
  - cross-session event filtering
  - history replay for all major stored event types

- `test/commands.test.ts`
  - `/new`, `/pwd`, `/switch`, `/exit`, `/prune`, `/cancel`
  - `/model`, `/mode`, `/think` query / fuzzy match / ambiguity handling
  - help output and shortcut listing

- `test/connection.test.ts`
  - hash-based session resume
  - last-session auto-resume
  - reconnect behavior without duplicate history replay

### Supporting frontend / backend modules

- `test/routes.test.ts`
  - static file / API route basics
  - image upload: valid PNG, size limit enforcement, non-image MIME rejection, empty body, missing content-type, session association

- `test/render.test.ts`
  - markdown / diff / bash block render helpers

- `test/images.test.ts`
  - attach preview and image-management behavior

- `test/config.test.ts`
  - config parsing / defaults

- `test/types.test.ts`
  - WS message validation

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

### Image persistence

- `image-upload-reload.spec.ts`
  - uploaded images are sent and restored after reload

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

## Known Boundary

- WebAgent now treats cancel as a session-wide hard stop for ACP prompt work,
  pending permission work, local `!` bash work, and title-generation work that
  it owns inside the server runtime.
- Host-level tasks started outside WebAgent's own runtime are not covered by
  this cancel path. That limitation is part ACP integration boundary and part
  current host integration boundary, not just a missing UI hook in this repo.
