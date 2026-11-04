import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_A,
  AGENT_B,
  SCHEMA_A,
  SCHEMA_B,
  executionValues,
  startHarness,
  type Harness,
} from "./fixtures/multi-agent-harness.ts";

/**
 * Creating a task chooses its execution environment at creation time. A child
 * created on another agent than its parent is a *declared* divergence, not a
 * write through the wrong process — but that permission must not leak a value
 * from one agent's environment into another's.
 */

/** Bootstrap so Root exists and is bound to A: the parent side of the case. */
async function bootRootOnA(harness: Harness): Promise<string> {
  const boot = await harness.request("POST", "/api/v1/tasks/bootstrap");
  assert.equal(boot.status, 200);
  assert.equal(
    harness.store.getBindingAgent(harness.store.rootTaskId),
    AGENT_A,
  );
  assert.equal(harness.agents.a.newSessions.length, 1);
  return harness.store.rootTaskId;
}

describe("creating a task for a named agent", () => {
  it("binds the target agent and starts only that agent", async () => {
    const harness = await startHarness();
    try {
      const root = await bootRootOnA(harness);

      const created = await harness.request("POST", "/api/v1/tasks", {
        cwd: harness.dir,
        agentId: AGENT_B,
      });
      assert.equal(created.status, 201);
      assert.equal(created.json.agentId, AGENT_B);

      // The target agent created exactly one session; the parent's agent
      // created none. Counting sessions is the only way to tell "created for B"
      // from "created for A and then rotated to B".
      assert.equal(harness.agents.b.newSessions.length, 1);
      assert.equal(harness.agents.a.newSessions.length, 1);
      assert.equal(
        harness.store.getBindingAgent(String(created.json.id)),
        AGENT_B,
      );
      assert.equal(
        harness.store.getAgentSessionId(String(created.json.id)),
        `${AGENT_B}-session-1`,
      );
      // The parent's execution was not rewritten to make this happen.
      assert.equal(harness.store.getBindingAgent(root), AGENT_A);
      assert.equal(
        harness.store.getAgentSessionId(root),
        `${AGENT_A}-session-1`,
      );
      // Nothing was rotated: the child was never carried by another agent.
      assert.deepEqual(
        harness.store
          .getEvents(String(created.json.id))
          .filter((event) => event.type === "system_message")
          .map((event) => JSON.parse(event.data) as Record<string, unknown>)
          .filter((data) => data.kind === "agent_rotation"),
        [],
      );

      // The new task reports the target agent's own environment, not A's.
      assert.deepEqual(executionValues(created.json), {
        model: "model-b2",
        mode: "agent",
        reasoning_effort: "high",
      });
    } finally {
      await harness.close();
    }
  });

  it("keeps inheriting when the target agent is the source agent", async () => {
    const harness = await startHarness();
    try {
      const root = await bootRootOnA(harness);
      const source = await harness.request("POST", "/api/v1/tasks", {
        cwd: harness.dir,
        agentId: AGENT_A,
      });
      assert.equal(source.status, 201);
      const sourceId = String(source.json.id);
      const modelWrite = await harness.request(
        "PUT",
        `/api/v1/tasks/${sourceId}/model`,
        { value: "model-a2" },
      );
      assert.equal(modelWrite.status, 200);
      const thinkWrite = await harness.request(
        "PUT",
        `/api/v1/tasks/${sourceId}/reasoning-effort`,
        { value: "low" },
      );
      assert.equal(thinkWrite.status, 200);
      assert.equal(harness.store.getTask(sourceId)?.model, "model-a2");
      assert.equal(harness.store.getTask(sourceId)?.reasoning_effort, "low");

      // Regression guard: a same-agent child still inherits the source's
      // stored execution config, exactly as before.
      const writesBefore = harness.agents.a.configWrites.length;
      const child = await harness.request("POST", "/api/v1/tasks", {
        cwd: harness.dir,
        parentId: root,
        inheritFromTaskId: sourceId,
        agentId: AGENT_A,
      });
      assert.equal(child.status, 201);
      assert.deepEqual(harness.agents.a.configWrites.slice(writesBefore), [
        { taskId: String(child.json.id), id: "model", value: "model-a2" },
        {
          taskId: String(child.json.id),
          id: "reasoning_effort",
          value: "low",
        },
      ]);
      assert.deepEqual(executionValues(child.json), {
        model: "model-a2",
        mode: "agent",
        reasoning_effort: "low",
      });
    } finally {
      await harness.close();
    }
  });

  it("does not carry execution config to a different agent", async () => {
    const harness = await startHarness();
    try {
      const root = await bootRootOnA(harness);
      const source = await harness.request("POST", "/api/v1/tasks", {
        cwd: harness.dir,
        agentId: AGENT_A,
      });
      const sourceId = String(source.json.id);
      await harness.request("PUT", `/api/v1/tasks/${sourceId}/model`, {
        value: "model-a2",
      });
      await harness.request(
        "PUT",
        `/api/v1/tasks/${sourceId}/reasoning-effort`,
        {
          value: "low",
        },
      );
      assert.equal(harness.store.getTask(sourceId)?.model, "model-a2");

      const child = await harness.request("POST", "/api/v1/tasks", {
        cwd: harness.dir,
        parentId: root,
        inheritFromTaskId: sourceId,
        agentId: AGENT_B,
      });
      assert.equal(child.status, 201);
      assert.equal(child.json.agentId, AGENT_B);

      // A's values were never sent to B, not even as a rejected request.
      assert.deepEqual(harness.agents.b.configWrites, []);
      // The child reports B's own environment.
      assert.deepEqual(executionValues(child.json), {
        model: "model-b2",
        mode: "agent",
        reasoning_effort: "high",
      });
      const stored = harness.store.getTask(String(child.json.id));
      assert.ok(stored, "the child task row exists");
      assert.equal(stored.model, "model-b2");
      assert.equal(stored.mode, "agent");
      assert.equal(stored.reasoning_effort, "high");
    } finally {
      await harness.close();
    }
  });

  it("refuses an agent id that is not in the configuration", async () => {
    const harness = await startHarness();
    try {
      await bootRootOnA(harness);
      const sessionsBefore = {
        a: harness.agents.a.newSessions.length,
        b: harness.agents.b.newSessions.length,
      };
      const created = await harness.request("POST", "/api/v1/tasks", {
        cwd: harness.dir,
        agentId: "agent-z",
      });
      assert.equal(created.status, 400);
      assert.match(String(created.json.error), /not configured/);
      // Refused before anything starts, and nothing was substituted.
      assert.deepEqual(
        {
          a: harness.agents.a.newSessions.length,
          b: harness.agents.b.newSessions.length,
        },
        sessionsBefore,
      );
      assert.deepEqual(
        harness.store.listTasks().map((task) => task.id),
        [harness.store.rootTaskId],
      );
    } finally {
      await harness.close();
    }
  });

  it("refuses an agent id that is not a string", async () => {
    const harness = await startHarness();
    try {
      await bootRootOnA(harness);
      const created = await harness.request("POST", "/api/v1/tasks", {
        cwd: harness.dir,
        agentId: 7,
      });
      assert.equal(created.status, 400);
      assert.match(String(created.json.error), /agentId must be a string/);
    } finally {
      await harness.close();
    }
  });

  it("reports the real reason when the named agent cannot start", async () => {
    const harness = await startHarness({
      started: ["a"],
      resolveErrors: {
        [AGENT_B]: "spawn failed: ENOENT /opt/webagent/agent-b",
      },
    });
    try {
      await bootRootOnA(harness);
      const sessionCount = harness.agents.a.newSessions.length;
      const created = await harness.request("POST", "/api/v1/tasks", {
        cwd: harness.dir,
        agentId: AGENT_B,
      });
      assert.equal(created.status, 503);
      // The reason is preserved instead of being flattened into "unavailable":
      // the caller chose this agent and must be able to act on the failure.
      assert.match(
        String(created.json.error),
        /spawn failed: ENOENT \/opt\/webagent\/agent-b/,
      );
      // No silent substitution onto the parent's agent.
      assert.equal(harness.agents.a.newSessions.length, sessionCount);
      assert.deepEqual(
        harness.store.listTasks().map((task) => task.id),
        [harness.store.rootTaskId],
      );
    } finally {
      await harness.close();
    }
  });

  it("still refuses a child built through another agent's transport", async () => {
    const harness = await startHarness();
    try {
      const root = await bootRootOnA(harness);
      // A caller that resolved the wrong agent must not be able to create a
      // child under a parent carried by another one: the exception is "the
      // caller chose the target", not "any transport may create anywhere".
      await assert.rejects(
        () =>
          harness
            .tasks()
            .createTask(
              harness.agents.b.bridge,
              harness.dir,
              undefined,
              "auto",
              { parentId: root },
            ),
        /is bound to agent agent-a/,
      );
      assert.deepEqual(harness.agents.b.newSessions, []);
      assert.equal(harness.store.getBindingAgent(root), AGENT_A);

      // Naming the target is what makes it legal, and that is the same call.
      const created = await harness
        .tasks()
        .createTask(harness.agents.b.bridge, harness.dir, undefined, "auto", {
          parentId: root,
          agentId: AGENT_B,
        });
      assert.equal(harness.store.getBindingAgent(created.taskId), AGENT_B);
      assert.equal(harness.agents.b.newSessions.length, 1);
    } finally {
      await harness.close();
    }
  });

  it("still uses the parent's agent when no agent id is given", async () => {
    const harness = await startHarness();
    try {
      const root = await bootRootOnA(harness);
      const created = await harness.request("POST", "/api/v1/tasks", {
        cwd: harness.dir,
        parentId: root,
      });
      assert.equal(created.status, 201);
      assert.equal(created.json.agentId, AGENT_A);
      assert.equal(harness.agents.b.newSessions.length, 0);
      // The inherited default is still the source agent's own schema.
      assert.deepEqual(executionValues(created.json), {
        model: SCHEMA_A[0].currentValue,
        mode: SCHEMA_A[1].currentValue,
        reasoning_effort: SCHEMA_A[2].currentValue,
      });
      assert.notEqual(SCHEMA_A[0].currentValue, SCHEMA_B[0].currentValue);
    } finally {
      await harness.close();
    }
  });
});
