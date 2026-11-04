import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AGENT_A, startHarness } from "./fixtures/multi-agent-harness.ts";

/**
 * Omitting a working directory means two different things on the two creation
 * entries: `/clear` keeps the task where it runs, `/new` uses the server
 * default. Callers must not be able to conflate them, and the parser/
 * interaction layer that will build `copilot:` coordinates relies on the
 * distinction being unchanged.
 */
describe("cwd defaults are not interchangeable", () => {
  it("keeps the task directory on clear and uses the server default on create", async () => {
    const harness = await startHarness();
    try {
      const sub = join(harness.dir, "project");
      mkdirSync(sub, { recursive: true });
      assert.notEqual(sub, harness.dir);

      const created = await harness.request("POST", "/api/v1/tasks", {
        cwd: sub,
        agentId: AGENT_A,
      });
      assert.equal(created.status, 201);
      const taskId = String(created.json.id);
      assert.equal(harness.store.getTask(taskId)?.cwd, sub);

      // Omitting `cwd` on clear means "stay where this task runs".
      const cleared = await harness.request(
        "POST",
        `/api/v1/tasks/${taskId}/clear`,
        {},
      );
      assert.equal(cleared.status, 200);
      assert.equal(harness.store.getTask(taskId)?.cwd, sub);
      assert.equal(harness.agents.a.newSessions.at(-1), sub);

      // Omitting it on create means "the server default", even as a child of a
      // task that runs elsewhere. The two omissions are not the same request.
      const child = await harness.request("POST", "/api/v1/tasks", {
        parentId: taskId,
      });
      assert.equal(child.status, 201);
      assert.equal(
        harness.store.getTask(String(child.json.id))?.cwd,
        harness.dir,
      );
      assert.equal(harness.agents.a.newSessions.at(-1), harness.dir);
    } finally {
      await harness.close();
    }
  });
});
