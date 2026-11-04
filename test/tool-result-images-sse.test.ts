import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SseManager } from "../src/sse-manager.ts";
import { stripRawOutputImageData } from "../src/tool-result-image.ts";
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

  it("clears an image payload nested inside an image block's metadata", () => {
    const bytes = png(256);
    const base64 = bytes.toString("base64");

    harness.toolCall("t1", "Screenshot");
    harness.emit({
      type: "tool_call_update",
      taskId: "t1",
      id: "t1",
      status: "completed",
      rawOutput: {
        type: "image",
        mimeType: "image/png",
        data: base64,
        // ACP image blocks may carry metadata, and that metadata can hold
        // another image block. `data` on the outer block is not the only
        // payload in this subtree.
        _meta: {
          content: [{ type: "image", mimeType: "image/png", data: base64 }],
          label: "kept",
        },
      },
    });

    const frame = frames.join("");
    assert.equal(frame.includes(base64), false);

    const updateFrame = frames
      .map((chunk) => chunk.replace(/^data: /, "").trim())
      .find((chunk) => chunk.includes('"rawOutput"'));
    assert.ok(updateFrame, "the tool_call_update frame must reach the client");
    const payload = JSON.parse(updateFrame) as {
      rawOutput: {
        type: string;
        mimeType: string;
        data: string;
        _meta: { content: Array<Record<string, unknown>>; label: string };
      };
    };
    assert.deepEqual(payload.rawOutput, {
      type: "image",
      mimeType: "image/png",
      data: "",
      _meta: {
        content: [{ type: "image", mimeType: "image/png", data: "" }],
        label: "kept",
      },
    });
  });
});

describe("rawOutput cloning", () => {
  it("keeps a __proto__ field as an own property", () => {
    // `JSON.parse` creates own data properties, `__proto__` included. A clone
    // through a plain `{}` would run the prototype setter and drop the field.
    const value = JSON.parse(
      '{"__proto__":{"note":"kept"},"text":"kept","data":"not an image"}',
    ) as Record<string, unknown>;
    const stripped = stripRawOutputImageData(value) as Record<string, unknown>;

    assert.equal(Object.hasOwn(stripped, "__proto__"), true);
    assert.equal(JSON.stringify(stripped), JSON.stringify(value));
    assert.match(JSON.stringify(stripped), /"__proto__":\{"note":"kept"\}/);
    assert.match(JSON.stringify(stripped), /"data":"not an image"/);
  });
});
