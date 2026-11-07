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
- **A closing reminder becomes the active turn before its resume completes.**
  `submitObligationReminder` transfers the reservation to an active turn before
  `ensureResumed`, so cancelling during that window does not clear the slot, and
  the pre-prompt re-check (`isTurnRunning`) does not consult cancel state.
  Present since P5-a; that step kept the ordering and did not widen it.
  *Closing:* move the transfer after the resume, or make the re-check read the
  cancel intent.
- **A late request is attributed to the turn it arrives in — accepted.**
  ACP carries no correlation from a permission request to the prompt that caused
  it, so the host uses the live turn at arrival. An old request answered by a
  new turn is a distortion we accept and document rather than paper over; see
  the turn-authorization invariant in
  [`implementation-invariants.md`](./implementation-invariants.md).

## Task lifecycle and storage

- **The empty-task GC can fail a foreign key.** `Store.deleteEmptyTasks` throws
  `FOREIGN KEY constraint failed` for a zero-event task that still has a share
  row, and `TaskManager` does not catch it, so an unrelated task creation can
  fail. `shares.task_id` is the one task FK with no `ON DELETE`, which is also
  what keeps the tombstone reap explicit. *Closing:* give the share row a
  cascade or reap the share before the task.
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
- **Task-created broadcast guards lack multi-client coverage.** The live
  `task_created` / `system_message` guards are asserted in the frontend tests,
  not against two real clients. *Closing:* a two-client integration test that
  asserts exactly one row per client.
- **The frontend installs the Root authority with the default generation.** A
  queued `replayQueue` event carried across an execution-generation boundary
  could install the previous connection's Root; live SSE is guarded by
  `gen !== streamGen` and any current-connection payload overwrites it.
  *Closing:* carry the generation on the replay payload and drop mismatches.

## Protocol and agent compatibility

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
- **`ClientSideConnection` / `AgentSideConnection` are deprecated** in ACP SDK
  1.7.0 in favour of the `client()` / `agent()` app API. *Closing:* migrate when
  the deprecated path starts warning.
- **Trip-wire: Copilot's image tool.** Once it emits a real ACP image block,
  delete `src/agent-compatibility/copilot-image-path.ts`, its import in
  `src/event-handler.ts`, and the one call in that file's `tool_call_update`
  branch; the normal path in `src/tool-result-image.ts` covers tool-result
  pictures. See [`acp.md`](./acp.md).
- **Trip-wire: `loadSession` capability.** If a future SDK moves `loadSession`
  under `sessionCapabilities`, the capability read in `src/bridge.ts` must be
  revisited.

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

## Planned work recorded elsewhere

- **`task_attach`** — an agent's non-image output has no automatic channel to a
  person. The contract (reuse the attachment pipeline, no path sandbox, no
  quota, preview widened to `text/*` and Markdown, one direction only) is in the
  private plan; it is not a defect and is not covered by this file.

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
