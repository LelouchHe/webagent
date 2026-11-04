import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_A,
  AGENT_B,
  A_CHOICES,
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

      // 4. A cold process over the same database reports the same values.
      await harness.restart();
      assert.deepEqual(
        rowValues(harness.store.getTask(taskId)!),
        B_DEFAULTS,
        "the values are durable, not process state",
      );
      // The cold read itself answers without a schema; the restore then
      // publishes what it learned, so read after it completed.
      await harness.tasks().ensureTaskLive(taskId);
      const cold = await harness.request("GET", `/api/v1/tasks/${taskId}`);
      assert.deepEqual(executionValues(cold.json), B_DEFAULTS);

      // 5. Going back to A starts from A's defaults, not from A's old choice.
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
