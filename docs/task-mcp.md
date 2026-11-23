# Task MCP Control Plane

WebAgent injects a `lelouchhe_webagent` MCP server into each compatible ACP
session. The name is a client-visible label (some clients namespace tools as
`mcp__<name>__<tool>`); it is not persisted and carries no identity. It
lets an agent inspect and coordinate with tasks in its local task family without
granting access to unrelated tasks.

This document is the reference for what the code does not say to the agent:
authentication, transport, result shapes, limits, errors, and the rows each
call records. Each fact has one home:

| Fact | Home |
| --- | --- |
| What each tool and parameter does, as the agent sees it | tool and parameter descriptions in [`src/mcp/tools.ts`](../src/mcp/tools.ts) and [`src/mcp/task-create-description.ts`](../src/mcp/task-create-description.ts) |
| The cross-tool model advertised at `initialize` | `MCP_SERVER_INSTRUCTIONS` in [`src/mcp/server.ts`](../src/mcp/server.ts) |
| Host ownership and the implementation boundary behind task commands | [Multi-host task operations](multi-host.md) |
| Accounts, reminders, notices, and settlement | [Task Obligations](task-obligations.md) |
| How to use Tasks well | [Task Manual](task-manual.md) and [Task Examples](task-examples.md) |

## Scope and authentication

The server is a Streamable HTTP endpoint at `/mcp`. Each ACP session receives a
fresh capability token; WebAgent sends it as an `Authorization: Bearer` header.
A capability names one task **and** the agent whose execution it belongs to, and
is checked before MCP protocol handling. It can access only that task plus its
parent and direct children — the family check is the cross-agent read boundary,
so a capability never widens into another agent's tasks or sideways to a
sibling.

A token starts **initializing** while the session that carries it is still being
created: the MCP handshake and tool discovery work (a real agent connects from
inside `session/new`), but every business tool answers `initializing`. It is
promoted only after the task's binding commits, and it is pinned to that
commit's execution generation. An authenticated request therefore still fails
once its task has rotated, because the token names the generation it was minted
for rather than whatever the task is running now. Rotation, deletion, and a Root
reset revoke the token.

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

### The server name

The name on the session entry (`MCP_SERVER_NAME`, `lelouchhe_webagent`) is a
client-visible label, not an internal id. Some clients namespace a server's
tools by it (`mcp__<name>__<tool>`) and reject generic names — Claude Code
refuses `webagent` — which is why the vendor prefix is spelled out. The value is
never persisted: every session entry and every MCP `initialize` response is
built from that constant.

## Server instructions

The server advertises the cross-tool model (reach, delivery, accounts, history)
through the MCP `initialize` result. It states facts only: per-tool effects live
in tool descriptions, parameter meanings in parameter descriptions, and usage
policy in skills.

The text is `MCP_SERVER_INSTRUCTIONS` in
[`src/mcp/server.ts`](../src/mcp/server.ts); it is not copied here so the two
cannot drift.

Clients may surface these instructions through their own discovery UI or tool;
they are not a replacement for the individual tool descriptions.

## Tools

### `task_list`

Takes no arguments and returns the current Task plus its parent and direct
children. The whole family gets the same fields, with no special-casing.
Ordering is relation-then-id (`self`, `parent`, `child`) and is deliberately not
status-sorted, so the caller reads the statuses instead of inheriting a second
prioritization policy. A sibling is not visible.

```ts
type TaskListItem = {
  id: string;
  title: string;
  relation: "self" | "parent" | "child";
  workflowStatus: "running" | "idle" | "waiting" | "blocked" | "done";
  executionState: "idle" | "agent" | "bash";
  lastEventAt: string | null;
  lastAgentActivityAt: string | null;
};
```

`workflowStatus` uses the same vocabulary as `task_list`: `running` while a turn runs, `idle` after it ended without a typed report, `waiting` when the Task says its work continues without the requester, and `blocked`/`done` when it handed the ball back. `task_query` returns only `task_id`, `max_seq`, and flat event rows.
It is **per turn, not a lifecycle terminal**: a `done` Task can be woken by a
later message and run again, so `done` means the Task reported complete for that
turn, not that it is finished forever.

`executionState` is the live runtime source: `agent` while an ACP turn or a
collaboration delivery is running, `bash` while a user shell command owns the
Task, and `idle` otherwise. It is execution telemetry, not a quality signal, and
it is deliberately separate from `workflowStatus`, which is only the last typed
report.

