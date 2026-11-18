import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM } from "./frontend-setup.ts";
import type { AgentImageAttachment } from "../src/types.ts";

let applyStoredImageProps: typeof import("../public/js/stored-image.ts").applyStoredImageProps;
let serializeStoredImage: typeof import("../public/js/stored-image.ts").serializeStoredImage;
let storedImageProps: typeof import("../public/js/stored-image.ts").storedImageProps;

const attachment: AgentImageAttachment = {
  kind: "image",
  attachmentId: "image-1",
  displayName: 'generated "image"',
  mimeType: "image/png",
  path: "/api/v1/tasks/t1/attachments/image-1.png?exp=1&sig=abc",
  width: 320.4,
  height: 200.2,
};

describe("stored image view model", () => {
  before(async () => {
    setupDOM();
    ({ applyStoredImageProps, serializeStoredImage, storedImageProps } =
      await import("../public/js/stored-image.ts"));
  });

  after(() => {
    teardownDOM();
  });

  it("shares rewrite, class, lazy, alt and natural dimensions with DOM images", () => {
    const props = storedImageProps(attachment, {
      className: "tc-image",
      rewriteSrc: () => "/share/image.png",
    });
    const image = applyStoredImageProps(document.createElement("img"), props);

    assert.deepEqual(props, {
      className: "tc-image",
      alt: attachment.displayName,
      src: "/share/image.png",
      loading: "lazy",
      width: 320,
      height: 200,
    });
    assert.equal(image.className, "tc-image");
    assert.equal(image.alt, attachment.displayName);
    assert.equal(image.getAttribute("src"), "/share/image.png");
    assert.equal(image.loading, "lazy");
    assert.equal(image.getAttribute("width"), "320");
    assert.equal(image.getAttribute("height"), "200");
  });

  it("serializes controlled Markdown image props with the token alt", () => {
    const props = storedImageProps(attachment, {
      className: "agent-image",
      alt: 'screen "preview" & <detail>',
    });
    const html = serializeStoredImage(props, 'title "quoted"');
    const host = document.createElement("div");
    host.innerHTML = html;
    const image = host.querySelector("img")!;

    assert.equal(image.className, "agent-image");
    assert.equal(image.alt, 'screen "preview" & <detail>');
    assert.equal(image.title, 'title "quoted"');
    assert.equal(image.getAttribute("src"), attachment.path);
    assert.equal(image.loading, "lazy");
    assert.equal(image.getAttribute("width"), "320");
    assert.equal(image.getAttribute("height"), "200");
  });

  it("omits attachment URL and invalid dimensions for an unresolved image", () => {
    const props = storedImageProps(
      { ...attachment, width: -1, height: Number.POSITIVE_INFINITY },
      { className: "agent-image", alt: "pending" },
    );
    assert.equal(props.src, attachment.path);
    assert.equal("width" in props, false);
    assert.equal("height" in props, false);

    const unresolved = storedImageProps(null, {
      className: "agent-image",
      alt: "pending",
    });
    assert.equal(unresolved.src, null);
    assert.equal(serializeStoredImage(unresolved).includes(" src="), false);
  });
});
