# Task Examples

These short examples show common ways to use Tasks. They focus on the
collaboration shape, not on a particular application or model.

For the underlying principles, see [Task Manual](task-manual.md). What each
tool does is in its own description; the reference contract is in
[Task MCP Control Plane](architecture/mcp.md).

## Work directly in the current Task

Use one Task when the work is clear, sequential, and small enough for one Agent:

```text
Read the parser, add a regression test for the empty-input case, run the test,
and report the result.
```

Do not create child Tasks just to make a simple task look parallel.

## Delegate one independent piece of work

Create a child when another Agent can work independently:

```text
Current Task
└── Test investigation
```

Conceptually:

```text
task_create(title: "Test investigation")
task_send(
  target: <new-task-id>,
  body: "Find the existing tests for parser errors. Do not modify files. Return the relevant files, gaps, and a recommended regression test."
)
```

After dispatching, end the current turn. Do not wait by repeatedly querying the
child.

The child reports completion with a handoff:

```text
task_update(
  status: "done",
  body: "The relevant tests are ... The missing case is ... The recommended test is ..."
)
```

The completed handoff is delivered to the parent automatically. The parent
checks the original completion condition and evidence; receiving `done` is not
itself acceptance. If the result is incomplete, send focused follow-up work;
otherwise accept it and continue the parent's own Task.

## Split independent investigations

Use several children when the question has independent parts:

```text
Current Task
├── Code-path investigation
├── Test-coverage investigation
└── Failure-mode investigation
```

Give each child a different responsibility:

```text
Code-path:
  Trace how the request reaches the handler. Cite files and symbols.

Test-coverage:
  Find tests that exercise the behavior and identify missing cases.

Failure-mode:
  Look for error, timeout, cancellation, and recovery paths.
```

The parent should wait for the children through their lifecycle handoffs, then
combine the results. It should not poll every child to discover whether it has
finished.

## Ask a parent for a decision

When a finding crosses task boundaries, send it to the parent:

```text
task_send(
  target: <parent-task-id>,
  body: "The implementation and tests disagree about cancellation. Please decide whether the contract should follow the implementation or the test expectation."
)
```

Use `task_send` for the question or finding. Use `task_update(done)` only when
the child's assigned work is complete.

## Exchange a peer review

MCP reaches self, parent, and direct children only; a sibling is not addressable
from an agent. When two sibling Tasks need to compare findings, the parent
relays:

1. Each child sends its bounded finding to the parent with `task_send`.
2. The parent sends the other child one focused question with `task_send`.
3. The child answers the parent, which decides whether another round is useful.

A person can still send a message across trees through the UI or REST, but the
agent-side primitive is parent-mediated. Keep the initial investigation
independent when independent perspectives matter; exchange findings after each
Task has a concrete claim to examine.

## Resume a blocked Task

A blocked Task should explain what it needs:

```text
task_update(
  status: "blocked",
  body: "I cannot choose between the two migration behaviors. I need the parent to decide whether backward compatibility or strict validation is the priority."
)
```

The parent continues it with a normal message:

```text
task_send(
  target: <blocked-task-id>,
  body: "Prefer backward compatibility. Keep the old input valid and add a warning test. Continue the investigation."
)
```

The message is the continuation signal. Do not create a replacement Task or
poll the blocked Task unless recovery is actually needed.

A completed Task remains available for follow-up work as well:

```text
task_send(
  target: <done-task-id>,
  body: "The review found one more bounded issue. Please investigate it and report the result."
)
```

Use a new Task only when the follow-up needs a separate boundary, context,
owner, or execution policy.

## Finish a coordinated task

A coordinator can fan work out and then fan it back in:

```text
Coordinator
├── A — inspect implementation
├── B — inspect tests
└── C — inspect operational impact
```

Each child returns one concise lifecycle handoff. A `done` handoff marks that
assignment complete; it does not delete or permanently close the Task. The
coordinator verifies each handoff, requests focused follow-up when needed, and
then produces one synthesis containing:

```text
Conclusion:
  what should happen

Evidence:
  the files, symbols, tests, or observations that support it

Uncertainty:
  what could not be verified

Next step:
  the smallest action that follows
```

If the coordinator is itself a delegated child, it reports
`task_update(waiting)` after fanning out and ends the turn; each child's
handoff wakes it. It does not blindly forward the children's raw reports, and
completes its own Task with:

```text
task_update(
  status: "done",
  body: "<final synthesis with evidence>"
)
```

That handoff wakes its parent. No polling loop is part of the normal path.

## User-created interactive Task

A Task created directly by the user can still receive collaboration messages
and important child results, but it remains an interactive workspace. The user
can discuss or steer it without an automatic runtime demand for
`task_update(done|blocked)` after every turn. It may still use typed handoffs
when the user or its own workflow wants an explicit completion boundary.

## Send several discoveries

When findings arrive independently, send them as separate messages when each
one is useful on its own:

```text
task_send(target: <parent-task-id>, body: "Finding 1: ...")
task_send(target: <parent-task-id>, body: "Finding 2: ...")
task_send(target: <parent-task-id>, body: "Finding 3: ...")
```

Messages may be delivered together if the recipient is busy. Separate messages
are useful for incremental discussion; combine them when they form one result
that should be reviewed as a unit.

## Recover context from the current Task

Normal collaboration uses messages and handoffs, not history queries. After
`/compact` or `/clear`, index the current Task's history and read the rows you
need:

```text
task_query({ range: [-50, -1] })
task_read({ seqs: [42, 43] })
```

The same tools help when a delivery seems missing or an earlier decision needs
revisiting. Do not use them as a waiting loop or in place of a handoff.

## Keep the example small

Before creating another Task, ask:

```text
Is the work independent?
Will a separate context help?
Can the result be handed off clearly?
Is the coordination cost justified?
```

If the answers are no, stay in the current Task.
