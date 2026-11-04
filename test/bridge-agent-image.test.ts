import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentBridge } from "../src/bridge.ts";
import type { AgentEvent } from "../src/types.ts";

/**
 * An agent's inline image reaches the transcript as an event carrying the
 * agent's own base64 — nothing is decoded, rewritten, or written to disk. The
 * event stream is the only carrier, so the mapping is also the only place that
 * can decide an image is too large to carry.
 */

const mappedTasks = {
  getAgentSessionId(taskId: string) {
    return taskId === "web-1" ? "agent-1" : taskId;
  },
  getTaskId(taskId: string) {
    return taskId === "agent-1" ? "web-1" : taskId;
  },
};

/** Base64 of exactly `bytes` decoded bytes. */
function base64Of(bytes: number): string {
  return Buffer.alloc(bytes).toString("base64");
}

function collect(bridge: AgentBridge): AgentEvent[] {
  const events: AgentEvent[] = [];
  bridge.on("event", (event) => events.push(event as AgentEvent));
  return events;
}

async function emitImage(
  bridge: AgentBridge,
  content: Record<string, unknown>,
): Promise<AgentEvent[]> {
  const events = collect(bridge);
  await (bridge as any).handleSessionUpdate({
    sessionId: "agent-1",
    update: { sessionUpdate: "agent_message_chunk", content },
  });
  return events;
}

describe("inline agent images", () => {
  it("carries the agent's base64 payload as a message chunk", async () => {
    const bridge = new AgentBridge("fake-agent", mappedTasks);
    const events = await emitImage(bridge, {
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    });

    assert.deepEqual(events, [
      {
        type: "message_chunk",
        taskId: "web-1",
        text: "",
        images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }],
      },
    ]);
  });

  it("keeps one image per chunk", async () => {
    const bridge = new AgentBridge("fake-agent", mappedTasks);
    const events = collect(bridge);
    for (const payload of ["AAAA", "BBBB"]) {
      await (bridge as any).handleSessionUpdate({
        sessionId: "agent-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "image", mimeType: "image/png", data: payload },
        },
      });
    }

    assert.equal(events.length, 2);
    for (const [index, event] of events.entries()) {
      const images = (event as { images?: unknown[] }).images ?? [];
      assert.equal(images.length, 1, "a chunk never batches images");
      assert.equal(
        (images[0] as { data: string }).data,
        index === 0 ? "AAAA" : "BBBB",
      );
    }
  });

  it("reports an oversized image instead of carrying it", async () => {
    const bridge = new AgentBridge("fake-agent", mappedTasks);
    bridge.setImageInlineLimit(2 * 1024 * 1024);
    const events = await emitImage(bridge, {
      type: "image",
      mimeType: "image/png",
      // 3 MiB decoded: above the limit, so the bytes must not travel.
      data: base64Of(3 * 1024 * 1024),
    });

    assert.equal(events.length, 1);
    const event = events[0] as Extract<AgentEvent, { type: "message_chunk" }>;
    assert.equal(event.type, "message_chunk");
    assert.equal(event.images, undefined);
    assert.match(event.text, /^\[image omitted: 3 MB > 2 MB limit\]$/);
  });

  it("inlines an image exactly at the limit", async () => {
    const bridge = new AgentBridge("fake-agent", mappedTasks);
    bridge.setImageInlineLimit(1024);
    const events = await emitImage(bridge, {
      type: "image",
      mimeType: "image/jpeg",
      data: base64Of(1024),
    });

    const event = events[0] as Extract<AgentEvent, { type: "message_chunk" }>;
    assert.equal(event.images?.length, 1);
    assert.equal(event.text, "");
  });

  it("still drops an image in a thought chunk", async () => {
    const bridge = new AgentBridge("fake-agent", mappedTasks);
    const events = collect(bridge);
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

  it("reports an empty image payload instead of emitting nothing", async () => {
    const bridge = new AgentBridge("fake-agent", mappedTasks);
    const events = await emitImage(bridge, {
      type: "image",
      mimeType: "image/png",
      data: "",
    });
    assert.deepEqual(events, [
      {
        type: "message_chunk",
        taskId: "web-1",
        text: "[image omitted: empty]",
      },
    ]);
  });
});