`lastEventAt` is the `created_at` of the Task's most recent persisted event, any
type — the Task's own activity clock, not its user-visible `last_active_at`.
It is an ISO-8601 timestamp with an explicit `Z`, for example
`2026-09-13T21:05:03.123Z`. It is `null` when the Task has no persisted events
yet. A stale `lastEventAt` next to `workflowStatus: "running"` is a **lag
signal, not proof of work**: a long silent tool call can look stale while the
Task is still running.

`lastAgentActivityAt` is an ISO-8601 timestamp of the Task's latest qualifying
agent-runtime event (assistant or thinking chunks, tool calls, plans, or
permission requests), or `null` when none has been observed. Unlike
`lastEventAt`, it ignores user and system events, so a running turn with no
agent activity is a silence signal rather than an activity claim.

### `task_query`

List a flat index of persisted event rows for the current Task or one visible
relative. Thinking rows are included. The response is deliberately an index,
not a payload expansion; use `task_read` for exact event data.

```ts
{
  task_id?: string; // visible target; current task when omitted
  text?: string; // fixed string search; ASCII case folding only
  range?: [number, number]; // inclusive seq range; negative indexes use max_seq
}
```

Optional fields accept `null` as omission. With no range, all rows are
returned. Start recovery with `range: [-50, -1]`, then request older absolute
ranges. Ranges are normalized in either order and clamped to `[1, max_seq]`;
`[1, 0]` therefore returns only sequence 1 and must not be used as a
continuation request.

```ts
{
  task_id: string;
  max_seq: number;
  rows: Row[];
}

type Row = {
  seq: number;
  type: string;
  bytes: number;
  group?: string;
  title?: string;
  field?: string;
  text?: string;
  content_shape?: "unknown";
  unprojected?: true;
};
```

Rows are chronological and flat. `group` is the payload's tool call id
(`id` for tool rows, `toolCallId` for permission requests). `title` and `text`
are capped at 200 Unicode code points, with `…` marking each truncated side.
Known event types use deterministic projections. For `tool_call_update`, text
and terminal content projects as `content[]`, while a row made only of terminal
items names its anchor `content[0].terminalId`; diff items project their file
anchor as `content[0].path`, where `text` carries the path — every path joined
by newlines when a row holds several diff items — and `field` names the first
one's index. Neither diff body is indexed. An unrecognized content-item shape
is reported as `content_shape: "unknown"` alongside whatever recognized
siblings project, so an unknown item cannot erase a recognized one; when every
item is unrecognized the row carries `content_shape: "unknown"` and no text
rather than falling back to the status. Unknown event
types still appear with
`seq`, `type`, and `bytes`. Search scans decoded string leaves, not serialized
JSON, and returns the matching JSON path plus a centered window (radius 100).
It is fixed-string matching, not regular expression matching; only ASCII
letters are case-folded. The search term is limited to 128 code points so the
centered window always retains the complete match before allocating context.
An unprojected search hit carries `unprojected: true` so the reason for the hit
remains visible.

The serialized `{task_id, max_seq, rows}` response is subject to a 24 KiB
implementation limit — one index page is a decision aid, not a corpus, so the
cap sits just above the recommended 50-row window even when every row carries
its full 200-code-point text. Over-limit responses are rejected, never
partially returned, with a JSON tool error containing `response_too_large`,
`required_bytes`, `limit_bytes`, `max_seq`, and a tail-range hint.

### `task_read`

Read one or more complete persisted event rows by task-local sequence. This
is the sole complete-row history tool; no single-row alias is registered.

```ts
task_read({ task_id?: string, seqs: number[] })

{
  task_id: string;
  rows: Array<{
    seq: number;
    type: string;
    at: string; // ISO-8601 UTC with Z
    from: string;
    data: unknown; // complete decoded stored payload
  }>;
}
```

The target defaults to the current Task, so a Task that has just woken from
`/compact` or `/clear` reads its own history without first learning its id.

Duplicate sequences are removed and rows are returned in ascending order. Any
missing sequence rejects the whole request with
`{"error":"unknown_seq","missing":[...]}`. A batch is limited by an
implementation constant (128 KiB) together with an item-count limit; a single
sequence is exempt from both and answers to a separate 1 MiB single-row limit,
so one legitimate event is never permanently unreadable. Over-limit responses
are rejected without partial data and report `response_too_large` with the
exact `required_bytes`. That value is always
`Buffer.byteLength(JSON.stringify({task_id, rows}), "utf8")`.

