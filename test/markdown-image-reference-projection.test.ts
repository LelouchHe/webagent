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
import { setupDOM, teardownDOM } from "./frontend-setup.ts";

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

  it("projects a split assistant image URI across the viewer merge boundary", async () => {
    const row = insert("t1", "66666666-6666-4666-8666-666666666666");
    const attachment = attachmentDescriptor("t1", row);
    const sourceUri = pathToFileURL(join(dir, "private", "generated.png")).href;
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
    const split = sourceUri.indexOf("/generated.png");
    store.saveEvent(
      "t1",
      "assistant_message",
      { text: `![screen](${sourceUri.slice(0, split)}` },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "t1",
      "assistant_message",
      { text: `${sourceUri.slice(split)})` },
      { from_ref: "agent" },
    );
    const events = store.getEvents("t1");
    const projected = projectShareMarkdownImageReferences(
      "b".repeat(24),
      projectMarkdownImageReferences(store, "t1", events),
      events,
    );
    const assistantEvents = events.filter(
      (event) => event.type === "assistant_message",
    );
    const combined = assistantEvents
      .map((event) => (JSON.parse(event.data) as { text: string }).text)
      .join("");
    assert.equal(assistantEvents.length, 2);
    assert.equal(combined.includes(sourceUri), false);
    assert.equal(combined.includes(projected[0].sourceUri), true);
    assert.equal(JSON.stringify(events).includes(join(dir, "private")), false);

    setupDOM();
    try {
      const references =
        await import("../public/js/markdown-image-references.ts");
      const markdown = await import("../public/js/markdown-stream.ts");
      references.setMarkdownImageReferenceScope("share:test", projected);
      const host = document.createElement("div");
      host.className = "msg assistant";
      markdown.updateMarkdownStream(host, combined);
      const image = host.querySelector("img.agent-image");
      assert.equal(image?.getAttribute("src"), projected[0].attachment.path);
      markdown.clearMarkdownImageHosts();
      references.clearMarkdownImageReferenceScope();
    } finally {
      teardownDOM();
    }
  });
});
