# Regression tests

`npm run test:regression [scenario ...] [--update]` characterizes WebAgent's
external behavior. It is a golden suite, not a test of internal scheduling.

## Architecture

`run.ts` loads each file in `scenarios/` independently. Scenarios run in
parallel; every scenario runs twice (A/A) before either result is compared with
`golden/<name>.json`.

Each run gets a temporary data directory, home directory, random port, config,
real WebAgent server, global SSE subscription, and deterministic ACP agent.
Setup and steps use authenticated REST or MCP-over-HTTP only. The agent is
declared in the scenario and communicates over real ACP. No scenario can
control, hold, or release the agent while a run is active.

The server and agent are preloaded with `observer.ts`. It only observes
`better-sqlite3` statement calls, while fixing the clock, UUID stream, and
random stream. Instance paths and ports are normalized when results are read.
The observer records write SQL in order and records read operations as counts.
The final database snapshot is opened read-only after all steps.

Regression runs extend `test/e2e/mock-agent.ts` through opt-in environment
variables. The existing E2E branches run unchanged when those variables are
absent. The regression branch is a small declarative dispatcher for replies,
MCP calls, failures, and declared waits.

## Results and `settle()`

One step result contains:

1. the REST caller's response;
2. new global SSE events;
3. ACP requests and MCP-over-HTTP calls received by the mock;
4. ordered write SQL plus read counts;
5. the final read-only database snapshot.

After every step, the runner alone calls `settle()`. The runner waits until
observer, ACP, and SSE activity is quiet. Any busy task must either become idle
or be represented by a mock-declared wait; a timeout reports the scenario,
step, busy task ids, and declared waits. Scenarios do not sleep, poll, wait for
named events, or inspect internal state.

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

## Adding a scenario

Create `scenarios/<name>.ts` and use `scenario(...)`. The declaration order is:
mock behavior, public-interface setup, then named steps. Prompt actions are
limited to a reply, an MCP call list, a declared wait, or a declared failure.
`"$lastCreatedTaskId"` can be used in later MCP arguments to refer to the
latest `task_create` result.

The setup builds its own task tree through `RegressionContext.rest()`. A step
returns the external response it receives; it must not contain assertions
derived from production code. Generate the new golden with `--update`, inspect
it manually, then run the scenario again without `--update`.

Every external asynchronous operation must use the harness's timed client or
the mock's timed ACP/MCP helper. Keep new infrastructure generic. Internal
fences, timing windows, and race interleavings belong in unit tests and in
`COVERAGE.md`, not in this suite.

