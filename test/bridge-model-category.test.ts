import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentBridge } from "../src/bridge.ts";
import type { ConfigOption } from "../src/types.ts";

const wireA = JSON.stringify(["vendor-a", "one"]);
const wireB = JSON.stringify(["vendor-b", "two"]);

function modelSchema(
  category: string | undefined,
  wireValue: string,
): ConfigOption[] {
  return [
    {
      type: "select",
      id: "selection",
      name: "Selection",
      ...(category === undefined ? {} : { category }),
      currentValue: wireValue,
      options: [{ value: wireValue, name: "Choice" }],
    },
  ];
}

function makeBridge() {
  const currentSchemas = new Map<string, ConfigOption[]>();
  const sent: Array<{ sessionId: string; configId: string; value: string }> =
    [];
  const bridge = new AgentBridge("unused", {
    getAgentSessionId: (taskId) =>
      taskId === "task-a" ? "session-a" : "session-b",
    getTaskId: (sessionId) =>
      sessionId === "session-a"
        ? "task-a"
        : sessionId === "session-b"
          ? "task-b"
          : undefined,
  });
  (bridge as any).conn = {
    setSessionConfigOption: async (params: {
      sessionId: string;
      configId: string;
      value: string;
    }) => {
      sent.push(params);
      return { configOptions: currentSchemas.get(params.sessionId) ?? [] };
    },
  };
  return {
    bridge,
    currentSchemas,
    sent,
    ingest: (sessionId: string, options: ConfigOption[]) => {
      currentSchemas.set(sessionId, options);
      (bridge as any).normalizeSessionConfigOptions(sessionId, options);
    },
  };
}

describe("current model category classification", () => {
  it("passes through a currently advertised choice when category disappears", async () => {
    const { bridge, ingest, sent } = makeBridge();
    ingest("session-a", modelSchema("model", wireA));
    const currentSchema = modelSchema(undefined, wireA);
    ingest("session-a", currentSchema);

    await bridge.setConfigOption("task-a", "selection", wireA);

    assert.deepEqual(sent, [
      { sessionId: "session-a", configId: "selection", value: wireA },
    ]);
  });

  it("uses current classification per session and passes through a repurposed id", async () => {
    const { bridge, ingest, currentSchemas, sent } = makeBridge();
    ingest("session-a", modelSchema("model", wireA));
    const repurposed: ConfigOption[] = [
      {
        type: "select",
        id: "selection",
        name: "Reasoning",
        category: "thought_level",
        currentValue: "high",
        options: [{ value: "high", name: "High" }],
      },
    ];
    ingest("session-a", repurposed);
    ingest("session-b", modelSchema("model", wireB));
    currentSchemas.set("session-a", repurposed);

    await bridge.setConfigOption("task-a", "selection", "high");
    await bridge.setConfigOption("task-b", "selection", "vendor-b/two");

    assert.deepEqual(sent, [
      { sessionId: "session-a", configId: "selection", value: "high" },
      { sessionId: "session-b", configId: "selection", value: wireB },
    ]);
  });

  it("keeps a previously classified id fail-closed after it is removed", async () => {
    const { bridge, ingest, sent } = makeBridge();
    ingest("session-a", modelSchema("model", wireA));
    ingest("session-a", []);

    await assert.rejects(
      bridge.setConfigOption("task-a", "selection", "vendor-a/one"),
      /cannot resolve model option for this session/,
    );
    assert.deepEqual(sent, []);
  });
});
