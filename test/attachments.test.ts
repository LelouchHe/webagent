import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("attachments", () => {
  let state: any;
  let dom: any;
  let attachments: any;
  let clicked = 0;

  class MockFileReader {
    result: string | null = null;
    onload: null | (() => void) = null;

    readAsDataURL(file: any) {
      this.result = `data:${file.type};base64,${file.base64}`;
      this.onload?.();
    }
  }

  before(async () => {
    setupDOM();
    globalThis.FileReader = MockFileReader as any;
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    attachments = await import("../public/js/attachments.ts");
    // Register input-action handlers (attach/send/...) so the attach button
    // click routes through the handler registry to fileInput.click().
    await import("../public/js/render.ts");
    await import("../public/js/events.ts");
    await import("../public/js/commands.ts");
    await import("../public/js/input.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    clicked = 0;
    dom.input.focus = () => {
      clicked += 1;
    };
    dom.fileInput.click = () => {
      clicked += 100;
    };
  });

  it("renders image thumbnails and removes them when requested", () => {
    state.pendingAttachments.push({
      kind: "image",
      file: { name: "x.png", type: "image/png" },
      mimeType: "image/png",
      name: "x.png",
      previewUrl: "data:image/png;base64,abc",
    });

    attachments.renderAttachPreview();
    assert.equal(dom.attachPreview.classList.contains("active"), true);
    assert.equal(dom.attachPreview.querySelectorAll(".attach-thumb").length, 1);
    assert.equal(
      dom.attachPreview.querySelectorAll(".attach-thumb img").length,
      1,
    );

    dom.attachPreview.querySelector(".remove").click();
    assert.equal(state.pendingAttachments.length, 0);
    assert.equal(dom.attachPreview.classList.contains("active"), false);
  });

  // Decode probe, not a mime allow-list: iOS/macOS Safari render HEIC
  // thumbnails, desktop Chrome does not (the reported IMG_1040.HEIC bug).
  it("degrades an undecodable image thumbnail to a file chip", () => {
    state.pendingAttachments.push({
      kind: "image",
      file: { name: "IMG_1040.HEIC", type: "image/heic" },
      mimeType: "image/heic",
      name: "IMG_1040.HEIC",
      previewUrl: "data:image/heic;base64,abc",
    });

    attachments.renderAttachPreview();
    const img = dom.attachPreview.querySelector(".attach-thumb img");
    assert.ok(img, "thumbnail first — the browser gets to try decoding");

    // happy-dom never decodes images, so the decode verdict is driven here.
    img.dispatchEvent(new globalThis.window.Event("error"));

    assert.equal(
      dom.attachPreview.querySelectorAll(".attach-thumb img").length,
      0,
      "undecodable thumbnail must be removed",
    );
    const chip = dom.attachPreview.querySelector(".attach-thumb.attach-file");
    assert.ok(chip, "undecodable image must degrade to the file chip");
    assert.ok(
      chip.textContent.includes("IMG_1040.HEIC"),
      "file chip shows the original name",
    );
    assert.equal(
      chip.querySelectorAll(".remove").length,
      1,
      "remove button survives the swap",
    );
    assert.equal(state.pendingAttachments.length, 1);
  });

  it("treats a thumbnail load with no intrinsic size as undecodable", () => {
    state.pendingAttachments.push({
      kind: "image",
      file: { name: "IMG_1040.HEIC", type: "image/heic" },
      mimeType: "image/heic",
      name: "IMG_1040.HEIC",
      previewUrl: "data:image/heic;base64,abc",
    });

    attachments.renderAttachPreview();
    const img = dom.attachPreview.querySelector(".attach-thumb img");
    // happy-dom reports naturalWidth 0 for every image: the "loaded but
    // not decodable" signal the chip renderer must distrust.
    assert.equal(img.naturalWidth, 0);
    img.dispatchEvent(new globalThis.window.Event("load"));

    assert.equal(
      dom.attachPreview.querySelectorAll(".attach-thumb img").length,
      0,
    );
    assert.ok(
      dom.attachPreview.querySelector(".attach-thumb.attach-file"),
      "zero-size load must degrade to the file chip",
    );
  });

  it("keeps the thumbnail for an image the browser can decode", () => {
    state.pendingAttachments.push({
      kind: "image",
      file: { name: "x.png", type: "image/png" },
      mimeType: "image/png",
      name: "x.png",
      previewUrl: "data:image/png;base64,abc",
    });

    attachments.renderAttachPreview();
    const img = dom.attachPreview.querySelector(".attach-thumb img");
    Object.defineProperty(img, "naturalWidth", {
      value: 120,
      configurable: true,
    });
    img.dispatchEvent(new globalThis.window.Event("load"));

    assert.equal(
      dom.attachPreview.querySelectorAll(".attach-thumb img").length,
      1,
      "decodable thumbnail must stay an <img>",
    );
    assert.equal(
      dom.attachPreview.querySelectorAll(".attach-thumb.attach-file").length,
      0,
      "decodable image must NOT become a file chip",
    );
  });

  it("renders non-image attachments as a text chip", () => {
    state.pendingAttachments.push({
      kind: "file",
      file: { name: "notes.txt", type: "text/plain" },
      mimeType: "text/plain",
      name: "notes.txt",
    });

    attachments.renderAttachPreview();
    assert.equal(
      dom.attachPreview.querySelectorAll(".attach-thumb.attach-file").length,
      1,
    );
    assert.equal(
      dom.attachPreview.querySelectorAll(".attach-thumb img").length,
      0,
    );
    assert.ok(
      dom.attachPreview.textContent.includes("notes.txt"),
      "chip shows file name",
    );
  });

  it("opens the file picker from the attach button", () => {
    dom.attachBtn.click();
    assert.equal(clicked, 100);
  });

  it("adds selected files (any type) to pending attachments", async () => {
    Object.defineProperty(dom.fileInput, "files", {
      configurable: true,
      value: [
        { type: "image/png", base64: "abc123", name: "p.png" },
        { type: "text/plain", base64: "ignored", name: "n.txt" },
      ],
    });

    await dom.fileInput.onchange();

    assert.equal(state.pendingAttachments.length, 2);
    assert.partialDeepStrictEqual(state.pendingAttachments[0], {
      kind: "image",
      mimeType: "image/png",
      name: "p.png",
      previewUrl: "data:image/png;base64,abc123",
    });
    assert.partialDeepStrictEqual(state.pendingAttachments[1], {
      kind: "file",
      mimeType: "text/plain",
      name: "n.txt",
    });
    assert.equal(state.pendingAttachments[1].previewUrl, undefined);
    assert.equal(dom.fileInput.value, "");
    assert.equal(clicked, 0);
  });

  it("adds pasted images and prevents the default paste behavior", async () => {
    const event = new window.Event("paste", {
      bubbles: true,
      cancelable: true,
    }) as any;
    event.clipboardData = {
      items: [
        {
          type: "image/png",
          getAsFile() {
            return { type: "image/png", base64: "xyz789", name: "pasted.png" };
          },
        },
      ],
    };

    dom.input.dispatchEvent(event);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(event.defaultPrevented, true);
    assert.equal(state.pendingAttachments.length, 1);
    assert.partialDeepStrictEqual(state.pendingAttachments[0], {
      kind: "image",
      mimeType: "image/png",
      previewUrl: "data:image/png;base64,xyz789",
    });
    assert.equal(clicked, 0);
  });
});
