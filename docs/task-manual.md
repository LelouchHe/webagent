# Task Manual

This is the user-facing manual for coordinating work between Tasks. It explains
how to use the Task collaboration surface; it does not describe WebAgent's
internal implementation.

## The core rule

**Use messages as the normal data path and let Tasks wake one another. Do not
poll for completion.**

- Use `task_send` for instructions, questions, context, progress, and decisions.
- Use `task_update(done, ...)` for a completed handoff to the parent.
- Use `task_update(blocked, ...)` when the Task cannot continue without input.
- Let the resulting delivery wake the receiving Task.
- Use `task_query` and `task_get_record` only for diagnosis, recovery, or
  explicit history inspection.

A Task that is `idle` is not necessarily complete. Treat `done` as the explicit
completion signal for delegated work.

## Choose a Task structure

Keep work in the current Task when the work is sequential and shares one
context. Create a child Task when the work is independent, has a clear scope,
or can proceed while the parent is idle.

A common structure is:

```text
Coordinator
├── independent investigation A
├── independent investigation B
└── independent investigation C
```

For a review or other multi-stage workflow, use a coordinator Task as an
Arbiter:

```text
Main Task
└── Arbiter
    ├── Specialist A
    ├── Specialist B
    └── Specialist C
```

A Task can normally coordinate with itself, its parent, its direct children,
and its siblings. Keep this boundary in mind when choosing where to put the
coordinator: the parent receives the Arbiter's synthesis rather than directly
reading the Arbiter's children.

## The standard delegation flow

### 1. Create a child

Create a child with a title that describes its responsibility. Creation and
instruction are separate operations:

```text
task_create(title: "API investigation")
task_send(target: <new-task>, body: <first instruction>)
```

Always send the first instruction after creation. Include:

- the objective;
- the scope and explicit non-goals;
- the relevant files, features, or questions;
- the expected evidence and output format;
- the completion condition;
- whether the child may modify files.

### 2. End the dispatch turn

After the child has received its brief, the parent should end its current turn.
Do not wait with `sleep`, repeatedly call `task_query`, or ask the child to
announce that it has started.

The child runs independently. Its messages are durable and will be delivered
to the parent when the parent can receive them.

### 3. Complete with a handoff

When the child has finished, use:

```text
task_update(
  status: "done",
  body: <final result with evidence>
)
```

A completed workflow update is also handed off to the parent. Do not send the
same final result again with `task_send`.

A useful final handoff contains:

```text
Result:
  <short conclusion>

Evidence:
  - <file, symbol or line range, and observation>

Risks or limitations:
  <what remains uncertain>

Suggested next step:
  <action, or "none">
```

## Use the right communication operation

### `task_send`: normal collaboration

Use `task_send` for:

- the first instruction after creating a child;
- questions and requests for clarification;
- context or findings that are not final;
- routine progress updates;
- decisions that allow a blocked Task to continue;
- follow-up instructions for another round.

`task_send` does not itself mark the sender complete.

### `task_update(done)`: final handoff

Use `task_update(done)` when the assigned work is complete. Put the conclusion
and its evidence in the body so the parent can act without reconstructing the
child's entire history.

### `task_update(blocked)`: actionable blocking

Use `task_update(blocked)` only when the Task cannot make progress. State:

- what is blocking the work;
- what decision or information is required;
- who can provide it;
- what the Task will do after receiving it.

The parent resumes the blocked Task by sending a decision or additional
information with `task_send`. A blocked state is not a reason to poll and is
not automatically a terminal result.

## Fan-out and fan-in

For parallel work, the coordinator should keep an explicit set of expected
children and wait for their handoffs:

```text
expected: specialist-a, specialist-b, specialist-c
received: specialist-a, specialist-b
```

The coordinator should finish the fan-in when all expected children have sent a
terminal handoff, or explicitly explain which child is blocked or unavailable.
It should not discover completion by repeatedly querying every child.

The normal fan-in path is:

```text
child task_update(done)
        ↓
parent receives the handoff
        ↓
parent synthesizes
        ↓
parent task_update(done)
        ↓
its parent receives the synthesis
```

## Independent work and peer communication

Keep the first analysis independent when the purpose is to obtain diverse
opinions or catch independent failure modes. Do not give one specialist's
conclusion to another before the independent phase is complete.

After the independent phase, sibling Tasks may communicate directly when the
workflow calls for review, rebuttal, or shared investigation. Prefer explicit
questions with a bounded expected response rather than open-ended discussion.

For example:

```text
Arbiter → Skeptic: challenge Engineer's claim 2 with a concrete counterexample
Skeptic → Engineer: reply with evidence or mark the claim uncertain
```

## Evidence and history

Put concise, independently verifiable evidence in the handoff itself. For code
work, prefer file paths, symbols, line ranges, observed behavior, and the
causal mechanism over large pasted files or diffs.

Use `task_query` only when normal message flow is insufficient, such as when:

- a delivery appears to be missing;
- a Task must be recovered after a restart;
- an earlier round needs to be reviewed;
- a status or handoff is ambiguous.

Use `task_get_record` only when a compact history entry is not enough and one
specific persisted record must be inspected. These are exception and audit
operations, not the normal coordination path.

## Multi-round workflows

Use a small round identifier in messages when a workflow can have more than one
round:

```text
review_id: api-review
round: 2
role: engineer
```

At the end of a round:

1. each child sends one terminal `done` or `blocked` handoff;
2. the Arbiter synthesizes the received results;
3. the Arbiter either completes with `done` or sends bounded follow-ups;
4. a user decision is sent back with `task_send` when needed.

Keep each handoff idempotent: repeating the same round message should not make
the coordinator apply the same decision twice.

## Anti-patterns

Avoid these patterns:

- creating a child without sending its first instruction;
- polling a child while waiting for a delivery;
- using `task_query` as the normal result channel;
- expanding raw records when the handoff already contains sufficient evidence;
- sending a final conclusion with both `task_send` and `task_update(done)`;
- using `task_update` for ordinary progress updates;
- marking a Task `done` before its assigned work is complete;
- sharing one specialist's opening analysis with other specialists too early;
- putting unrelated responsibilities into one child Task;
- using a huge handoff body instead of a concise result with references.

## Example: one-round panel review

```text
Main
└── Arbiter
    ├── Skeptic
    ├── Minimalist
    └── Engineer
```

1. Main creates Arbiter and sends the subject brief.
2. Main ends its turn.
3. Arbiter creates the three specialists and sends each a role brief.
4. Arbiter ends its turn.
5. Each specialist independently investigates and calls
   `task_update(done, result-and-evidence)`.
6. Each handoff wakes Arbiter; no polling is required.
7. Arbiter compares the received claims, marks unsupported concerns as
   uncertain or dismissed, and calls `task_update(done, synthesis)`.
8. The final handoff wakes Main.

For a single verdict round, this workflow needs only task creation, instruction
messages, and terminal handoffs. History queries are optional diagnostics, not
part of the happy path.

## Quick checklist

Before dispatching:

- Is the work independent enough to justify a child Task?
- Does each child have one bounded responsibility?
- Is the expected output and evidence format clear?
- Does the coordinator know which children it is waiting for?

During coordination:

- Have all normal updates used messages rather than polling?
- Has each completed child sent exactly one terminal handoff?
- Are independent findings kept independent until the review phase?
- Is a blocked Task waiting for a decision rather than being repeatedly queried?

Before completing:

- Does the synthesis cite the evidence it relies on?
- Are missing, blocked, dismissed, and uncertain results distinguished?
- Is the final result sent through `task_update(done)` to the parent?
