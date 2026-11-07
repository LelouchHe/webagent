import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

// The decode verdict belongs to the browser, so a fake DOM has to be told what
// it "decoded": happy-dom reports naturalWidth 0 for every image and fires the
// load verdict itself, which would make every thumbnail look undecodable.
// Stubbing the accessor keeps these tests about our fallback branches rather
// than about the emulator's image pipeline.
let restoreNaturalWidth: (() => void) | null = null;

function stubIntrinsicWidth(width: number | ((src: string) => number)): void {
  restoreNaturalWidth?.();
  // The suite exposes only a subset of constructors on globalThis, so reach the
  // prototype through an element instead of HTMLImageElement.
  const proto = Object.getPrototypeOf(document.createElement("img"));
  const original = Object.getOwnPropertyDescriptor(proto, "naturalWidth");
  const widthFor = typeof width === "function" ? width : () => width;
  Object.defineProperty(proto, "naturalWidth", {
    configurable: true,
    get(this: HTMLImageElement) {
      return widthFor(this.src);
    },
  });
  restoreNaturalWidth = () => {
    if (original) Object.defineProperty(proto, "naturalWidth", original);
    else Reflect.deleteProperty(proto, "naturalWidth");
    restoreNaturalWidth = null;
  };
}

/** Let the environment deliver the load/error verdict for a src assignment. */
const settleImage = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

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
    restoreNaturalWidth?.();
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    // Default premise: this environment decodes image previews. Tests that need
    // the undecodable branch re-stub to 0.
    stubIntrinsicWidth(120);
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
  it("degrades an undecodable image thumbnail to a file chip", async () => {
    state.pendingAttachments.push({
      kind: "image",
      file: { name: "IMG_1040.HEIC", type: "image/heic" },
      mimeType: "image/heic",
      name: "IMG_1040.HEIC",
      previewUrl: "data:image/heic;base64,abc",
    });

    attachments.renderAttachPreview();
    await settleImage();
    const img = dom.attachPreview.querySelector(".attach-thumb img");
    assert.ok(img, "thumbnail first — the browser gets to try decoding");

    // A decode failure arrives after the element exists; that branch, not the
    // zero-size load branch, has to swap in the chip here.
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

  it("treats a thumbnail load with no intrinsic size as undecodable", async () => {
    // "Loaded, but the browser decoded nothing" — the verdict the chip
    // renderer must distrust even though no error fired.
    stubIntrinsicWidth(0);
    state.pendingAttachments.push({
      kind: "image",
      file: { name: "IMG_1040.HEIC", type: "image/heic" },
      mimeType: "image/heic",
      name: "IMG_1040.HEIC",
      previewUrl: "data:image/heic;base64,abc",
    });

    attachments.renderAttachPreview();
    await settleImage();

    assert.equal(
      dom.attachPreview.querySelectorAll(".attach-thumb img").length,
      0,
    );
    assert.ok(
      dom.attachPreview.querySelector(".attach-thumb.attach-file"),
      "zero-size load must degrade to the file chip",
    );
  });

  it("keeps the thumbnail for an image the browser can decode", async () => {
    state.pendingAttachments.push({
      kind: "image",
      file: { name: "x.png", type: "image/png" },
      mimeType: "image/png",
      name: "x.png",
      previewUrl: "data:image/png;base64,abc",
    });

    attachments.renderAttachPreview();
    await settleImage();

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
