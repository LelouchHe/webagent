import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentBridge } from "../src/bridge.ts";
import type { AgentEvent, ConfigOption } from "../src/types.ts";

const flatOptions: ConfigOption[] = [
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "provider/model-id",
    options: [
      {
        value: "provider/model-id",
        name: "provider/Human Name",
        description: "unchanged metadata",
        _meta: { retained: true },
      },
    ],
  },
];

function assertByteIdentical(actual: unknown): void {
  assert.equal(JSON.stringify(actual), JSON.stringify(flatOptions));
}

describe("flat model option ingress", () => {
  it("preserves flat payload bytes on every bridge schema ingress", async () => {
    let mapped = true;
    const bridge = new AgentBridge("unused", {
      getAgentSessionId: () => "session-1",
      getTaskId: (sessionId) =>
        mapped && sessionId === "session-1" ? "task-1" : undefined,
    });
    (bridge as any).loadSessionSupported = true;
    (bridge as any).conn = {
      newSession: async () => ({
        sessionId: "session-1",
        configOptions: flatOptions,
      }),
      loadSession: async () => ({ configOptions: flatOptions }),
      resumeSession: async () => ({ configOptions: flatOptions }),
      setSessionConfigOption: async () => ({ configOptions: flatOptions }),
    };

    const created = await bridge.newSession("/repo");
    assertByteIdentical(created.configOptions);

    const events: AgentEvent[] = [];
    bridge.on("event", (event: AgentEvent) => events.push(event));
    const loaded = await bridge.loadSession("task-1", "/repo");
    assertByteIdentical(loaded.configOptions);
    (bridge as any).sessionCapabilities = { resume: {} };
    const resumed = await bridge.loadSession("task-1", "/repo");
    assertByteIdentical(resumed.configOptions);
    for (const event of events.filter(
      (candidate) => candidate.type === "task_created",
    )) {
      assertByteIdentical(event.configOptions);
    }

    assertByteIdentical(
      await bridge.setConfigOption("task-1", "model", "provider/model-id"),
    );
    assertByteIdentical(
      await bridge.setAgentConfigOption(
        "session-1",
        "model",
        "provider/model-id",
      ),
    );

    await (bridge as any).handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: flatOptions,
      },
    });
    assertByteIdentical(
      events.filter((event) => event.type === "config_option_update").at(-1)
        ?.configOptions,
    );

    mapped = false;
    (bridge as any).pendingNewSessions = 1;
    await (bridge as any).handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: flatOptions,
      },
    });
    (bridge as any).pendingNewSessions = 0;
    mapped = true;
    bridge.sessionMapped("session-1");
    assertByteIdentical(
      events.filter((event) => event.type === "config_option_update").at(-1)
        ?.configOptions,
    );
  });
});
