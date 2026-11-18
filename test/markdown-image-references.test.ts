import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";

let clearMarkdownImageHosts: typeof import("../public/js/markdown-stream.ts").clearMarkdownImageHosts;
let updateMarkdownStream: typeof import("../public/js/markdown-stream.ts").updateMarkdownStream;
let clearMarkdownImageReferenceScope: typeof import("../public/js/markdown-image-references.ts").clearMarkdownImageReferenceScope;
let registerMarkdownImageReference: typeof import("../public/js/markdown-image-references.ts").registerMarkdownImageReference;
let setMarkdownImageReferenceScope: typeof import("../public/js/markdown-image-references.ts").setMarkdownImageReferenceScope;

const sourceUri = "file:///tmp/generated.png";
const attachment = {
  kind: "image" as const,
  attachmentId: "attachment-1",
  displayName: "generated-image-1",
  mimeType: "image/png",
  path: "/api/v1/tasks/t1/attachments/attachment-1.png?exp=1&sig=abc",
  width: 8,
  height: 6,
};

describe("Markdown registered file images", () => {
  beforeEach(async () => {
    setupDOM();
    ({ clearMarkdownImageHosts, updateMarkdownStream } =
      await import("../public/js/markdown-stream.ts"));
    ({
      clearMarkdownImageReferenceScope,
      registerMarkdownImageReference,
      setMarkdownImageReferenceScope,
    } = await import("../public/js/markdown-image-references.ts"));
    setMarkdownImageReferenceScope("owner:t1", []);
  });

  afterEach(() => {
    clearMarkdownImageReferenceScope();
    clearMarkdownImageHosts();
    teardownDOM();
  });

  it("waits for a complete token, then renders one registered image once", () => {
    const host = document.createElement("article");
    host.className = "msg assistant";
    updateMarkdownStream(host, "before ![screen](");
    assert.equal(host.querySelector("img"), null);

    updateMarkdownStream(host, `before ![screen](${sourceUri}`);
    assert.equal(host.querySelector("img"), null);
    updateMarkdownStream(host, `before ![screen](${sourceUri}) after`);
    const unresolved = host.querySelector("img") as HTMLImageElement;
    assert.ok(unresolved);
    assert.equal(unresolved.hasAttribute("src"), false);

    registerMarkdownImageReference({ sourceUri, attachment });
    const images = host.querySelectorAll("img.agent-image");
    assert.equal(images.length, 1);
    assert.equal(images[0].getAttribute("src"), attachment.path);
    assert.equal(images[0].getAttribute("alt"), "screen");
    assert.equal((images[0] as HTMLImageElement).width, 8);
    assert.equal((images[0] as HTMLImageElement).height, 6);
  });

  it("does not resolve code-fenced or ordinary-link file text", () => {
    const host = document.createElement("article");
    host.className = "msg assistant";
    updateMarkdownStream(
      host,
      `\`\`\`\n![screen](${sourceUri})\n\`\`\`\n\n[open](${sourceUri})`,
    );
    registerMarkdownImageReference({ sourceUri, attachment });
    assert.equal(host.querySelector("img"), null);
    assert.equal(host.querySelector("a")?.hasAttribute("href"), false);
  });

  it("keeps DOMPurify strict for raw non-registered file images", () => {
    const host = document.createElement("article");
    host.className = "msg assistant";
    updateMarkdownStream(host, `<img src="${sourceUri}" alt="raw">`);
    const image = host.querySelector("img");
    assert.ok(image);
    assert.equal(image.hasAttribute("src"), false);
  });

  it("invalidates list and table subcaches on late association", () => {
    const list = document.createElement("article");
    const table = document.createElement("article");
    list.className = "msg assistant";
    table.className = "msg assistant";
    updateMarkdownStream(list, `- ![screen](${sourceUri})`);
    updateMarkdownStream(
      table,
      `| preview |\n| --- |\n| ![screen](${sourceUri}) |`,
    );
    const oldItem = list.querySelector("li");
    const oldRow = table.querySelector("tbody tr");

    registerMarkdownImageReference({ sourceUri, attachment });

    assert.notEqual(list.querySelector("li"), oldItem);
    assert.notEqual(table.querySelector("tbody tr"), oldRow);
    assert.equal(
      list.querySelector("img")?.getAttribute("src"),
      attachment.path,
    );
    assert.equal(
      table.querySelector("img")?.getAttribute("src"),
      attachment.path,
    );
  });

  it("keeps the first verified binding stable", () => {
    const host = document.createElement("article");
    host.className = "msg assistant";
    registerMarkdownImageReference({ sourceUri, attachment });
    updateMarkdownStream(host, `![screen](${sourceUri})`);
    registerMarkdownImageReference({
      sourceUri,
      attachment: { ...attachment, path: "/different.png" },
    });
    assert.equal(
      host.querySelector("img")?.getAttribute("src"),
      attachment.path,
    );
  });
});
