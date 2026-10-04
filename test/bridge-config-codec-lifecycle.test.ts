import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentBridge } from "../src/bridge.ts";
import type { ConfigOption } from "../src/types.ts";

const modelOptions: ConfigOption[] = [
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "vendor-a/model-one",
    options: [{ value: "vendor-a/model-one", name: "Model One" }],
  },
];

describe("session model codec lifecycle", () => {
  it("does not let a setter response repopulate a retired session codec", async () => {
    let resolveResponse!: (value: { configOptions: ConfigOption[] }) => void;
    const response = new Promise<{ configOptions: ConfigOption[] }>(
      (resolve) => {
        resolveResponse = resolve;
      },
    );
    const bridge = new AgentBridge("unused", {
      getAgentSessionId: () => "session-1",
      getTaskId: () => "task-1",
    });
    (bridge as any).conn = {
      newSession: async () => ({
        sessionId: "session-1",
        configOptions: modelOptions,
      }),
      setSessionConfigOption: async () => response,
    };

    await bridge.newSession("/repo");
    const pendingSet = bridge.setConfigOption(
      "task-1",
      "model",
      "vendor-a/model-one",
    );
    await Promise.resolve();
    await bridge.retireExecution("session-1");
    resolveResponse({ configOptions: modelOptions });

    await assert.rejects(pendingSet, /ACP execution changed while setting/);
    assert.equal((bridge as any).modelValuesBySession.has("session-1"), false);
    assert.equal(
      (bridge as any).modelOptionIdsBySession.has("session-1"),
      false,
    );
  });

  it("rejects a late setter response after process replacement", async () => {
    let resolveResponse!: (value: { configOptions: ConfigOption[] }) => void;
    const response = new Promise<{ configOptions: ConfigOption[] }>(
      (resolve) => {
        resolveResponse = resolve;
      },
    );
    const bridge = new AgentBridge("unused", {
      getAgentSessionId: () => "session-1",
      getTaskId: () => "task-1",
    });
    (bridge as any).conn = {
      newSession: async () => ({
        sessionId: "session-1",
        configOptions: modelOptions,
      }),
      setSessionConfigOption: async () => response,
    };

    await bridge.newSession("/repo");
    const pendingSet = bridge.setConfigOption(
      "task-1",
      "model",
      "vendor-a/model-one",
    );
    await Promise.resolve();
    (bridge as any).clearSessionConfigCodecs();
    resolveResponse({ configOptions: modelOptions });

    await assert.rejects(pendingSet, /ACP execution changed while setting/);
    assert.equal((bridge as any).modelValuesBySession.has("session-1"), false);
  });

  it("clears session codecs when the agent process dies unexpectedly", () => {
    const bridge = new AgentBridge("unused", {
      getAgentSessionId: () => undefined,
      getTaskId: () => undefined,
    });
    (bridge as any).normalizeSessionConfigOptions("session-1", modelOptions);

    (bridge as any).markAgentDead("unexpected exit");

    assert.equal((bridge as any).modelValuesBySession.size, 0);
    assert.equal((bridge as any).modelOptionIdsBySession.size, 0);
    assert.equal((bridge as any).knownModelOptionIdsBySession.size, 0);
  });
});
