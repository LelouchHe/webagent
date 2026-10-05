import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentBridge } from "../src/bridge.ts";
import type { ConfigOption, ConfigSelectOption } from "../src/types.ts";

describe("model identity wire selection", () => {
  it("sends the exact wire value for each pathological advertised choice", async () => {
    const wireA = JSON.stringify(['["vendor-a","model', 'two"]']);
    const wireB = "vendor-a/model/two";
    const options: ConfigOption[] = [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: wireA,
        options: [
          { value: wireA, name: "Choice A" },
          { value: wireB, name: "Choice B" },
        ],
      },
    ];
    const sent: string[] = [];
    const bridge = new AgentBridge("unused", {
      getAgentSessionId: () => "session-1",
      getTaskId: () => "task-1",
    });
    (bridge as any).conn = {
      newSession: async () => ({
        sessionId: "session-1",
        configOptions: options,
      }),
      setSessionConfigOption: async (params: { value: string }) => {
        sent.push(params.value);
        return {
          configOptions: options.map((option) =>
            option.id === "model"
              ? { ...option, currentValue: params.value }
              : option,
          ),
        };
      },
    };

    const created = await bridge.newSession("/repo");
    const model = created.configOptions.find(
      (option): option is ConfigSelectOption =>
        option.id === "model" && "options" in option,
    );
    assert.ok(model);
    for (const choice of model.options) {
      await bridge.setConfigOption("task-1", "model", choice.value);
    }

    assert.deepEqual(sent, [wireA, wireB]);
  });
});
