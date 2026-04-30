# Attachments — Upload Pipeline & Lifecycle

End-to-end notes on how WebAgent stores and uses user-uploaded attachments
(images and arbitrary files). Routes are in [`docs/api.md`](api.md), DB
columns in [`docs/schema.md`](schema.md). This doc covers the parts those
two don't: the trust-boundary model, on-disk layout, lifecycle, and
observability.

## Trust boundary — the wire shape

The browser never sends a path, URI, or raw bytes back to the server after
the initial upload. After `POST /api/v1/sessions/:id/attachments` returns
an `attachmentId`, every subsequent reference uses just the ID:

```jsonc
// POST /api/v1/sessions/:id/prompt body
{
  "text": "What's in this PDF?",
  "attachments": [
    {
      "kind": "file",
      "attachmentId": "9b0c7e1a-7d35-4a7f-8c11-...",
      "displayName": "report.pdf",
      "mimeType": "application/pdf"
    }
  ]
}
```

The server resolves the on-disk path itself by joining the per-session
attachments directory with the row keyed by `(sessionId, attachmentId)`.
**Strict validation** in `src/routes.ts` rejects any prompt body whose
`attachments[]` entries carry `uri`, `data`, or `path` fields with `400`
— it's not just ignored, it's a hard fail, so a compromised browser
cannot smuggle arbitrary paths through.

## On-disk layout

```
<data_dir>/
  sessions/
    <sessionId>/
      attachments/
        <attachmentId>.<ext>     # final, immutable
        <attachmentId>.<ext>.tmp # in-flight upload (cleaned on abort/crash)
```

Filenames embed the UUID `attachmentId` plus an extension derived from
sniffed MIME, never the user-supplied filename. The original filename is
stored as `display_name` in the `attachments` DB row and is what the user
sees in the chat bubble + permission dialog; on-disk it is irrelevant.

The pin happens at boot (`resolveSessionsAnchor` in
`src/sessions-anchor.ts`) using `realpathSync` on `<data_dir>/sessions`,
which defends against the macOS `/var → /private/var` symlink. Every
later check (file:// URI construction in the bridge dispatcher, the
permission interceptor's allowlist) compares realpaths against this same
canonical anchor.

## Upload pipeline

1. Browser opens `<input type="file">` (no `accept` filter — any type).
2. For images only, `FileReader.readAsDataURL` populates a thumbnail
   preview. Non-image attachments render as a name chip.
3. On send, each pending attachment is uploaded individually via
   `multipart/form-data` (busboy on the server) — no base64 round-trip.
4. Server classifies `kind = image | file` from sniffed MIME, picks the
   size cap (`limits.image_upload` or `limits.file_upload`), streams to
   `<uuid>.<ext>.tmp`, renames atomically on success, inserts a row into
   `attachments`.
5. After all uploads resolve, the browser fires `POST /prompt` with the
   `attachments[]` array of refs.
6. Server's `AttachmentDispatcher` resolves each ref to a file:// URI
   under `sessionsAnchor` and turns it into an ACP block. Any failure
   (DB row missing, file missing, realpath outside anchor) falls back
   to an ACP `text` block reading `[attachment removed: <displayName>]`
   — the prompt still goes through, just without that file.

## Permission auto-approve

When the agent issues a tool call to read one of these files later in
the turn, WebAgent can auto-approve **without prompting the user** — but
only under a strict allowlist. The check lives in
`src/attachment-interceptor.ts` and runs **after** the permission
request has already been broadcast to the UI (so multi-client visibility
is preserved), then races to `allow_once` if every defense passes.
`allow_always` is never used — auto-approval doesn't persist across
mode switches.

Defenses (numbering matches the plan):

| #  | Check                                                                                  |
| -- | -------------------------------------------------------------------------------------- |
| F1 | Tool kind is exactly `read`                                                            |
| F2 | Tool name (when present) is in `{view, read_file}` — conditional, not required        |
| F3 | Every `locations[].path` realpaths into the per-session attachment realpath set       |
| F4 | If `rawInput` carries `path` / `filePath` / `file`, those must also realpath in       |
| F5 | If neither locations nor rawInput surface a path, fall through (don't auto-approve)   |
| F6 | Any realpath / DB error → fall through (let the user prompt show)                     |
| F7 | First-ever schema drift escalates once per process                                    |

If a future agent CLI starts using a different rawInput key for paths
(say `target_file`), defense F4 trips schemaDrift, the operator sees
the warning, and we add the new key. The user's permission dialog still
shows in the meantime — the agent is never silently denied.

## Lifecycle

### Session delete

`DELETE /api/v1/sessions/:id` cascades:

- DB rows: `attachments` rows go via SQLite `ON DELETE CASCADE` from
  `sessions.id` (covered by `test/store-attachments.test.ts`).
- Disk: the session directory `<data_dir>/sessions/<sid>/` is removed
  recursively, which takes the `attachments/` subdir with it.

### Orphaned `.tmp` files

Atomic `rename()` after the upload finishes means a crashed upload
leaves a `<uuid>.<ext>.tmp` file but no DB row. There is currently
**no automatic sweeper** — these accumulate until the session is
deleted. The plan calls this out as a deferred GC task; in practice
the count is bounded by aborted uploads per session, which is small.

### Unreferenced attachments

If an attachment is uploaded but no prompt is ever sent (user picks a
file then types `/exit`), the row + file persist until the session is
deleted. Same deferred GC story as `.tmp` files.

## Observability

The interceptor exposes four counters, dumped to stdout once per hour
(`ATTACHMENT_INTERCEPTOR_DUMP_MS = 1h` in `src/server.ts`):

```
[attachment-interceptor] counters {"autoAllowed":17,"fellThrough":3,"realpathErrors":0,"schemaDrift":0}
```

| Counter           | Meaning                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `autoAllowed`     | Reads we auto-approved as known attachments                              |
| `fellThrough`     | Reads we declined to auto-approve (let the user dialog show as normal)  |
| `realpathErrors`  | Filesystem error during realpath check — also falls through              |
| `schemaDrift`     | Tool's rawInput had path-like keys we don't recognize. **Investigate.** |

The first time `schemaDrift` increments per process, an `error`-level
log fires immediately (in addition to the hourly counter dump). A 24h
throttle prevents spam if the new schema is steady. When you see a
schemaDrift line, grep `src/attachment-interceptor.ts`'s
`RAWINPUT_PATH_KEYS` and add the new key.

`fellThrough` going up is normal whenever the agent asks to read a
non-attachment file; a sudden jump in `realpathErrors` is the
interesting signal — it usually means a session was renamed or the
data dir moved out from under a live process.

## Limits

- `limits.image_upload` (default 10 MB) — caps `kind: "image"` uploads.
- `limits.file_upload` (default 50 MB) — caps `kind: "file"` uploads.

The 413 response is emitted the moment the running byte total crosses
the cap, before the rest of the body is buffered.
