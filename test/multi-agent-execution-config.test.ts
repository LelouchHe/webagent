import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_A,
  AGENT_B,
  A_CHOICES,
  SCHEMA_B as SCHEMA_B_FOR_BOUNDARY,
  executionValues,
  startHarness,
  type Harness,
} from "./fixtures/multi-agent-harness.ts";

/**
 * `model` / `mode` / `reasoning_effort` are execution facts: they describe one
 * agent's environment and do not travel with the task across agents. Both ways
 * a task's agent can change (an explicit clear and the implicit takeover of a
 * removed owner) must drop them, and the replacement's own report then becomes
 * the task's read face.
 */

const A_DEFAULTS = {
  model: "model-a",
  mode: "agent",
  reasoning_effort: "medium",
};
const B_DEFAULTS = {
  model: "model-b2",
  mode: "agent",
  reasoning_effort: "high",
};

/** Store the three non-default values a task ran with on A. */
async function storeChoices(
  harness: Harness,
  taskId: string,
  choices: Record<string, string>,
): Promise<void> {
  const paths: Array<[string, string]> = [
    ["model", choices.model],
    ["mode", choices.mode],
    ["reasoning-effort", choices.reasoning_effort],
  ];
  for (const [path, value] of paths) {
    const written = await harness.request(
      "PUT",
      `/api/v1/tasks/${taskId}/${path}`,
      { value },
    );
    assert.equal(written.status, 200, `${path} write must succeed`);
  }
}

function rowValues(task: {
  model: string | null;
  mode: string | null;
  reasoning_effort: string | null;
}): Record<string, string | null> {
  return {
    model: task.model,
    mode: task.mode,
    reasoning_effort: task.reasoning_effort,
  };
}

/** A task that ran on A with values that are neither A's nor B's defaults. */
async function taskOnA(harness: Harness): Promise<string> {
  const created = await harness.request("POST", "/api/v1/tasks", {
    cwd: harness.dir,
    agentId: AGENT_A,
  });
  assert.equal(created.status, 201);
  const taskId = String(created.json.id);
  await storeChoices(harness, taskId, A_CHOICES);
  assert.deepEqual(rowValues(harness.store.getTask(taskId)!), A_CHOICES);
  return taskId;
}

