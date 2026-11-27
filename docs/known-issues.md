# Known issues and deferred work

What this file is: the single place that records defects we deliberately did not
fix in the change that found them, plus the limits we know about and the
trip-wires that will remove them.

What it is not: a roadmap, and not a wishlist. Nothing here is planned work
unless it says so. If you fix one, move it out — this file only grows by
deferral, and every entry has to say what would close it.

How to add an entry: open it when you knowingly leave a defect or a soft edge
behind, with the symptom, where it lives, and why deferring was right at the
time. An entry without a "closing condition" is a wish, not an issue.

## Cross-instance collaboration

- **A committed remote create can outlive a failed post-commit read/broadcast.**
  The durable owner task and hub link are already complete; only follow-up
  display refresh may fail. *Closing:* require presentation to be retriable
  without weakening the durable write.
- **Hub and owner must be upgraded together.** Pre-1.0 has no cross-version
  multi-host wire compatibility; mixing a new hub with an older owner is
  unsupported. *Closing:* introduce protocol versioning at 1.0 if needed.
- **A hard-deleted remote child can be recreated if a create retry lands after
  deletion.** Remote `POST /api/v1/tasks` derives its task id from
  `opIdentity(TASK_CREATE_NAMESPACE, callerLinkName, opId)`. A soft-deleted
  (shared) task still exists in `tasks` and returns `404 target_deleted` on
  replay, but a hard-deleted task removes the row so a late retry inside the
  hub's retry window would insert it again (requires create response loss,
  immediate hard delete, and retry within the same window). *Closing:* accepted
  edge case; do not add a tombstone table for it.
- **Permission responses, cancel, prompt, and message ingress do not promise
  same-op replay.** Repeating a request with the same `X-Client-Op-Id` can
  re-execute against live state (cancel may stop a newer turn, prompt after
  idle starts a new turn, ingress creates a second message, and permission
  returns `404` once answered). None of these routes currently has a caller
  that automatically retries with the same op id. *Closing:* when a caller
  begins automatically retrying these routes on unknown outcome (expected in
  plan v7 step 6 when the browser adopts `shared/sync` requests).
- **Existing databases retain an orphan `client_ops` table.** Fresh databases
  do not create `client_ops`, and startup does not `DROP` it on older
  databases; operators may drop it manually while stopped. *Closing:* pre-1.0
  schema reset or manual cleanup.
- **A browser retry uses whatever token is current.** The `@` send keeps one op
  id across retries, but each attempt reads the stored token; if another tab
  signs in under a different token name between attempts, the retry derives a
  different Message id and the message can be delivered twice. Requires an
  attempt that committed but whose outcome was unknown to the browser (lost or
  malformed response, proxy `5xx`) and a token swap inside the retry window. *Closing:* a real browser
  path that keeps several tokens live at once.
- **Owner entries stay queued indefinitely if a hub never reconnects.** The
  pull-side outbox does not expire entries when a hub stops dialing. *Closing:*
  add an explicit host/link removal operation.
