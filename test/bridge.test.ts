import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentBridge } from "../src/bridge.ts";

describe("AgentBridge", () => {
  it("emits prompt_done when a prompt is cancelled", async () => {
    const bridge = new AgentBridge("fake-agent");
    const events: any[] = [];
    bridge.on("event", (event) => events.push(event));

    (bridge as any).conn = {
      prompt: async () => {
        throw new Error("Request cancelled by user");
      },
    };

    await bridge.prompt("s1", "hello");

    assert.deepEqual(events, [{
      type: "prompt_done",
      sessionId: "s1",
      stopReason: "cancelled",
    }]);
  });
});
