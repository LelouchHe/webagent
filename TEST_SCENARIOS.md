# Test Scenarios

Last updated: 2026-11-07

This file is a scenario-level map of the current automated test suite.
It is intentionally higher-level than raw test names so we can review coverage,
spot gaps, and decide what still needs to be added without reading every spec.

## Coverage Snapshot

- Unit / integration tests: `test/*.test.ts`
- Browser E2E tests: `test/e2e/*.spec.ts`
- Current focus of the suite:
  - task lifecycle and restore behavior
  - cross-client synchronization
  - permission and cancel lifecycles
  - config persistence / inheritance / sync
  - bash execution lifecycle
  - slash command and picker UX
  - ACP Agent Slash discovery, forwarding, snapshot hydration, and busy gating
  - REST API surface (tasks, prompt, bash, permissions, ops, SSE, push)
  - Share links (token issue, owner auth, sanitizer, viewer routes, attachment proxy, build prune)
  - Attachment upload pipeline (image + file, send-time upload, atomic disk writes)
  - Local file viewer (arbitrary paths, signed bytes, slash picker, responsive viewer)

## Unit / Integration Scenarios

### Multi-agent runtime

- `test/multi-agent-runtime.test.ts` (real ACP child processes, one per agent)
  - no agent exists before the first demand; unrelated agents stay unstarted
  - each task executes on its binding agent: B really receives the prompt, A receives nothing, and two agents sharing one session id stay two executions
  - a task bound to one agent cannot be projected onto another agent's identical session id (`setConfigOption` refuses)
  - concurrent demand starts one process; a failed `initialize` leaves no process and the next start succeeds
  - reads (task, list, events, session view, commands, permissions) work with the agent's transport gone, and no read rotates the binding
  - Root's three first-use states: unbound attaches, empty slot replaces, real binding loads; concurrent first use materializes once; each commit advances the generation
  - a reload of one agent leaves another agent's streaming, plan, usage, and busy state untouched
  - GC and Root exit retire through the agent recorded on the binding, never a default adapter (same session id on both agents)

- `test/multi-agent-mcp.test.ts` (production host + endpoint + real store/ledger; business calls go through real HTTP `tools/call`)
  - a caller that rotates while a `task_create` waits for the tree lock is refused before the task row is written
  - a caller that rotates while a `task_cancel` awaits the transport gets a refused tool result and no cancellation row
  - a caller that rotates during a child's config inheritance is refused before the source transcript row is written; the already-committed child stays
  - an `initializing` capability completes the MCP handshake but every business tool returns `initializing`; after promotion the same token works
  - a request authenticated before a real rotation cannot write after it (the task-persist boundary re-checks after `newSession`), while a fresh token against the current generation succeeds; the rotated-away token is revoked
  - a token whose task moved to another agent is refused; a Root exit revokes the old Root's token
  - unknown/revoked tokens are refused before any protocol work; the caller principal is frozen and carries `(task, agent, generation)`

- `test/multi-agent-mcp-create.test.ts` (production host + endpoint + real REST handler, one distinguishable transport per configured agent)
  - `task_create(agent: …)` creates the child on the target: exactly one new session on B, none on the parent's A, the child's binding and session belong to B, a relative `cwd` still resolves against the parent's `cwd`, and exactly one five-field creation record (`Task ID`/`agent`/`cwd`/`model`/`thinking`) is written to the parent
  - the three argument forms resolve to three bindings: omitted (parent's A), explicit same agent (A), and a third configured agent (C, with B never started)
  - an explicit `model` the target accepts really applies: the row, the detail read, the target mock's session values, and the creation record all agree
  - a target session that reports no option while the agent-level cache still holds an older list fails as `unsupported_config`: the error names the missing option and never offers the cached values, and no task row, creation record, or valid capability survives
  - a small candidate set is listed with the target's current value; a wide `model` list is reduced to its count and current value (and is not enumerated); a same-agent failure keeps the same error shape
  - a model override that succeeds before `thinking` fails proves the cleanup: the model write reached the target, and the task row, creation record, and capability are all gone afterwards
  - an unconfigured `agent` is refused with the omission hint and no id list (the list stays in the tool description); a configured agent that cannot start reports the transport's real reason plus the same hint
  - a target that starts but refuses `session/new` fails as a tool error with that session's reason, and leaves no task row, creation record, or valid capability
  - the explicit-agent path keeps the authority boundary: a rotation landing inside the target's start yields `execution_replaced` with no task and no target session, a token from an older generation is refused, and unknown/revoked capabilities are still entry-level `401`
  - the per-request description lists only the configured agents (a configured-but-not-advertised agent is absent)
  - same-agent regression: inheritance still carries the parent's stored model, and same-agent validation reports its own schema's candidates

- `test/mcp-create-errors.test.ts` (pure builders and the shared composer)
  - a 900-character id is dropped whole (no pseudo-id fragment) while the failure category and the `agent` omission hint survive
  - a start reason with embedded newlines is flattened into one line, so the message stays at two lines instead of eight
  - an over-long start reason / requested value / current value is dropped whole; the guidance and the target id remain
  - a message of exactly the 400-character ceiling keeps the reason, and a composer of exactly six lines keeps all six
  - the line budget counts real line breaks, not parts: a three-line variant consumes three lines
  - a small candidate set is listed with the current value, a wide one becomes its count, and an unreported option offers no values at all

- `test/mcp-task-create-description.test.ts`
  - a single-agent deployment keeps the plain description (no cross-agent wording, no id list)
  - every configured id is listed whole when it fits; duplicates collapse; the whole description stays within 1024 characters
  - a large deployment lists whole ids only, ends with an omitted count that accounts for every unlisted id, and never truncates an id
  - ids that cannot fit are dropped entirely, leaving the omission note and, when not even one fits, a "too long to list here" explanation

- `test/multi-agent-mcp-collaboration.test.ts` (same harness: production host, endpoint, REST handler, one transport per agent)
  - a parent on A dispatches to a child on B: the contract reaches B's own transport and never A's; the production manager's own collaboration observer is called exactly once for that message (measured by wrapping the store registration the manager makes), and exactly one obligation record exists for the edge
  - the child's typed `task_update(done)` on B settles the record from its live turn, persists the typed update, and wakes the parent through A's transport with readable prose (`Task status: done` + the account), not JSON; the observer count grows by exactly one
  - an unanswered dispatch sends its closing reminder to B's transport (never A's), and after the transport budget is spent the terminal `delivery_failed` notice is delivered to A's transport with the readable block, while the machine payload stays in `task_outcome_notice`
  - a token minted for the generation that was current just before the child's execution was replaced is refused with `execution_replaced` even though the replacement owns a live, settleable turn: no settlement, no attempt spent, no re-enqueue, no account message; the current generation's token settles the same turn (control)

- `test/multi-agent-pending.test.ts` (real ACP child process)
  - the agent connects to `/mcp` from inside `session/new`: the handshake succeeds, `task_list` answers `initializing`, nothing is created, and the same token works after the binding commits

- `test/agent-registry.test.ts` (real child processes with delayed / refused initialize)
  - a half-initialized bridge is not available and concurrent demand shares one process
  - a live process that refuses `initialize` is cleaned up (its pid is gone) and the same agent retries successfully
  - a live process that answers `initialize` with another protocol version is refused with the version it reported, reaped, left not-ready, and the same agent retries successfully once it speaks v1
  - a reload beside a start is refused, a resolve during a reload waits, and one process exists throughout
  - `shutdownAll` reaches a transport whose adapter was already unbound

- `test/multi-agent-directory.test.ts` (HTTP; two configured agents)
  - `GET /config` and every bootstrap branch carry `agents` + `defaultAgentId`; each entry is exactly `id` (no PATH or liveness field), and an agent whose command is missing is still listed because configuration is the fact
  - taking the directory creates no adapter and no ACP session; bootstrap starts only the agent it materializes

- `test/multi-agent-create.test.ts` (HTTP + direct runtime)
  - creating for a named agent binds it with exactly one session on that agent, none on the parent's agent, and leaves no rotation record; the parent's binding is untouched
  - a same-agent create still inherits the source task's model and reasoning effort; a cross-agent create sends the source's values nowhere and reports the target's own schema
  - an unconfigured or non-string `agentId` is refused with `400` before anything starts, and a configured agent that cannot start returns `503` with its real reason plus the agent it tried (`agentId`), for an explicit target and for an inherited one (no silent substitution)
  - the parent-binding guard still refuses a child built through another agent's transport unless that caller named the target

- `test/multi-agent-execution-config.test.ts` (HTTP + direct runtime; two agents with distinguishable schemas)
  - an explicit clear onto another agent sends none of the old values (one of them is legal on the target, so a rejection cannot hide an omission), and the clear response, the database row, and the detail read agree on the replacement's own defaults
  - the replacement's report survives a live resume (asserted directly, not through the detail read) and a cold reopen — the database reopened in a new store, fresh transports, and a row value the new session does not report — while another task's session values sit in the agent's cache
  - a replacement that reports no schema leaves the columns null (never the old values), and a follow-up same-agent rotation finds nothing to replay
  - going A → B → A starts from A's defaults again instead of restoring the abandoned choice; a same-agent clear still replays the stored mode/thinking/model in order
  - an implicit takeover (the owner left the configuration) drops the stored values, keeps the `agent_rotation` record, and adopts the replacement's report
  - named boundary: with the agent's cache warmed by another task, an unreporting replacement's task reads that other task's values (null cannot override the shared cache), while the warm task still reads its own

- `test/multi-agent-config-replay.test.ts` (real ACP agent process, real `AgentBridge`)
  - a config report written immediately after the `session/new` result is queued by the transport, replayed when the binding commits, and survives the rotation's tail: the initial response's older value never rolls it back

- `test/multi-agent-config-clear.test.ts` (real ACP agent process, real `AgentBridge`)
  - a cross-agent clear whose replacement reports `medium` *before* its `session/new` result (which says `high`) keeps `medium`, and the clear response agrees: the clear runs before the transport replays queued updates, so ordering — not value equality — decides ownership
  - the same holds when the new report re-selects the value the task already had (`rotate("before", "medium")`): "the row did not change" is not proof nobody wrote
  - control: an unreporting replacement still has the old value cleared and adopts its snapshot default, so the zeroing itself is not disabled

- `test/multi-agent-cwd-defaults.test.ts`
  - an omitted `cwd` on `/clear` keeps the task's own directory while an omitted
    `cwd` on create uses the server default, even for a child of a task that
    runs elsewhere (API contract; no client entry relies on it — see
    `agent-coordinate-entries.test.ts`)

