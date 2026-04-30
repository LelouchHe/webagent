import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("images", () => {
  let state: any;
  let dom: any;
  let images: any;
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
    images = await import("../public/js/images.ts");
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

  it("renders thumbnails and removes them when requested", () => {
    state.pendingImages.push({
      data: "abc",
      mimeType: "image/png",
      previewUrl: "data:image/png;base64,abc",
    });

    images.renderAttachPreview();
    assert.equal(dom.attachPreview.classList.contains("active"), true);
    assert.equal(dom.attachPreview.querySelectorAll(".attach-thumb").length, 1);

    dom.attachPreview.querySelector(".remove").click();
    assert.equal(state.pendingImages.length, 0);
    assert.equal(dom.attachPreview.classList.contains("active"), false);
  });

  it("opens the file picker from the attach button", () => {
    dom.attachBtn.click();
    assert.equal(clicked, 100);
  });

  it("adds selected image files to pending images", async () => {
    Object.defineProperty(dom.fileInput, "files", {
      configurable: true,
      value: [
        { type: "image/png", base64: "abc123" },
        { type: "text/plain", base64: "ignored" },
      ],
    });

    await dom.fileInput.onchange();

    assert.equal(state.pendingImages.length, 1);
    assert.partialDeepStrictEqual(state.pendingImages[0], {
      data: "abc123",
      mimeType: "image/png",
      previewUrl: "data:image/png;base64,abc123",
    });
    assert.equal(clicked, 1);
    assert.equal(dom.fileInput.value, "");
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
            return { type: "image/png", base64: "xyz789" };
          },
        },
      ],
    };

    dom.input.dispatchEvent(event);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(event.defaultPrevented, true);
    assert.equal(state.pendingImages.length, 1);
    assert.partialDeepStrictEqual(state.pendingImages[0], {
      data: "xyz789",
      mimeType: "image/png",
      previewUrl: "data:image/png;base64,xyz789",
    });
    assert.equal(clicked, 1);
  });
});
