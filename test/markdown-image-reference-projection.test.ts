import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
