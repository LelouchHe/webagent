import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

/**
 * A tool result's image thumbnail.
 *
 * Live streaming and replay render through the same helper, so the two DOMs
 * must match byte for byte, and the thumbnail must open the same lightbox a
 * user's attachment and an agent's inline image already open.
 */
describe("tool-result image rendering", () => {
  let state: any;
  let dom: any;
  let events: any;
  let stateMod: any;

  const ATTACHMENT = {
    kind: "image",
    attachmentId: "att-1",
    displayName: "agent-image-1",
    mimeType: "image/png",
    path: "/api/v1/tasks/s1/attachments/att-1.png",
    width: 2,
    height: 2,
  };

  const CALL = {
    id: "tc-img",
    kind: "other",
    title: "Screenshot",
    rawInput: {},
  };

  const UPDATE = {
    id: "tc-img",
    status: "completed",
    content: [
      { type: "content", content: { type: "text", text: "here it is" } },
      { type: "image", attachment: ATTACHMENT },
    ],
  };

  before(async () => {
    setupDOM();
    stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    events = await import("../public/js/events.ts");
    // The lightbox installs its click delegate at import time.
    await import("../public/js/lightbox.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    stateMod.resetTaskUI();
    resetState(state, dom);
    dom.messages.innerHTML = "";
  });

  function renderLive() {
    events.handleEvent({ type: "tool_call", ...CALL });
    events.handleEvent({ type: "tool_call_update", ...UPDATE });
  }

  it("shows a thumbnail inside the tool card, from the stored path", () => {
    renderLive();

    const card = document.getElementById("tc-tc-img")!;
    const images = card.querySelector(".tc-images");
    assert.ok(images, "the card must hold an image container");
    const img = images.querySelector("img.tc-image") as HTMLImageElement;
    assert.ok(img);
    assert.equal(img.getAttribute("src"), ATTACHMENT.path);
    assert.equal(img.alt, "agent-image-1");
    assert.equal(img.loading, "lazy");
    // The picture sits with the label, before the text output disclosure.
    assert.ok(
      images.compareDocumentPosition(card.querySelector(".tc-output")!) &
        (globalThis as any).window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
    assert.equal(card.querySelector(".tc-content")?.textContent, "here it is");
  });

  it("reserves the picture's own size, not a fixed ceiling", () => {
    // The card's width decides the display size (CSS); the attributes only
    // reserve a proportional box before the bytes arrive, so they must carry
    // the image's own pixels rather than a 360px ceiling.
    events.handleEvent({ type: "tool_call", ...CALL });
    events.handleEvent({
      type: "tool_call_update",
      ...UPDATE,
      content: [
        {
          type: "image",
          attachment: { ...ATTACHMENT, width: 1600, height: 900 },
        },
      ],
    });

    const img = document.querySelector(
      "#tc-tc-img img.tc-image",
    ) as HTMLImageElement;
    assert.ok(img);
    assert.equal(img.getAttribute("width"), "1600");
    assert.equal(img.getAttribute("height"), "900");
  });

  it("opens the shared lightbox when the thumbnail is clicked", () => {
    renderLive();
    const img = document.querySelector(
      "#tc-tc-img img.tc-image",
    ) as HTMLImageElement;
    img.dispatchEvent(
      new (globalThis as any).window.MouseEvent("click", { bubbles: true }),
    );

    const overlay = document.getElementById("lightbox-overlay")!;
    assert.ok(overlay.classList.contains("active"));
    assert.equal(overlay.querySelector("img")!.getAttribute("src"), img.src);
  });

  it("clears the thumbnail when an update replaces content with an empty set", () => {
    renderLive();
    assert.ok(document.querySelector("#tc-tc-img .tc-images"));

    events.handleEvent({
      type: "tool_call_update",
      ...UPDATE,
      content: [],
    });

    const card = document.getElementById("tc-tc-img")!;
    assert.equal(card.querySelector(".tc-images"), null);
    assert.equal(card.querySelector("img.tc-image"), null);
  });

  it("keeps the thumbnail when an update omits content", () => {
    renderLive();
    const { content: _content, ...withoutContent } = UPDATE;
    events.handleEvent({
      type: "tool_call_update",
      ...withoutContent,
    });

    assert.ok(document.querySelector("#tc-tc-img img.tc-image"));
  });

  it("replays the cleared thumbnail too", () => {
    events.replayEvent("tool_call", CALL, [], 0);
    const rows = [
      { seq: 1, type: "tool_call", data: JSON.stringify(CALL) },
      { seq: 2, type: "tool_call_update", data: JSON.stringify(UPDATE) },
      {
        seq: 3,
        type: "tool_call_update",
        data: JSON.stringify({ ...UPDATE, content: [] }),
      },
    ];
    events.replayEvent("tool_call_update", UPDATE, rows, 1);
    events.replayEvent("tool_call_update", { ...UPDATE, content: [] }, rows, 2);

    assert.equal(document.querySelector("#tc-tc-img .tc-images"), null);
  });

  it("replays the same DOM the live path produced", () => {
    renderLive();
    const liveHtml = document.getElementById("tc-tc-img")!.outerHTML;

    stateMod.resetTaskUI();
    resetState(state, dom);
    dom.messages.innerHTML = "";

    events.replayEvent("tool_call", CALL, [], 0);
    events.replayEvent(
      "tool_call_update",
      UPDATE,
      [
        { seq: 1, type: "tool_call", data: CALL },
        { seq: 2, type: "tool_call_update", data: UPDATE },
      ],
      1,
    );

    const replayed = document.getElementById("tc-tc-img");
    assert.ok(replayed);
    assert.equal(replayed.outerHTML, liveHtml);
  });
});