- **Owner-to-hub messages have no offline handoff timeout.** Timeout T runs
  only on the hub pusher. While the hub is offline, an R1 → P `task_send` stays
  queued on the owner with no failure notice to R1, unlike P → R1 (exception E1 in
  [multi-host](./architecture/multi-host.md#differences-from-local)). The owner cannot time out honestly: the pull side has no
  handoff signal (the hub does not acknowledge its `applied` position), and a
  missing receipt only means P has not drained the message yet, so timing out
  on receipts would report failure for messages P later receives. *Closing:*
  when a real workflow needs R1 to learn that the hub is gone, have the hub
  report `applied` to the owner and apply the same `max(queued_at,
  offlineSince) + T` rule and failed-run absorption on the owner's pull-side
  cursor.
- **A temporary apply failure on one link blocks later entries on that link.**
  Feed application is strictly serial per link; a transient error retries in
  place rather than skipping ahead. *Closing:* accepted trade-off until
  per-task partitioning is ever required.
- **A pull-side protocol error stops that link until operator intervention.**
  Relationship mismatches or unknown envelopes stop automatic reconnect for
  that link without advancing `applied_pos`; other links continue normally.
  *Closing:* operator fixes the configuration/data and restarts the process.
- **Re-issuing a revoked host token name to a different hub inherits the old
  link's outbox and cursor.** Links are identified by `(remote_role,
  remote_host)` using the token name; reuse a token name only when rotating
  credentials for the same hub. *Closing:* operational convention.
- **`outbox.pos` relies on monotonic SQLite `rowid` without online deletion.**
  No online outbox purge or `VACUUM` path exists yet. *Closing:* before adding
  outbox compaction, switch to `INTEGER PRIMARY KEY AUTOINCREMENT` and define
  `prev` truncation rules.
- **Remote text search fetches the full owner history.** The owner exposes no
  server-side search endpoint, so the hub applies the shared projector after a
  full task-events read. *Closing:* add a bounded history-search route and
  preserve the MCP shapes and limits.
- **A timed-out hub push whose earlier attempt had an unknown result may still
  have been accepted by the owner.** Offline handoff timeout T reports that
  handoff was not confirmed before the deadline, without revoking work the
  owner already committed; a late receipt is consumed without flipping status.
  *Closing:* accepted residual of at-least-once handoff; do not add a rollback
  or cancel protocol for it.
- **Open obligation accounts are in-memory on both local and remote tasks.**
  An owner restart drops open accounts, so subsequent `no_update` /
  `no_activity` notices for pre-restart dispatches are not emitted; `done` and
  `blocked` reports still reach the external parent via the persisted
  `remote_tasks` fallback. *Closing:* accepted parity with local tasks; no
  obligation persistence planned.
- **Soft-deleting a shared remote child with both an open external account and
  a queued inbound message can emit two notices to the hub parent.** Soft delete
  leaves the inbound row untouched while keeping the tombstone, and purges the
  in-memory account (emitting an A3 `target_removed` notice); the second notice
  happens only if the last share is later revoked and its failed receipt reaches
  the hub (emitting an A1 notice).
  *Closing:* fail outstanding inbound rows in the soft-delete transaction so
  the existing status-before-purge ordering deduplicates them.
- **`SyncOutbox.wake()` during an empty `pump()` is dropped.** While
  `SyncOutbox.pump()` is awaiting `port.next()` on an empty snapshot, an
  intervening `wake()` returns early because `pumping` is still `true`; under
  offline timeout `T`, a message fails without any POST only if no later wake
  revives the pump first. *Closing:* latch a pending wake during `pumping` and
  recheck once when `pump()` completes empty.
- **A transient SQLite `SELECT` error in the pusher's `next()` escapes the
  fire-and-forget pump.** `SyncOutbox.pump()` invokes `port.next()` without a
  catch handler (`src/shared/sync/outbox.ts`), so a transient head-read error
  becomes an unhandled promise rejection: under Node's default handling it
  terminates the process, and otherwise it leaves the pump idle until a
  subsequent wake. *Closing:* the adapter catches
  head-read errors and schedules a pump retry.
- **Remote rename and browser task routing are not yet cross-host.** Rename is
  still local-only and the browser does not yet address remote Task entries.
  *Closing:* implement cross-host naming (E7) and browser routing slices.
- **An offline owner blocks deleting its hub parent.** Deleting a hub task (or
  exiting Root) synchronously deletes each remote child first; while an owner is
  offline or unreachable, the delete fails and preserves the parent (analogous
  to a busy local descendant blocking parent delete). *Closing:* future host
  removal flow.
- **A timed-out synchronous remote command may complete after the caller reports
  an unknown result.** When a synchronous remote cancel or delete times out or
  loses its response, the owner may still commit after the caller reports an
  unknown outcome; no background retry or compensation runs. *Closing:* accepted
  limit of synchronous network calls.
- **Create-vs-delete/unarchive link-registration window.** If an owner deletes
  or unarchives a newly created remote child after owner commit but before the
  hub records the child link, the owner's `child_left` is a no-op on the hub and
  the hub then records a stale child link; similarly, deleting a hub parent
  while a remote create is in flight can miss the new child. *Closing:*
  lifecycle-safe link creation.

## Permission and turn lifecycle

- **A pending permission has no turn-boundary cleanup.** `bridge.cancel` /
  `denyPermission` / `resolvePermission` drop the resolver, but
  `TaskManager.pendingPermissions` is not synchronized with it, so a request
  from a turn that was cancelled mid-flight can still be answered later. The
  attachment-read interceptor now fails closed when no live turn can be
  identified (`src/event-handler.ts`), which covers its own path only; a manual
  click on a dead request still writes a `permission_response` no turn can
  consume. *Closing:* expire or drop pending entries with their turn, and write
  a response only after a real resolve.
- **A permission request that arrives during a restore is swallowed.**
  `handleAgentEvent` returns early for `restoringTasks`; the request neither
  reaches `pendingPermissions` nor the UI, while the bridge has already
  registered its resolver, so the agent's promise is never settled.
  *Closing:* buffer restore-time requests like pending session updates, then
  route them once the restore binds.
- **A late request is attributed to the turn it arrives in — accepted.**
  ACP carries no correlation from a permission request to the prompt that caused
  it, so the host uses the live turn at arrival. An old request answered by a
  new turn is a distortion we accept and document rather than paper over; see
  the turn-authorization invariant in
  [`implementation-invariants.md`](./implementation-invariants.md).

## Task lifecycle and storage

- **Task creation repeats input-shape validation.** `src/task-ops.ts` and
  `src/host/local/adapter.ts` both check basic fields such as `agentId` and
  the external `parentId`. *Closing:* revisit after the create path is
  refactored. If the duplication remains, validate input shape once with Zod
  at the Core API boundary and pass typed input downstream. Keep authorization
  and state-dependent checks in their owning layers, and preserve the existing
  REST and MCP error behavior.

- **A Root replacement is announced only when the fallback lands normally.**
  `/exit` prints its request row and the landing prints a `notify: Root replaced`
  row, both from client memory. If the fallback's own reads fail
  (`fallbackToNextTaskImpl`'s `loadTaskList` / `getTask` / `loadHistory` /
  hydration) the client falls through to the create-new tail and bootstraps
  instead, and the row is dropped: the user lands on the replacement Root with
  nothing but the generic task-created line. That path needs a failed request
  or a stale task list, which is why it was deferred rather than carried through
  the bootstrap flow. *Closing:* key the notice on the replacement task id
  (recorded from the delete response) at the activation path instead of passing
  a flag through the fallback.

- **An internally deleted task leaves a ghost entry in a client's live set.**
  Some deletions happen inside the manager and broadcast nothing: the 60s
  empty-task sweep (`TaskManager.tryCleanupEmptyTasks`) and the consume
  cleanup drop rows directly, while clients derive "live" from
  `listSnapshot ∪ created − deleted` over the events they received. A client
  that received the matching `task_created` therefore keeps a task that no
  longer exists as live, so a reference to it would not be marked exited and
  the collection would not drop it until the next successful list read replaces
  the base. The consume carrier is no longer announced when it is created, but
  a baseline read taken while it briefly exists keeps it the same way; both are
  one class. The error direction is safe — a missing mark, never a wrong one. *Closing:* broadcast `task_deleted`
  from the manager's own deletions as well, or make the derived set subscribe
  to every deletion source instead of only the event stream.

- **A list read that fails after a baseline does not downgrade existing marks.**
  `loadTaskList` applies only successful reads, so a later 503 leaves the last
  baseline in place. Exits are permanent, so an exited mark cannot become
  false; only a `renamed` reference can keep a current name that has since
  changed, and its old-name strike was correct when it was derived. This is
  deliberate: clearing marks on a failed read would turn "cannot check" into
  "no claim" and lose correct information. *Closing:* none expected; treat the
  next successful read as the correction.

- **The empty-task GC can fail a foreign key.** `Store.deleteEmptyTasks` throws
  `FOREIGN KEY constraint failed` for a zero-event task that still has a share
  row, and `TaskManager` does not catch it, so an unrelated task creation can
  fail. `shares.task_id` is the one task FK with no `ON DELETE`, which is also
  what keeps the tombstone reap explicit. *Closing:* give the share row a
  cascade or reap the share before the task.
- **A claimed delivery batch is not repaired if the drain throws after the
  claim.** `claimQueuedDeliveries` marks the batch delivered before the rows are
  projected and before the ACP prompt, so an exception in between (a database
  error writing a projected row, say) leaves the batch marked delivered while
  the agent never receives it; the catch logs and returns without requeueing or
  failing. The runtime message lookup no longer throws on unreadable data — it
  parses per row and skips what it cannot read — but a failed `sqlite3_step`, a
  projection write, or any other throw in that window still reaches this catch,
  and the claim-before-prompt window is by design. *Closing:* repair or
  requeue the batch in the drain's catch, or claim after the prompt is
  accepted.
- **A soft-deleted task's share cannot be revoked.** The tombstone path keeps
  history but leaves the published snapshot addressable. *Closing:* revoke on
  tombstone and record the revocation in the share row.
- **A user-initiated cancel writes no transcript row — deliberate.** Only the
  MCP `task_cancel` path records who cancelled what, because the agent's cancel
  is news to both sides while yours is an action you took in the UI.
  *Closing:* only if a human-initiated cancel should also appear on the child's
  transcript; today that is a product decision, not a bug.
- **`/new`'s create-failure recovery clears the view first.** It drops the
  active task before the create request, so a failed create (for example the
  source task is deleted during the cwd probe) leaves no active task until a
  reload. The probe's liveness guard fails open on purpose. *Closing:* clear
  only after a successful create, or restore the previous task on failure.
- **Archive UI and late delivery are best effort.** An already-open task menu
  on another client may keep a pre-archive row until the menu is reopened; work
  already handed to ACP may still be delivered after archive; and a late
  failure on a cut edge may leave a harmless retry-map entry with a
  `prompt_failed` label. No dedicated race fence covers these windows.

- **A crash between handover and the ACP request leaves a delivered row the
  agent never saw.** The drain marks rows `delivered` and calls the agent in
  the same synchronous step, so only a process exit or a failed database write
  inside that step can strand one. It is not redelivered. *Closing:* a startup
  sweep, if this is ever observed.

- **Task-created broadcast guards lack multi-client coverage.** The live
  `task_created` / `system_message` guards are asserted in the frontend tests,
  not against two real clients. *Closing:* a two-client integration test that
  asserts exactly one row per client.

## Protocol and agent compatibility

- **A host token command can ignore cancellation or leave descendants holding
  its stdout pipe.** The command receives SIGTERM on stop/timeout, and the
  connection waits for the child `close` event, so a replacement command is not
  started early. A shell that ignores SIGTERM or a descendant that retains the
  pipe can therefore delay that host's next retry beyond the five-second
  command timeout; other configured hosts do not share the wait. *Closing:*
  handle this after a real command demonstrates the behavior, then choose an
  explicit process-tree termination mechanism. While the command is still
  pending, the attempt watchdog continues from its original start, so the
  diagnostic host state may alternate between `connecting` and
  `unreachable(network)` every 45–50 seconds; no second command starts.
- **`MAX_ACP_MESSAGE_BYTES` is a hardcoded 128 MiB cap.** It is not derived from
  configured limits, so raising `file_upload` above roughly 120 MiB still hits
  it. *Closing:* derive the cap from the configured upload limit (with a
  documented floor).
- **`restoreTaskConfig` swallows a same-agent rejection.** A rejected config
  restore on the same agent is dropped instead of surfaced. *Closing:* report it
  once, the way a cross-agent restore failure is reported.
- **Restore rejections other than `-32002` surface raw.** `-32601` or a cwd
  mismatch arrives as a bare error with no `/new` hint and no `load` fallback.
  *Closing:* map the rejections we can act on to their remedy.
- **`bootstrap` cannot name an agent.** Startup materialization always uses the
  default agent. *Closing:* accept an agent id and validate it like any other
  coordinate.
- **`GET /config` reports `configOptions` from the default agent only.**
  *Closing:* report per configured agent, or name the agent the snapshot came
  from.
- **`POST /api/v1/tasks` will need `TaskConfigOverrideError` mapping** once it
  accepts `model` / `thinking`; today only the MCP path renders the candidates.
  *Closing:* the same budgeted error rendering at the REST boundary.
- **`configOptionsFor` caches one slot.** A second agent's snapshot can evict
  the first within a request. *Closing:* key the cache by agent.
- **Trip-wire: Copilot's image tool.** Once it emits a real ACP image block,
  delete `src/agent-compatibility/copilot-image-path.ts`, its import in
  `src/event-handler.ts`, and the one call in that file's `tool_call_update`
  branch; the normal path in `src/tool-result-image.ts` covers tool-result
  pictures. See [`acp.md`](./acp.md).
- **Trip-wire: `loadSession` capability.** If a future SDK moves `loadSession`
  under `sessionCapabilities`, the capability read in `src/bridge.ts` must be
  revisited.
- **Trip-wire: no handshake deadline, and a batched `initialize` no longer
  fails fast.** `bridge.start()` awaits `initialize` with no timeout, and ACP SDK
  2.4.0 answers a JSON-RPC batch (which ACP v1 forbids) with `-32600` *without*
  closing the connection, where 1.7.0 closed it. *Symptom:* an agent that wraps
  its `initialize` response in an array no longer fails the start — the start
  flight never settles, so `resolve()` for that agent waits forever and `reload`
  is refused as already in progress while the child stays attached. *Trigger:*
  any peer that sends batches, i.e. non-conforming v1 traffic; conforming agents
  are unaffected, and every other start failure still reaps the process.
  *Closing:* give the handshake a bounded deadline in `bridge.start()`; that
  removes this entry. Restoring the old close-on-batch behaviour is not the fix.

- **Trip-wire: `stopWaitingOnCancel` is not our turn cancel.** ACP SDK 2.x
  offers `SendRequestOptions.cancellationSignal` / `stopWaitingOnCancel`, and
  neither replaces the bridge's `Promise.race([prompt, abortPromise])`.
  *Symptom:* a cancelled turn reports the wrong `stopReason`, or loses the
  agent's terminal `session/prompt` response, because `stopWaitingOnCancel`
  governs `$/cancel_request` — a JSON-RPC request cancellation that abandons the
  response — while ACP turn cancellation is the `session/cancel`
  **notification**, whose `stopReason: "cancelled"` arrives on that response.
  *Trigger:* passing a `cancellationSignal` to
  `request("session/prompt", …)`, or "simplifying" the bridge race into a signal
  because the SDK now documents one. *Closing:* delete this entry if a future
  protocol makes `$/cancel_request` authoritative for turn cancellation and the
  bridge moves to it; it does not apply while we stay on v1.

## Test and platform

- **Terminal notifications have no browser e2e.** A task finishing while the tab
  is hidden is covered by unit tests on the push service, not by a browser.
  *Closing:* an e2e that asserts the notification call and the visibility
  suppression together.
- **`share-publish` is flaky.** The publish path has failed intermittently in
  e2e and the cause is not established; it is unresolved until it reproduces in
  isolation. *Closing:* a captured failure with a mechanism.
- **The iOS input method does not open on focus.** Tapping the composer on iOS
  does not always raise the keyboard after a programmatic focus. *Closing:* a
  real-device reproduction and a focus strategy that respects the platform
  gesture requirement.

- **Trip-wire: happy-dom's `Node.prototype.nodeName` needs a shim.**
  happy-dom keeps the real accessor on `Element.prototype` and leaves a stub on
  `Node.prototype` that cannot name a node when invoked generically, which is
  where the DOM spec puts it. DOMPurify >= 3.4.8 reads tag names through a
  captured `Node.prototype.nodeName` getter while guarding against DOM
  clobbering, so under the stub every element looks like a disallowed tag and is
  unwrapped — the frontend unit suite then renders stripped markdown. Browsers
  are correct, so this is a test-environment deviation, not a sanitizer or
  product defect. `test/frontend-setup.ts` patches the accessor to the spec's
  per-node-type values, and only while the deviation is present (it checks for
  the second accessor on `Element`). *Closing:* delete the shim when
  https://github.com/capricorn86/happy-dom/issues/2182 ships a fix.

- **Trip-wire: `typescript` stops at 6.0.3 while 7.x is published.** TS 7 is
  the native (Go) rewrite: the package root exports only
  `{ version, versionMajorMinor }`, `tsc` becomes a launcher for a bundled
  binary, and the compiler API moved to `typescript/unstable/ast` plus
  `unstable/ast/is` — entrypoints that are themselves marked unstable.
  typescript-eslint refuses to load on any compiler with major version >= 7
  (it throws from its entrypoint; support for >= 7.1 is tracked in
  typescript-eslint#10940), and `test/http-status.test.ts` consumes the old
  surface (`ts.Expression`, `ts.isIdentifier`, `ts.isPropertyAccessExpression`),
  which on 7.0.2 fails to typecheck against `lib/version`. 6.0.x is the bridge
  release both consume. *Closing:* raise to 7.x once typescript-eslint supports
  it, then either move the http-status test to `typescript/unstable/ast` /
  `unstable/ast/is` or drop its AST dependency. Running TS 7 side-by-side behind
  a `typescript-native` alias is the only interim route and is not worth the
  ~1s it saves on a 2.2s typecheck.

## Performance

- **Plain HTTP/1.1 exhausts a browser origin's connection pool at about six
  WebAgent tabs.** Browsers allow roughly six concurrent connections per
  origin for plain HTTP/1.1, shared across all tabs. Every WebAgent tab holds
  one long-lived SSE connection (for example when opened directly at
  `http://127.0.0.1:6800`), so around six open tabs consume the pool: further
  tabs' SSE connections and all tabs' REST requests queue, and the UI appears
  frozen. HTTPS through a reverse proxy or CDN serving HTTP/2 or HTTP/3 avoids
  this limit. *Closing:* move each browser profile's long-lived connection into
  a SharedWorker that owns one `watch` and fans out to tabs over MessagePort
  (planned with the browser migration to the feed model), or document HTTP/2
  as a deployment requirement.
- **A cold page load waits six serial round trips before it settles.** With a
  task hash: HTML → assets → `POST /sse-ticket` → `GET /config` (stream opens)
  → history + detail → snapshot. Server time is 1–7 ms per call, so this is
  round trips: through Cloudflare from the host (~50 ms RTT) the transcript
  appears at ~580 ms; a far client pays six times its RTT. Task switches take
  two rounds (history + detail, then snapshot) and are not affected.

  Two of those rounds are historical: task loading has waited for the ticket
  since Bearer auth made stream setup async (`d2ecf33`), and for `/config`
  since Root identity needed it (`413aab6`, no longer true after `203b921`).
  They stay because removing them is not free:

  - history read before the stream registers can miss events persisted in
    between, and the reconnect catch-up (`loadNewEvents` after the last seq)
    cannot recover them once a live event (e.g. a compaction summary) has
    advanced `lastEventSeq`;
  - an early `GET /tasks/:id` can start an agent warm-up whose config-option
    broadcast is sent once and missed; the snapshot does not restore the
    option schema, and `applySnapshot()` does not apply a rename made in that
    window;
  - continuations must be fenced by connection epoch *and* navigation
    generation (a task id misses A→B→A);
  - `/new`, `/clear` and `+` parse `agent:path` with the directory from
    `/config` at submission time, so a late directory turns a coordinate into
    a plain path.

  The reviewed shape, if this is ever worth it: on a cold hashed load only,
  start `/config` and a *provisional* history render beside the ticket mint;
  after `connected`, run the existing full load (history and detail, then
  snapshot) and replace the provisional render. The transcript appears two
  rounds earlier; settlement stays at six. *Closing:* cold-load latency on a
  real client matters enough to pay for the second history read and the
  replace step.

## Deferred features (design decided, not scheduled)

- **An agent's output file has no automatic channel to a person — postponed,
  and the design changed.** The file-serving API already exists
  (`GET /api/v1/files/{info,list,content}` with a signed URL and an MIME-aware
  `Content-Disposition`: small images inline, everything else as a download),
  and `/view` is just its UI. So copying bytes into the attachment pipeline
  would add storage and quota pressure for a file that is already on disk.

  The chosen direction is a **reference**, not a copy: make a path in the
  transcript render as a link that opens `/view` for a preview or
  `files/content` for a download. Two candidate entry points — (a) egress-time
  recognition of paths in rendered text, verified with `files/info`, which needs
  no protocol change and works for agents that ignore `mcpServers`; (b) an
  explicit "this is my deliverable" declaration, which needs either the ACP
  `resource_link` content block (deferred) or a **session-scoped** tool.

  Recorded as a decision, not a defect: **do not** put an attach tool in the
  `task_*` control plane — those seven tools are coordination verbs (create,
  send, update, cancel, list, query, read), and handing a file to the person
  watching is a session action, not a task one. Copying into attachments stays
  as a later "save a durable snapshot" action, never the default.

  *Closing:* a transcript row whose file reference previews and downloads
  through the existing signed-URL path.

## Collaboration accounting limits

- **One account per parent→child edge, with no correlation id.** If a parent
  dispatches several requests before the child reports, they share one account.
  One `done` or `blocked` settles all of them, so the requester must infer which
  request the report answers from the child's prose and its own follow-ups.
  *Closing:* per-request correlation, deliberately deferred; reopen only with
  evidence that shared accounting causes wrong decisions.
- **Live delivery marks can be missed across a reconnect.** A
  `collaboration_delivery` SSE event is not persisted, and reconnect replay
  carries raw event rows without the egress-derived delivery state. A sender
  that disconnects between the send and the drain can keep `⋯` until a full
  reload, which reads the delivery row. *Closing:* persist or replay delivery
  status alongside the event, or accept the reload as the only truth.
- **A soft-deleted recipient with an active share keeps deliveries queued.**
  Soft deletion preserves the row for the share viewer, so the queued
  deliveries are not failed with `target_deleted` until the tombstone is
  reaped. They stay queued and are never claimed while the task is not live.
  *Closing:* fail queued deliveries when a task is tombstoned, or drop them
  when the share ends.
- **The replay deduper can duplicate a system-message row.** A system row
  loaded through REST history while the same live event is still queued on the
  SSE path can render twice, because the deduper keys only the live queue and
  not the replayed row. *Closing:* key both paths on message id, or drain the
  queue before applying a history page.
- **A configured agent that cannot start leaves its dispatch queued.** The
  delivery stays `queued` until the agent can be started; nothing fails or
  retries on a timer. No account opens and the source gets no notice, so only
  the sender's `⋯` mark shows it. *Closing:* start-failure handling that marks
  the delivery failed, if this proves common.
- **A turn the agent starts on its own is not a WebAgent turn.** When a harness
  wakes the agent without a prompt (a finished background command, a scheduled
  wakeup, idle compaction), its events are recorded and count as activity for
  the silence watch, but the Task is not marked busy, its turn end is not
  checked, a queued delivery can be handed over while it runs, and its final
  text is persisted only when the next turn starts. ACP has no portable signal
  for when such work ends. *Closing:* a standard ACP signal for agent-initiated
  turns.

## Accepted as designed

These are decisions, not debts. Reopen one only with new evidence.

- **Delegated turns are answered by the host, unattended.** The rule is an
  availability rule, not a security boundary: a dispatched Task must not stop on
  a button nobody will see. What actually constrains it is the agent's own mode
  and approval configuration, the dispatch wording, `task_cancel`, and the
  stored permission events. An agent can make any Task's turn unattended by
  messaging it, including one a person is watching.
- **`allow_always` may be answered, and its memory belongs to the agent.** The
  host stores no authorization state; a later human turn may therefore not be
  asked. Recorded in the audit, not revoked by the host.
- **`mode` classifies human turns only.** It decides whether *your own* turn is
  answered for you, never whether a dispatched child runs unattended.
