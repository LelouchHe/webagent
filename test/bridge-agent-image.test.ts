import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentBridge } from "../src/bridge.ts";
import type { AgentEvent } from "../src/types.ts";

/**
 * An agent's inline image must leave the transport as an event, not be dropped.
 * The bridge hands over the agent's own block; turning it into an attachment
 * (file, row, unsigned path) is the event handler's job, because only that
 * layer has the store and the task's data root.
 */

const mappedTasks = {
  getAgentSessionId(taskId: string) {
    return taskId === "web-1" ? "agent-1" : taskId;
  },
  getTaskId(taskId: string) {
    return taskId === "agent-1" ? "web-1" : taskId;
  },
};

async function emitImage(
  bridge: AgentBridge,
  content: Record<string, unknown>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  bridge.on("event", (event) => events.push(event as AgentEvent));
  await (bridge as any).handleSessionUpdate({
    sessionId: "agent-1",
    update: { sessionUpdate: "agent_message_chunk", content },
  });
  return events;
}

describe("an agent image block", () => {
  it("leaves the transport as an agent_image event carrying the block", async () => {
    const bridge = new AgentBridge("fake-agent", mappedTasks);
    const events = await emitImage(bridge, {
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    });

    assert.deepEqual(events, [
      {
        type: "agent_image",
        taskId: "web-1",
        block: { mimeType: "image/png", data: "iVBORw0KGgo=" },
      },
    ]);
  });

  it("emits one image per chunk", async () => {
    const bridge = new AgentBridge("fake-agent", mappedTasks);
    const events: AgentEvent[] = [];
    bridge.on("event", (event) => events.push(event as AgentEvent));
    for (const payload of ["AAAA", "BBBB"]) {
      await (bridge as any).handleSessionUpdate({
        sessionId: "agent-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "image", mimeType: "image/png", data: payload },
        },
      });
    }

    assert.deepEqual(
      events.map(
        (event) => (event as { block?: { data: string } }).block?.data,
      ),
      ["AAAA", "BBBB"],
    );
  });

  it("still drops an image in a thought chunk", async () => {
    const bridge = new AgentBridge("fake-agent", mappedTasks);
    const events: AgentEvent[] = [];
    bridge.on("event", (event) => events.push(event as AgentEvent));
    await (bridge as any).handleSessionUpdate({
      sessionId: "agent-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "image", mimeType: "image/png", data: "AAAA" },
      },
    });
    assert.deepEqual(events, []);
  });

  it("leaves a text chunk unchanged", async () => {
    const bridge = new AgentBridge("fake-agent", mappedTasks);
    const events = await emitImage(bridge, { type: "text", text: "hello" });
    assert.deepEqual(events, [
      { type: "message_chunk", taskId: "web-1", text: "hello" },
    ]);
  });
});
