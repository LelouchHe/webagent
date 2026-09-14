# Task MCP Control Plane

WebAgent injects a `webagent` MCP server into each compatible ACP session. It
lets an agent inspect and coordinate with tasks in its local task family without
granting access to unrelated tasks.

This document is the tool reference. For the user-facing principles and
examples, see the [Task Manual](task-manual.md) and [Task Examples](task-examples.md).

## Scope and authentication

The server is a Streamable HTTP endpoint at `/mcp`. Each ACP session receives a
fresh capability token; WebAgent sends it as an `Authorization: Bearer` header.
A capability is scoped to one task, is checked before MCP protocol handling, and
can access only that task plus its parent, direct children, and siblings.

The server is additive. It does not replace an agent's own MCP configuration or
native tools.

## How the server reaches the agent

WebAgent does not write an agent's MCP configuration files. It attaches the
server to the ACP session request — `session/new` and `session/load` — through
the protocol's `mcpServers` field, which carries standard transport
descriptions (`stdio`, `http`, `sse`). Putting those definitions to work is the
agent's own MCP implementation. One thing is required of it; the other is only
a preference:

- Required: forward the session's `mcpServers` into its own MCP stack. An agent
  that ignores the field never sees this server.
- Preferred: expose the discovered tools to the model directly instead of behind
  a generic proxy step. WebAgent expresses that with `_meta.directTools: true`
  on the server entry.

The preference is not a requirement. `_meta` is where the protocol reserves
exactly this kind of non-standard note, and it forbids implementations from
assuming anything about the values there, so ignoring the hint is a normal
outcome rather than a failure: the tools still work, they simply surface the way
that agent exposes MCP tools. A presentation preference like this has no
standard field by design — MCP describes what a server offers, not how a client
presents it — so whether tools are registered directly or reached through a
proxy stays the client's or agent's choice.

Neither is required for the session itself: MCP is separate from the rest of the
session. An agent that cannot attach these servers still serves the user
normally — chat, files, permissions, and other tools are unaffected — it simply
has no task tools, and the client does not treat the failure as fatal.

