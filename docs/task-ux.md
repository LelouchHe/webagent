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

## `+` — create a named child Task

```text
+<title> [<cwd>]
```

Examples:

```text
+api-fix                    child named `api-fix` in the current Task cwd
+"api fix" /tmp/repo         quoted title, explicit cwd
+api-fix /tmp/my dir         a cwd containing spaces needs no quoting
```

Both input forms share one shape: a shell-style word addressing the object,
followed by a verbatim remainder. For `+` the address is the new Task title and
the remainder is its working directory; for `@` the address is a Task path and
the remainder is the message body.

- the first shell-style word is the child's title, with the same quoting and
  backslash escaping as `@`;
- the title must not contain `/` or be `.`/`..`, which would make the Task
  unreachable through the `@` path grammar;
- everything after the title is the child working directory, taken verbatim —
  quotes are ordinary characters there;
- a relative cwd resolves against the current Task cwd, `~` expands to HOME, and
  the directory must already exist;
- omitting the cwd creates the child in the current Task cwd;
- the new Task is a direct child of the current Task;
- creation does not switch to the new Task; the system message reports the
  created title so the next step can address it;
- the first instruction is not part of the command. Send it with
  `@<title> <message>`, or use `@<title>` alone to open the new Task.

A `+`-created Task is user-owned and interactive. It can receive messages and
child results, but the runtime does not automatically require a typed
`task_update(done|blocked)` handoff after each turn. Agent-created delegated
Tasks follow the lifecycle handoff contract described in the [Task Manual](task-manual.md).

Autocomplete serves the second field. Once a title is present the menu leads
with the action row for the current input — `↵ create 'api-fix'`, extended to
`create 'api-fix' at '/tmp/repo'` only when a cwd is given explicitly — so what
Enter will do is visible. The default cwd is implicit and is not echoed back. A
space then lists cwd candidates: the current cwd marked `*`, the recent paths,
and, once a path prefix is typed, the real directory layer to drill into.

A bare `+` has no title to create with. It shows the hint
`create task · type a title`, and Enter reports `err: Task title is required after +`.

`/new [cwd]` is the unnamed form of the same creation: it creates a direct
child of the current Task without a title (the task id stands in), optionally
in another cwd, and switches to it. A relative `cwd` resolves against the
current Task cwd, `~` expands on the server, and the directory must already
exist; both the picker action row and Enter send that resolved path, so the
preview names the directory that is actually created. Use `+` when the child
needs a name that other Tasks can address. Its picker mirrors `+`: the action
row `create task` (extended to `create task at '<cwd>'` once a path is typed)
leads, and the current cwd is listed first with `*`, ahead of the recent paths.

## `@` — target, navigate, and send

```text
@<task-path>
@<task-path> <message>
```

Without a message body, submitting an exact target navigates to that Task. With
a message body, it sends a collaboration message when the target is reachable
from the current Task. The target is one shell-style word; everything after it
is the message body, taken verbatim.

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
