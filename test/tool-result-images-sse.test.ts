import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SseManager } from "../src/sse-manager.ts";
import type { Store } from "../src/store.ts";
import { stripRawOutputImageData } from "../src/tool-result-image.ts";
import type { ToolContentItem } from "../src/types.ts";
import {
  attachmentOf,
  createToolResultImageHarness,
  disposeToolResultImageHarness,
  png,
  textOf,
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

  /** A harness writing real SSE frames into `frames`. */
  function createHarness(
    extra: Partial<Parameters<typeof createToolResultImageHarness>[0]> = {},
  ): ToolResultImageHarness {
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
    return createToolResultImageHarness({ sseManager: sse, ...extra });
  }

  /**
   * The harness store with one attachments-table call broken.
   *
   * This is what an unavailable `attachments` table looks like from the handler:
   * a throw, not a returned error. `countAttachments` is the first touch, so its
   * failure is the one that used to hand the raw content back for persistence.
   */
  function storeWith(fail: {
    countAttachments?: boolean;
    insertAttachment?: (call: number) => boolean;
  }): (store: Store) => Store {
    return (real) => {
      let inserts = 0;
      return new Proxy(real, {
        get(target, prop) {
          if (prop === "countAttachments" && fail.countAttachments) {
            return () => {
              throw new Error("attachments table unavailable");
            };
          }
          if (prop === "insertAttachment" && fail.insertAttachment) {
            const decide = fail.insertAttachment;
            return (...args: unknown[]) => {
              inserts++;
              if (decide(inserts)) {
                throw new Error("attachments table unavailable");
              }
              return (
                target.insertAttachment as (...rest: unknown[]) => unknown
              )(...args);
            };
          }
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
  }

  beforeEach(() => {
    frames = [];
    harness = createHarness();
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

  it("stores an image nested in a content wrapper's metadata", () => {
    const base64 = png(256).toString("base64");

    harness.toolCall("t1", "Screenshot");
    harness.emit({
      type: "tool_call_update",
      taskId: "t1",
      id: "t1",
      status: "completed",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "kept",
            // A wrapper's own metadata. It is not `item._meta`, so a walk that
            // only looked there left the payload in SQLite and on the wire.
            _meta: {
              nested: { type: "image", mimeType: "image/png", data: base64 },
            },
          },
        },
      ] as unknown as ToolContentItem[],
    });

    assert.equal(harness.store.countAttachments("t1", "image"), 1);
    assert.equal(
      JSON.stringify(harness.store.getEvents("t1")).includes(base64),
      false,
      "SQLite must not hold the payload",
    );

    const frame = frames.join("");
    assert.match(frame, /^data: \{/);
    assert.equal(
      frame.includes(base64),
      false,
      "the wire frame must not carry it",
    );

    // The descriptor sits where the payload was, and the text is untouched.
    const content = harness.storedContent();
    assert.equal(textOf(content), "kept");
    const inner = (
      content[0] as {
        content?: { _meta?: { nested?: ToolContentItem } };
      }
    ).content;
    assert.equal(attachmentOf(inner!._meta!.nested!)?.kind, "image");
  });

  it("degrades to a placeholder when the attachments table is unavailable", () => {
    // `countAttachments` is the first attachments-table touch. Its failure used
    // to return the content as received, so the raw payload was persisted and
    // broadcast; degrading is a placeholder, never a pass-through.
    disposeToolResultImageHarness(harness);
    harness = createHarness({
      decorateStore: storeWith({ countAttachments: true }),
    });
    const first = png(128).toString("base64");
    const second = png(192).toString("base64");

    harness.toolCall("t1", "Screenshots");
    harness.emit({
      type: "tool_call_update",
      taskId: "t1",
      id: "t1",
      status: "completed",
      content: [
        { type: "image", mimeType: "image/png", data: first },
        { type: "image", mimeType: "image/png", data: second },
      ],
    });

    // The event is the record: it is stored and broadcast, not lost.
    const rows = harness.store.getEvents("t1");
    assert.equal(
      rows.filter((row) => row.type === "tool_call_update").length,
      1,
    );
    const frame = frames.join("");
    assert.match(frame, /^data: \{/);

    // The count only names new files, so both pictures are still stored.
    const content = harness.storedContent();
    assert.equal(attachmentOf(content[0])?.kind, "image");
    assert.equal(attachmentOf(content[1])?.kind, "image");

    // Neither the row nor the frame carries a payload.
    const stored = JSON.stringify(rows);
    for (const payload of [first, second]) {
      assert.equal(stored.includes(payload), false, "SQLite must stay clean");
      assert.equal(frame.includes(payload), false, "the frame must stay clean");
    }
  });

  it("stores the siblings and degrades only the block whose write failed", () => {
    disposeToolResultImageHarness(harness);
    harness = createHarness({
      decorateStore: storeWith({ insertAttachment: (call) => call === 2 }),
    });
    const first = png(128).toString("base64");
    const second = png(192).toString("base64");

    harness.toolCall("t1", "Screenshots");
    harness.emit({
      type: "tool_call_update",
      taskId: "t1",
      id: "t1",
      status: "completed",
      content: [
        { type: "image", mimeType: "image/png", data: first },
        { type: "image", mimeType: "image/png", data: second },
      ],
    });

    const content = harness.storedContent();
    // The first picture is a descriptor, the failed one a visible placeholder.
    assert.equal(attachmentOf(content[0])?.kind, "image");
    assert.equal(textOf(content), "[image omitted: could not be stored]");

    const stored = JSON.stringify(harness.store.getEvents("t1"));
    const frame = frames.join("");
    assert.match(frame, /^data: \{/);
    for (const payload of [first, second]) {
      assert.equal(stored.includes(payload), false, "SQLite must stay clean");
      assert.equal(frame.includes(payload), false, "the frame must stay clean");
    }
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
