import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { attachmentDescriptor } from "../src/agent-image.ts";
import {
  projectMarkdownImageReferences,
  projectShareMarkdownImageReferences,
} from "../src/markdown-image-references.ts";
import { Store } from "../src/store.ts";
import { REAL_PNG } from "./tool-result-images-harness.ts";

describe("Markdown image reference projection", () => {
  let dir: string;
  let store: Store;
  let storedPath: string;
  const sourcePath = () => join(dir, "generated-source.png");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "webagent-md-image-ref-"));
    store = new Store(join(dir, "db"));
    store.createTask("t1", "/tmp", "auto", "test-agent");
    storedPath = join(dir, "stored.png");
    writeFileSync(storedPath, REAL_PNG);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function insert(taskId: string, id: string) {
    return store.insertAttachment({
      id,
      taskId,
      kind: "image",
      name: "generated-image-1",
      mime: "image/png",
      size: REAL_PNG.length,
      realpath: storedPath,
      width: 1,
      height: 1,
    });
  }

  it("keeps the first verified task-local binding and ignores malformed late updates", () => {
    const row = insert("t1", "11111111-1111-4111-8111-111111111111");
    const attachment = attachmentDescriptor("t1", row);
    const sourceUri = pathToFileURL(sourcePath()).href;
    store.saveEvent(
      "t1",
      "tool_call",
      {
        id: "call",
        title: "image_generation",
        kind: "other",
      },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "t1",
      "tool_call_update",
      {
        id: "call",
        status: "completed",
        content: [],
        recoveredCopilotImage: { sourceUri, attachment },
      },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "t1",
      "tool_call_update",
      {
        id: "call",
        status: "completed",
        content: [],
        recoveredCopilotImage: {
          sourceUri,
          attachment: { ...attachment, path: "/wrong.png" },
        },
      },
      { from_ref: "agent" },
    );

    assert.deepEqual(
      projectMarkdownImageReferences(store, "t1", store.getEvents("t1")),
      [{ sourceUri, attachment }],
    );
  });

  it("reconstructs an unambiguous legacy row without reading the saved_to file", () => {
    store.createTask("t2", "/tmp", "auto", "test-agent");
    const row = insert("t2", "22222222-2222-4222-8222-222222222222");
    const attachment = attachmentDescriptor("t2", row);
    writeFileSync(sourcePath(), REAL_PNG);
    const hash = createHash("sha256").update(REAL_PNG).digest("hex");
    store.saveEvent(
      "t2",
      "tool_call",
      {
        id: "legacy",
        title: "image_generation",
        kind: "other",
      },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "t2",
      "tool_call_update",
      {
        id: "legacy",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `image_id: sha256:${hash}\nsaved_to: ${sourcePath()}`,
            },
          },
          { type: "image", attachment },
        ],
      },
      { from_ref: "agent" },
    );
    unlinkSync(sourcePath());

    assert.deepEqual(
      projectMarkdownImageReferences(store, "t2", store.getEvents("t2")),
      [{ sourceUri: pathToFileURL(sourcePath()).href, attachment }],
    );
  });

  it("fails closed on ambiguous legacy descriptors and preserves the thumbnail data", () => {
    store.createTask("t2", "/tmp", "auto", "test-agent");
    const row = insert("t2", "33333333-3333-4333-8333-333333333333");
    const attachment = attachmentDescriptor("t2", row);
    const hash = createHash("sha256").update(REAL_PNG).digest("hex");
    store.saveEvent(
      "t2",
      "tool_call",
      {
        id: "legacy",
        title: "image_generation",
        kind: "other",
      },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "t2",
      "tool_call_update",
      {
        id: "legacy",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `image_id: sha256:${hash}\nsaved_to: ${sourcePath()}`,
            },
          },
          { type: "image", attachment },
          { type: "image", attachment },
        ],
      },
      { from_ref: "agent" },
    );

    assert.equal(
      projectMarkdownImageReferences(store, "t2", store.getEvents("t2")).length,
      0,
    );
    assert.equal(
      JSON.parse(store.getEvents("t2").at(-1)!.data).content.length,
      3,
    );
  });

  it("produces an opaque share projection and removes owner identities", () => {
    const row = insert("t1", "44444444-4444-4444-8444-444444444444");
    const attachment = attachmentDescriptor("t1", row);
    const sourceUri = pathToFileURL(join(dir, "secret", "generated.png")).href;
    store.saveEvent(
      "t1",
      "tool_call_update",
      {
        id: "call",
        status: "completed",
        recoveredCopilotImage: { sourceUri, attachment },
        content: [],
      },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "t1",
      "assistant_message",
      {
        text: `![screen](${sourceUri})`,
      },
      { from_ref: "agent" },
    );
    const events = store.getEvents("t1");
    const projected = projectShareMarkdownImageReferences(
      "a".repeat(24),
      projectMarkdownImageReferences(store, "t1", events),
      events,
    );
    const publicJson = JSON.stringify({ events, imageReferences: projected });
    assert.equal(publicJson.includes(sourceUri), false);
    assert.equal(
      publicJson.includes(join(dir, "secret", "generated.png")),
      false,
    );
    assert.equal(publicJson.includes("/api/v1/tasks/t1/attachments/"), false);
    assert.equal(publicJson.includes("recoveredCopilotImage"), false);
    assert.match(projected[0].attachment.path, /^\/s\/a{24}\/attachments\//);
  });
});
