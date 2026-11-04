import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { AgentBridge } from "../src/bridge.ts";
import { handleAgentEvent } from "../src/event-handler.ts";
import type { SseManager } from "../src/sse-manager.ts";
import type { ConfigOption, AgentEvent } from "../src/types.ts";
import {
  AGENT_A,
  AGENT_B,
  startHarness,
} from "./fixtures/multi-agent-harness.ts";
import { makeEventHandlerConfig } from "./fixtures.ts";

/**
 * A cross-agent clear replaces the execution *environment*, so the task's
 * stored `model` / `mode` / `reasoning_effort` are not the new agent's
 * defaults and the rotation clears them.
 *
 * That clear must not overwrite a value the replacement generation already
 * reported. The transport queues config updates that arrive before the session
 * is mapped and replays them when the binding commits — which happens *before*
 * the rotation's tail. The real protocol order here is notification first, then
 * the `session/new` response, through a real agent process.
 */

const FIXTURE = fileURLToPath(
  new URL(
    "./fixtures/config-report-after-new-session-agent.ts",
    import.meta.url,
  ),
);

type ReportMode = "before" | "after" | "none";

function reasoningOf(configOptions: unknown): string | undefined {
  const options = Array.isArray(configOptions)
    ? (configOptions as ConfigOption[])
    : [];
  return options.find((option) => option.id === "reasoning_effort")
    ?.currentValue as string | undefined;
}

describe("a cross-agent clear of the stored execution config", () => {
  async function rotate(
    mode: ReportMode,
    stored: string,
  ): Promise<{
    taskId: string;
    reports: Array<string | null>;
    final: string | null;
    response: string | undefined;
  }> {
    const harness = await startHarness();
    const bridge = new AgentBridge(
      `${process.execPath} --experimental-strip-types ${FIXTURE} ${mode}`,
      harness.store.sessionView(AGENT_B),
      AGENT_B,
    );
    try {
      const created = await harness.request("POST", "/api/v1/tasks", {
        cwd: harness.dir,
        agentId: AGENT_A,
      });
      assert.equal(created.status, 201);
      const taskId = String(created.json.id);
      // The task ran on A with a value that is neither agent's default.
      harness.store.updateTaskConfig(taskId, "reasoning_effort", stored);

      const reports: Array<string | null> = [];
      bridge.on("event", (event: AgentEvent) => {
        handleAgentEvent(
          event,
          harness.tasks(),
          harness.store,
          bridge,
          makeEventHandlerConfig({ cancelTimeout: 0 }),
          { broadcast() {} } as unknown as SseManager,
        );
        if (event.type === "config_option_update") {
          reports.push(harness.store.getTask(taskId)?.reasoning_effort ?? null);
        }
      });
      await bridge.start();

      const cleared = await harness.tasks().clearTask(bridge, taskId);
      assert.equal(harness.store.getBindingAgent(taskId), AGENT_B);
      return {
        taskId,
        reports,
        final: harness.store.getTask(taskId)?.reasoning_effort ?? null,
        response: reasoningOf(cleared.configOptions),
      };
    } finally {
      await bridge.shutdown();
      await harness.close();
    }
  }

  it("keeps the replacement's newer report instead of its snapshot", async () => {
    // B reports `medium` *before* its `session/new` result, whose snapshot says
    // `high`. The replay is the newer fact and must survive the clear.
    const result = await rotate("before", "low");
    assert.deepEqual(
      result.reports,
      ["medium"],
      "the queued report must be accepted by the new generation",
    );
    assert.equal(
      result.final,
      "medium",
      "the clear must not roll the accepted report back to the snapshot",
    );
    assert.notEqual(result.final, "high");
    assert.equal(
      result.response,
      "medium",
      "the rotation's own read face must agree with the row",
    );
  });

  it("still clears the old value when the replacement never reported", async () => {
    // Control: the same cross-agent clear with a session that only sends its
    // `session/new` snapshot. `high` is B's default, so a leftover `low` would
    // mean the clear did not happen at all.
    const result = await rotate("none", "low");
    assert.deepEqual(result.reports, []);
    assert.equal(result.final, "high");
    assert.equal(result.response, "high");
  });
});
