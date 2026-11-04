import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SseManager } from "../src/sse-manager.ts";
import type { ToolContentItem } from "../src/types.ts";
import {
  attachmentOf,
  createToolResultImageHarness,
  disposeToolResultImageHarness,
  png,
  type ToolResultImageHarness,
} from "./tool-result-images-harness.ts";

/**
 * The live SSE frame is `rawOutput`'s only egress: `saveEvent` omits the field,
 * so SQLite, `GET /events`, the MCP history tools and share pages never see it.
 * An agent that repeats the tool's content inside `rawOutput` would still put
 * the image's base64 on the wire, so the frame itself is what this asserts.
 */
describe("tool-result images: the live frame", () => {
  let harness: ToolResultImageHarness;
  let frames: string[];

  beforeEach(() => {
    frames = [];
    const sse = new SseManager();
    sse.add({
      id: "frame-client",
      taskId: "t1",
      res: {
        writableEnded: false,
        write(data: string) {
          frames.push(data);
          return true;
        },
        on() {},
      },
    } as unknown as Parameters<SseManager["add"]>[0]);
    harness = createToolResultImageHarness({ sseManager: sse });
  });

  afterEach(() => {
    disposeToolResultImageHarness(harness);
  });

  it("never carries an image payload the update repeats in rawOutput", () => {
    const bytes = png(256);
    const base64 = bytes.toString("base64");

    harness.toolCall("t1", "Screenshot");
    harness.emit({
      type: "tool_call_update",
      taskId: "t1",
      id: "t1",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "done" } },
        { type: "image", mimeType: "image/png", data: base64 },
      ],
      rawOutput: {
        progress: 100,
        result: {
          output: [
            { type: "content", content: { type: "text", text: "done" } },
            { type: "image", mimeType: "image/png", data: base64 },
          ],
          note: "kept as received",
        },
        attempts: [1, 2, 3],
      },
    });

    const frame = frames.join("");
    // Prove this is a real SSE write, not an empty capture.
    assert.match(frame, /^data: \{/);
    assert.equal(
      frame.includes(base64),
      false,
      "the wire frame must not carry the image's base64",
    );

    const updateFrame = frames
      .map((chunk) => chunk.replace(/^data: /, "").trim())
      .find((chunk) => chunk.includes('"rawOutput"'));
    assert.ok(updateFrame, "the tool_call_update frame must reach the client");
    const payload = JSON.parse(updateFrame) as {
      content: ToolContentItem[];
      rawOutput: {
        progress: number;
        result: {
          output: Array<Record<string, unknown>>;
          note: string;
        };
        attempts: number[];
      };
    };
    assert.equal(attachmentOf(payload.content[1])?.kind, "image");
    assert.equal("data" in (payload.content[1] as object), false);
    // `rawOutput` keeps its shape and every field, minus the payload.
    assert.deepEqual(payload.rawOutput, {
      progress: 100,
      result: {
        output: [
          { type: "content", content: { type: "text", text: "done" } },
          { type: "image", mimeType: "image/png", data: "" },
        ],
        note: "kept as received",
      },
      attempts: [1, 2, 3],
    });
  });
});
