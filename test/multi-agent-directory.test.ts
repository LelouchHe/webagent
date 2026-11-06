import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_A,
  AGENT_B,
  startHarness,
} from "./fixtures/multi-agent-harness.ts";

/**
 * A client cannot offer "create this task on agent X" without knowing which
 * agents exist and what the server's default is. That directory is a
 * configuration fact, so it belongs to the metadata read face — and taking it
 * must never resolve or start an agent.
 *
 * The directory carries no liveness: it used to report a startup PATH probe as
 * `available`, which is stale as soon as a CLI is installed and silent about
 * handshake or authentication failures. Whether an agent can really run is
 * decided when one is started.
 */
describe("configured agent directory", () => {
  it("appears on the config read face as configuration order and ids only", async () => {
    const harness = await startHarness({
      // No transport is bound, so an adapter can only appear if the directory
      // read resolved an agent to answer.
      started: [],
    });
    try {
      const config = await harness.request("GET", "/api/v1/config");
      assert.equal(config.status, 200);
      assert.deepEqual(config.json.agents, [{ id: AGENT_A }, { id: AGENT_B }]);
      assert.equal(config.json.defaultAgentId, AGENT_A);
      // The entry is an id and nothing else: launch detail and PATH state stay
      // server-side.
      for (const entry of config.json.agents as Array<
        Record<string, unknown>
      >) {
        assert.deepEqual(Object.keys(entry), ["id"]);
      }
      // Taking the directory created no adapter and no ACP session.
      assert.equal(harness.env().existing(AGENT_A), undefined);
      assert.equal(harness.env().existing(AGENT_B), undefined);
      assert.deepEqual(harness.agents.a.newSessions, []);
      assert.deepEqual(harness.agents.b.newSessions, []);
    } finally {
      await harness.close();
    }
  });

  it("lists a configured agent that has no started transport", async () => {
    // Configuration is the fact, not whether a transport is bound: nothing is
    // started here, and both agents are listed anyway. (A configured agent
    // whose launch command is missing is covered where that condition is really
    // established: the `ghost` case in `test/e2e/agent-hint.spec.ts`.)
    const harness = await startHarness({ configured: ["a", "b"], started: [] });
    try {
      const config = await harness.request("GET", "/api/v1/config");
      assert.equal(config.status, 200);
      assert.deepEqual(
        (config.json.agents as Array<{ id: string }>).map(({ id }) => id),
        [AGENT_A, AGENT_B],
      );
    } finally {
      await harness.close();
    }
  });

  it("carries the same directory on every bootstrap response", async () => {
    const harness = await startHarness();
    try {
      // A fresh workspace: bootstrap materializes Root, which is a real
      // creation and therefore really starts the default agent.
      const first = await harness.request("POST", "/api/v1/tasks/bootstrap");
      assert.equal(first.status, 200);
      assert.equal(first.json.id, harness.store.rootTaskId);
      assert.equal(first.json.created, true);
      assert.deepEqual(first.json.agents, [{ id: AGENT_A }, { id: AGENT_B }]);
      assert.equal(first.json.defaultAgentId, AGENT_A);
      assert.equal(harness.agents.a.newSessions.length, 1);
      // Reporting the directory never starts the other agent.
      assert.deepEqual(harness.agents.b.newSessions, []);

      // The "resume my task" branch answers with the same directory.
      const second = await harness.request("POST", "/api/v1/tasks/bootstrap");
      assert.equal(second.status, 200);
      assert.equal(second.json.created, false);
      assert.deepEqual(second.json.agents, first.json.agents);
      assert.equal(second.json.defaultAgentId, AGENT_A);
      assert.deepEqual(harness.agents.b.newSessions, []);
    } finally {
      await harness.close();
    }
  });
});
