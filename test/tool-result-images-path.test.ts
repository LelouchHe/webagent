import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContentItem } from "../src/types.ts";
import { enrichEventForDisplay } from "../src/attachment-labels.ts";
import {
  REAL_PNG,
  attachmentOf,
  createToolResultImageHarness,
  disposeToolResultImageHarness,
  png,
  sha256,
  textOf,
  type ToolResultImageHarness,
} from "./tool-result-images-harness.ts";

/**
 * A tool result that only names the file it wrote.
 *
 * This covers the temporary shim in `src/agent-compatibility/` that turns an
 * `image_generation` text result into the same stored attachment the normal
 * path produces. Delete these tests with that one file.
 *
 * Every capture condition is pinned here: all three markers, the sha256 match,
 * the container sniff, the size ceiling, and one row per content hash.
 */
describe("tool-result images: a named image file", () => {
  let harness: ToolResultImageHarness;
  let store: ToolResultImageHarness["store"];
  let imagePath: string;

  beforeEach(() => {
    harness = createToolResultImageHarness();
    store = harness.store;
    imagePath = join(harness.dir, "image-generated.png");
    writeFileSync(imagePath, REAL_PNG);
  });

  afterEach(() => {
    disposeToolResultImageHarness(harness);
  });

  function markerText(path: string, hash: string): string {
    return [
      "Image generated successfully.",
      `image_id: sha256:${hash}`,
      `saved_to: ${path}`,
    ].join("\n");
  }

  function textItem(text: string): ToolContentItem {
    return { type: "content", content: { type: "text", text } };
  }

  function generated(
    id: string,
    path = imagePath,
    hash = sha256(REAL_PNG),
    title = "image_generation",
  ) {
    harness.toolCall(id, title);
    harness.emit(harness.update(id, [textItem(markerText(path, hash))]));
  }

  it("copies the file, records the row and appends the descriptor", () => {
    generated("t1");

    const content = harness.storedContent();
    assert.equal(content.length, 2);
    // The tool's own text is still there; the picture is additive.
    assert.match(textOf(content), /Image generated successfully/);
    const descriptor = attachmentOf(content[1]);
    assert.ok(descriptor);
    assert.equal(descriptor.kind, "image");
    assert.equal(descriptor.mimeType, "image/png");
    assert.equal(descriptor.displayName, "generated-image-1");
    const row = store.getAttachment("t1", String(descriptor.attachmentId));
    assert.ok(row);
    // Copied, never moved: the tool's file is still on disk.
    assert.ok(existsSync(imagePath));
    assert.deepEqual(readFileSync(row.realpath), REAL_PNG);
    assert.notEqual(row.realpath, imagePath);
    // `REAL_PNG` is a real 1x1 PNG, so the recovered row is measured too.
    assert.equal(row.width, 1);
    assert.equal(row.height, 1);
    assert.equal(descriptor.width, 1);
    assert.equal(descriptor.height, 1);
    // The descriptor is a reference, and the persisted row never carries the
    // file's actual payload. Compute the expectation from the fixture bytes:
    // checking for the literal string "base64" would pass on any payload.
    assert.equal("data" in descriptor, false);
    const encoded = REAL_PNG.toString("base64");
    assert.equal(
      JSON.stringify(store.getEvents("t1")).includes(encoded.slice(0, 32)),
      false,
    );
  });

  it("invalidates the cached label map after storing the recovered image", () => {
    assert.equal(harness.tasks.getLabelMap("t1").size, 0);

    generated("t1");

    const descriptor = attachmentOf(harness.storedContent()[1]);
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
    assert.match(enriched.title, /generated-image-1/);
    assert.equal(enriched.title.includes(row.realpath), false);
  });

  it("does not invalidate the label cache when a duplicate row is reused", () => {
    let invalidations = 0;
    const original = harness.tasks.invalidateLabelCache.bind(harness.tasks);
    harness.tasks.invalidateLabelCache = (taskId: string) => {
      invalidations++;
      original(taskId);
    };

    generated("t1");
    assert.equal(store.countAttachments("t1", "image"), 1);
    const afterFirst = invalidations;
    assert.equal(afterFirst, 1, "the first image inserted a row");

    // Identical bytes: `findStoredCopy` reuses the existing row, so the cache
    // has nothing new to learn and must not be dropped again.
    generated("t1");
    assert.equal(store.countAttachments("t1", "image"), 1);
    assert.equal(invalidations, afterFirst);
  });

  it("resolves the tool call's title when the update omits it", () => {
    harness.toolCall("t1", "image_generation");
    harness.emit(
      harness.update("t1", [textItem(markerText(imagePath, sha256(REAL_PNG)))]),
    );
    assert.equal(store.countAttachments("t1", "image"), 1);
  });

  it("refuses a file whose bytes do not match the marker's sha256", () => {
    generated("t1", imagePath, sha256(Buffer.from("something else")));
    assert.equal(store.countAttachments("t1", "image"), 0);
    assert.equal(harness.storedContent().length, 1);
  });

  it("refuses a file that is not a storable image container", () => {
    const notAnImage = join(harness.dir, "image-generated.txt");
    const bytes = Buffer.from("definitely not a png");
    writeFileSync(notAnImage, bytes);
    generated("t1", notAnImage, sha256(bytes));
    assert.equal(store.countAttachments("t1", "image"), 0);
  });

  it("refuses a file above the image limit", () => {
    const huge = join(harness.dir, "image-huge.png");
    const bytes = png(2 * 1024 * 1024);
    writeFileSync(huge, bytes);
    generated("t1", huge, sha256(bytes));
    assert.equal(store.countAttachments("t1", "image"), 0);
  });

  it("refuses an unreadable saved_to path", () => {
    generated("t1", join(harness.dir, "does-not-exist.png"));
    assert.equal(store.countAttachments("t1", "image"), 0);
    assert.equal(harness.storedContent().length, 1);
  });

  it("stores identical bytes once, and later updates reuse the row", () => {
    generated("t1");
    harness.emit(
      harness.update("t1", [textItem(markerText(imagePath, sha256(REAL_PNG)))]),
    );
    assert.equal(store.countAttachments("t1", "image"), 1);

    const rows = store
      .getEvents("t1")
      .filter((event) => event.type === "tool_call_update");
    assert.equal(rows.length, 2);
    const attachments = rows.map((event) =>
      attachmentOf(
        (JSON.parse(event.data) as { content: ToolContentItem[] }).content[1],
      ),
    );
    assert.equal(attachments[0]?.attachmentId, attachments[1]?.attachmentId);
  });

  it("does nothing when any one marker is missing", () => {
    const hash = sha256(REAL_PNG);

    // Missing the title marker.
    generated("t1", imagePath, hash, "some_other_tool");
    // Missing saved_to.
    harness.toolCall("t2", "image_generation");
    harness.emit(
      harness.update("t2", [
        textItem(`Image generated successfully.\nimage_id: sha256:${hash}`),
      ]),
    );
    // Missing image_id.
    harness.toolCall("t3", "image_generation");
    harness.emit(
      harness.update("t3", [
        textItem(`Image generated successfully.\nsaved_to: ${imagePath}`),
      ]),
    );
    // A relative path is not an absolute saved_to.
    harness.toolCall("t4", "image_generation");
    harness.emit(
      harness.update("t4", [textItem(markerText("relative/image.png", hash))]),
    );

    assert.equal(store.countAttachments("t1", "image"), 0);
    for (const id of ["t1", "t2", "t3", "t4"]) {
      const row = store
        .getEvents("t1")
        .find(
          (event) =>
            event.type === "tool_call_update" &&
            (JSON.parse(event.data) as { id: string }).id === id,
        );
      assert.ok(row);
      assert.equal(
        (JSON.parse(row.data) as { content: ToolContentItem[] }).content.length,
        1,
      );
    }
  });
});
