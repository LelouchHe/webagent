# Task MCP Control Plane

WebAgent injects a `webagent` MCP server into each compatible ACP session. It
lets an agent inspect and coordinate with tasks in its local task family without
granting access to unrelated tasks.

## Scope and authentication

The server is a Streamable HTTP endpoint at `/mcp`. Each ACP session receives a
fresh capability token; WebAgent sends it as an `Authorization: Bearer` header.
A capability is scoped to one task, is checked before MCP protocol handling, and
can access only that task plus its parent, direct children, and siblings.

The server is additive. It does not replace an agent's own MCP configuration or
native tools.

## Tools

| Tool | Purpose |
| --- | --- |
| `task_list` | List the current task and its locally reachable parent, children, and siblings. |
| `task_query` | Read a bounded, compact history page for the current task or one visible relative. |
| `task_get_record` | Read one complete WebAgent-persisted event row by task-local sequence. |
| `task_send` | Send a durable collaboration message to a visible relative. |
| `task_update` | Mark the current task `blocked` or `done`, with a handoff message to its parent when one exists. |

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
identity/reference value; this version of the MCP surface does not expose a
raw-event lookup by sequence.

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
| `system_message`, `task_update`, `message` | Collaboration route/status and message body. |
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
stored event record, not necessarily the complete original ACP notification:
WebAgent may normalize ACP updates before persistence, merge assistant chunks,
or intentionally omit fields from sensitive or high-volume notifications. The
`fromRef` field is WebAgent metadata, not an ACP field. Current origin
conventions include `user`, `agent`, `system`, `msg:<id>`, `cron:<id>`, and
`external:<id>`; clients should treat it as an opaque string.

The tool reads one record per call and does not support bulk sequence lookup, so
raw payload expansion remains explicit and bounded by the caller's choice.