Both history tools authorize only the current Task, its parent, or its direct
children. A sibling is outside the family. Tombstones, nonexistent tasks, and
out-of-family task IDs all return `target_not_allowed`.

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

The cancellation is recorded and broadcast as one `system_message` row per side
of the edge, both `kind: "task_cancel"` with the machine fields (`sourceTaskId`,
`targetTaskId`, `reason`, `status`), the raw `sourceLabel`/`targetLabel` the
title was built from, and a `role` in `data`, and both carrying the same
`reason:` / `status:` body. The labels are additive: a row written before they
existed leaves its reference unmarked (it is placed by task id and never parsed
out of the title), and the row itself is never muted — a row is history and
keeps its normal contrast.

| Row lands on | `role` | Title |
| --- | --- | --- |
| The cancelling Task | `source` | `@source cancelled @target` |
| The cancelled Task | `target` | `Cancelled by @source` |

`@X` is the Task's title, falling back to its short id, exactly like a
collaboration row. A user-initiated cancel writes neither row.

How a cancelled turn affects an open account is defined in
[Task Obligations](task-obligations.md#turn-end-check).

### `task_create`

Create a direct child Task immediately. The request includes a required `title`
plus optional `agent`, `cwd`, `model`, and `thinking`.

`agent` names the execution agent for the child. It is a free string, validated
against the configured `[agents.*]` ids when the call runs: adding an agent is a
configuration change and a restart, not a schema change. The tool description
advertises the configured ids and is rebuilt on every request from the startup
snapshot — the whole description stays within 1024 characters, ids are listed
whole or omitted with a count, and an id is never truncated (a shortened id
would look legal while naming nothing). Omitting `agent` keeps the existing
behaviour: the child inherits the current Task's agent. A deployment with a
single configured agent advertises no list, because there is nothing to choose
between.

The target agent is started on demand. Creating a child on another agent is a
declared divergence, not a write through the wrong process: the caller's own
binding is untouched, and a relative `cwd` still resolves against the current
Task's `cwd`.

**Execution config.** Omitted `model` / `thinking` inherit from the current Task
only when the child lands on the same agent; a cross-agent child starts from the
target's own defaults. Explicit values are passed to the target's session and
validated against the schema that session reported — the target is the only
authority on its own environment. On rejection the just-created task is deleted
again (best-effort: the ACP session is retired and the capability revoked) and
the call fails as a tool error.

**Errors.** Every failure is an MCP tool error, never a silent fallback to
another agent. Each message is bounded (400 characters / 6 lines) and never
quotes a partial id:

| Case | Reported |
| --- | --- |
| `agent` not configured | that the id is not configured, plus "Omit `agent` to create the Task on this Task's agent". No agent list: the description already carries it. |
| configured but unstartable | the transport's real reason, plus the same omission hint. |
| target refuses `model` / `thinking` | `unsupported_config:<id>` when that session did not report the option — no values offered, and **no** fallback to the cached agent-level schema, which can be an older session's list; `invalid_config_value:<id>` otherwise, listing up to five candidates with the target's current value. A wider list (the `model` normal case) becomes its count, the current value, and a "omit it or ask the user" instruction. Candidates always come from the session that rejected the value. |
| caller's own execution replaced | the existing authority refusal (`execution_replaced`), independent of `agent`. |

**Result and record.** The result contains the new Task ID. The parent's
transcript gets exactly one `task_created` row with five fields — `Task ID`,
`agent`, `cwd`, `model`, `thinking`. `model` and `thinking` show the values that
took effect: the explicit value, the value inherited from a same-agent source,
or the target session's own current value. `inherited` appears only when a value
genuinely cannot be determined, so a cross-agent child shows the target's
defaults instead of claiming an inheritance that did not happen.


### `task_send`

The message is stored before the call returns, so it survives a restart, and is
delivered in order with any other queued items. Whether it opens an account is
defined in [Task Obligations](task-obligations.md#opening-an-account).

### `task_update`

```ts
task_update(status: "waiting" | "blocked" | "done", body: string)
```

The call records one `task_update` event on the current Task and sets its
`workflowStatus`. Routing, settlement, the `waiting` precondition, and the
turn-end check are defined in [Task Obligations](task-obligations.md). A
refused `waiting` is an MCP tool error and records nothing.
