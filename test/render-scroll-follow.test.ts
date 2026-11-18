import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("stored image scroll follow", () => {
  let callbacks: FrameRequestCallback[];
  let state: typeof import("../public/js/state.ts").state;
  let dom: typeof import("../public/js/state.ts").dom;
  let scrollToBottom: typeof import("../public/js/render.ts").scrollToBottom;

  before(async () => {
    setupDOM();
    callbacks = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    };
    const stateModule = await import("../public/js/state.ts");
    state = stateModule.state;
    dom = stateModule.dom;
    ({ scrollToBottom } = await import("../public/js/render.ts"));
    resetState(state, dom);
  });

  after(() => {
    teardownDOM();
  });

  it("cancels a queued bottom scroll when the user scrolls away", () => {
    Object.defineProperty(dom.messages, "scrollHeight", {
      configurable: true,
      get: () => 1000,
    });
    Object.defineProperty(dom.messages, "clientHeight", {
      configurable: true,
      get: () => 300,
    });
    state.followMessages = true;
    dom.messages.scrollTop = 700;

    scrollToBottom();
    assert.equal(callbacks.length, 1);

    dom.messages.dispatchEvent(new window.WheelEvent("wheel"));
    dom.messages.scrollTop = 0;
    dom.messages.dispatchEvent(new window.Event("scroll"));
    callbacks.shift()!(performance.now());

    assert.equal(dom.messages.scrollTop, 0);
    assert.equal(state.followMessages, false);
  });
});