- `test/multi-agent-config-race.test.ts` (HTTP)
  - a configuration request parked in `readBody` while the task is cleared onto another agent is refused with `409`, and no configuration request reaches the new execution

- `test/runtime-warm.test.ts` (background warm-up)
  - a read-started materialization of an unmaterialized task projects its creation claim and then re-projects busy to idle when it finishes, so a client that read mid-flight is not left with a spinner no local event can end
  - a completed warm-up publishes the restored schema and commands once per task and generation
  - concurrent reads share one restore; a failed warm-up publishes nothing
  - a warm-up that outlived a rotation publishes nothing (the guard is exercised directly: a stale generation and a moved binding are both refused)
  - a deleted task publishes nothing

- `test/e2e/runtime-warm.spec.ts` (slow restore, 3s load delay)
  - the snapshot answers in well under the restore time, and the detail read returns no schema
  - while that restore is in flight the UI stays idle (`↵`, `runtime.busy` null): a background restore is never rendered as busy
  - without a refresh, the restored model and command appear from `task_runtime_warmed`

- `test/multi-agent-reads.test.ts` (HTTP + real processes)
  - three genuinely different unavailable shapes, each produced its own way: a real spawn of a missing binary, a configured agent whose transport was shut down, and a binding whose agent left the configuration
  - reads cover task detail, snapshot, events, the list, attachment bytes, the owner share list, and deletion, in every state, without moving the binding
  - the snapshot returns while a restore is still hanging (it does not wait at all)

- `test/multi-agent-clear.test.ts` (HTTP)
  - `/clear { agentId }` moves a task off a removed agent, records `explicit_clear`, preserves history, and creates exactly one session on the configured agent
  - an unconfigured `agentId`, a non-string `agentId`, and the default-to-binding path
  - a configured agent whose transport cannot be created answers `503` naming that agent (`agentId`), because a clear without `agentId` inherits its target

- `test/multi-agent-server.test.ts` (black-box: real server process + two mock agents)
  - boot starts zero agents; the first task starts only the default agent
  - global list, `?agent=` narrowing, and `agentId` on every payload
  - `/clear { agentId }` moves a task onto the second agent without starting the first
  - reads, snapshots, and deletion keep working with agents idle
  - a Root carried by another configured agent is returned by bootstrap as metadata without resolving or rebinding

### Agent coordinates and labels

- `test/agent-coordinate.test.ts` (pure parse and rescue, no server)
  - the colon is the only marker: a configured prefix is a coordinate and the
    suffix keeps consecutive spaces, TAB, full-width spaces, a trailing space,
    and a literal backslash; `~/repo`, `/tmp/a:b`, `:~/repo`, `./agent:x`, an
    unknown prefix, and a case variant are one path
  - `notes:2026` is a path until an agent named `notes` exists, then a
    coordinate; `./notes:2026` stays a path either way
  - an empty coordinate suffix previews the task directory (`copilot:~/work`),
    the same directory the bare preview shows, so the preview never hides the
    directory a submission chooses
  - the rescue names the configured default unless it is the failed target, and
    yields nothing when the default is absent or failed (PATH presence is never
    consulted)

