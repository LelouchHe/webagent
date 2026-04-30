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
  });
});
