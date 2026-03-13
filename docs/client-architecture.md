# WebAgent Client Architecture

WebAgent is a terminal-style web UI for ACP-compatible agents. This document describes the frontend architecture: module structure, data flow, how the client uses the [Server API](api.md), and key design patterns.

---

## Table of Contents

- [Overview](#overview)
- [Module Structure](#module-structure)
- [Boot Sequence](#boot-sequence)
- [Connection Lifecycle](#connection-lifecycle)
  - [SSE Stream](#sse-stream)
  - [REST Initialization (Parallel)](#rest-initialization-parallel)
  - [Reconnection](#reconnection)
- [Data Flow](#data-flow)
  - [Sending a Message](#sending-a-message)
  - [Receiving Events](#receiving-events)
  - [History Replay](#history-replay)
  - [Incremental Sync](#incremental-sync)
- [Session Management](#session-management)
  - [Session Switching](#session-switching)
  - [Hash Routing](#hash-routing)
  - [New Session Creation](#new-session-creation)
- [API Client (`api.ts`)](#api-client-apits)
- [Event Handling](#event-handling)
  - [Live Events vs Replay Events](#live-events-vs-replay-events)
  - [Event Deduplication](#event-deduplication)
  - [Replay Queue](#replay-queue)
  - [Self-Echo Suppression](#self-echo-suppression)
- [Permission Flow](#permission-flow)
- [Slash Commands](#slash-commands)
- [Bash Execution](#bash-execution)
- [State Management](#state-management)
- [UI Patterns](#ui-patterns)
  - [Streaming Text](#streaming-text)
  - [Tool Calls](#tool-calls)
  - [Status Bar](#status-bar)
  - [Busy State](#busy-state)
  - [Mode Indicator](#mode-indicator)
- [Build System](#build-system)
- [Key Design Decisions](#key-design-decisions)

---

## Overview

```
┌──────────────────────────────────────────────┐
│                  Browser                      │
│                                               │
│  app.ts (boot)                                │
│    ├── connection.ts  ←→ SSE + REST           │
│    ├── events.ts      ←  event dispatch       │
│    ├── input.ts       →  user messages        │
│    ├── commands.ts    →  slash commands        │
│    ├── images.ts      →  image attach/paste   │
│    ├── render.ts      →  DOM manipulation     │
│    ├── state.ts       ←→ shared state + refs  │
│    └── api.ts         →  REST client          │
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │           EventSource (SSE)             │  │
│  │     GET /api/events/stream              │  │
│  └─────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────┐  │
│  │            fetch (REST)                 │  │
│  │  POST /api/sessions/:id/messages        │  │
│  │  GET /api/sessions/:id/events           │  │
│  │  PATCH /api/sessions/:id                │  │
│  │  ...                                    │  │
│  └─────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

The client uses **REST for all commands** and **SSE for receiving real-time events**. There is no WebSocket dependency.

---

## Module Structure

All frontend source lives in `public/js/*.ts`. esbuild bundles it into a single content-hashed file.

| Module | Responsibility | Key exports |
|---|---|---|
| **`app.ts`** | Boot entry point. Imports all modules, calls `connect()`, registers service worker | — |
| **`state.ts`** | Shared state singleton, DOM refs (`dom`), config helpers, routing, cancel logic | `state`, `dom`, `setBusy()`, `requestNewSession()`, `resetSessionUI()`, `setConnectionStatus()` |
| **`connection.ts`** | SSE + REST connection lifecycle, parallel init, visibility sync | `connect()` |
| **`events.ts`** | Event dispatch (live + replay), history loading, permission responses | `handleEvent()`, `loadHistory()`, `loadNewEvents()` |
| **`input.ts`** | User input: send messages, cancel, keyboard shortcuts, mode cycling | — |
| **`commands.ts`** | Slash command parsing, menu UI, `/switch`, `/new`, `/delete`, `/model`, `/mode`, `/notify` | `handleSlashCommand()`, `hideSlashMenu()` |
| **`images.ts`** | Image attach (click/drag/paste), preview, upload to server | `renderAttachPreview()` |
| **`render.ts`** | DOM helpers: add messages, markdown rendering, theme, scroll, tool call display | `addMessage()`, `addSystem()`, `scrollToBottom()`, `renderMd()` |
| **`api.ts`** | REST client — typed `fetch` wrappers for every server endpoint | `createSession()`, `sendMessage()`, `cancelSession()`, etc. |

**Dependency graph** (arrows = imports):

```
app.ts
  ├── connection.ts → state, render, events, api
  ├── events.ts     → state, render, api, types, constants
  ├── input.ts      → state, render, commands, images, api
  ├── commands.ts   → state, render, events, api
  ├── images.ts     → state, render
  └── render.ts     → state
```

**Cross-directory imports:** The frontend imports types (`AgentEvent`, `ConfigOption`, `StoredEvent`) from `src/types.ts` and constants (`TOOL_ICONS`, `PLAN_STATUS_ICONS`) from `src/shared/constants.ts`. esbuild resolves these at bundle time.

---

## Boot Sequence

`app.ts` is the entry point:

```typescript
import './render.ts';    // theme, click-to-collapse listeners
import './commands.ts';  // slash menu listeners
import './images.ts';    // attach/paste listeners
import './input.ts';     // keyboard/send listeners
import { connect } from './connection.ts';

connect();

// Register service worker for push notifications + offline shell
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
  // Handle push notification click → navigate to session
  navigator.serviceWorker.addEventListener('message', ...);
}
```

The module imports trigger side effects (event listeners, theme initialization). Then `connect()` starts the connection lifecycle.

---

## Connection Lifecycle

### SSE Stream

`connect()` opens a global SSE stream and starts REST initialization **in parallel**:

```
connect()
  ├── new EventSource('/api/events/stream')   // background
  └── initSession()                            // parallel REST calls
```

The SSE stream is **not** a prerequisite for page load. It runs in the background while REST calls fetch session data.

**SSE message handling:**
- `connected` event → stores `state.clientId`, reports visibility via REST
- All other events → dispatched to `handleEvent()`
- `onerror` → close, cleanup, reconnect after 3 seconds

### REST Initialization (Parallel)

`initSession()` determines which session to load:

```
initSession()
  ├── Hash has session ID? ──→ resumeAndLoad(id, incremental?)
  │     ├── Same as current session ──→ incremental=true  (reconnect)
  │     └── Different session ──→ incremental=false (full load)
  ├── No hash? ──→ listSessions() → resumeAndLoad(most recent)
  └── No sessions? ──→ requestNewSession()
```

**`resumeAndLoad(sessionId, incremental)`:**

For **full loads** (new session or first visit):
```
Promise.all([
  api.getSession(sessionId),    // auto-resumes in ACP if needed
  loadHistory(sessionId),        // GET /api/sessions/:id/events
])
→ handleEvent({ type: 'session_created', ... })
```

For **incremental reconnects** (same session, SSE dropped):
```
api.getSession(sessionId)        // get config/title/busy state
→ handleEvent({ type: 'session_created', ... })
→ loadNewEvents(sessionId)       // GET /events?after_seq=N
```

This parallel loading means history rendering starts as soon as the event data arrives, without waiting for session resume.

### Reconnection

When SSE disconnects:
1. `cleanup()` — reset connection state, finalize streaming elements
2. `setTimeout(connect, 3000)` — retry after 3 seconds
3. On reconnect, `initSession()` detects the same session in the hash → **incremental** path
4. Only fetches events after `state.lastEventSeq` — no full history reload

### Visibility Sync

When the browser tab goes hidden/visible:
- **Hidden:** `api.postVisibility(clientId, false)` — server stops sending push notifications
- **Visible:** `api.postVisibility(clientId, true)` + `loadNewEvents()` — catches up on any events missed while backgrounded (important for iOS PWA which can suspend event delivery)

---

## Data Flow

### Sending a Message

```
User types text + Enter
        │
        ▼
  input.ts: sendMessage()
        │
        ├── Show user message in DOM (optimistic)
        ├── Upload images if any: POST /api/images/:sessionId
        ├── api.sendMessage(): POST /api/sessions/:id/messages
        ├── setBusy(true)
        ├── showWaiting()
        └── state.sentMessageForSession = sessionId  // for echo suppression
```

The `POST /messages` returns `202` immediately. The agent's response arrives as SSE events.

### Receiving Events

```
EventSource.onmessage
        │
        ▼
  handleEvent(msg)
        │
        ├── replayInProgress? → queue it
        ├── Wrong session? → ignore
        └── Switch on msg.type:
              ├── session_created → update state, UI, hash
              ├── message_chunk  → append to streaming element
              ├── tool_call      → create tool call element
              ├── permission_request → show buttons
              ├── prompt_done    → setBusy(false)
              └── ... (see events.ts for full switch)
```

### History Replay

`loadHistory()` fetches all stored events and replays them through `replayEvent()`:

```
GET /api/sessions/:id/events
        │
        ▼
  for each event:
    replayEvent(type, data, events, idx)
        │
        ├── user_message     → addMessage('user', text)
        ├── assistant_message → addMessage('assistant', text)
        ├── tool_call        → create collapsed tool element
        ├── permission_request → show resolved or with buttons
        ├── bash_command     → create bash block
        └── ... (see events.ts replayEvent())
```

**Key difference from live events:** Replay uses aggregated types (`assistant_message` instead of `message_chunk`, `bash_result` instead of `bash_output`). The render logic is different because the full content is available at once.

During replay, `state.replayInProgress = true` and live SSE events are queued in `state.replayQueue`.

### Incremental Sync

`loadNewEvents()` fetches only events after the last known sequence:

```
GET /api/sessions/:id/events?after_seq=42
        │
        ▼
  1. Remove DOM elements after sync boundary
  2. Reset streaming state (assistant/thinking/bash)
  3. Replay new events
  4. Update lastEventSeq and sync boundary
```

The **sync boundary** is a `data-sync-boundary` attribute on the last DOM element from replay. On incremental sync, all elements after this boundary are removed (they were live-rendered and may be stale/partial) and replaced with the authoritative DB content.

---

## Session Management

### Session Switching

All session switches go through `handleEvent({ type: 'session_created', ... })` to ensure consistent state:

```typescript
// Pattern used in commands.ts /switch, menu click, app.ts SW handler:
state.sessionId = null;  // clear to pass the guard in handleEvent
resetSessionUI();
Promise.all([
  api.getSession(targetId),
  loadHistory(targetId),
]).then(([session, loaded]) => {
  handleEvent({
    type: 'session_created',
    sessionId: session.id,
    cwd: session.cwd,
    title: session.title,
    configOptions: session.configOptions,
    busyKind: session.busyKind,
  });
});
```

**Why through handleEvent?** The `session_created` handler updates `configOptions`, `statusBar`, `sessionCwd`, `sessionTitle`, hash, connection status, and busy state. Bypassing it (e.g., setting fields manually) leads to inconsistencies (status bar disappearing, mode not updating).

### Hash Routing

Sessions are identified by URL hash: `/#session-id`. This enables:
- Bookmarking sessions
- Push notification click → navigate to session
- Browser back/forward (hash change)

`state.ts` provides `getHashSessionId()` and `setHashSessionId()`.

### New Session Creation

```typescript
requestNewSession({ cwd, inheritFromSessionId })
  → state.awaitingNewSession = true
  → api.createSession({ cwd, inheritFromSessionId })
  → server broadcasts session_created
  → handleEvent checks awaitingNewSession === true → accepts the new session
```

The `awaitingNewSession` flag prevents the client from ignoring its own `session_created` broadcast (normally filtered out if `sessionId` differs from current).

---

## API Client (`api.ts`)

Thin wrapper around `fetch` with error handling. All server communication goes through this module.

**Core pattern:**

```typescript
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    // Parse error body, throw ApiError with status
    throw new ApiError(res.status, message);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}
```

Uses `res.text()` + `JSON.parse()` instead of `res.json()` to handle empty bodies (204 responses).

**Exported functions** (each maps to one REST endpoint):

| Function | Method | Endpoint |
|---|---|---|
| `createSession(opts?)` | POST | `/api/sessions` |
| `deleteSession(id)` | DELETE | `/api/sessions/:id` |
| `listSessions()` | GET | `/api/sessions` |
| `getSession(id)` | GET | `/api/sessions/:id` |
| `sendMessage(sessionId, text, images?)` | POST | `/api/sessions/:id/messages` |
| `cancelSession(sessionId)` | POST | `/api/sessions/:id/cancel` |
| `resolvePermission(requestId, optionId)` | POST | `/api/permissions/:requestId` |
| `denyPermission(requestId)` | POST | `/api/permissions/:requestId` |
| `setConfig(sessionId, configId, value)` | PATCH | `/api/sessions/:id` |
| `execBash(sessionId, command)` | POST | `/api/sessions/:id/bash` |
| `cancelBash(sessionId)` | POST | `/api/sessions/:id/bash/cancel` |
| `postVisibility(clientId, visible)` | POST | `/api/clients/:clientId/visibility` |
| `getStatus(sessionId)` | GET | `/api/sessions/:id/status` |

---

## Event Handling

### Live Events vs Replay Events

| Concern | Live (SSE) | Replay (History) |
|---|---|---|
| Handler | `handleEvent()` | `replayEvent()` |
| Text format | `message_chunk` (incremental) | `assistant_message` (complete) |
| Tool calls | Rendered with pending state | Rendered with final state (look-ahead for `tool_call_update`) |
| Permissions | Show buttons | Check if resolved later in history |
| Streaming | Updates DOM incrementally | Renders complete content at once |

### Event Deduplication

When SSE events arrive during history replay, they're queued. After replay completes, `drainReplayQueue()` checks each queued event:

- `tool_call`: Skip if `#tc-{id}` already exists in DOM
- `permission_request`: Skip if `.permission[data-request-id="{id}"]` exists

This prevents tool calls and permissions from appearing twice when SSE delivers an event that was also in the DB history.

### Replay Queue

```
[history loading]          [SSE events arriving]
  replayInProgress=true        │
  for events in history:       ├── message_chunk → queued
    replayEvent()              ├── tool_call → queued
                               └── tool_call_update → queued
  replayInProgress=false
  drainReplayQueue()
    ├── message_chunk → handleEvent() (new content)
    ├── tool_call → skip (already in DOM from history)
    └── tool_call_update → handleEvent() (update existing)
```

### Self-Echo Suppression

SSE broadcasts to **all** clients, including the sender. When sending a message:

```typescript
state.sentMessageForSession = state.sessionId;  // before send
```

When `user_message` arrives via SSE:

```typescript
if (state.sentMessageForSession === msg.sessionId) {
  state.sentMessageForSession = null;
  break;  // skip — already rendered optimistically
}
```

This prevents the user's own message from appearing twice.

---

## Permission Flow

```
1. Agent requests permission → SSE: permission_request
2. handleEvent renders permission card with buttons
3. User clicks Allow/Deny
4. Client:
   a. api.resolvePermission(requestId, optionId)  // or denyPermission
   b. Update DOM optimistically (collapse card)
   c. Track in state.unconfirmedPermissions
5. Server: POST /api/permissions/:requestId
   a. bridge.resolvePermission() or bridge.denyPermission()
   b. Broadcast permission_resolved
6. Client receives permission_resolved
   a. Remove from unconfirmedPermissions
   b. Update DOM (idempotent — already collapsed)
```

**Reconnect retry:** If the connection drops between steps 4 and 5, the permission response is lost. On reconnect, `retryUnconfirmedPermissions()` checks `state.unconfirmedPermissions` against the DOM and resends any that still show buttons.

---

## Slash Commands

Triggered by `/` prefix in input. Handled in `commands.ts`.

| Command | API Call | Description |
|---|---|---|
| `/switch [query]` | `api.listSessions()` + `api.getSession()` + `loadHistory()` | Switch to another session |
| `/new [path]` | `api.createSession()` | Create new session |
| `/delete` | `api.deleteSession()` | Delete current session |
| `/model [name]` | `api.setConfig(sessionId, 'model', value)` | Switch model |
| `/mode [name]` | `api.setConfig(sessionId, 'mode', value)` | Switch mode |
| `/think [level]` | `api.setConfig(sessionId, 'reasoning_effort', value)` | Set reasoning effort |
| `/compact` | `api.sendMessage(sessionId, '/compact')` | Send as prompt (agent handles) |
| `/notify [on\|off]` | Push API + `/api/push/subscribe` | Manage push notifications |
| `/clear` | — | Clear the DOM (no API call) |
| `/? [query]` | — | Search sessions by title |

The slash menu provides autocomplete with keyboard navigation (arrow keys, Tab to fill, Enter to send).

---

## Bash Execution

Triggered by `!` prefix in input:

```
User types: !ls -la
        │
        ▼
  input.ts: sendMessage()
        ├── addBashBlock(command, isUser=true)
        ├── api.execBash(sessionId, command)
        └── setBusy(true)

  SSE events:
        ├── bash_command → (already rendered)
        ├── bash_output  → append to bash output element
        ├── bash_output  → append...
        └── bash_done    → finishBash(), setBusy(false)
```

---

## State Management

All state lives in `state.ts` as a single mutable object. No state management library.

**Key state fields:**

| Field | Type | Purpose |
|---|---|---|
| `eventSource` | EventSource | Active SSE connection |
| `clientId` | string | Assigned by server on SSE connect |
| `sessionId` | string | Current session |
| `sessionCwd` | string | Working directory |
| `configOptions` | ConfigOption[] | Model, mode, reasoning_effort options |
| `busy` | boolean | Agent or bash is running |
| `currentAssistantEl` | HTMLElement | In-progress streaming message element |
| `currentAssistantText` | string | Accumulated streamed text |
| `lastEventSeq` | number | Last event seq from history/incremental load |
| `replayInProgress` | boolean | True during history replay |
| `replayQueue` | AgentEvent[] | SSE events queued during replay |
| `sentMessageForSession` | string | For self-echo suppression |
| `unconfirmedPermissions` | Map | Permissions sent but not confirmed |

---

## UI Patterns

### Streaming Text

`message_chunk` events are appended to a growing `<div class="msg assistant">`:

```typescript
state.currentAssistantText += msg.text;
state.currentAssistantEl.innerHTML = renderMd(state.currentAssistantText);
```

Markdown is re-rendered on each chunk (full re-render, not incremental). `renderMd()` uses marked.js.

When a turn boundary occurs (`tool_call`, `plan`, `prompt_done`), the streaming element is finalized via `finishAssistant()`.

### Tool Calls

Each tool call gets a `<div id="tc-{id}" class="tool-call">` with an icon from `TOOL_ICONS`. Status updates change the class and icon:
- Pending: tool icon
- Completed: ✓
- Failed: ✗

Edit tool calls render a diff view. Command tool calls show the command string.

### Status Bar

A `<div id="status-bar">` below the input area shows: `model · cwd`

Updated by `updateStatusBar()` in `state.ts`, called from:
- `updateConfigOptions()` (on any config change)
- `handleEvent(session_created)` (on session load/switch)

### Busy State

When `setBusy(true)`:
- Send button changes to `^X` (cancel)
- Prompt indicator shows busy animation
- Regular messages are blocked (slash/bash commands still allowed)

### Mode Indicator

The input area gets CSS classes based on mode:
- `plan-mode` → mode label shows "plan"
- `autopilot-mode` → mode label shows "autopilot"

Ctrl+M cycles through available modes. Click on the prompt indicator also cycles.

---

## Build System

```
public/js/*.ts  ──→  esbuild  ──→  dist/js/app.[hash].js
public/styles.css ──→  copy   ──→  dist/styles.[hash].css
public/index.html ──→  inject ──→  dist/index.html
```

- `scripts/build.js` runs esbuild
- Production: minified, content-hashed filenames for cache busting
- Development (`--dev`): no minification, no hashing, output to `dist-dev/`
- `--watch`: live rebuild on file changes

Content-hashed filenames mean `npm run build` is sufficient for frontend-only changes — the server reads files on each request, and Cloudflare/browser caches are busted by the new hash.

---

## Key Design Decisions

### REST + SSE Instead of WebSocket

- **REST** for commands: simpler error handling, HTTP status codes, caching, load balancer compatibility
- **SSE** for events: automatic reconnection built into `EventSource` API, works through HTTP/2 proxies
- No bidirectional framing overhead for one-way event streams
- Matches industry standard (ChatGPT, Claude, Gemini all use REST + per-request SSE)

### Parallel Page Load

Session data and history are fetched in parallel, independent of the SSE connection:

```
Time →
SSE connect:  ████████████████████  (background, non-blocking)
getSession:   ████                  (parallel)
loadHistory:  ████████              (parallel)
              ↑                     ↑
              page starts rendering history is visible
```

This eliminates the serial dependency chain that existed with WebSocket-only architecture.

### Global SSE Stream

The client connects to `/api/events/stream` (global), not per-session. This means:
- No reconnect needed on session switch
- Multi-client broadcast works naturally (see other clients' session changes)
- One connection per browser tab, regardless of session switches

### Optimistic UI + Retry

Permission responses and user messages are rendered optimistically (before server confirms). This makes the UI feel instant. For permissions, `unconfirmedPermissions` tracks responses that haven't been confirmed, and `retryUnconfirmedPermissions()` resends them after reconnect.