The definitions are per session, which is also why this entry cannot live in a
static MCP configuration file: the endpoint carries a capability token minted
for one task. Which agents put the definitions to use is noted in
[Configuration & Operations](configuration.md#acp-compatible-agents).

## Server instructions

The server advertises a short, generic usage contract through the MCP
`initialize` result:

```text
Use task_create for a direct child, then immediately use task_send to give it its first instruction.
Use task_list to check each reachable Task's workflowStatus, executionState, lastEventAt, and lastAgentActivityAt before deciding to act; workflowStatus is per turn, not a lifecycle terminal, and executionState is the live runtime source.
Use task_send for normal coordination and for continuing or resuming existing Tasks; task_send is not a lifecycle handoff. Use task_update(done|blocked) for typed lifecycle handoffs. A done Task remains available and is not deleted or permanently closed.
task_update(done|blocked) settles the directed obligation when it comes from the current active turn; there is no correlation parameter to copy back.
After dispatching work, end the current turn; do not poll with task_query.
Use task_query and task_get_record only for history recovery, diagnosis, or audit.
Omit task_id to inspect the current Task's persisted history.
```

Clients may surface these instructions through their own discovery UI or tool;
they are not a replacement for the individual tool descriptions.

### Directed dispatch closure

> The runtime supervises and keeps the books; it reports what is true and never
> concludes for the accountable party. See
> [Task semantic authority](implementation-invariants.md#task-semantic-authority).

An accepted **agent-authored direct parent→child dispatch** creates one
directed obligation: a process-local record that the source is awaiting one
account from that target. The runtime decides this at the collaboration-message
boundary with the pure policy
`message.source_actor === "agent" && target.parent_id === source.id`. A user
send (including a human message in the parent session), a sibling or child
message, an account, and a runtime outcome notice never arm an obligation. The
policy is derived from data the rows already carry: there is no classification
field at message creation and no body inspection.

There is **no correlation token**. A target has one direct parent, so the
target's sole record is unambiguous; a plain `task_update(status, body)` decides
settlement from the record and the caller's turn. The record is still not an
intent or expectation control. There is no expectation level, no
per-counterparty ledger, and no separate lifecycle status beyond the existing
`running`/`idle`/`blocked`/`done` report.

**Settlement predicate.** A record settles only when both hold:

1. its state is `open`, `reminder_due`, `reminder_submitting`, or
   `unresolved` — `unresolved` stays settleable so a late account can resolve
   an edge the runtime stopped supervising;
2. the target has an active current agent turn.

It is refused without settling only when the state is `awaiting_delivery` (the
dispatch was never handed over) or `settled` (already resolved), or when no
agent turn is active.

The record opens when the dispatch is **handed to the target's session** (right
after `ensureResumed` and the prompt call), not when the prompt promise
resolves: `bridge.prompt` resolves at the end of the turn, after it emits
`prompt_done`, so a resolution-time open would leave the dispatch turn itself
`awaiting_delivery` and refuse the account that turn produces.

`markDelivered` is that hand-off transition. The prompt promise's resolution is
used only for transport accounting: a resolution clears the submission-failure
streak (`markDispatchSucceeded`), while a request-level rejection
(`PromptNotDeliveredError`, thrown only when the request never reached the
session) consumes the transport budget and returns the record to
`awaiting_delivery` for a bounded retry. A resume failure consumes the same
budget under the attempt's own turn identity. An agent error **inside a
delivered turn** emits an error event but resolves, so it is not a transport
failure.

No timer's expiry decides an outcome. A dispatch still queued at
`DISPATCH_ADVISORY_MS` and a record still without an account at
`AGE_ADVISORY_MS` each produce one non-terminal `still_waiting` advisory per
epoch, with the age and the last observed agent activity; the record is
unchanged and the accountable party decides. The attempt timer only schedules a
retry or a closing prompt; it is the bounded accounting of real events — three
submission failures, or three delivered reminders — that can move a record to
`unresolved`, never a timer's expiry. A coalescing follow-up resets both
advisories and bumps the record's recovery epoch, so an in-flight reminder
submission from the previous epoch is ignored rather than counted against the
refreshed budget.

There is deliberately **no timestamp guard**. The delivery turn is stamped
before the prompt is handed to the bridge, so comparing the turn's start
against the hand-off time would still reject the legitimate dispatch account.
Any future proposal to add such a guard must account for that ordering.

**Routing.** A settleable record is one atomic step: the update is persisted,
the reported `workflow_status` changes, the account message is created to the
**stored source**, the record becomes `settled`, and its timers are cancelled. A
record that exists but is not settleable — an `awaiting_delivery` record or an
already-`settled` one — still routes its account to the stored source without
settling, so a `settled` record is never re-settled and its earlier notice is
never retracted. A late account for an `unresolved` record does settle it,
without retracting the historical notice. With no record for the target, the
update is an ordinary report to the caller's **current parent** and settles
nothing. Routing an existing record to the current parent instead of the stored
source would misroute the account after a tree change.

**Accepted residual.** Settlement is judged from the *current* turn, not from
the turn that produced the content. A call delayed from an earlier turn that
arrives while a later turn is current therefore settles the record and
the source receives the earlier turn's content: a mis-attributed account, not
silence. That is a deliberate boundary, not a bug.

If a dispatch turn ends without an account, the controller submits up to three
delivered closing reminders: one at the turn boundary, one two minutes after
the previous delivered reminder, and one five minutes after that. A rejected
submission never consumes a delivered attempt: it is retried with backoff while
the target is idle, and three consecutive submission failures end the edge with
a **`delivery_failed`** notice — a capability fact ("I could not deliver this
dispatch after N attempts; I have stopped"), never a claim about the target's
work. A rejected **initial** dispatch is retried the same way instead of being
abandoned. When the last delivered reminder completes without an account the
edge becomes `unresolved` and the source receives exactly one **`no_account`**
notice: "no typed account arrived after N delivered reminders; the runtime has
stopped its own attempts; the outcome is unknown." A later account settles the
record without retracting that notice.

Each notice is a `task_outcome_notice` collaboration message with a system
actor, routed target→stored source, carrying `sourceTaskId`, `targetTaskId`,
`openingMessageId`, `openingDeliveryId`, `reason`, `message` (the fact, safe to
show verbatim), and `evidence`. It cannot arm an obligation. The watchdog is
independent: while a target turn with an active record runs, a quiet stretch of
`SILENCE_THRESHOLD_S = 900` emits one heuristic `no_activity` notice per
target×turn, never changes obligation state, and shares no limiter with the
exhaustion notices or the advisories.

Every drained collaboration prompt is also persisted on the target as a
`collaboration_prompt` audit event: the batch message ids plus up to 16 KiB of
the text. A batch larger than that records only a prefix and a
`truncated`/`rawSize` marker, so for an oversized prompt the prefix and its
size are provable, not the full rendered text. The closing reminder persists
its own full text as the `handoff_reminder` system message. Neither record
participates in the agent's control flow.

Obligation state is process-local runtime memory. It is not persisted, does not
survive a restart, and carries no cross-restart recovery promise. Releasing a
task (its deletion path) purges every record where it is either endpoint and
cancels that record's timers, so the map grows only with live edges; this is
hygiene, not deletion recovery.

#### Flow

The invariants above are the contract; the diagrams below show the same
mechanism as states, paths, and exceptions. Each state and transition names the
test that pins it at the end of this subsection.

**Record state machine**

```mermaid
stateDiagram-v2
    [*] --> awaiting_delivery: agent parent→child dispatch posted
    awaiting_delivery --> open: dispatch handed to the target's session
    awaiting_delivery --> awaiting_delivery: submission rejected before hand-off, retry with backoff
    open --> awaiting_delivery: submission rejected after hand-off, transport retry
    open --> unresolved: 3 consecutive submission failures
    reminder_due --> awaiting_delivery: dispatch submission rejected with no delivered reminder
    reminder_due --> unresolved: 3 consecutive submission failures
    open --> reminder_due: current target turn ends without an account
    reminder_due --> reminder_submitting: target idle, closing prompt submitted
    reminder_submitting --> reminder_due: submission rejected (no delivered attempt)
    reminder_submitting --> reminder_due: delivered attempt 1 or 2, schedule +2m / +5m
    reminder_submitting --> unresolved: 3 delivered attempts finished
    reminder_submitting --> unresolved: 3 consecutive submission failures
    open --> settled: task_update from an active current turn
    reminder_due --> settled: task_update from an active current turn
    reminder_submitting --> settled: task_update from an active current turn
    note right of awaiting_delivery
      A report here is refused: routed to the
      stored source, record unchanged.
    end note
    note right of unresolved
      The runtime stopped its own attempts; the
      outcome is unknown. A later account still
      settles it without retracting the notice.
    end note
    note right of settled
      Terminal. A later account is routed to the
      stored source; never re-settled.
    end note
```

**Happy path: dispatch, account, settlement**

```mermaid
sequenceDiagram
    participant S as Source Task
    participant E as CollaborationMessageEmitter
    participant M as TaskManager
    participant R as ObligationController
    participant B as Target bridge
    participant T as Target Task

    S->>E: task_send (agent, direct child)
    E->>E: persist message + delivery (transaction)
    E-->>M: post-commit onCollaborationMessageCreated
    M->>R: shouldArm(message, source, target) is true
    M->>R: arm(): state = awaiting_delivery
    M->>B: drain hands the dispatch prompt to the session
    M->>R: markDelivered(): state = open (content is actionable now)
    T->>T: run the turn
    T->>R: task_update(done|blocked)
    R->>R: settleReport(): state open + active turn = settle
    R->>S: account message to the stored source (workflow_status updated)
    R->>R: state = settled, timers cancelled
```

**Recovery path: three delivered reminders**

```mermaid
sequenceDiagram
    participant R as ObligationController
    participant T as Target Task
    participant S as Source Task

    Note over R,T: record is open and a turn ends without an account
    R->>T: reminder 1 at the turn boundary
    Note over R: delivered attempt 1
    R->>T: reminder 2 at +2 min after the delivered reminder
    Note over R: delivered attempt 2
    R->>T: reminder 3 at +5 min after the delivered reminder
    Note over R: delivered attempt 3
    R->>R: 3 delivered attempts finished, state = unresolved
    R->>S: one task_outcome_notice (reason = no_account)
```

**Failure paths: two separate budgets**

```mermaid
flowchart TD
    subgraph Initial["Initial-delivery budget (dispatch submission)"]
        A0[dispatch armed: awaiting_delivery] -->|handed over| A1[open]
        A0 -->|resume keeps failing| A2[submission-failure count +1]
        A1 -->|submission rejected| A2
        A2 -->|count < 3| A3[return to awaiting_delivery,<br/>requeue and retry with backoff]
        A3 --> A0
        A2 -->|count = 3| A4[unresolved + delivery_failed<br/>evidence delivery_unavailable]
    end
    subgraph Closing["Closing-reminder budget (reminder_due / reminder_submitting)"]
        B1[reminder_due] -->|submission rejected| B2[submission-failure count +1,<br/>no delivered attempt]
        B2 -->|count < 3| B3[retry with backoff, stays reminder_due]
        B3 --> B1
        B2 -->|count = 3| B4[unresolved + delivery_failed<br/>evidence delivery_unavailable]
        B1 -->|submission accepted| B5[deliveredAttempts +1, submission-failure count reset]
        B5 -->|deliveredAttempts < 3| B1
        B5 -->|deliveredAttempts = 3| B6[unresolved + no_account]
    end
    Note[The two budgets are independent: a rejected submission never consumes<br/>a delivered attempt, and a delivered reminder never counts as a failure.]
```

**Watchdog: silence observation, independent of the record**

```mermaid
sequenceDiagram
    participant A as Agent-runtime events
    participant W as Watchdog (per target×turn)
    participant S as Stored source

    Note over W: starts only while the target has a non-terminal record and a running turn
    A->>W: qualifying activity (message/thinking chunk, tool call, plan, permission)
    W->>W: lastAgentActivityAt = now, re-arm timer
    Note over W: 900 s with no qualifying activity
    W->>S: one task_outcome_notice (reason = no_activity)
    Note over W: never changes the record, never reminds the target,<br/>never cancels or retries
    Note over W,S: its limiter epoch is independent from no_account,<br/>so silence cannot suppress the factual outcome
```

**Cases that do not belong on the state diagram**

| Case | What happens |
| --- | --- |
| A user prompt | Starts a turn but arms nothing; the turn can never settle a record. |
| A sibling message | Ordinary delivery; it can claim the target's next turn but never arms and never erases an open record. |
| A message from the target's own child | Ordinary delivery; the relation fails the arming predicate. |
| A cancellation | The current turn's boundary is still a recovery boundary, so a reminder can follow; the record is unaffected. |
| A supersession | A superseded terminal event does not call `onTargetTurnEnded`; the live turn owns the boundary. |
| A session rotation | Delivery and reminder submissions bail while the target is rotating; the record is untouched. |
| A user-originated send from the source's own session | The actor fails the arming predicate; it is seen by the emitter and excluded. |
| A second dispatch from the same source while the record is open | Coalesces onto the same record, refreshes the budgets, and makes the next attempt due at the next turn boundary. |
| A report while `awaiting_delivery` | Refused as settlement; routed to the stored source, record unchanged. |
| A report while no turn is active | Refused as settlement; routed to the stored source. |
| A report after `unresolved` | Settles the record (a late account resolves an edge the runtime stopped supervising); the historical notice is not retracted and the account still reaches the stored source. |
| A report after `settled` | Never re-settles; the account still reaches the stored source. |
| A report from a target with no record | Ordinary report to the caller's current parent; settles nothing. |
| A dispatch never handed over | A resume that keeps failing consumes the transport budget; if nothing retries, a non-terminal `still_waiting` advisory reports that it is still queued and the accountable party decides. |
| A process restart | Obligation state is gone by decision, tasks do not auto-start, and no recovery promise is made. |

**State and transition to test**

| State or transition | Pinned by |
| --- | --- |
| Arming predicate (`shouldArm` true) | `test/task-collaboration.test.ts` "arms only an agent-authored direct parent→child dispatch"; `server-event-handler` "arms a direct parent dispatch and leaves unrelated sends ordinary"; `collaboration-store` "emits exactly one post-commit fact per created message" |
| → `awaiting_delivery` | `obligation-controller` "does not request an account until the source dispatch is accepted" |
| `awaiting_delivery` → `open` (at hand-off) | `obligation-controller` "does not request an account until the source dispatch is accepted"; `server-event-handler` "settles the account from the same dispatch turn through the real delivery path" |
| `awaiting_delivery` → `awaiting_delivery` retry | `obligation-controller` "retries a rejected initial dispatch and bounds the transport failures"; `server-event-handler` "retries a rejected initial dispatch at an idle boundary" |
| `awaiting_delivery` → `unresolved` (transport) | `obligation-controller` "exhausts awaiting_delivery after the transport bound without spending reminders"; `server-event-handler` "emits one delivery_failed notice when initial delivery keeps failing"; `server-event-handler` "ends a dispatch whose resume keeps failing" |
| `awaiting_delivery` advisory | `obligation-controller` "emits a still-waiting advisory for a never-handed-over dispatch" |
| age advisory | `obligation-controller` "emits one age advisory per epoch without changing state" |
| `open` → `reminder_due` | `server-event-handler` "reminds at the dispatch turn boundary and states the closing-only contract" |
| `reminder_due` → `reminder_submitting` | `obligation-controller` "delivers reminders at the turn boundary and at +2m and +5m"; "waits for the target to be idle before submitting" |
| `reminder_submitting` → `reminder_due` (delivered 1 or 2) | `obligation-controller` "delivers reminders at the turn boundary and at +2m and +5m" |
| `reminder_submitting` → `reminder_due` (rejected) | `obligation-controller` "does not consume an attempt on rejection and bounds consecutive failures"; `server-event-handler` "records no successful reminder when the bridge rejects it" |
| `reminder_submitting` → `unresolved` (3 delivered) | `obligation-controller` "declares unresolved and notifies no_account exactly once after the last reminder" |
| `reminder_submitting` → `unresolved` (3 failures) | `obligation-controller` "does not consume an attempt on rejection and bounds consecutive failures" |
| `open`/`reminder_due`/`reminder_submitting` → `settled` | `obligation-controller` "settles the record from an active current turn and routes to the stored source"; `server-event-handler` "settles the record from an active current turn and routes to the stored source" |
| `awaiting_delivery` refusal | `obligation-controller` "does not settle while the record is awaiting_delivery"; `server-event-handler` "does not settle while the record is awaiting_delivery and still routes to the stored source" |
| No active turn refusal | `obligation-controller` "does not settle without an active turn" |
| `unresolved` late settle | `obligation-controller` "a late account settles an unresolved record without retracting the notice" |
| `settled` non-re-settle | `obligation-controller` "settles the record from an active current turn and routes to the stored source" (second call) |
| No record → current parent | `obligation-controller` "routes to the current parent when no record exists" |
| Coalescing | `obligation-controller` "coalesces a same-source follow-up and replaces a terminal record" |
| Accepted residual | `obligation-controller` "accepts a delayed call from an earlier turn while a later turn is current" |
| Watchdog start, activity, silence, single notice | `obligation-controller` "emits one heuristic no_activity notice per target×turn"; "resets the watchdog on qualifying activity and keeps epochs independent"; "never changes obligation state from a silence notice"; "does not start a watchdog without an active obligation"; "does not watch a terminal record" |
| Process-local loss | `obligation-controller` "loses all obligation state when the controller is reconstructed" |
| Release purge | `obligation-controller` "purges records when a task is released, cancelling their timers"; `task-manager` "purges obligation records when a task is released" |

**Real path versus constructed turns.** The settlement assertions that must
prove the real delivery ordering — `awaiting_delivery` opening when the
dispatch is handed to the target's session and the same-turn account settling —
run through the creation boundary and the mock bridge (settlement tests in
`test/server-event-handler.test.ts`, notably "settles the account from the same
dispatch turn through the real delivery path", which emits the account while
the dispatch prompt is still pending). The pre-issuance refusal is also an
integration test: "does not settle while the record is queued awaiting
delivery" keeps the target agent-busy so no prompt is issued, which is the real
`awaiting_delivery` window. The controller-level refusal tests additionally
drive `settleReport` with a constructed active turn; those pin the guard but
cannot catch an ordering bug, which is why the same-turn test exists.

Two rows have no obligation-level test:

- **Supersession** is guarded only by the event handler's current-prompt check
  (`server-event-handler` "keeps the live turn busy when a superseded turn
  completes"); there is no settlement-specific supersession test because the
  controller is never consulted for a superseded turn.
- **Session rotation** is guarded by the `rotatingTasks` checks inside
  `drainCollaborationDeliveries` and `submitObligationReminder`; no test asserts
  record preservation across a rotation, because deletion/rotation recovery is
  out of scope by decision.

The earlier timestamp-guard transition (`startedAt >= deliveredAt`) was removed
by decision and is deliberately absent from these diagrams.


Detailed workflow guidance belongs in
the [Task Manual](task-manual.md) or an on-demand skill.

## Lifecycle at a glance

The MCP surface participates in this loop:

```mermaid
sequenceDiagram
    participant P as Parent Task
    participant C as Child Task

    P->>C: task_create
    P->>C: task_send(Task Contract)
    C->>C: Execute work
    C-->>P: task_update(done|blocked)
    P->>P: Verify contract, result, and evidence
    alt Accepted
        P->>P: Complete its own Task when ready
    else Follow-up needed
        P->>C: task_send(focused follow-up)
        C->>C: Continue work
    else Blocked
        P->>C: task_send(missing decision or input)
        C->>C: Resume work
    end
```

`task_send` does not complete the current Task. A `done` Task remains available
for history and follow-up. Parent Tasks receive direct child handoffs only;
WebAgent does not automatically rebroadcast raw child reports to ancestors.

## Tools

| Tool | Purpose |
| --- | --- |
| `task_list` | List the current task and its locally reachable parent, children, and siblings, each with `workflowStatus`, `executionState`, `lastEventAt`, and `lastAgentActivityAt` for triage. |
| `task_query` | Read a bounded, compact history page for the current task or one visible relative. |
| `task_get_record` | Read one complete persisted history record by task-local sequence. |
| `task_cancel` | Stop the current execution of a child Task while preserving its history. |
| `task_create` | Create a direct child Task with optional execution overrides. Use `task_send` for its first instruction. |
| `task_send` | Send a durable coordination message, including follow-up or resume instructions for an existing Task. Use `task_update` for typed `blocked`/`done` status. |
| `task_update` | Send a typed `blocked` or `done` lifecycle account for the current Task. A plain `(status, body)` call settles the directed obligation when it comes from an active current turn; there is no correlation parameter. This does not delete or permanently close the Task. |

### `task_list`

Takes no arguments and returns the current Task plus every locally reachable
parent, child, and sibling. The whole family gets the same fields, with no
special-casing. Ordering is relation-then-id (`self`, `parent`, `child`,
`sibling`) and is deliberately not status-sorted, so the caller reads the
statuses instead of inheriting a second prioritization policy.

```ts
type McpTaskListItem = {
  id: string;
  title: string;
  relation: "self" | "parent" | "child" | "sibling";
  workflowStatus: "running" | "idle" | "blocked" | "done";
  executionState: "idle" | "agent" | "bash";
  lastEventAt: string | null;
  lastAgentActivityAt: string | null;
};
```

`workflowStatus` uses the same vocabulary as `task_query`'s `workflowStatus`.
It is **per turn, not a lifecycle terminal**: a `done` Task can be woken by a
later message and run again, so `done` means the Task reported complete for that
turn, not that it is finished forever. Use `task_list` to decide whether to act
on a Task; use `task_query` only for history recovery or diagnosis, not to poll.

`executionState` is the live runtime source: `agent` while an ACP turn or a
collaboration delivery is running, `bash` while a user shell command owns the
Task, and `idle` otherwise. It is execution telemetry, not a quality signal, and
it is deliberately separate from `workflowStatus`, which is only the last typed
report.

`lastEventAt` is the `created_at` of the Task's most recent persisted event, any
type — the Task's own activity clock, not its user-visible `last_active_at`.
It uses the same representation as other MCP timestamps: SQLite
`strftime('%Y-%m-%d %H:%M:%f', 'now')` output, for example
`2026-09-13 21:05:03.123`, in **UTC with no timezone marker**. It is `null` when
the Task has no persisted events yet. A stale `lastEventAt` next to
`workflowStatus: "running"` is a **lag signal, not proof of work**: a long
silent tool call can look stale while the Task is still running.

`lastAgentActivityAt` is an ISO-8601 timestamp of the Task's latest qualifying
agent-runtime event (assistant or thinking chunks, tool calls, plans, or
permission requests), or `null` when none has been observed. Unlike
`lastEventAt`, it ignores user and system events, so a running turn with no
agent activity is a silence signal rather than an activity claim.

### `task_query`

All input fields are optional:

```ts
{
  task_id?: string; // Visible target task; current task when omitted
  text?: string;    // Literal search term in underlying stored event data
  cursor?: string;  // Opaque cursor from a prior response
  limit?: number;   // 1–100; defaults to 5
}
```

For provider compatibility, each optional field also accepts `null`, which has
exactly the same meaning as omission. MCP clients should normally omit unused
fields.

#### Provider schema compatibility

Some function-calling providers emit every property in a tool schema even when
fields are optional. Without a nullable alternative, they may invent placeholder
values for `task_id` or `cursor`, causing lookup or pagination failures.

For that reason, every optional `task_query` field also accepts `null`, and the
server treats `null` exactly like omission. The fields remain optional for MCP
clients that already handle the schema correctly.

Without arguments, the tool examines the latest five non-thinking events from
the current task. Normal completion events are omitted, so a returned page may
contain fewer records. A query selects the latest matching events and returns
that page in chronological order. `nextCursor`, when present, reads older
events. Search is literal database matching against the original stored
payload; it is not a semantic or full-text query.

The current Task's persisted history remains available after context
compaction or `clear`, so omitting `task_id` is also the way to recover earlier
context for the current Task. The history itself is not compacted by
`task_query`: that tool only returns a compact projection. `/compact` changes
the active model context, while `/clear` rotates the active execution and keeps
the Task's history. These tools expose stored events; they do not restore
hidden reasoning or automatically rebuild the previous model context.

```ts
{
  workflowStatus: "running" | "idle" | "blocked" | "done";
  records: CompactTaskHistoryRecord[];
  hasMore: boolean;
  nextCursor?: string;
}

type CompactTaskHistoryRecord = {
  seq: number;
  type: string;
  createdAt: string;
  text: string;
  truncated?: true;
  rawSize?: number;
};
```

`seq` is the event's stable sequence within its task. It is included as an
identity/reference value; pass it to `task_get_record` when the compact
projection is not enough.

### Compact history records

Task history remains stored as raw JSON events in SQLite. `task_query` does not
return that `data` field: tool inputs and results can contain entire source
files, diffs, or command output and would consume an agent's context budget.
Instead, it deterministically extracts a small plain-text representation based
on the event type. It does not invoke an LLM or alter the stored event.

| Event type | Included information |
| --- | --- |
| `user_message`, `assistant_message` | Message text and attachment count where applicable. |
| `tool_call` | Tool title, kind, and a bounded command or path when available. |
| `tool_call_update` | Tool title, status, bounded result text, and a bounded command or path when available. |
| `plan` | Each plan entry's status and content. |
| `permission_request`, `permission_response` | Permission title and choices, or allow/deny outcome. |
| `error` | Error message. |
| `system_message` | Message title and optional body; collaboration/task details use both fields. |
| `task_update`, `task_cancel`, `message` | Collaboration route/status and message body. |
| `bash_command`, `bash_result` | Command, exit code/signal, and bounded output. |
| `prompt_done` | Non-normal stop reasons only; ordinary `end_turn` is omitted as noise. |

Unknown event types and malformed payloads remain visible as a short notice
with `rawSize`; they are not silently discarded. Thinking events are excluded.

Text is capped at 800 characters per record; embedded tool result and command
or shell-output excerpts are capped at 400 characters before being placed in
the record. When text is shortened, `truncated: true` is set and `rawSize`
reports the UTF-8 size of the original event payload. A tool input such as a
large edit diff may be represented only by its title and target path even when
the resulting text itself does not need truncation.

This compact view is intended for normal task coordination. Raw events are
retained for the browser transcript and explicit diagnostic lookup; they are not
sent through `task_query`.

### `task_get_record`

Use this tool to expand exactly one `seq` returned by `task_query`:

```ts
{
  task_id?: string; // Visible target task; current task when omitted
  seq: number;      // Positive event sequence within that task
}
```

The response contains the complete WebAgent-persisted event row:

```ts
{
  taskId: string;
  record: {
    id: number;
    taskId: string;
    seq: number;
    type: string;
    data: string;      // Exact JSON string stored in SQLite
    fromRef: string;   // Persistence origin marker
    createdAt: string;
  };
}
```

`data` is not compacted, parsed, summarized, or rewritten. This is the complete
stored event record, not necessarily the complete original ACP notification.
The `fromRef` field is persistence metadata, not an ACP field; clients should
treat it as an opaque string.

The tool reads one record per call and does not support bulk sequence lookup, so
full payload expansion remains explicit and bounded by the caller's choice.

### `task_cancel`

Stop the current execution of a child Task without deleting or retiring the
Task. The Task and its history remain available. The request records a required
reason and uses the existing asynchronous cancellation result states:
`idle`, `cancelling`, `cancelled`, or `superseded`.

The MCP caller may cancel only a direct child Task. Cancellation does not
change the Task into `done`; normal completion uses `task_update` instead. The
configured cancellation safety timeout is shared with the REST cancel path;
when the Agent has not acknowledged cancellation, the result remains
`cancelling` and the runtime exposes the unconfirmed state rather than claiming
that execution has stopped.

### `task_create`

Create a direct child Task immediately. The request includes a required title
plus optional `cwd`, `model`, and `thinking` overrides. Omitted execution
options inherit from the current Task. The result contains the new Task ID.
This creates an Agent-delegated Task: immediately send its first Task Contract
with `task_send`, including the goal, scope, completion criteria, and report
format, then end the dispatch turn without polling. Failures return an MCP tool
error rather than an empty ID.

### `task_send`

Send a durable coordination message to another Task. Use it for instructions,
questions, findings, progress, decisions, and focused follow-up, including
continuing a Task marked `blocked` or `done`.

`task_send` is not a lifecycle handoff and does not complete the current Task.
Use `task_update(done|blocked)` when the current assignment is complete or
cannot continue. The recipient receives the full message body; important
findings are not discarded because the message is coordination.

### `task_update`

Submit a typed lifecycle account for the current Task:

```ts
task_update(status: "blocked" | "done", body: string)
```

- `blocked`: explain the missing input or decision and how the Task can resume;
- `done`: provide the result, completion evidence, limitations, and useful next
  step.

There is **no new parameter**. The runtime identifies the target's sole directed
obligation itself and settles it only from an active current turn: the record
must be `open`, `reminder_due`, `reminder_submitting`, or `unresolved`, and the
target must have an active agent turn. A settleable call is one atomic step that
records the update, changes the reported status, creates the account to the
**stored source**, and cancels the record's timers.

When a record exists but those conditions do not hold — `awaiting_delivery`, an
already-`settled` record, or no active turn — the update is still recorded and
routed to the stored source, without settling. When no record
exists for the target, the update is an ordinary report to the current parent
and settles nothing. A terminal record is never re-settled and its earlier
`no_account` notice is never retracted.

There is deliberately no timestamp guard, because the delivery turn is stamped
before `bridge.prompt` is issued while the record opens only when it resolves;
comparing the two would reject the legitimate dispatch account.

Because settlement is judged from the current turn, a call delayed from an
earlier turn that arrives while a later turn is current settles the
record and the source receives the earlier turn's content. That is an accepted
boundary, not a bug.

A `done` account is a result submission, not proof that the parent has accepted
it. The parent or verifier checks the original Task Contract and may accept it,
request focused follow-up with `task_send`, or keep it blocked. The Task and its
history remain available after either status.