- `test/task-topology.test.ts` (the current task's parent reference)
  - an activation hint (parent id + its binding, or a known absence) settles
    the reference with zero requests; the shared list is never read for this
  - without a hint the task's own link read supplies the parent and the parent
    read supplies its binding; a read issued for a task the client has left
    cannot fill the new task's reference
  - a settled parent is updated directly by its events
  - no parent, a parent without a binding, and "not looked up yet" are three
    distinct answers
  - the list-arrival flag still distinguishes not-loaded from loaded-and-empty
    for row labels; a list from an older connection generation is discarded
  - entry labels are baseline-relative to the current task (same agent → none,
    other agent → its id, no baseline → all); a null binding never prints one
  - concurrent list callers in one generation share one request

- `test/task-ref-marks.test.ts` (one reference per Task, four states)
  - a live reference is completely unmarked (no strike, no appended name, no
    screen-reader note), and no row ever carries a state of its own
  - a rename strikes the name the row recorded and appends the current one,
    with a `(renamed)` note; a rename back to the old name removes every part
    of the mark again; several renames show only the latest name
  - an exited reference is struck with an `(exited)` note and appends nothing;
    an exit after a rename drops the appended name (exited wins over renamed)
  - nothing is marked before a list arrives: the reference stays live-looking
    (unknown), and a delete learned without a list is still no claim; a failed
    read and a list from an older connection generation leave it unmarked
  - a listed task is marked after its `task_deleted`, and a list read issued
    before the delete cannot resurrect it; a listed task without a title is
    neither exited nor renamed
  - a live row resolves its target from `targetTaskId` (not the row's own
    `taskId`) and is marked when that other task is deleted while the client
    views the parent
  - a task this client saw created after the applied snapshot (or before a
    later, still-older one) is never marked; a create event without a title
    keeps the listed one, and a create announced after the list marked its
    reference exited clears that mark again (driven through `handleEvent`,
    the path every creation initiator now feeds)
  - rows rendered before the boot list read are re-evaluated when it arrives
  - `task_title_updated` refreshes a row that names a Task the client is not
    viewing, and applies to a row rendered after it; the current Task's header
    is untouched by another Task's rename
  - each reference of a collaboration row is judged on its own id on every
    copy, including the supervisor projection (the LCA, which is neither side):
    one side's rename or exit never marks the other; the live envelope marks
    the same references its replayed copy does
  - both sides of a cancellation row mark the other Task, and the source side
    marks both of its references by id
  - a row whose raw labels are missing, or whose reference does not sit at its
    anchored edge, is left fully unmarked rather than guessed
  - an adversarial title matrix (equal labels, a label containing ` sent `,
    quotes, backslashes, newlines, tabs, a full-width space, a label that is
    `sent`/`cancelled`, ids that disagree with the title) is either placed
    exactly at its anchored edge or not placed at all
- `test/collaboration-message.test.ts` (one collaboration row, three consumers)
  - the title is built from the raw labels, shell-quoting when needed
  - the persisted payload and the wire envelope carry the same title, body, and
    both raw labels, spelled out field by field

- `test/api-module.test.ts` (request building)
  - `createTask`/`clearTask` send a named `agentId`, omit it for `null` or an
    omitted option, and refuse an empty string locally before any request

- `test/slash-tree.test.ts` (`resolvePath` raw remainder)
  - `rawRemainder` keeps the argument byte for byte (trailing space, TAB,
    interior double spaces, full-width space, a degraded token) while
    `tailQuery` stays token-joined: the two answer different questions and a
    node's field reads only the raw one

- `test/agent-status-bar.test.ts` (DOM cwd field)
  - no prefix while the parent reference is unresolved, and none for a
    single-agent deployment (byte-identical text and tooltip, no agent node)
  - the agent is folded into the cwd field (`copilot:/work/child`) only when it
    differs from the parent's binding; the title names both, and the coordinate
    prefix stays outside the truncating tail
  - a task without a parent (or with an unbound one) is compared against the
    configured default and says so in the title; when the activation carried no
    parent hint the task's own link read supplies it; a task matching a
    non-default parent still draws nothing
  - an unbound current task draws nothing; a parent rotation repaints without
    navigation and removes the coordinate once the parent matches

- `test/agent-hint.test.ts` (real menu pipeline for `+`, `/new`, `/clear`)
  - no input produces an agent row (a bare `<id>:` label) on any of the three
    entries; path rows keep their order and the submit row its default selection
  - all three end with one non-selectable hint line naming the configured
    agents and the syntax once; the example is an agent the task is not running
    on (first configured when the binding is unknown)
  - the hint disappears once a coordinate is typed, with a single configured
    agent (menu byte-identical to before), and under a `(none)` placeholder
  - `buildCandidates` appends a field's trailing row last, except under a
    loading/error/`(none)`/`(no match)` placeholder
  - the hint's example, typed verbatim, previews as that coordinate and the
    request binds that agent; `/clear` and `/new` filter recent paths by the
    coordinate's suffix and send the agent with the directory; a suffix with a
    TAB or double space keeps its bytes

- `test/agent-coordinate-entries.test.ts` (`+`, `/new`, `/clear` payloads)
  - `/clear` sends the coordinate's agent and raw cwd; `/new` and `+` send the
    task directory for an empty suffix (the same directory a bare create uses)
    and the raw cwd otherwise
  - all three project the same `(agent, cwd)` for the same coordinate, including
    an empty suffix: the directory the task runs in, stated on the wire by every
    entry
  - an unconfigured prefix carries no `agentId` and resolves as a path; a
    configured `notes` prefix reads as a coordinate; a missing directory reports
    the raw value and never claims "not configured"
  - a 503 start failure appends `/clear <default>:<raw-cwd>` — the configured
    default unless it is the failed target (then nothing, and never a PATH-based
    next-best), keeping spaces in the cwd; a 400 unconfigured agent appends
    nothing
  - the exclusion uses the agent the server says it tried (`agentId` in the 503
    body), not the caller's guess: an unbound task, a task whose binding left the
    configuration, and an explicit coordinate all pointed at the default failing
    (`agentId: pi`) produce no rescue onto `pi`; a failing non-default target
    (`agentId: copilot`) still produces `/clear pi:<cwd>`
  - `ApiError` lifts that `agentId` out of the body (and leaves it `null` when
    the body names none)
  - the picker's action row and Enter submit the same `(agent, cwd)` projection
    for `/new` and `/clear`; `/clear <agent>:` states the task directory
  - the fidelity boundary: `copilot:~/a ` equals `copilot:~/a`, `copilot: `
    equals `copilot:`, and interior double spaces survive
  - a late 503 reports the agent and directory captured at submission, not the
    task the view moved to while the request was pending
  - a superseded bootstrap response installs no agent directory

### ACP bridge and backend orchestration

- `test/bridge-agent-image.test.ts`
  - an agent image chunk leaves the transport as an `agent_image` event carrying the agent's block; one image per chunk
  - an image inside a thought chunk is still dropped, and a text chunk is unchanged

- `test/agent-image-store.test.ts`
  - an inline image is written to the shared attachment layout with a row and an unsigned base path; the wire's mime claim is ignored in favour of the content
  - dimensions come from the bytes (PNG, GIF, JPEG and WebP alike), the row goes
    with the task, and a second image is named in sequence
  - a WebP is stored with its dimensions, so the thumbnail reserves its layout
    box before the bytes load
  - an image above `limits.image_upload`, a payload that is not a storable image container, an empty/malformed payload, and a file-write failure each become visible `[image omitted: …]` text with no file and no row

- `test/image-info.test.ts`
  - one byte reading yields both facts: PNG, GIF, JPEG (baseline and progressive
    SOF2) and all three WebP chunk layouts (`VP8 `, `VP8L`, `VP8X`) return their
    MIME and pixel size; a zero-sized header keeps the MIME and drops the size
  - formats the library measures but this app does not serve (BMP, AVIF, SVG
    text) return null, as do bytes no container claims
  - a matching signature is not enough: a PNG without IHDR, a lossless JPEG
    (SOF3, which no browser renders) and a bare two-byte JPEG SOI prefix all
    return null, so nothing is stored for a picture the client cannot decode

- `test/tool-result-images.test.ts` (the normal ACP path)
  - an image content block in a `tool_call_update` (bare or wrapped in
    `content`) is written to the shared attachment layout with a row, its
    server-measured dimensions, and an unsigned descriptor; the persisted event
    and the live broadcast carry no base64 and keep the surrounding text; the
    wire's mime claim is ignored
  - an image that exists only in `_meta` is not stored: no row, no payload in
    the row, and `_meta` itself is dropped from the stored item
  - a `_meta` nested 2000 and 5000 levels deep does not cost the event: it is
    stored and broadcast, and the slot (with the payload inside it) is not
    persisted
  - an item whose rewrite fails becomes a visible placeholder (its payload is
    dropped, never passed through) while its siblings are still stored
  - an item no reader can render (an `audio` block, a text array) is dropped,
    and its renderable siblings are kept
  - an inbound image descriptor is dropped (it is our stored form, not a wire
    shape), so a forged cross-task reference is never persisted; a descriptor
    ingest produced still classifies as the image shape
  - a persisted item carries exactly the fields the renderer reads: text, diff
    (including `oldText: null`), terminal and image keep their canonical shape,
    and an extension field on a text block (`vendorExtra`) is not persisted
  - a failed attachment count only affects naming: the pictures are still stored
  - refusals: above `limits.image_upload` and not a storable image container
    each become visible `[image omitted: …]` text with no file and no row;
    successive images are named in order and a text-only update is untouched
  - a stored tool image invalidates the task's cached label map, so a later
    event naming its path renders `agent-image-N` instead of the UUID path

- `test/tool-result-images-legacy-row.test.ts` (a row written before the rule)
  - a `tool_call_update` written straight to the store with a bare inline image
    projects as `unknown` (`content_shape`) with no text or field, contributes
    no text to the frontend extractor, and renders no thumbnail and no payload
    when the stored rows are replayed — the shape is not a compatibility target,
    so nothing turns it back into a picture or echoes its bytes

- `test/tool-result-images-sse.test.ts` (real `SseManager` frame)
  - an update carrying the same image in `content` and `rawOutput` writes a
    frame without its base64: `content` gets the descriptor, while `rawOutput`
    keeps its shape and every other field with `data` emptied
  - an image nested in an image block's `_meta` (any depth) is emptied too, not
    only the outer block's `data`
  - a `content` wrapper's own `_meta` is dropped, so the image inside it is
    neither stored nor carried by SQLite or the frame
  - an item whose shape hides an image (a text array under `content`) is dropped
    whole: the event is still stored and broadcast, `content` is empty, and
    neither SQLite nor the frame carries the payload
  - a payload inside `annotations._meta` reaches neither SQLite nor the frame:
    the item is rebuilt from its rendered fields, so the slot is not persisted
  - with the attachments table unavailable (the count or one insert throws), the
    event and the frame still go out, every block degrades to visible
    `[image omitted: …]` text, and neither SQLite nor the frame carries a
    payload; a failed insert degrades only its own block and its sibling is
    still stored
  - cloning keeps a JSON `__proto__` key as an own property (`JSON.stringify`
    still sees it) while leaving unrelated fields untouched

- `test/tool-result-images-path.test.ts` (temporary shim)
  - all three markers (`image_id: sha256:…`, `saved_to:` absolute path,
    `image_generation` title) copy the file, verify its sha256, record a row and
    append the descriptor; the tool's text and its own file survive
  - refusals: sha256 mismatch, non-image magic bytes, above the limit,
    unreadable path, and any missing marker each do nothing; identical bytes
    are stored once and a later update reuses that row
  - the recovered image invalidates the task's cached label map when it inserts
    a row; a content-hash duplicate reuses the existing row and does not
    invalidate again
  - delete with `src/agent-compatibility/copilot-image-path.ts`

- `test/tool-result-images-render.test.ts`
  - a tool card renders `.tc-images img.tc-image` from the stored path, before
    the output disclosure, from the same helper live streaming and replay use
    (identical DOM), and the thumbnail opens the shared lightbox
  - an explicit `content: []` removes the thumbnails on both live and replay
    paths, while an update that omits `content` keeps them

- `test/bridge.test.ts`
  - prompt success / failure / cancellation
  - silent prompt buffering for compact summarization
  - permission request resolution ordering
  - targeted cancellation of pending permission requests
  - config-option update return path
  - ACP task update event translation, including live-only rawOutput forwarding
  - available_commands_update translation
  - ACP text file read/write callbacks

- `test/bridge-session-restore.test.ts`
  - execution-lifetime restore (resume-only, load-only, both), config reapplication, cache warming
  - a session update from an execution whose generation was replaced emits nothing; a session that never became current in this process emits nothing either
  - a warm-cache or stored-config response that arrives after its execution was replaced is discarded and never cached; a restore refuses to publish its result under a replaced lease
  - a death notice is attributed to the task whose prompt captured the lease, never re-resolved to the current generation, and a `/compact` silent prompt (keyed by ACP session id) writes no task event at all
  - real ACP initialization and restore matrix: resume-only, load-only, both (resume wins), neither (actionable failure with no unadvertised call or fresh session)
  - both restore methods preserve opaque ACP IDs, cwd/MCP injection, task_created payloads, stored config, and cache warming
  - advertised close/delete retirement gates read initialize.agentCapabilities, with delete preferred when both exist
  - resume resource-not-found retains the actionable error without retrying load/new

- `test/bridge-message-limit.test.ts`
  - an ACP tool-result update just over the SDK default 32 MiB line limit reaches the bridge under WebAgent's explicit finite 128 MiB cap

- `test/bridge-grouped-config.test.ts`
  - grouped choices and per-session canonical-to-wire translation across creation, buffered notifications, restore, setters, retirement, and process replacement
  - restore responses without configOptions preserve notification-established codecs; silent sessions update codecs without emitting config events
  - removed model-category ids fail closed while ids never classified as models remain passthrough

- `test/bridge-model-identity.test.ts`
  - pathological pair identities send each selected choice's exact wire value

- `test/bridge-model-category.test.ts`
  - current model classification controls advertised ids; historical classification keeps only removed ids fail-closed, isolated per session

- `test/bridge-flat-config.test.ts`
  - flat canonical payloads are byte-identical at creation, restore, both setters, mapped notifications, and buffered replay

- `test/bridge-config-codec-lifecycle.test.ts`
  - late setter responses cannot repopulate codecs after retirement or process replacement; unexpected process death clears session codecs

- `test/config-options.test.ts`
  - generic grouped-select flattening preserves wire values, leaf order, and metadata independently of model policy

- `test/model-identity.test.ts`
  - value-only, idempotent model identity, regrouping stability, opaque values, and collision rejection

- `test/config-model-persistence.test.ts`
  - legacy identity migration, stale-snapshot normalization, and stable repeated writes/reopen

- `test/field-block.test.ts`
  - `formatFieldBlock` keeps the caller's field order, emits values verbatim
    (no escaping or trimming), applies a fallback only for a falsy value, and
    keeps an empty value when a field has no fallback
  - the task-created body renders `model` / `thinking` as `inherited` for an
    empty or null value while its machine payload keeps `?? null` semantics

- `test/server-event-handler.test.ts`
  - event routing: message_chunk, thought_chunk, tool_call, prompt_done, task_created, error
  - thinking↔assistant buffer flush transitions
  - restoring-task event suppression
  - per-task Agent command snapshot replacement and revision broadcast
  - autopilot auto-approval with allow_once
  - autopilot fallback when no allow_once option exists
  - normal permission_request broadcast in non-autopilot mode
  - turn-origin authorization: a delegated turn answers with `allow_once`, else `allow_always`, and cancels (`cancelled`, no `reject_*` selected, reason `no_allow_option` / `no_options`) when the request offers no allow option; the stored `permission_response` is `from_ref: system`
  - the delegated condition requires a live turn, not just a recorded origin: after the turn ends, the same request prompts
  - a human turn is unchanged: default mode prompts, and our own injected MCP tools have no privilege there
  - the attachment-read interceptor approves only inside the turn the request arrived in; a turn that ended or was superseded before the realpath work finishes produces no `permission_response`
  - directed dispatch closure: only an agent-authored direct parent→child dispatch arms an obligation; a user send, a sibling/child message, an account, and a runtime notice do not
  - settlement predicate: a plain `task_update` settles only an `open|reminder_due|reminder_submitting` record when the target has an active current agent turn; `awaiting_delivery`, a terminal record, and no active turn do not settle and still route to the stored source
  - an `unresolved` record is settled by a late account without retracting its notice, while a `settled` record is never re-settled; with no record the report goes to the current parent and settles nothing
  - the real delivery path: the dispatch is handed to the target's session (opening the record at hand-off, not at prompt resolution), and the account arriving from that same dispatch turn settles it with no reminder issued (this is the assertion that fails if the record opens at turn end or if a timestamp guard is reintroduced)
  - the accepted boundary: a delayed call from an earlier turn arriving while a later turn is current settles the record, and the source receives the earlier turn's content
  - releasing a task purges every record where it is either endpoint and cancels their timers
  - a queued sibling delivery claims the next turn without erasing the open obligation, and the reminder is recovered on the next turn boundary
  - a request-level prompt failure (error event plus `PromptNotDeliveredError` rejection) consumes the transport budget, while an in-turn agent error (error event plus resolution) does not
  - a rejected initial dispatch is retried under the transport bound (backoff, no immediate idle re-drain) and ends in one factual `delivery_failed` notice with `delivery_unavailable` evidence; a resume that keeps failing exhausts the same budget, and a still-queued dispatch produces a non-terminal `still_waiting` advisory rather than a terminal deadline
  - a late callback from a superseded dispatch prompt identity is ignored, including a failing resume and a stale hand-off; the still-waiting and age advisories are non-terminal and cleared on terminal states; an in-flight reminder from a previous epoch is ignored after a coalescing follow-up; a runtime rotation (and bridge restart, including a draining turn) aborts the watchdog and a silence notice requires a live current turn
  - the closing reminder scopes its prohibition to the runtime-injected closing turn, resumes a non-live session before reminding, records no successful reminder on rejection, persists a bounded audit copy of the drained prompt, and logs obligation lifecycle decisions
  - a cancelled turn owes no closing reminder: the ACP `cancelled` stop reason, the cancel intent stamped on the turn before the transport round trip, and the busy cancel marker each end the turn without a `handoff_reminder` or `task_outcome_notice`, and the record stays `open`; a later dispatch that ends without an account still reminds
  - the cancel intent is stamped before `bridge.cancel` awaits: a turn that finishes with an ordinary `end_turn` while the cancel is still in flight is still treated as cancelled (no reminder), and it dies with that turn — the same task's next turn is not cancelled and its unaccounted end reminds normally
  - a closing-reminder turn that is itself cancelled is fenced: no delivered attempt is counted, nothing is re-armed, no `task_outcome_notice` is emitted, no delivered-attempt `handoff_reminder` row is written, and the record returns to `open`; a later dispatch still reminds
  - a runtime notice is delivered as a readable `reason:` / `message:` / `openingMessageId:` block (the text the parent agent actually receives, fenced verbatim), while its machine payload stays in the `task_outcome_notice` event; the live broadcast title and the persisted twin share one `messageId` and one title
  - execution write lease, fail closed: an event stamped with a replaced generation, an unknown generation, another task's lease, no lease at all, or no lease for a task with no ledger entry writes nothing — no buffer, no stored event, no broadcast, no activity timestamp

- `test/obligation-controller.test.ts`
  - awaiting_delivery → open timing, coalescing without a fresh record, +2m/+5m delivered-reminder schedule, transport-bound exhaustion, idle wait, the two-condition settlement predicate and its guards (awaiting_delivery, no active turn, terminal records), stored-source/current-parent routing, the accepted boundary, superseded-dispatch identity, abort and advisory backstops, live-turn requirement, process-local loss on reconstruction, terminal records never watched, and independent watchdog/no-account epochs
  - tri-state submission: a `deferred` outcome leaves `reminder_submitting`, keeps both counters, and retries on a growing bounded backoff; a permanently deferring transport never exhausts the record and emits no notice
  - `execution_rotated` keeps the same record (endpoints, attempts) in a waitable state and never requests a re-dispatch
  - a pre-rotation watchdog with a live turn emits its silence notice (control), and the same steps after a rotation emit none — the rotation ends that watchdog epoch (the retained-callback case is covered by the next bullet)
  - a retry callback that is still queued when the rotation lands is run explicitly after it (the clock keeps callbacks after `clearTimer`): it re-derives from the record, so the old body is never re-enqueued and a closing reminder for the replacement is what it submits
  - a reminder result from the replaced execution (old recovery generation) cannot settle the record, spend an attempt, or re-enqueue the dispatch
  - a cancelled boundary quiets the edge and nothing gets through: hours later there is no closing reminder, no `still_waiting` advisory (neither the queued-dispatch nor the age form), no notice, and no armed deadline at all; a timer that was already armed is dropped at dispatch time, and a rotation is not new work (no timer, no sound)
  - new work on the same edge lifts the silence and restarts the clocks: a fresh dispatch arm + hand-off produces the age advisory only after a full `AGE_ADVISORY_MS` from that arrival, and its closing reminder follows once the target is idle; another task's edge is unaffected and keeps its own reminder
  - a quiet record still settles on a late typed account, then stays silent
  - a cancellation never reopens a terminal record: a settled edge stays `settled` (not `open`/quiet), and a later user message handed to it plus a normal unaccounted end produces no reminder and no notice
  - a hand-off lifts the silence from any state, including `reminder_due` after a rotation (the reminder and the advisory run again); a rotation with no new work leaves the edge quiet with no timer

- `test/turn-slot.test.ts`
  - one turn slot per task, and every real submission assigns its own origin: the interactive route, `/compact`, and the beta quick prompt are `interactive`; a collaboration drain is `delegated` for an all-agent/system batch and `interactive` for a batch containing one user message; a closing reminder is `delegated`. Nothing inherits the previous turn's value
  - every per-path release point of the end-of-turn table closes the slot — `prompt_done`, agent error, drain rejection, reminder `finally`, interactive `finally`, `/compact` `finally`, `resetTaskRuntime` even under `preserveRuntimeState`, and an agent-scoped `clearAgentRuntime` — and the next turn on that task is interactive again; a cancel request alone ends nothing, because only the turn's own terminal does. The task-vanishing row is covered only through its production entries (next bullet), never by calling a private release method
  - a superseded turn's late terminal (including a late `prompt_done`) never releases or re-origins the turn that replaced it
  - the submission protocol is shared and survives awaits: a runtime reservation blocks an interactive submit and vice versa, the slot is held across `ensureResumed`, a submitter that wins during the transport resolution is the only one that reaches `bridge.prompt` (and the loser's delivery stays queued), and a reservation invalidated by a cancel during that await gives up without claiming or submitting
  - admission is one check over every busy source, for both the interactive and the runtime route; `allowBash` opens bash and nothing else, and only an explicit `allowRestoring` waives a restore
  - deletion through its real entries: the REST delete refuses a task mid-turn and leaves the slot alone, a successful delete releases that task's runtime only, a cascading delete releases every removed task, the Root exit route releases the removed subtree plus Root's own runtime, and the empty-task sweep (the only deletion path with no busy gate) releases the row, the slot and the task's runtime
  - bash is not an ACP turn: a delegated turn opens beside a running bash command, and closing it leaves only bash busy

- `test/task-collaboration.test.ts`
  - pure `shouldArm` policy: agent parent→child only; user, system, and non-parent relations never arm

- `test/collaboration-store.test.ts`
  - the collaboration-message emitter reports exactly one post-commit fact for both the normal and in-transaction creation entry points

- `test/task-manager.test.ts`
  - busy has two faces: a restoring task is agent-busy for the gate (`getGateBusyKind`) and idle for rendering (`getBusyKind`); a Root exit under a restoring descendant and a rotation during the restore window are both refused
  - a bash run that ignores `SIGINT` is escalated to `SIGKILL` and the stop waits for close; the handle stays tracked until then; a replaced run's late close is ignored; an agent teardown stops bash-only tasks
  - task title hydration
  - task deletion cleanup
  - inherited config application for new tasks
  - non-inherited mode reset behavior
  - returned config options for inherited tasks
  - assistant / thinking buffer flush behavior
  - busy-kind reporting
  - cwd lookup fallback
  - deduplicated resume (ensureResumed)
  - revisioned Agent command snapshot lifecycle and cleanup
  - authoritative snapshot waits for command discovery during warm-cache restore
  - rotation busy gate: a restoring task is agent-busy, a `/clear` or Root exit that arrives during the restore window is refused, and a store replacement restores nothing under a lease that moved; the compaction turn keeps its controlled internal rotation path
  - rotation transport truncation: dispatch retry ids and unfinished delivery rows are finalized, the obligation record survives as a reminder, and the old dispatch body is never re-sent to the replacement execution
  - a closing reminder with no execution to accept it is deferred: waiting again with neither attempt nor failure consumed and no reminder event recorded
  - reminder turn ownership: a resume failure, a replaced execution and a dead agent each return the task to idle (one `activePrompts` add, one guarded release), and the controller can still submit afterwards
  - a config replay re-authorizes before every request and discards a response that outlived its execution

- `test/execution-rotation.test.ts`
  - implicit owner rotation: Root is taken over only when its owner left configuration, never from an owner that is still configured, and the takeover leaves a transcript line naming both agents
  - a taken-over empty slot materializes through an ordinary resume
  - an implicit rotation truncates the transport and keeps the obligation; the queued delivery row ends as failed (`cleared_before_delivery`) while the debt survives
  - a rotation refused because the target owns a live turn leaves the record, its state, the queued delivery, and the binding untouched
  - each rotated task gets its own empty execution slot: two ordinary tasks rotated under the same agent both succeed alongside the Root's empty slot, and each materializes later
  - the empty slot is recognised by exact equality with the value generated for that task, never by the reserved prefix: a real session id that merely shares the prefix is restored (not materialized) and stays bound
  - a reserved-shape session id that is not this task's own slot is refused at the binding write (create/attach/replace), so no task or binding is stored under a shape the reader would have to guess about

- `test/tree-deletion.test.ts`
  - deleting a parent takes a foreign child with it, and each execution is retired through its own agent's adapter even when both report the same session id
  - a delete or Root exit is refused while a foreign descendant is busy, retiring nothing
  - a Root exit spans every agent, retiring each execution once; the new Root keeps the agent as one empty owner slot
  - exiting Root makes the replacement Root live before the request returns, so the caller lands on a live, idle task; a Root whose agent cannot start is refused before anything is destroyed, leaving the Root, the tree, the events, and the retired executions untouched
  - a child create that was waiting for the tree lock behind an exit fails with `TaskNotFoundError`, because the parent it named (the old Root) is gone
  - two concurrent exits of a shared Root: exactly one replaces it, the other fails with `TaskNotFoundError`, and the replacement it named still exists and was made live once

- `test/runtime-authority.test.ts`
  - one `seq` source across a real A→B rotation (two Stores): the binding's agent and session both move, two client cursors accept every patch, and the post-rotation snapshot is never superseded
  - public reads stay filtered by the caller's agent while the internal read stays global

- `test/store.test.ts`
  - task creation / deletion / updates
  - config persistence, including clearing one column with `null` without touching the others
  - an agent image is stored as an attachment (file + row) and referenced by its own `agent_image` record between the surrounding text blocks; the persisted row carries no base64, the live broadcast is the same reference, and an oversized image becomes visible text with no row
  - title persistence
  - unix-millisecond `last_active_at` for stable ordering
  - each database gets its own UUID Root, stable across reopen and agent keys; it keeps `parent_id = NULL`, preserves a renamed title, and is never adopted into a parent
  - `createTask` creates the Root on the first direct write when absent; omitted/null `parentId` attaches to the Root, and creation only ever produces the Root parentless (a delete may detach a collision survivor to `NULL`)
  - a second agent cannot attach another binding to the shared Root; ownership moves only through the replace path, and `ensureRootTask` is idempotent
  - ensure and rotate leave the Root anchor and cwd stable without ownership assertions
  - ordinary creation of the Root id is rejected; prefix-shaped ids are ordinary tasks
  - delete, tombstone reap, and empty-task GC refuse the Root even when its tombstone flag is corrupted
  - `getParentTask` accepts the global Root for another agent's task
  - reset sentinels cover events, client_ops, attachments, compact summaries, previews, and descendants; Root keeps an ownership binding holding its own `no-execution:<id>` slot and reports the retired execution
  - `replaceRoot` inserts a new Root (new id; same directory, title, model, and agent as an empty slot; no history), moves the `workspace` pointer durably, and deletes the old tree in one transaction; a failure while deleting the old tree (after the in-memory pointer moved) leaves the old Root, its tree, its binding, and both the in-memory and stored pointer as they were; a caller naming a Root that is no longer the Root is refused
  - a shared Root is tombstoned and still replaced, and is reapable once no longer the Root
  - binding write authority: a foreign attach is refused with no fact emitted, detach removes the binding, the same session id from two agents is two different executions, one outermost commit emits one fact per task, and a rolled-back batch is discarded rather than leaked into the next commit
  - deletion follows the task tree: a foreign survivor is deleted with its parent's subtree, a share-backed survivor is tombstoned and re-parented under Root with its history/share/attachment intact, and a Root exit keeps a shared tombstone alive, re-parented under the new Root
  - the empty-task GC still re-parents a surviving child under Root instead of deleting it
  - deleteEmptyTasks age gating
  - hasInterruptedTurn detection
  - migration idempotency

- `test/timestamp-migration.test.ts`
  - legacy string timestamps (with and without milliseconds) convert to unix millis, checked against an independent `Date.parse`
  - per-table row counts and every stored value are preserved (non-vacuous seeds)
  - boundary values (`1970-01-01`, `9999-12-31`, a real leap day) convert without aborting
  - the oldest live DDL shape (`datetime('now')` default, nullable `last_active_at`) converts, with a NULL falling back to the row's `created_at`
  - the real historical `tasks` / `events` DDL layout (quoted table name, out-of-order columns) migrates without rewriting the non-timestamp parts
  - migrated schema text is byte-identical to a freshly created database; every index on a rebuilt table is recreated byte-identically
  - a malformed legacy value (`'0'`, empty, `'now'`, `T` separator, out-of-range, or calendar-invalid such as `2026-02-29` / `24:00:00` / `23:59:60`) aborts the migration with the offending row and rolls back with nothing changed
  - an INTEGER column whose default is still the legacy expression is rebuilt and its values copied through untouched, including `shares.created_at` / `owner_prefs.updated_at` converging from the seconds-aligned default
  - migration is idempotent and leaves an already-INTEGER database untouched
  - the legacy task-only `agent_sessions` index is dropped during a timestamp table rebuild; per-(agent, task) uniqueness remains, while a second agent can no longer attach another binding to an already-bound task
  - `foreign_key_check` / `integrity_check` pass after the rebuild

- `test/daemon.test.ts`
  - subcommand recognition
  - `resolveArgs` config-path resolution
  - PID file round-trip / stale cleanup / corrupt handling
  - supervisor lifecycle: PID file write, SIGTERM exit, SIGHUP restart

### REST API layer

- `test/tasks.test.ts`
  - task CRUD (create / get / delete / list), with server-only id assignment; the Root resolves by its id, and unknown/legacy ids (including the old literal `root`) return 404
  - an in-flight restore is rendered idle (snapshot `runtime.busy` and `/status` `busyKind` are null) while `/clear` and delete still refuse with 409
  - task list is global (`?agent=` narrows); every list entry, task detail, snapshot, bootstrap/create/clear payload, and `task_created` broadcast carries `agentId`; only `/api/v1/config` reports `rootTaskId`, and responses and the SSE `connected` event do not repeat it
  - creating a child of a task carried by another configured agent targets that agent without rotating the parent; when the parent's agent is gone the child is created for `default_agent`
  - `POST /clear { agentId }` rescues a task onto another configured agent, leaves the `agent_rotation` record, and refuses an unconfigured / non-string `agentId`
  - REST and MCP callers cannot choose reserved task ids; bootstrap, clear, compact, and actual/synthetic task_created envelopes preserve Root identity
  - bootstrap materializes the Root as the workspace's first task (attach on a never-bound Root, materialize an exit's empty slot) instead of creating an unrelated task
  - config update (model, mode) and broadcast
  - source filter on task list
  - parent validation: an unknown parent is 400; a parent carried by another agent keeps its own binding
  - gzip compression for events endpoint
  - streaming buffer flush on events endpoint
  - auto-resume of non-live tasks
  - a created task is announced exactly once, by the creation itself: exactly one `task_created` for its id, carrying the request's `clientOpId` plus the title, agent, cwd, parent, and final config the response echoes
  - a `/clear` whose request body window saw a restore start is rejected by the final gate with 409, not by the early check; the test waits for the handler's body-read signal rather than a fixed sleep
  - `/compact` leaves its own rotation line (`kind: agent_rotation`, reason `compact`) before publishing the replacement execution
  - restoring an interrupted turn does not auto-continue it (recovery is user-driven)
  - input validation and bridge-not-ready errors

- `test/routes-config-option.test.ts`
  - config_set broadcasts the value resolved from the response options, not the request encoding

- `test/file-viewer-routes.test.ts`
  - Bearer-gated `info` / `list` and independently HMAC-signed `content`
  - absolute / `~` / `..` / symlink canonicalization, portable HOME display paths, relative/invalid rejection
  - bounded `opendir` scanning, directory order, hidden/special omission, and truncation
  - one-descriptor regular-file validation/sniff/stream flow for directories, FIFOs, and mutable paths
  - 1 MiB inline text preview; complete streamed attachment fallback for larger/unknown content
  - signed URL tamper/retarget rejection, no-store responses, and URL-safe Unicode/space paths

- `test/prompt.test.ts`
  - prompt acceptance and bridge forwarding
  - user-started turns do not arm a directed obligation
  - unsolicited Main-agent buffer flush before the next user turn
  - user_message storage and broadcast
  - last_active_at update and active-prompt tracking
  - busy-state conflict (409) for agent and bash
  - a prompt and a config write that arrive while a restore is parked wait for it (one shared restore) instead of answering 409 "Task is busy"
  - events endpoint: listing, thinking filter, after pagination
  - title generation trigger for untitled tasks
  - image support in prompts
  - input validation and bridge-not-ready errors
  - raw `//` storage/broadcast with canonical `/command` Agent forwarding
  - undeclared Agent command rejection before prompt side effects

- `test/bash.test.ts`
  - bash command execution and event storage / broadcast
  - bash output streaming and completion
  - bash cancel (kill) and idempotent cancel
  - busy-state reporting during bash
  - conflict (409) for concurrent bash
  - non-zero exit code handling
  - input validation and unknown-task errors

- `test/permissions.test.ts`
  - pending permission listing and task scoping
  - permission approval / denial with event storage and broadcast
  - idempotent resolution for already-resolved permissions
  - input validation and bridge-not-ready errors

- `test/ops.test.ts`
  - cancel: active prompt, running bash, idempotent idle task
  - repeated bash cancel escalation (`SIGINT` → `SIGKILL`)
  - local bash cancellation still runs when the agent bridge is unavailable
  - status: idle / busy-agent / busy-bash
  - `GET /api/v1/config` includes the backend's canonical `rootTaskId`
  - bridge-not-ready error handling

- `test/sse.test.ts`
  - SSE client ID generation and tracking
  - global and per-task SSE streams include the current `rootTaskId` in their initial connected event
  - global SSE stream (broadcast from all tasks)
  - per-task SSE stream (task filtering, Last-Event-ID replay)
  - `POST /api/beta/clients/:clientId/visibility` (update, taskId, validation)
  - heartbeat delivery

- `test/quick-prompt.test.ts`
  - task creation and prompt forwarding
  - custom cwd and source=auto marking
  - input validation and bridge-not-ready errors

- `test/messages-route-actions.test.ts`, `test/messages-schema.test.ts`
  - Inbox consume creates a live ACP-backed task and never reloads it
  - Inbox-created tasks reuse `/new` model/reasoning inheritance while resetting mode
  - message cwd inheritance and configured-default fallback
  - sequential idempotency and concurrent consume deduplication
  - ACP creation and local transaction failure preserve the pending message
  - existing-task message move is atomic at the SQLite boundary
  - ack / delete aliases and corresponding SSE broadcasts
  - authoritative pending-count broadcasts after create, dedup supersede, consume, and dismiss

- `test/message-cleanup.test.ts`, `test/sse.test.ts`
  - TTL cleanup broadcasts the post-sweep pending count only when rows change
  - SSE handshakes initialize the count without fetching message bodies
  - global inbox-count events reach task-scoped SSE clients

- `test/task-navigation.test.ts`, `test/service-worker-click.test.ts`
  - Inbox notification consume reuses the current task as inheritance source
  - direct task targets take priority over unresolved message targets
  - task switches require successful busy snapshot hydration; provisional hash is written before detail fetch, then Root canonicalization waits for detail authority
  - hashless startup preserves user-input-first selection and canonical Root fallback
  - Root is addressed by its own `#<id>` deep link like every task, and stays active across a reconnect, including one whose config request fails
  - an SSE `task_deleted` for the current (old) Root follows its `replacedBy` to the new Root even when another task is more recently active (`test/events.test.ts`)
  - foreign `root-*` ids are ordinary 404s and never aliases; fallback selection uses the current connection's scoped task array
  - explicit switches, `/new`, and competing notification consumes use ordered navigation ownership
  - existing-window and cold-start service-worker routing
  - terminal startup intents are cleared; retryable intents survive refresh without in-page duplication

### Frontend state and UI event flow

- `test/inbox-indicator.test.ts`, `test/state.test.ts`, `test/events.test.ts`
  - header renders `>_ (N)`, caps at `9+`, and hides zero
  - the full accessible logo button opens the `/inbox` picker
  - count events update the indicator without adding inbox lifecycle rows to the conversation

- `test/agent-slash-frontend.test.ts`
  - `//` command discovery, filtering, Tab, Click, and input-hint rendering
  - busy-state gating and unavailable-command feedback
  - snapshot/SSE revision ordering, server-restart epoch recovery, and stale-command optimistic rollback
  - `/` root and `/help` discoverability for Agent commands

- `test/state.test.ts`
  - DOM wiring
  - config helpers
  - busy-state button / prompt UI
  - mode-class updates
  - new-task request payloads (with custom cwd)
  - reset-task cleanup (messages, input, title, metadata)
  - global task cancel payloads, including forced cancel when frontend busy state is stale
  - exact canonical Root hash removal; `#root` and stale ordinary `root-*` hashes resolve through the task list; Root identity survives per-task resets and is cleared/re-authorized across connections

- `test/input.test.ts`
  - normal prompt send flow
  - optimistic sends seal prior assistant/thinking streams before the user bubble
  - own-echo guard is released when the prompt request fails
  - `!` bash routing
  - image upload send flow
  - global `Ctrl+C` cancel (smart: skips when text selected)
  - `Ctrl+U` upload
  - `Ctrl+M` mode cycle
  - slash command bypass while busy
  - send-button label switching (↵ vs ^C) while busy
  - not-connected and not-ready warnings

- `test/input-disabled-writes.test.ts` (counts every write to `dom.input.disabled`)
  - busy flapping, `updateModeUI()`, `config_option_update`, and
    `task_runtime_warmed` repaints never write the input
  - entering preview disables exactly once, leaving it enables exactly once,
    and a repaint inside preview writes nothing
  - `resetTaskUI()` and `task_created` restore a preview-disabled input to
    typeable

- `test/input-focus-recovery.test.ts`
  - fully closed stale iOS keyboard focus unlocks after a short textarea tap
  - half-open keyplane unlocks after a same-position status-bar double tap
  - status-bar child content participates in the recovery gesture
  - healthy textarea double-tap selection, long press, movement, cancellation,
    slow taps, and distant taps do not trigger recovery
  - a keyboard that reopens between pointerdown and pointerup is not blurred

- `test/events.test.ts`
  - task creation / busy-state restoration
  - an agent-issued `task_cancel` is produced as one `system_message` row per
    side of the edge, both `kind: "task_cancel"` with `role` and the machine
    fields in `data`, worded from that side (`@source cancelled @target` /
    `Cancelled by @source`). Both rows are broadcast, so the cancel page and the
    cancelled page each render exactly one line, live and from replay
  - a replayed collaboration row anchors its reference from the stored
    `task_id`: the target-side copy strikes the source at the front, the
    source-side copy strikes the target at the end
  - user / assistant / thinking rendering
  - unsolicited Main-agent text and tool calls render while the foreground turn
    stays idle without reopening busy state
  - unsolicited live assistant → thought → assistant ordering after prompt
    completion matches database replay
  - tool-call render and completion state
  - sequence-aware bounded orphan tool-update recovery when live rendering or
    newest-first history pagination sees an update before its DOM host
  - generic bounded/escaped rawOutput inspector with replacement semantics,
    stable output-before-raw ordering across patches, and no persistence
  - task_complete summary rendering (visible, not collapsed) with ✔ icon
  - plan transcript render (collapsed by default), pinned input panel updates,
    status colors/icons, panel show/hide, snapshot/state-patch restoration, and
    cross-turn retention
  - permission request / response / resolution handling
  - bash command / output / completion handling
  - prompt completion rules
  - historical prompt replay cannot override authoritative runtime busy state
  - cancelled-turn cleanup for tool calls and permissions
  - late permission suppression after prompt_done; late tool calls render without
    taking foreground pending/busy ownership
  - cancel acknowledgement timeout transitions to unconfirmed while busy
  - config update application
  - task deletion and title update handling
  - cross-task event filtering
  - Agent command update revision ordering
  - history replay for all major stored event types (incl. task_complete with
    visible summary)
  - active reconnect restores pending tool ownership for terminal cleanup;
    older-history pagination never takes foreground ownership
  - paginated loadHistory (limit param, hasMoreHistory)
  - loadOlderEvents prepend and sentinel removal
  - loadNewEvents incremental sync and orphan cleanup
  - replay queue: dedup on reconnect for user_message (by client operation), tool_call, permission_request, thought_chunk, message_chunk
  - terminal reconciliation waits for an optimistic user echo, restores
    DB-only assistant output, and does not duplicate either the user row or a
    volatile assistant tail already represented by persisted fragments
  - retryUnconfirmedPermissions after reconnect

- `test/mcp-task-host.test.ts`, `test/mcp.test.ts`, `test/mcp-doc-coverage.test.ts`
  - flat task_query index includes thinking rows, range normalization, and bounded Unicode projections
  - an `agent_image` row and a stored tool-image descriptor both project as
    `[image]` instead of an empty or status-only row; a row that still holds an
    inline block is `unknown` and echoes no payload
  - fixed-string search returns a visible matching window and real JSON field path
  - task_read returns batched decoded event data, including large single rows
  - self/parent/child/sibling authorization, tombstone/nonexistent target convergence, unknown sequence rejection
  - omitting the target reads the current Task's own history
  - explicit response_too_large errors report required_bytes without partial rows
  - a successful `task_cancel` writes one `system_message` row per side (each
    with its own `taskId`, `role`, and wording; machine fields in `data`) and
    broadcasts both frames
  - `task_create` announces its child through the same creation broadcast as
    every other initiator, and the envelope carries the id and the title a
    client judges a `Created task @x` reference from
  - MCP registration and documentation expose task_read as the sole raw-history tool

- `test/commands.test.ts`, `test/slash-menu.test.ts`
  - `/new`, `/switch`, `/exit`, `/cancel`, `/rename`
  - `/new` (typed and picker-selected) posts a child create whose parent and
    inheritance source are the launching task, keeping the id as its title
  - typed and menu-clicked `/cancel` remain authoritative escape hatches when frontend busy state is stale
  - `/model`, `/mode`, `/think` query / fuzzy match / ambiguity handling
  - help output and shortcut listing
  - version display in `?` / help command

- `test/connection.test.ts`
  - hash-based task resume
  - last-task auto-resume with the Root fallback, identified by the task list's `isRoot` flag rather than by the id's value
  - new-task creation when no previous task exists
  - reconnect behavior without duplicate history replay
  - one connection epoch, bumped on connect and on disconnect: a config response that arrives after the stream dropped (before any reconnect) installs nothing
  - incremental sync on reconnect when task matches
  - visibility-change sync (hidden→visible)
  - task-switch abort on generation change
  - no-op sync when no new events

### Supporting frontend / backend modules

- `test/root-identity-structure.test.ts`
  - no runtime code under `src/` or `public/js/` compares a task id with the literal `root`
  - no SQL under `src/` matches a task row by the literal `root`

- `test/routes-images-signed.test.ts`
  - signed upload and image retrieval
  - owner Root event history refreshes an expired attachment URL against the current derived task path

- `test/routes.test.ts`
  - static file / API route basics
  - task list flags exactly the store's Root with `isRoot`
  - events endpoint: limit/before pagination, backward-compat without limit
  - attachment upload (`POST /api/v1/tasks/:sid/attachments`): valid PNG, file (non-image) accepted, size limit enforcement, invalid task, JPEG normalization, UTF-8 filename round-trip (busboy `defParamCharset: utf8`), Content-Disposition emitted on download
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

- `test/attachments.test.ts`
  - attach preview: image thumbnail vs file chip rendering, × overlay removal
  - undecodable image preview — HEIC on desktop Chrome/Firefox, which has no
    decoder — degrades to the same file chip on the browser's `error` event or
    a zero-size `load`; a decodable image keeps its `<img>` thumbnail
  - file picker and paste handling for both image and non-image files
  - send-time upload + AbortController cancel; file chip swap to anchor on success

- `test/event-interpreter.test.ts`
  - zero-DOM tool-call extraction: exact multiline `rawInput.code`, independent
    of title/kind and command/path detail, safe rejection of non-string or empty
    code, and unchanged command-before-path precedence
  - a text array under `content` contributes no text: it is not a protocol shape
    (ingest drops it too), so extraction and persistence agree

- `test/render-event.test.ts`
  - shared app/share tool-call source disclosure: initially collapsed, exact
    multiline text on initial and update-only paths, one reused node with open
    state preserved, source retained across content/status/omitted-code updates,
    stable diff → source → output → raw ordering even with late inputs, and
    hostile source rendered literally without injected elements
  - native `<details>` keyboard toggling is unverified (no browser E2E coverage)
  - chat bubble attachment DOM shape: `<img class=user-image>` for a decodable
    image, `<a class=user-file download>` link, `[kind: name]` marker only when
    `path` is missing, thumbnail max-size variables, no upscaling
  - undecodable image (HEIC on desktop Chrome/Firefox, but not on iOS/macOS
    Safari) is replaced **in place** by the same file link on `error` or a
    zero-size `load`; a decodable image gets no link

- `test/attachments-mime.test.ts`, `test/attachment-dispatch.test.ts`
  - sniffed MIME detection (PDF/PNG/ZIP/HEIC magic bytes, UTF-8 text vs binary) and mime → disk extension mapping, including heic/heif/avif/bmp/tiff
  - the display (`INLINE_MIMES`) and upstream (`UPSTREAM_IMAGE_MIMES`) image mime sets hold the same members; a deliberate divergence must update that assertion
  - dispatcher wire format driven by the server-side row, not the client ref: upstream-accepted image mimes inline as base64 image blocks; heic and other unsupported image containers degrade to a hint plus `resource_link`; non-images emit `resource_link` alone
  - fallback text block on row miss, cross-task ref, anchor breach, and disk failure; client-supplied uri/data/path rejection

- `test/api-module.test.ts`
  - frontend API client: all REST endpoints (tasks, prompt, cancel, permissions, bash, files, config, visibility, status)
  - error handling (ApiError, non-JSON responses)

- `test/file-browser.test.ts`, `test/view-command.test.ts`, `test/file-viewer-frontend.test.ts`
  - cwd-relative, absolute, portable Windows/HOME, root, trailing-slash, and local-filter path semantics
  - Enter dispatch: directory drill-down vs direct file open/download
  - existing Markdown pipeline reuse, safe highlighted code/text + batched line numbers, image, attachment fallback, and close lifecycle

- `test/slash-menu.test.ts`
  - Tab fills input without executing (top-level, notify submenu, config submenu)
  - query-dependent `fetchKey` partitioning, monotonic stale/ABA suppression, and separate display/fill values
  - `/view` cwd listing, local filtering, `~`-preserving Tab completion, folder Tab continuation, and one-level drill-down
  - click on submenu item executes the command

- `test/push-frontend.test.ts`
  - `/notify` command: current state, on/off toggling, permission handling
  - visibility reporting on document visibility change

- `test/push-service.test.ts`
  - push_subscriptions store: save, upsert, remove, migration
  - VAPID key generation, loading, and permissions
  - notification formatting (permission_request, prompt_done, bash_done, fallback title)
  - visibility tracking: client registration, per-subscription, global task suppression
  - maybeNotify event-type filtering
  - sendToAll: consecutive failure cleanup, 410 Gone removal, task-based suppression

- `test/doc-coverage.test.ts`
  - staleness guard: asserts all endpoints in routes.ts are documented in docs/api.md

- `test/config.test.ts`
  - multi-agent TOML parsing, `default_agent` membership, lenient root/nested tables, strict agent-entry keys
  - rejects empty `agents`, empty `cmd`, invalid ids, unknown `default_agent`, and a leftover `agent_cmd` (before any startup side effect)
- `test/legacy-database.test.ts`
  - read-only refusal of tasks without the Root `workspace` names (including a pre-UUID literal `root` database) / command-path `agent_key`s with the database bytes and directory unchanged
  - accepts a migrated DB (UUID Root, including a removed-but-valid agent id), ordinary prefix-shaped ids such as `root-forged` / `root-2f3a9c`, and a fresh DB
- `test/server-bootstrap.test.ts`
  - a missing default-agent binary still starts the service: nothing probes PATH at boot, so the failure is the first use's 503 rather than a startup warning

- `test/e2e-watchdog.test.ts` (injected clock, schedule, and stat)
  - without `E2E_RUN_DIR` (unset or empty) no timer is scheduled and no file is
    read
  - a moving heartbeat never triggers shutdown
  - a stale heartbeat triggers shutdown exactly once, cancels the timer, and
    never calls the hook twice
  - a heartbeat that never appears counts as stale after the threshold

- `test/types.test.ts`
  - errorMessage helper (Error, string, object, null)

- `test/atomic-write.test.ts`
  - sync + async API: file appears with full content after write
  - polling-reader race regression: 200 sequential atomic writes never expose an empty / partial file to a concurrent `setImmediate` polling reader
  - mode preservation; tmp file cleanup on rename failure

### Share links

- `test/tokens.test.ts`
  - share token: 24-char base64url shape (144 bits), url-safe alphabet, uniqueness over 1000 draws
  - API token and SSE ticket shapes, alphabet, and uniqueness

- `test/share-store.test.ts`
  - DDL + state machine: preview (`shared_at IS NULL`) → activated (`shared_at` set)
  - `revoked_at` column migration (drop on existing DBs)
  - revoke is hard delete; preview-GC sweep deletes only stale unactivated rows
  - `reapTombstoneIfOrphaned`: no-op while an active share remains, no-op on a
    live task, cascades attachment rows, and repeating it after a successful
    reap is a no-op

- `test/share-sanitize.test.ts` / `test/share-sanitize-secrets.test.ts`
  - secret detection → hard-reject with `event_id` + `rule`
  - path / hostname soft-redact placeholders
  - markdown raw-HTML disabled; URL allowlist applied

- `test/share-routes-preview.test.ts` / `test/share-routes-publish-viewer.test.ts`
  - preview create / read / staleness flag
  - publish freezes snapshot; viewer JSON strips `task_id`
  - publish works for a live task with no execution binding (the gate is the
    task row, not `hasBinding`)
  - 410 when share row is missing or `enabled=false`
  - viewer attachment proxy: serves correct `Content-Type` from `attachments.mime` and emits RFC 5987 `Content-Disposition` with original filename for non-image attachments (regression: iOS Safari `.bin` suffix)

- `test/share-routes-revoke-list-patch.test.ts`
  - DELETE is idempotent; PATCH updates `owner_label` / `display_name`
  - owner share writes authorize on the share row + task existence, never the
    execution binding: revoking the last share of a tombstoned (soft-deleted)
    task reaps the tombstone (row, events, attachment rows, `tasks/<id>` on
    disk), and a tombstoned task's share can still be relabeled
  - a hard-deleted or unknown task still 404s (the wider gate resurrects
    nothing); another task's token still 404s against a tombstone
  - GET `/api/v1/shares` returns owner's live shares

- `test/share-routes-skeleton.test.ts`
  - 410-by-default when `[share] enabled=false`

- `test/share-cleanup.test.ts`
  - 24h preview-GC sweep removes rows with `shared_at IS NULL AND created_at < now-24h`
  - activated rows are never swept

- `test/share-smoke.test.ts`
  - end-to-end: create preview → publish → public fetch → revoke → 410

- `test/share-xss-grep.test.ts`
  - CI gate: viewer source must not contain `innerHTML` / `eval` / inline event handlers

- `test/share-viewer-attachment-rewriter.test.ts`
  - viewer rewrites `/api/v1/tasks/<id>/attachments/<file>` → `/s/<token>/attachments/<file>`
  - rewriter accepts a query-string tail (signed attachment URLs from owner side)

- `test/build-split.test.ts`
  - chunk prune is reachability-aware AND transitive — chunks reachable
    only via chunk → chunk dynamic imports (e.g. hljs lazy load) survive
    a rebuild that retains the previous app bundle

## Playwright E2E Scenarios

### Basic task and messaging flow

- `task-bootstrap.spec.ts`
  - app boots into the canonical Root task and is ready for input

- `bootstrap-concurrency.spec.ts`
  - concurrent clients on the root path converge on this backend's derived
    Root id without posting a new task

- `task-send-message.spec.ts`
  - normal prompt / assistant reply round-trip

- `final-answer-fold.spec.ts`
  - sub-agent results fold while their assistant echo is still streaming for
    both chunk-before-wrapper and wrapper-before-chunk ordering
  - animation-frame observation catches any normal-flow text leak before folding
  - parent narration after the verified result boundary remains in the normal flow
  - an exact echo after nested tool calls still folds with no continuation
  - share viewer coalesces consecutive persisted assistant fragments into one fold

- `task-reload-history.spec.ts`
  - reload restores the same task and replays chat history

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
  - retrying cancel until the agent acknowledges it

- `cancel-after-tool-call.spec.ts`
  - cancellation after a tool call has already started

### Task isolation and cleanup

- `new-task-isolation.spec.ts`
  - creating a new task in one tab does not switch the other tab

- `cross-task-isolation.spec.ts`
  - events from one task do not leak into another

- `task-switch-isolation.spec.ts`
  - switching tasks reloads the right history without message mixing

- `message-notification-cold-start.spec.ts`
  - cold Inbox notification consumes after startup, switches to the new task, cleans the URL, and inherits model configuration

- `inbox-indicator.spec.ts`
  - pending messages update the header count through SSE without adding conversation rows
  - the logo button opens the live Inbox picker and dismissing the message hides the count

- `task-delete-broadcast.spec.ts`
  - deleting the current task disables peer clients correctly
  - other tabs auto-switch away from the deleted task to a remaining one

- `task-delete-command.spec.ts`
  - `/exit` deletes current task and switches to previous
  - a `Created task @x` reference is unmarked while `x` exists, struck after
    `/exit` deletes it, and still struck after a reload (the mark is re-derived,
    not stored); the row itself is never marked
  - a renamed reference strikes the old name and appends the current one, then
    drops the appended name when the renamed task exits; both states survive a
    reload
  - a collaboration row exposes both references; exiting the target strikes only
    its reference and leaves the source reference unmarked, before and after a
    reload

- REST delete (`test/tasks.test.ts`, `test/store.test.ts`)
  - deleting a task cascades to every descendant regardless of owner, retires each affected
    ACP execution through that agent's adapter, and broadcasts one `task_deleted` per removed task
  - a share-backed survivor is tombstoned and re-parented under Root; the empty-task GC keeps a surviving child under Root
  - `getTaskPath` strips the Root anchor; other ids render as path segments
  - creating a task under an unknown parent is rejected with `400`
  - generic deletion rejects the Root; deleting it through the task endpoint exits Root: the whole tree is deleted, the answer and the old Root's `task_deleted` name the new Root as `replacedBy`, the new Root is broadcast as `task_created` and is live before the answer, and no `task_reset` exists
  - `/exit` on Root lands on the Root named by `replacedBy`, even when another task is more recently active (`test/commands.test.ts`)

- `task-clear-command.spec.ts`
  - `/clear` keeps the stable WebAgent task id, history, and cwd; only the
    ACP execution rotates and the task stays available through the API

- `/compact`
  - compact summary is visible as an assistant message, but is deferred until
    the next real user prompt; the new ACP execution stays idle meanwhile
  - the real prompt stores only the user's original text and consumes the
    one-shot handoff

### Resume / reconnect / restart recovery

- `auto-resume-last-task.spec.ts`
  - hashless startup opens the newest task with user input first, then falls back to the Root; existing tasks stay reachable through their stable hash

- `sse-reconnect-recovery.spec.ts`
  - SSE reconnect restores the active task without duplicate replay

- `server-restart-recovery.spec.ts`
  - full server restart restores task context and history through a load-only agent
  - a resume-only agent (advertises `session.resume`, not `loadSession`) is
    restored through `session/resume` with no `session/load`; the transcript is
    rebuilt from local history and the task stays usable afterwards

- `expired-task-recovery.spec.ts`
  - expired hash task falls back to a new task with a warning

### Attachment handling

- `image-upload-reload.spec.ts`
  - uploaded images are sent and restored after reload
  - undecodable images fall back to a file link instead of a broken image

- `image-lightbox.spec.ts`
  - clicking an image opens the lightbox overlay
  - backdrop click and Escape close the lightbox
  - mouse wheel zooms the lightbox image

- `agent-image.spec.ts`
  - an image the agent returns renders as `img.agent-image` with a **signed attachment URL** (never base64), between the text blocks around it, and opens the same lightbox
  - a reload replays it from the stored `agent_image` record: same three-element order, same URL form, and the row carries no bytes; following the signed URL returns the exact PNG

- `tool-result-images.spec.ts`
  - an image block in a tool result renders as a `.tc-images img.tc-image` thumbnail with a **signed attachment URL** (never base64) next to the tool output, and opens the same lightbox; the stored row carries the descriptor
  - a reload replays the thumbnail from the stored row
  - at 390px, a 1600×900 source stays inside the card and the **real scroll container** (`#messages.scrollWidth <= #messages.clientWidth`, not the document element) does not overflow; the box keeps its aspect ratio
  - at a desktop viewport, the same source renders **wider than 600px** (the old fixed 360px ceiling fails this) while staying inside the card's content box and keeping 16:9
  - a 200×100 source is not upscaled past its own pixels

- `tool-result-images-path.spec.ts`
  - a tool result that only names a generated image file (the temporary path adapter) renders the same thumbnail, keeps its text result, and stores the appended descriptor

- `file-attachment-download.spec.ts`
  - non-image attachment renders as a clickable file chip in the user message
  - download from owner side preserves original filename (no `.bin` suffix)

### Slash menu and picker UX

- `slash-menu-escape.spec.ts`
  - Escape dismisses the slash menu

- `slash-menu-switch.spec.ts`
  - slash-menu task switch works from keyboard navigation

- `slash-menu-new-picker.spec.ts`
  - `/new` creates an unnamed child in the current cwd or an explicit cwd, and
    attaches it under the launching task (`/exit` returns there)
  - the `/new` picker leads with the `create task` action row, then the current
    cwd — marked `*` on that row itself — and only then other recent
    directories (a second recent directory makes the order real, not vacuous)
  - `/new <relative>` resolves against the current task cwd on both Enter and
    the picker action row, and the preview names the resolved directory
  - `+<title>` creates a titled child without switching; `@<title> <body>` then
    delivers the first instruction from the same task
  - `+` takes the cwd verbatim after the title (spaces, relative path, `~`) and
    refuses a missing directory or a `/`, `.`, or `..` title
  - bare `+` (and a whitespace-only title) shows the `create task · type a
    title` hint and Enter reports the missing title
  - the `+` picker leads with the action preview (`create '<title>'`, with an
    `at '<cwd>'` clause only when a cwd is given) and lists cwd candidates only
    after the separating space

- `model-picker.spec.ts`
  - `/model` picker changes a flat model choice without changing its label or canonical status-bar tooltip

- `grouped-model-picker.spec.ts`
  - grouped choices flatten in order with group-qualified labels and preserve leaf metadata
  - a grouped model write sends its encoded wire value but returns, persists, and broadcasts the canonical identity
  - the status bar shows only the model-id portion and keeps the full identity in its tooltip

- `slash-menu-think-picker.spec.ts`
  - `/think` picker changes reasoning effort

- `file-viewer.spec.ts`
  - mobile `/view` taps through one folder level and opens Markdown full-screen
  - text over 1 MiB downloads directly and completely without opening the viewer
  - desktop `/view` opens a 55%-up-to-800px right split and close restores chat width

### Mode / config persistence / inheritance / sync

- `mode-cycle-shortcut.spec.ts`
  - `Ctrl+M` cycles Agent → Plan → Autopilot

- `new-task-mode-reset.spec.ts`
  - new tasks do not inherit autopilot mode

- `plan-reload-persistence.spec.ts`
  - plan mode survives reload

- `plan-panel.spec.ts`
  - live ACP plans stay pinned above the input while transcript plans remain
    collapsed
  - active pinned plan recovery after page reload
  - panel collapse state and `/plan hide` / `/plan show`
  - pinned plan survives prompt cancellation until explicitly hidden

- `autopilot-permission.spec.ts`
  - autopilot auto-approves permissions

- `autopilot-multi-permission.spec.ts`
  - autopilot auto-approves multiple permissions in one turn

- `autopilot-reload-persistence.spec.ts`
  - autopilot behavior still works after reload

- `model-reload-persistence.spec.ts`
  - selected model survives reload

- `new-task-model-inherit.spec.ts`
  - new tasks inherit selected model

- `think-reload-persistence.spec.ts`
  - selected reasoning effort survives reload

- `new-task-think-inherit.spec.ts`
  - new tasks inherit selected reasoning effort

- `config-write-failure.spec.ts` (the `PUT` is refused at the network boundary)
  - the `/model` picker reports `err: …` and never prints `Model → …`; the
    status bar returns to the stored model
  - the typed `/model <option>` path has the same contract
  - a `Ctrl+M` mode switch reports the failure and leaves the mode indicator
    rolled back

### E2E harness determinism

- `test/e2e/run-suite.ts` — `npm run test:e2e` wrapper
  - preflight refuses to start on an occupied port
  - frontend build is serialized across runs sharing this worktree
  - signals are forwarded to the Playwright process group (SIGTERM, then
    SIGKILL after 3s)
  - teardown asserts no listener on the run's port, no process carrying the run
    directory, and no orphaned agent; a leftover fails the run

- `test/e2e/determinism-check.ts heartbeat` — SIGKILL the runner mid-turn
  - the server and its agent exit through the stale-heartbeat watchdog and the
    port becomes free (measured against the 5s stale + 2s check bound)

- `test/e2e/determinism-check.ts concurrent` — two suites at once in one
  worktree
  - both finish green with distinct run directories and ports, and each one's
    teardown is clean

- `test/e2e/global-setup.ts`
  - one actionable error when the suite server is not serving this run's data
    directory

- `test/e2e/spawn-server.ts`
  - `writeSpecConfig` builds a one-agent config by default; a spec may pass
    `template` to read a checked-in template instead (port and `data_dir` still
    substituted), which is how `config.single-agent.toml` gives the
    zero-visual-change assertions a genuinely single-agent deployment

### Agent coordinates and labels

- `agent-coordinate.spec.ts` (suite server, real submissions)
  - `+`, `/new`, and `/clear` each deliver a cwd containing consecutive spaces,
    TAB, a full-width space, or a literal backslash byte for byte (request body
    and stored task both checked)
  - an unconfigured `notes:2026` / `copliot:repo` is a path, with no `agentId`
    on the wire, when the directory exists; a missing one fails as a directory
    error and never as an unconfigured agent
  - `mock2:` on `/new` stays in the task directory (and the request states it),
    on `/clear` it keeps the same directory and states it too, and an explicit
    cwd on create lands there; all three entries agree on the semantic
    `(agent, cwd)` projection
  - a child created for `mock2` is bound to it at creation and carries no
    rotation record, while the parent keeps its own binding

- `agent-labels.spec.ts`
  - single-agent template (`test/e2e/config.single-agent.toml`): the cwd field
    has no `<agent>:` prefix and the whole status bar equals a golden built from
    the fixture model and the API's cwd display (not from the renderer); a
    same-agent child changes nothing
  - a task that inherits its agent shows no coordinate; a static deviation
    (mock3 under mock) states `mock3:` with both ids in the title
  - another client rotating the parent onto another agent makes the child state
    its coordinate without this client navigating; a task without a confirmed
    parent binding compares against the default and says so in the title
  - a task that does not deviate keeps its plain path while another task on a
    second agent exists; only the deviating task shows a prefix; deleting it
    returns to a prefix-free field
  - the same database restarted without that agent still states the task's
    confirmed binding, proving the field follows task facts rather than the
    configuration
  - activating a task whose parent runs on another agent costs no request:
    no `GET /tasks/<parentId>` and no extra list, whether the activation came
    from the task detail or from the create broadcast, and the coordinate is
    already correct (the payload carries `parentId` + `parentAgentId`)
  - `/switch` rows state an agent only for rows whose agent differs from the
    current task's; a menu reopened after a switch uses the new baseline, and
    an already-open menu re-renders when the current binding changes
  - a cross-agent `/clear` repaints the new agent's own model and coordinate,
    and the detail read agrees; clearing back removes the coordinate

- `agent-hint.spec.ts` (private servers; real menus, real submissions)
  - no menu shows an agent row for any input (`+` empty/prefix/`./`/closed
    token/settled coordinate, `/new`, `/clear`); the submit row leads, the
    current cwd is the only `*`, and the hint is the last row
  - the hint's example, typed exactly as shown, submits through the real chain
    and the request + stored task bind that agent
  - a typed coordinate keeps its prefix through suffix completion: picking the
    current-cwd path row on `/new mock2:` creates for mock2, and a decorated
    `/clear mock:~/` row sends `agentId` with the directory
  - single-agent template (`config.single-agent.toml`): the three menus carry
    no hint, and `+` is exactly its action row plus the current cwd (API golden)
  - the directory on `/config` is `[{ id }]` only; an agent whose launch command
    is missing from PATH is listed like any other, the menu makes no availability
    claim, and naming it produces the real failure with its own `agentId`
  - menus are asserted only after their settled (non-loading) rows, so a
    negative assertion cannot pass on a placeholder or an older generation
  - at 390px the hint is one line — its first and last characters share a line
    box — and neither the menu nor the page scrolls sideways; the full form
    with its example still fits

- `agent-rescue.spec.ts` (private server, an agent whose command exists in PATH
  but whose process exits immediately)
  - `/clear dead:` and `+nope dead:<dir>` report the real 503 reason and append
    one copyable `/clear mock:<raw cwd>` line (spaces preserved), never a button
  - the failure is a real start failure (the command exists on PATH, the process
    exits), not a faked flag
  - an unconfigured agent through the API is a 400 "not configured"

### Multi-agent runtime

- `agent-scope-reload.spec.ts` (private server, two configured agents)
  - two tasks carried by two different agents; reloading the agent of the task
    a client is *not* watching leaves it connected and idle, adds no reload
    transcript line, keeps the watched task's id and history, and its next
    prompt still round-trips
  - reverse control: reloading the watched task's own agent *does* show the
    busy phase (a `^C` flash caught by a DOM observer, not a poll) and the
    completion line — without it the negative assertions would be vacuous
  - the reloaded task is usable afterwards, with its history intact

- `multi-agent-task.spec.ts` (suite server, two configured agents)
  - `GET /config` and bootstrap name both agents as ids only, with the default
    agent
  - a task created with `agentId: mock2` reports mock2's own defaults (never the
    first option of its lists) and carries no rotation record
  - clearing onto the other agent starts from that agent's environment, and
    clearing back starts from the first agent's defaults rather than restoring
    the abandoned choice
  - creating for an unconfigured agent is a `400` client error

