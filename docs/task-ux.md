# Task UX

This document is the user-facing contract for Task creation, navigation, and
collaboration through the `+` and `@` input forms. The backend Task tree remains
the authority for identity, lifecycle, and collaboration scope; the browser uses
Task paths as its addressing surface.

## Task paths

Task paths use filesystem-style components:

```text
@a                 target Task `a`
@a/                show the next path layer under `a`
@a/child           target `child` under `a`
@..                target the parent Task
@../sibling        target a sibling through the parent path
@/project/api      target an absolute Task path
@/.                target Root
@/                 show the Root path layer
```

A trailing slash is a browse hint. It does not become part of a completed
concrete target: autocomplete fills `@a`, not `@a ` or `@a/`.

Every Task can be navigated to. Only Tasks in the current collaboration scope
(parent, direct child, or sibling) can receive a collaboration message from the
current Task. Navigation and collaboration are separate capabilities.

Task paths are display and lookup addresses, not stable identities. URLs,
history, deliveries, and persistence continue to use the stable `taskId`.

## Hashless startup

A URL hash explicitly selects a Task. When the application opens without a
hash, it resumes the most recent Task with user-originated input, using the
Task list's `last_active_at` ordering. Root is the fallback when no Task has
user input. Root remains the canonical clean URL (`/`); a resumed child uses
its stable `#task-id` hash.

User input includes normal prompts and user-originated collaboration/create
messages. Agent output, background deliveries, navigation, and merely viewing
a Task do not make it the most recent user Task.

## `+` — create a child Task

```text
+<cwd>/<title> <brief>
```

Examples:

```text
+./api-fix 修复接口错误处理
+~/work/webagent/tests 增加回归测试
```

The `/view` filesystem grammar is reused for the creation prefix:

- the final path segment is the new Task title;
- preceding segments resolve the child working directory;
- a relative cwd is resolved from the current Task cwd;
- quoting and backslash escaping are supported for path segments;
- the new Task is a direct child of the current Task;
- the brief is delivered as its first instruction;
- after successful creation, the browser opens the new Task.

A `+`-created Task is user-owned and interactive. It can receive messages and
child results, but the runtime does not automatically require a typed
`task_update(done|blocked)` handoff after each turn. Agent-created delegated
Tasks follow the lifecycle handoff contract described in the [Task Manual](task-manual.md).

A bare `+` opens the default current cwd and recent paths. Selecting a cwd
continues the picker so the user can enter the title; it does not create a Task
until the completed command is submitted.

## `@` — target, navigate, and send

```text
@<task-path>
@<task-path> <message>
```

Without a message body, submitting an exact target navigates to that Task. With
a message body, it sends a collaboration message when the target is reachable
from the current Task.

```text
@../                 navigate to the parent Task
@../backend          navigate to the concrete sibling target
@../backend review   send a message to that sibling when allowed
```

A navigation-only target can still be selected and opened. A communication
capability only adds the option to type a message; it does not change the
Task's navigation behavior.

## Autocomplete

The picker is command-first for an exact target:

```text
@a

↵ navigate
child
 tests
```

When the exact target can receive collaboration messages, the selected command
row additionally shows:

```text
↵ navigate    or send a message
```

The command row is the operation for the exact path currently in the input. A
navigation-only target still shows `↵ navigate`, without the message affordance.

The picker also exposes the next path layer as concrete Task suggestions. A
Task with children is visually marked with a trailing `/` and `›`, but that is
a display hint only:

```text
↵ navigate
› child/       idle
  leaf         blocked
```

Selecting a child completes a concrete path without a trailing slash:

```text
@a/child
```

It never completes to `@a/child/` or appends a space automatically. The user
can then press Enter to navigate, or type a space and a message when the target
is reachable.

For an explicit browse form, the command row for the directory itself is not
repeated:

```text
@a/

› child/       idle
  leaf         blocked
```

The same child suggestions are available from `@a`; `@a` additionally has the
first `↵ navigate` command for `a` itself.

A bare `@` lists the current path layer and its parent target when present. It
does not invent a command for an unresolved target.

## Enter, Tab, and Click

Enter always submits the current input value. It never silently replaces the
input with the highlighted row. Therefore an incomplete or ambiguous prefix is
rejected at submission time, even though it may produce autocomplete results.

| Input / row | Enter | Tab | Click |
| --- | --- | --- | --- |
| Exact target command | Submit and navigate | Fill the concrete path | Execute navigate immediately |
| Reachable target row | Submit: navigate or send | Fill the concrete path, without a space | Fill the path; the user may type a body |
| Navigation-only target row | Submit and navigate | Fill the concrete path, without a space | Navigate immediately |
| Child suggestion with children | Submit its concrete target | Fill the concrete target | Navigate or prepare to send according to target capability |
| Browse/path form ending in `/` | Submit the browse input | Preserve the path form | Continue showing that path layer |

The selected row is the only place where a reachable target receives the
message affordance. Unselected rows do not display `type message`; the input
path and the normal Enter behavior remain unchanged.

## Exactness and errors

Autocomplete may use a prefix to help find a Task, but submission requires one
exact Task path. The browser must not route a typo or an ambiguous prefix to an
arbitrary match.

Examples:

```text
@research             valid when `research` is exact
@res                  autocomplete query; Enter rejects unless exact
@does-not-exist       error
@                     error: Task target is required after @
```

A target path ending in `/` is a path/browse form. It is not a message body
separator and cannot be used to send a message until the user selects or types
a concrete target without that trailing slash.

## Scope and implementation boundary

The Task tree and `parent_id` relationships remain in the backend for:

- lifecycle and deletion rules;
- local collaboration scope;
- message delivery and permissions;
- stable path resolution.

The UI does not render a permanent tree panel and does not expose separate
parent/child/sibling communication shortcuts. Users address Tasks through
paths. `/switch` remains available as a temporary low-frequency navigation
fallback.

Agent collaboration uses the separate MCP control plane documented in
[Task MCP Control Plane](task-mcp.md). The recommended message-first workflow
is documented in the [Task Manual](task-manual.md). This
document describes browser input semantics; it does not redefine MCP tool
contracts.