describe("a replacement owned by another agent", () => {
  it("drops the stored execution config on every read face", async () => {
    const harness = await startHarness();
    try {
      const taskId = await taskOnA(harness);

      const cleared = await harness.request(
        "POST",
        `/api/v1/tasks/${taskId}/clear`,
        { agentId: AGENT_B },
      );
      assert.equal(cleared.status, 200);
      assert.equal(harness.store.getBindingAgent(taskId), AGENT_B);

      // A's values were never sent to B — not even as a rejected request. One
      // of them (`mode: chat#plan`) is legal on B, so "B refused it" cannot be
      // what kept the row clean.
      assert.deepEqual(harness.agents.b.configWrites, []);

      // 1. The clear response reports B's own environment.
      assert.deepEqual(executionValues(cleared.json), B_DEFAULTS);
      // 2. The row agrees: not A's values, and not left unknown.
      assert.deepEqual(rowValues(harness.store.getTask(taskId)!), B_DEFAULTS);
      // 3. The detail read agrees (the task is live, so this is the resume
      //    read face: the agent's cached schema overridden by the row).
      const detail = await harness.request("GET", `/api/v1/tasks/${taskId}`);
      assert.equal(detail.status, 200);
      assert.deepEqual(executionValues(detail.json), B_DEFAULTS);
      assert.equal(detail.json.agentId, AGENT_B);
      assert.equal(harness.store.getTask(taskId)?.model, "model-b2");

      // 4. Going back to A starts from A's defaults, not from A's old choice.
      const writesBefore = harness.agents.a.configWrites.length;
      const back = await harness.request(
        "POST",
        `/api/v1/tasks/${taskId}/clear`,
        { agentId: AGENT_A },
      );
      assert.equal(back.status, 200);
      assert.deepEqual(executionValues(back.json), A_DEFAULTS);
      assert.deepEqual(rowValues(harness.store.getTask(taskId)!), A_DEFAULTS);
      // Nothing was replayed into A either.
      assert.deepEqual(
        harness.agents.a.configWrites.slice(writesBefore),
        [],
        "the abandoned values are not restored on the way back",
      );
    } finally {
      await harness.close();
    }
  });

  it("keeps the replacement's report on live resume and after a cold reopen", async () => {
    // The read faces that the row — not the in-memory schema — has to supply:
    // an agent whose cache belongs to *another* task, a resume of the live
    // task, and a process that starts with nothing warm at all.
    const harness = await startHarness();
    try {
      // Warm the agent cache through a different task on the same agent, with a
      // value that is not this agent's default. A read that leaked the cache
      // would show `low` here instead of this task's own values.
      const other = await harness.request("POST", "/api/v1/tasks", {
        cwd: harness.dir,
        agentId: AGENT_B,
      });
      assert.equal(other.status, 201);
      const otherId = String(other.json.id);
      await harness.request(
        "PUT",
        `/api/v1/tasks/${otherId}/reasoning-effort`,
        {
          value: "low",
        },
      );
      const warm = await harness.request(
        "POST",
        `/api/v1/tasks/${otherId}/clear`,
        {},
      );
      assert.equal(warm.status, 200);

      const taskId = await taskOnA(harness);
      const cleared = await harness.request(
        "POST",
        `/api/v1/tasks/${taskId}/clear`,
        { agentId: AGENT_B },
      );
      assert.equal(cleared.status, 200);
      assert.deepEqual(executionValues(cleared.json), B_DEFAULTS);

      // Live resume, asserted directly instead of through the detail read: the
      // task is live, so this answers from the in-memory schema overlaid by the
      // row.
      const resumed = await harness
        .tasks()
        .resumeTask(harness.agents.b.bridge, taskId);
      assert.equal(resumed.type, "task_created");
      assert.deepEqual(executionValues(resumed), B_DEFAULTS);

      // Give the row a value that a fresh session will *not* report, so the
      // cold read can only produce it by overlaying the row.
      const coldChoice = await harness.request(
        "PUT",
        `/api/v1/tasks/${taskId}/reasoning-effort`,
        { value: "low" },
      );
      assert.equal(coldChoice.status, 200);
      assert.equal(harness.store.getTask(taskId)?.reasoning_effort, "low");

      // Cold reopen: a new store over the same database and fresh transports,
      // so no cache and no session values survive.
      await harness.coldRestart();
      assert.deepEqual(harness.agents.b.configWrites, []);
      const cold = await harness
        .tasks()
        .resumeTask(harness.agents.b.bridge, taskId);
      assert.equal(cold.type, "task_created");
      // The fresh session reports its own default (`high`); the resume must
      // still answer with the task's stored choice, which is the overlay.
      assert.deepEqual(executionValues(cold), {
        model: "model-b2",
        mode: "agent",
        reasoning_effort: "low",
      });
      const coldDetail = await harness.request(
        "GET",
        `/api/v1/tasks/${taskId}`,
      );
      assert.deepEqual(executionValues(coldDetail.json), {
        model: "model-b2",
        mode: "agent",
        reasoning_effort: "low",
      });
      assert.equal(harness.store.getTask(taskId)?.reasoning_effort, "low");
    } finally {
      await harness.close();
    }
  });

  it("clears the columns even when the replacement reports no config", async () => {
    // A replacement that reports no schema at all is the case that makes the
    // clear load-bearing: adopting the report cannot stand in for it, so the
    // previous agent's values would otherwise stay on the task and be replayed
    // into the next same-agent replacement.
    const harness = await startHarness({ schemaB: [] });
    try {
      const taskId = await taskOnA(harness);

      const cleared = await harness.request(
        "POST",
        `/api/v1/tasks/${taskId}/clear`,
        { agentId: AGENT_B },
      );
      assert.equal(cleared.status, 200);
      assert.equal(harness.store.getBindingAgent(taskId), AGENT_B);
      assert.equal(harness.agents.b.newSessions.length, 1);

      // Nothing was sent to B, and nothing of A's survived.
      assert.deepEqual(harness.agents.b.configWrites, []);
      const row = harness.store.getTask(taskId);
      assert.ok(row, "the task row still exists");
      assert.deepEqual(rowValues(row), {
        model: null,
        mode: null,
        reasoning_effort: null,
      });

      // The response cannot offer A's values either: B reported no options to
      // offer. "Absent" is the honest answer here — never a guess.
      const options = (cleared.json.configOptions ?? []) as Array<{
        currentValue?: unknown;
      }>;
      assert.deepEqual(options, []);
      assert.deepEqual(executionValues(cleared.json), {
        model: undefined,
        mode: undefined,
        reasoning_effort: undefined,
      });

      // A later same-agent replacement finds nothing to replay.
      const writesBefore = harness.agents.b.configWrites.length;
      const again = await harness.request(
        "POST",
        `/api/v1/tasks/${taskId}/clear`,
        {},
      );
      assert.equal(again.status, 200);
      assert.deepEqual(harness.agents.b.configWrites.slice(writesBefore), []);
      assert.deepEqual(rowValues(harness.store.getTask(taskId)!), {
        model: null,
        mode: null,
        reasoning_effort: null,
      });
    } finally {
      await harness.close();
    }
  });

  it("keeps a same-agent replacement's stored config", async () => {
    const harness = await startHarness();
    try {
      const taskId = await taskOnA(harness);
      const writesBefore = harness.agents.a.configWrites.length;

      const cleared = await harness.request(
        "POST",
        `/api/v1/tasks/${taskId}/clear`,
        {},
      );
      assert.equal(cleared.status, 200);
      assert.equal(harness.store.getBindingAgent(taskId), AGENT_A);

      // Regression guard: the replacement really inherited — the values were
      // sent into the new session, in the documented order.
      assert.deepEqual(harness.agents.a.configWrites.slice(writesBefore), [
        { taskId, id: "mode", value: A_CHOICES.mode },
        { taskId, id: "reasoning_effort", value: A_CHOICES.reasoning_effort },
        { taskId, id: "model", value: A_CHOICES.model },
      ]);
      assert.deepEqual(executionValues(cleared.json), A_CHOICES);
      assert.deepEqual(rowValues(harness.store.getTask(taskId)!), A_CHOICES);
    } finally {
      await harness.close();
    }
  });

  it("falls back to the agent cache when the replacement reports no config (documented boundary)", async () => {
    // A known boundary, not desired behavior: `model` / `mode` /
    // `reasoning_effort` are stored per task, but the *schema* they are rendered
    // into is cached per agent. A replacement that reports no `configOptions`
    // leaves the task's columns unknown, and null cannot override that cache —
    // so this task's reads show the values of another task on the same agent
    // until something reports for this one. Closing that needs the cache split
    // per task/session (or a "unknown" marker); it is deliberately out of scope
    // here, and this case exists so the boundary is visible before anyone
    // changes the overlay semantics.
    const harness = await startHarness({
      profiled: {
        // Two ordinary sessions first (the warm task's creation and its
        // rotation); the third — the one the cleared task materializes —
        // reports nothing at all.
        b: {
          newSessionSchema: (sessionIndex) =>
            sessionIndex === 3 ? [] : SCHEMA_B_FOR_BOUNDARY,
        },
      },
    });
    try {
      // Warm the shared cache through a *different* task on the same agent, and
      // give it a value that is not this agent's default: whatever this task
      // then shows did not come from its own row. A same-agent rotation is the
      // realistic way the cache learns those values (its config replay caches
      // the responses).
      const other = await harness.request("POST", "/api/v1/tasks", {
        cwd: harness.dir,
        agentId: AGENT_B,
      });
      assert.equal(other.status, 201);
      const otherId = String(other.json.id);
      const warm = await harness.request(
        "PUT",
        `/api/v1/tasks/${otherId}/reasoning-effort`,
        { value: "low" },
      );
      assert.equal(warm.status, 200);
      const warmRotation = await harness.request(
        "POST",
        `/api/v1/tasks/${otherId}/clear`,
        {},
      );
      assert.equal(warmRotation.status, 200);
      assert.deepEqual(executionValues(warmRotation.json), {
        model: "model-b2",
        mode: "agent",
        reasoning_effort: "low",
      });

      const taskId = await taskOnA(harness);
      const cleared = await harness.request(
        "POST",
        `/api/v1/tasks/${taskId}/clear`,
        { agentId: AGENT_B },
      );
      assert.equal(cleared.status, 200);
      assert.equal(harness.store.getBindingAgent(taskId), AGENT_B);

      // Nothing was adopted: the replacement had nothing to report.
      const row = harness.store.getTask(taskId);
      assert.ok(row, "the task row still exists");
      assert.deepEqual(rowValues(row), {
        model: null,
        mode: null,
        reasoning_effort: null,
      });
      assert.deepEqual(
        cleared.json.configOptions ?? [],
        [],
        "the response has no options to offer",
      );

      // Boundary: the read is the *other* task's session values, not this
      // task's (unknown) ones and not the agent's defaults.
      const detail = await harness.request("GET", `/api/v1/tasks/${taskId}`);
      assert.deepEqual(executionValues(detail.json), {
        model: "model-b2",
        mode: "agent",
        reasoning_effort: "low",
      });
      // The other task still reads its own values, so the fallback is a read of
      // the shared cache rather than a corruption of the warm task.
      const otherDetail = await harness.request(
        "GET",
        `/api/v1/tasks/${otherId}`,
      );
      assert.deepEqual(executionValues(otherDetail.json), {
        model: "model-b2",
        mode: "agent",
        reasoning_effort: "low",
      });
    } finally {
      await harness.close();
    }
  });

  it("drops the stored execution config when a removed owner is replaced", async () => {
    const harness = await startHarness();
    try {
      // The task ran on B with values that are not B's defaults either.
      const created = await harness.request("POST", "/api/v1/tasks", {
        cwd: harness.dir,
        agentId: AGENT_B,
      });
      assert.equal(created.status, 201);
      const taskId = String(created.json.id);
      const bChoices = {
        model: "model-b",
        mode: "chat#plan",
        reasoning_effort: "low",
      };
      await storeChoices(harness, taskId, bChoices);
      assert.deepEqual(rowValues(harness.store.getTask(taskId)!), bChoices);

      // B leaves the configuration: its tasks are taken over by the default
      // agent on next use, without going through an explicit clear.
      await harness.restart({ configured: ["a"], started: ["a"] });
      const writesBefore = harness.agents.a.configWrites.length;

      const resumed = await harness
        .tasks()
        .resumeTask(harness.agents.a.bridge, taskId);
      assert.equal(resumed.type, "task_created");
      assert.equal(harness.store.getBindingAgent(taskId), AGENT_A);
      assert.equal(
        harness.store.getAgentSessionId(taskId),
        `${AGENT_A}-session-1`,
      );

      // The takeover dropped B's values instead of sending them to A.
      assert.deepEqual(harness.agents.a.configWrites.slice(writesBefore), []);
      // The rotation is still recorded as the reason the execution moved.
      const rotations = harness.store
        .getEvents(taskId)
        .filter((event) => event.type === "system_message")
        .map((event) => JSON.parse(event.data) as Record<string, unknown>)
        .filter((data) => data.kind === "agent_rotation");
      assert.equal(rotations.length, 1);
      assert.equal(rotations[0].reason, "owner_removed");
      assert.equal(rotations[0].fromAgent, AGENT_B);
      assert.equal(rotations[0].toAgent, AGENT_A);

      // The replacement's own report is the task's read face.
      assert.deepEqual(executionValues(resumed), A_DEFAULTS);
      assert.deepEqual(rowValues(harness.store.getTask(taskId)!), A_DEFAULTS);
    } finally {
      await harness.close();
    }
  });
});
