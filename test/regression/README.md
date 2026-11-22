# Regression tests

`npm run test:regression [scenario ...] [--update]` characterizes WebAgent's
external behavior. It is a golden suite, not a test of internal scheduling.

## Architecture

`run.ts` loads each file in `scenarios/` independently. Scenarios run in
parallel; every scenario runs twice (A/A) before either result is compared with
`golden/<name>.json`. One scenario's failure does not stop the others from
finishing and cleaning up.

Each run gets a temporary data directory, home directory, random port, config,
real WebAgent server, global SSE subscription, and deterministic ACP agent.
The config fixes every task's default cwd to `/`, so path-sensitive byte counts
are stable before golden normalization; regression tasks do not read files.
Setup and steps use authenticated REST or MCP-over-HTTP only. The agent is
declared in the scenario and communicates over real ACP. No scenario can
control, hold, or release the agent while a run is active.

The server and agent are preloaded with `observer.ts`. It only observes
`better-sqlite3` statement calls, while fixing the clock, UUID stream, and
random stream. Instance paths, the checkout root, and ports are normalized when results are
read. `<INSTANCE>` replaces the scenario's private directory, `<REPOSITORY>`
replaces the checkout path, and `<ORIGIN>` replaces the loopback port. The
observer uses `better-sqlite3` statement `.readonly` metadata, records write SQL
in order, and records reads as counts. The final database snapshot is opened
read-only after all steps.

Regression runs extend `test/e2e/mock-agent.ts` through opt-in environment
variables. The existing E2E branches run unchanged when those variables are
absent. The regression branch is a small declarative dispatcher for replies,
MCP calls, failures, and declared waits. A declared prompt matches by substring
so it can tolerate the server's real collaboration envelope. In regression
mode an undeclared prompt fails immediately; runtime prompts such as typed
updates and removal notices must therefore be declared explicitly.

## Results and `settle()`

The golden's top-level shape is:

```text
{
  steps: [<setup or step result>],
  snapshot: { tasks, agent_sessions, events, messages, deliveries, ... }
}
```

`setup` is recorded first like an ordinary step. Its `response` is the value
returned by the scenario setup, and it includes the SSE, mock, and SQL activity
caused by public setup calls. Later step `response` values are exactly what the
scenario's REST action returned. The mock group is a JSON response, event, or
state shape, not an assertion.

Each step also contains:

- `sse`: groups keyed by `taskId`; events inside one task retain arrival
  order, while task groups are sorted by id and have no cross-task order.
- `mock`: groups keyed by `sessionId`; ACP `session/new`, `session/prompt`, and
  `session/cancel`, plus MCP `initialize`, `notifications/initialized`, and
  tool-call results. Calls inside one session retain order, while session
  groups are sorted and have no cross-session order. Unscoped process calls use
  `sessionId: "*"`.
- `sql.reads`: the read statement count.
- `sql.writes`: an array of transaction arrays. Statements within one
  transaction retain order; transaction arrays are sorted by their serialized
  content. Each autocommit write is its own transaction.

Stringified JSON remains a string in the golden when the public/DB shape
contains serialized JSON. This deliberately exposes changes in escaped event
payloads instead of hiding them by parsing and reformatting them. A diff from
adding a table column, reformatting SQL, or shifting deterministic IDs is
review evidence, but does not by itself prove a user-visible regression.

After every step, the runner alone calls `settle()`. It probes every 25ms and
declares the run quiet after 250ms with no new observer, ACP, or SSE output.
Every busy task must correspond to a declared wait on that task's own ACP
session; a timeout reports the busy task-to-session mapping and all active waits
at the timeout instant. A missing wait or an unexpected SSE EOF, including a
normal EOF, is an error.
Scenarios do not wait for named events or inspect internal state.

This fixed quiet window has a known limitation: a step that pauses for more
than 250ms without producing output can be mistaken for settled. Usually the
late output shows up in the next step or as an A/A mismatch, but after the
final step the instance is torn down immediately, so output that is late in
both runs can be missed entirely. Tighten the declared behavior when such a
late continuation becomes reproducible.

`--update` still performs the A/A check, then replaces the selected goldens.
Review those diffs by asking what external behavior changed, whether the SQL
difference is intentional, and whether the A1 refactor introduced any
non-read-count change.

## Daily workflow

```bash
npm run test:regression                 # all scenarios
npm run test:regression -- mcp-list     # one or more scenarios
npm run test:regression -- --update     # regenerate all goldens
npm run test:regression -- mcp-list --update
```

A golden failure includes a line diff. A/A failure means the test itself is
nondeterministic. A settle timeout means the observable system did not become
quiescent. Do not weaken normalization to make either failure disappear.

Known environment limits:

- a checkout path or Node installation path containing spaces cannot currently
  be used to launch the mock command;
- the runner probes an available port before binding the server, so another
  process can still take that port between the two operations.

## Adding a scenario

Create `scenarios/<name>.ts` and use `scenario(...)`. The declaration order is:
mock behavior, public-interface setup, then named steps. Prompt actions are
limited to a reply, an MCP call list, a declared wait, or a declared failure.
`"$lastCreatedTaskId"` can be used in later MCP arguments to refer to the
latest `task_create` result.
`"$currentTaskId"` and `"$parentTaskId"` resolve after a `task_list` call;
`"$task:<title>"` resolves a task created or listed by this mock process.

The setup builds its own task tree through `RegressionContext.rest()`. A step
returns the external response it receives; it must not contain assertions
derived from production code. Generate the new golden with `--update`, inspect
it manually, then run the scenario again without `--update`.

Every external asynchronous operation must use the harness's timed client or
the mock's timed ACP/MCP helper. Keep new infrastructure generic. Internal
fences, timing windows, and race interleavings belong in unit tests and in
`COVERAGE.md`, not in this suite.

