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

## Server instructions

The server advertises a short, generic usage contract through the MCP
`initialize` result:

```text
Use task_create for a direct child, then immediately use task_send to give it its first instruction.
Use task_send for normal coordination and for continuing or resuming existing Tasks; task_send is not a lifecycle handoff. Use task_update(done|blocked) for typed lifecycle handoffs. A done Task remains available and is not deleted or permanently closed.
After dispatching work, end the current turn; do not poll with task_query.
Use task_query and task_get_record only for history recovery, diagnosis, or audit.
Omit task_id to inspect the current Task's persisted history.
```

Clients may surface these instructions through their own discovery UI or tool;
they are not a replacement for the individual tool descriptions. When an
Agent-created delegated Task's collaboration turn ends or errors while
the Task is still `running` without a typed `task_update(done|blocked)` handoff,
WebAgent may send one Markdown handoff reminder before leaving the Task idle.
User-created interactive Tasks are not subject to this automatic reminder.
Detailed workflow guidance belongs in
the [Task Manual](task-manual.md) or an on-demand skill.

## Lifecycle at a glance

The MCP surface participates in this loop:

```text
task_create
  → task_send: first Task Contract
  → agent executes
  → task_update(done|blocked): typed handoff
  → parent receives the full handoff body
  → parent verifies, accepts, or sends focused follow-up
  → parent reports its own result when its own Task is complete
```

`task_send` does not complete the current Task. A `done` Task remains available
for history and follow-up. Parent Tasks receive direct child handoffs only;
WebAgent does not automatically rebroadcast raw child reports to ancestors.

## Tools

| Tool | Purpose |
| --- | --- |
| `task_list` | List the current task and its locally reachable parent, children, and siblings. |
| `task_query` | Read a bounded, compact history page for the current task or one visible relative. |
| `task_get_record` | Read one complete persisted history record by task-local sequence. |
| `task_cancel` | Stop the current execution of a child Task while preserving its history. |
| `task_create` | Create a direct child Task with optional execution overrides. Use `task_send` for its first instruction. |
| `task_send` | Send a durable coordination message, including follow-up or resume instructions for an existing Task. Use `task_update` for typed `blocked`/`done` status. |
| `task_update` | Send a typed `blocked` or `done` lifecycle handoff for the current Task; this does not delete or permanently close it. |

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
The creating Task also receives a durable system message containing the child
Task title. Send the first work instruction separately with `task_send`; the
Task ID remains in the tool result and event metadata. Failures return an MCP
tool error rather than an empty ID.