- `multi-agent-collaboration.spec.ts` (suite server, two configured agents)
  - the mock agent creates a child on mock2 and dispatches the contract; mock2 really runs the turn and hands back a typed account, which appears in the parent's transcript live as readable collaboration text titled with the same `@reference sent @reference` form the store persisted
  - the live row and the persisted twin share one title and one body, and a reload replays exactly the same row (the terminal-notice variant of this equality needs operator thresholds of minutes or a request-level transport failure, so it is proven at the integration layer)

- `multi-agent-create.spec.ts` (suite server, two configured agents)
  - the mock agent's real `task_create({ agent: "mock2" })` lands the child on
    mock2: the detail read names mock2, `mock2-model`, the parent link, and a
    `cwd: "."` that resolved against the parent's directory while the parent
    kept its own binding
  - the parent transcript holds exactly one five-field creation record naming
    mock2 and mock2's own `model`/`thinking` (not `inherited`, not mock's
    defaults), and the live UI shows the same row without a reload

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

### Task status bar

- `switch-status-bar.spec.ts`
  - status bar shows model and cwd after switching tasks

### Share links

- `share-publish.spec.ts`
  - `/share` creates a preview; input enters preview mode (textarea disabled, ^P/^C buttons)
  - `^P` button publishes; viewer page (`/s/<token>`) loads under strict CSP with no violations and renders the sanitized event stream
  - public JSON (`/api/v1/shared/<token>/events`) does not leak `task_id`
  - unknown token → HTTP 410

### Screenshots (separate script, not in E2E suite)

- `scripts/screenshots.spec.ts` — run via `npm run screenshots`
  - capture desktop chat, slash menu, permission, and mobile screenshots
  - signs a fresh temporary token for every run, then revokes it and removes the temporary auth data at teardown

## Known Boundary

- WebAgent requests cancellation of ACP prompt work and keeps it visibly
  pending until the agent acknowledges the terminal prompt state. It hard-stops
  pending permission work, local `!` bash work, and title-generation work that
  it owns inside the server runtime.
- Host-level tasks started outside WebAgent's own runtime are not covered by
  this cancel path. That limitation is part ACP integration boundary and part
  current host integration boundary, not just a missing UI hook in this repo.
