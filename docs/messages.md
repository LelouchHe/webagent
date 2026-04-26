# Messages / Inbox

A general-purpose **structured-notification primitive** built into WebAgent. External tools — cron jobs, file watchers, CI hooks, other agents — can `POST` a message to WebAgent; the user decides when to engage with it. This is the "push doorbell" for the agent UI: the sender gets delivery without stealing the user's current context.

Endpoint-level contract and schemas: [API Reference → Inbox (Messages Primitive)](api.md#inbox-messages-primitive). This doc covers the design, conventions, and integration patterns.

---

## Why a separate primitive?

An ACP agent's prompt stream is a conversation between one user and one model. It is not suitable for:

- **Unsolicited, asynchronous events** (a backup just failed; a long-running build just finished; a teammate mentioned you)
- **Cross-session routing** (this belongs in project X's session, not the one I'm currently typing in)
- **Senders without LLM access** (a bash cron job can't form a good follow-up prompt; it can only describe what happened)

The inbox addresses all three:

- Messages live in a separate `messages` table until the user decides what to do with them.
- Each message declares its target — either `user` (unbound) or a specific session (bound).
- The payload is plain `title` / `body`; the user frames the follow-up prompt themselves.

It is deliberately **not** an auto-inject mechanism. Nothing a cron job sends ever goes into an agent prompt without an explicit user action.

---

## Delivery model

Two shapes on ingress:

| Mode | `to` field | Behavior |
|---|---|---|
| **Unbound** | `"user"` | Message goes into the inbox. User opens `/inbox`, picks it, and either **consume** (creates a new session, cwd inherited if provided) or **ack** (dismiss without engaging). |
| **Bound** | `"session:<id>"` | Message is appended as a `message` event directly to the target session's event stream. No inbox hop. Unknown session id → `400`. |

Supersede (optional): pass `dedup_key`. A new unbound message with the same `(to, dedup_key)` pair replaces any older unprocessed row. Useful for "build status" style pings where only the latest matters.

---

## `from_ref` convention

Every message must declare its origin. Enforced by regex in `src/types.ts`:

```
^(cron|external):[A-Za-z0-9._\-+/]{1,120}$
```

- `cron:<name>` — scheduled local jobs (e.g. `cron:nightly-backup`)
- `external:<label>` — other one-off integrations (e.g. `external:gh-webhook`, `external:copilot-cli-dogfood`)

Reserved strings (`agent`, `user`, `system`) and `session:<id>` are rejected. This keeps server-emitted events and user input distinguishable from ingress messages throughout the data path (`from_ref` survives in the stored event; the UI displays the label accordingly).

---

## Lifecycle

```
┌─────────────┐          POST /api/v1/messages
│ external    │ ─────────── to:"user" ────────────→ messages table (pending)
│ tool (cron, │                                              │
│ webhook,    │                                              ▼
│ script...)  │                                    push notify (tag msg-<id>)
└─────────────┘                                              │
                                                             ▼
                                            user opens /inbox menu, picks row
                                                │           │
                                       ack  ◀───┘           └───▶  consume
                                        │                           │
                                        ▼                           ▼
                         row deleted                    session created
                         SSE message_acked              message event appended
                         push close sent                row deleted
                                                        SSE message_consumed
                                                        push close sent

Bound path (to:"session:<id>") skips the inbox entirely:
external tool → POST → message event on target session → session SSE + push
```

Messages are physically deleted on ack/consume (no soft-delete). Historical record lives in the owning session's `message` event once consumed; ack leaves no trace.

---

## Frontend integration

### `/inbox` slash menu

Typing `/inbox` (with or without a trailing space) opens a picker listing all pending unbound messages, newest first. Each row shows:

```
[x] Title                                     HH:MM
    from · /cwd/left-ellipsed
```

- **Default action (click / Tab+Enter):** consume → creates session + switches the UI
- **`[x]` button:** ack (dismiss without consuming)
- **Tab:** fills `/inbox <id>` into the input so the command is visible before you press Enter

Typing `/inbox <id-prefix|title-substring>` (without picker) consumes the first match; `/inbox dismiss <id-prefix|title-substring>` dismisses it. Matching mirrors `/switch` (id prefix OR case-insensitive title substring, first hit wins). There is no `consume` keyword — plain `/inbox <query>` is the consume path.

The menu refetches on every open (no client-side caching) so new arrivals show up immediately.

### Push notifications

Unbound messages fire a web-push with tag `msg-<id>`. Clicking the banner opens the app; the SW sees the `data.messageId` and navigates to `/inbox`. Acking or consuming fires a silent `sendClose("msg-<id>")` so stale banners on other devices disappear.

For bound messages the push tag is the owning session's event tag (`sess-<sid>-...`) and clicking routes to that session directly (`data.sessionId` set on send).

---

## Integration recipes

### 1. Cron job notification

```bash
#!/bin/bash
# Fire a notification whenever nightly backup fails.
if ! rsync -a "$SRC" "$DEST"; then
  curl -s -X POST "${WEBAGENT_URL:-http://localhost:6800}/api/v1/messages" \
    -H "Content-Type: application/json" \
    -d "$(jq -cn \
      --arg from "cron:nightly-backup" \
      --arg title "Backup failed" \
      --arg body "$(tail -20 /var/log/backup.log)" \
      '{from_ref:$from, to:"user", title:$title, body:$body}')"
fi
```

### 2. Route to a specific project session

```bash
# Append a tool-result style message into an existing long-lived session.
curl -s -X POST http://localhost:6800/api/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "from_ref": "external:gh-action",
    "to": "session:2b7f9e1a-...",
    "title": "Build #423 passed",
    "body": "All 1516 tests green. Artifacts: ..."
  }'
```

### 3. Dedup flapping status pings

```bash
# Supersede any prior pending "build-status" row; only the latest matters.
curl -s -X POST http://localhost:6800/api/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "from_ref": "cron:ci-watcher",
    "to": "user",
    "dedup_key": "build-status",
    "title": "CI: main is red",
    "body": "1 failed: typecheck"
  }'
```

### 4. Idempotent retries

Pass `X-Client-Op-Id: <uuid>`; repeated requests return the same message id (response is cached under the reserved `__ingress__` session key).

---

## Current scope and limits

- **No `prompt` field.** An earlier design had senders pre-populate a follow-up prompt for the user. Dropped: senders without LLM access can't reliably predict phrasing, and users compose better prompts after reading `body`. The DB column is retained for forward-compat but the API neither reads nor writes it.
- **Plain text only.** `body` is displayed verbatim; no markdown rendering, no image attach via the ingress path. The main chat supports those, but inbox content stays deliberately simple.
- **Local by design.** There is no auth on `/api/v1/messages` today — WebAgent is expected to listen on localhost or behind a trusted reverse proxy. Do not expose the ingress endpoint publicly without adding auth.
- **Browser push only.** Notification delivery piggybacks on the same `web-push` / VAPID stack as session push (see [API → Push Notifications](api.md#push-notifications)). Other transports would need separate plumbing.

---

## Where to look in the code

| Concern | File |
|---|---|
| Zod schema, `from_ref` regex | `src/types.ts` (`MessageIngressSchema`) |
| REST routes (`POST`, `GET`, `consume`, `ack`) | `src/routes.ts` |
| DB operations (`consumeMessageTx`, `findBySupersede`, `deleteOlderThan`) | `src/store.ts` |
| Push tag derivation, `session:<id>` routing | `src/push-service.ts` (`sendForMessage`, `tagToTopic`) |
| Inbox slash menu, rendering, click/tab handlers | `public/js/commands.ts` |
| Inbox types + API client | `public/js/api.ts` |
| SW banner-close + notificationclick routing | `public/sw.js` |
| Tests | `test/messages-*.test.ts`, `test/push-egress*.test.ts`, `test/inbox-command.test.ts`, `test/slash-menu.test.ts` |
