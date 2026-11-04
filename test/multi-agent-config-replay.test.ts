import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { AgentBridge } from "../src/bridge.ts";
import { handleAgentEvent } from "../src/event-handler.ts";
import type { SseManager } from "../src/sse-manager.ts";
import { AGENT_B, startHarness } from "./fixtures/multi-agent-harness.ts";
import { makeEventHandlerConfig } from "./fixtures.ts";

/**
 * A `session/new` response is a snapshot of the moment it was produced, not the
 * session's last word: an agent may report a config change immediately
 * afterwards. While the session is not yet mapped to a task, the transport
 * queues those reports and replays them when the binding commits — which can
 * land *before* the rotation's own tail.
 *
 * The rotation's tail must therefore never treat its pre-rotation snapshot as
 * current. This is the real protocol order, through a real `AgentBridge` and a
 * real agent process; only the store in between is the test's.
 */

const FIXTURE = fileURLToPath(
  new URL(
    "./fixtures/config-report-after-new-session-agent.ts",
    import.meta.url,
  ),
);

describe("a config report that follows the session/new response", () => {
  it("outranks the initial report of the same replacement", async () => {
    const harness = await startHarness();
    const bridge = new AgentBridge(
      `${process.execPath} --experimental-strip-types ${FIXTURE}`,
      harness.store.sessionView(AGENT_B),
      AGENT_B,
    );
    const taskId = "replay-target";
    try {
      // No stored execution config: adopting the replacement's report is the
      // only writer, so any ordering mistake lands directly in the row.
      harness.store.createTask(taskId, harness.dir, "auto", AGENT_B, "b-old");
      const reports: Array<string | null> = [];
      bridge.on("event", (event) => {
        handleAgentEvent(
          event,
          harness.tasks(),
          harness.store,
          bridge,
          makeEventHandlerConfig({ cancelTimeout: 0, recentPathsLimit: 10 }),
          { broadcast() {} } as unknown as SseManager,
        );
        if (event.type === "config_option_update") {
          reports.push(harness.store.getTask(taskId)?.reasoning_effort ?? null);
        }
      });
      await bridge.start();

      // Same-agent replacement: the agent's own environment is unchanged, so
      // nothing is replayed from the task and the two reports are the only
      // writers.
      await harness.tasks().clearTask(bridge, taskId);

      // The queued report was replayed under the new generation and accepted.
      assert.deepEqual(reports, ["medium"]);
      // The newer report survives the rotation's tail: the initial value is
      // stale by the time it could be adopted.
      assert.equal(harness.store.getTask(taskId)?.reasoning_effort, "medium");
    } finally {
      await bridge.shutdown();
      await harness.close();
    }
  });
});
