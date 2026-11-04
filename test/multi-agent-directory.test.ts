import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkAgentAvailability } from "../src/agent-availability.ts";
import {
  AGENT_A,
  AGENT_B,
  startHarness,
} from "./fixtures/multi-agent-harness.ts";

/**
 * A client cannot offer "create this task on agent X" without knowing which
 * agents exist, what the server's default is, and which of them could start.
 * That directory is a configuration fact, so it belongs to the metadata read
 * face — and taking it must never resolve or start an agent.
 */
describe("configured agent directory", () => {
  it("appears on the config read face with PATH availability and the default agent", async () => {
    // Availability comes from the real PATH with two controlled commands: one
    // binary that exists (this test runner's runtime) and one that cannot. The
    // expectation is built from those facts, not from the response under test.
    const snapshot = checkAgentAvailability({
      [AGENT_A]: { cmd: "node --acp" },
      [AGENT_B]: { cmd: "webagent-definitely-missing-agent --acp" },
    });
    assert.deepEqual(
      snapshot.map(({ id, available }) => ({ id, available })),
      [
        { id: AGENT_A, available: true },
        { id: AGENT_B, available: false },
      ],
      "the controlled PATH must produce one available and one missing agent",
    );

    const harness = await startHarness({
      agentAvailability: snapshot,
      // No transport is bound, so an adapter can only appear if the directory
      // read resolved an agent to answer.
      started: [],
    });
    try {
      const config = await harness.request("GET", "/api/v1/config");
      assert.equal(config.status, 200);
      assert.deepEqual(config.json.agents, [
        { id: AGENT_A, available: true },
        { id: AGENT_B, available: false },
      ]);
      assert.equal(config.json.defaultAgentId, AGENT_A);
      // The directory is id + availability: launch detail stays server-side.
      for (const entry of config.json.agents as Array<
        Record<string, unknown>
      >) {
        assert.deepEqual(Object.keys(entry).sort(), ["available", "id"]);
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

  it("carries the same directory on every bootstrap response", async () => {
    const snapshot = checkAgentAvailability({
      [AGENT_A]: { cmd: "node --acp" },
      [AGENT_B]: { cmd: "webagent-definitely-missing-agent --acp" },
    });
    const harness = await startHarness({ agentAvailability: snapshot });
    try {
      // A fresh workspace: bootstrap materializes Root, which is a real
      // creation and therefore really starts the default agent.
      const first = await harness.request("POST", "/api/v1/tasks/bootstrap");
      assert.equal(first.status, 200);
      assert.equal(first.json.id, harness.store.rootTaskId);
      assert.equal(first.json.created, true);
      assert.deepEqual(first.json.agents, [
        { id: AGENT_A, available: true },
        { id: AGENT_B, available: false },
      ]);
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
