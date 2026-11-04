import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { storeToolResultImages } from "../src/tool-result-image.ts";
import { enrichEventForDisplay } from "../src/attachment-labels.ts";
import type { ToolContentItem } from "../src/types.ts";
import {
  LIMIT,
  attachmentOf,
  createToolResultImageHarness,
  disposeToolResultImageHarness,
  png,
  textOf,
  type ToolResultImageHarness,
} from "./tool-result-images-harness.ts";

/**
 * The normal path: an ACP image block inside a `tool_call_update`.
 *
 * ACP defines this shape, so any compliant agent can send it. The block is
 * stored through the same attachment pipeline an `agent_image` uses, and the
 * persisted/broadcast content carries the descriptor instead of the bytes.
 */
describe("tool-result images: ACP image blocks", () => {
  let harness: ToolResultImageHarness;
  let store: ToolResultImageHarness["store"];

  beforeEach(() => {
    harness = createToolResultImageHarness();
    store = harness.store;
  });

  afterEach(() => {
    disposeToolResultImageHarness(harness);
  });

  it("stores it as an attachment and persists a descriptor, never base64", () => {
    const base64 = png(200).toString("base64");
    harness.toolCall("t1", "Take a screenshot");
    harness.emit(
      harness.update("t1", [
        { type: "content", content: { type: "text", text: "here it is" } },
        { type: "image", mimeType: "image/png", data: base64 },
      ]),
    );

    const content = harness.storedContent();
    assert.equal(content.length, 2);
    const descriptor = attachmentOf(content[1]);
    assert.ok(descriptor);
    assert.equal(descriptor.kind, "image");
    assert.equal(descriptor.mimeType, "image/png");
    assert.equal(descriptor.displayName, "agent-image-1");
    assert.match(
      String(descriptor.path),
      /^\/api\/v1\/tasks\/t1\/attachments\/[0-9a-f-]+\.png$/,
    );
    assert.equal(String(descriptor.path).includes("?"), false);

    const row = store.getAttachment("t1", String(descriptor.attachmentId));
    assert.ok(row, "an attachments row must exist");
    assert.ok(existsSync(row.realpath));
    assert.equal(readFileSync(row.realpath).length, 200);

    // Neither the stored rows nor the live broadcast carries the bytes, and
    // the text block keeps its place.
    const stored = JSON.stringify(store.getEvents("t1"));
    assert.equal(stored.includes(base64), false);
    assert.equal(textOf(content), "here it is");
    const live = harness.broadcasts.find(
      (event) => event.type === "tool_call_update",
    );
    assert.ok(live);
    assert.equal(JSON.stringify(live).includes(base64), false);
    assert.equal((live as { content: ToolContentItem[] }).content.length, 2);
  });

  it("invalidates the cached label map after storing a tool image", () => {
    // An earlier SSE for this task cached the label map while it was empty, so
    // only invalidation can make the new attachment nameable.
    assert.equal(harness.tasks.getLabelMap("t1").size, 0);

    harness.toolCall("t1", "Screenshot");
    harness.emit(
      harness.update("t1", [
        {
          type: "image",
          mimeType: "image/png",
          data: png().toString("base64"),
        },
      ]),
    );

    const descriptor = attachmentOf(harness.storedContent()[0]);
    assert.ok(descriptor);
    const row = store.getAttachment("t1", String(descriptor.attachmentId));
    assert.ok(row);
    const enriched = enrichEventForDisplay(
      {
        type: "tool_call",
        taskId: "t1",
        id: "later",
        title: `wrote ${row.realpath}`,
        kind: "other",
      },
      harness.tasks.getLabelMap("t1"),
    ) as { title: string };
    assert.match(enriched.title, /agent-image-1/);
    assert.equal(enriched.title.includes(row.realpath), false);
  });

  it("accepts the wrapped block shape too, and ignores the claimed mime", () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(120, 3),
    ]);
    harness.toolCall("t1", "Screenshot");
    harness.emit(
      harness.update("t1", [
        {
          type: "content",
          content: {
            type: "image",
            mimeType: "image/png",
            data: bytes.toString("base64"),
          },
        },
      ]),
    );

    const content = harness.storedContent();
    assert.equal(content.length, 1);
    const descriptor = attachmentOf(content[0]);
    assert.ok(descriptor);
    assert.equal(descriptor.mimeType, "image/jpeg");
    assert.match(String(descriptor.path), /\.jpg$/);
  });

  it("replaces an oversized image with visible text and writes nothing", () => {
    harness.toolCall("t1", "Screenshot");
    harness.emit(
      harness.update("t1", [
        {
          type: "image",
          mimeType: "image/png",
          data: png(2 * 1024 * 1024).toString("base64"),
        },
      ]),
    );

    const content = harness.storedContent();
    assert.equal(content.length, 1);
    assert.equal(textOf(content), "[image omitted: 2 MB > 1 MB limit]");
    assert.equal(store.countAttachments("t1", "image"), 0);
    assert.equal(existsSync(join(harness.dir, "tasks", "t1")), false);

    const live = harness.broadcasts.find(
      (event) => event.type === "tool_call_update",
    ) as { content: ToolContentItem[] } | undefined;
    assert.ok(live);
    assert.equal(live.content.length, 1);
    assert.equal("data" in live.content[0], false);
    assert.match(textOf(live.content), /image omitted/);
  });

  it("replaces a non-image payload with visible text and writes nothing", () => {
    harness.toolCall("t1", "Screenshot");
    harness.emit(
      harness.update("t1", [
        {
          type: "image",
          mimeType: "image/png",
          data: Buffer.from("<svg>not storable</svg>").toString("base64"),
        },
      ]),
    );

    assert.match(textOf(harness.storedContent()), /image omitted/);
    assert.equal(store.countAttachments("t1", "image"), 0);
  });

  it("names successive images in order and leaves text-only updates alone", () => {
    harness.toolCall("t1", "Screenshots");
    harness.emit(
      harness.update("t1", [
        {
          type: "image",
          mimeType: "image/png",
          data: png().toString("base64"),
        },
        {
          type: "image",
          mimeType: "image/png",
          data: png().toString("base64"),
        },
      ]),
    );
    const names = harness
      .storedContent()
      .map((item) => attachmentOf(item)?.displayName);
    assert.deepEqual(names, ["agent-image-1", "agent-image-2"]);

    const textOnly: ToolContentItem[] = [
      { type: "content", content: { type: "text", text: "plain" } },
    ];
    const unchanged = storeToolResultImages(
      { store, dataDir: harness.dir, taskId: "t1", limitBytes: LIMIT },
      textOnly,
    );
    assert.equal(
      unchanged,
      textOnly,
      "nothing to do must leave content untouched",
    );
  });
});
