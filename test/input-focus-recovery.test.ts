import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("input focus recovery", () => {
  let state: any;
  let dom: any;
  let focusRecovery: any;
  let blurCount = 0;
  let focusCount = 0;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    focusRecovery = await import("../public/js/input-focus-recovery.ts");
    focusRecovery.installInputFocusRecovery();
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    blurCount = 0;
    focusCount = 0;
    Object.defineProperty(window, "innerHeight", {
      value: 650,
      configurable: true,
    });
    Object.defineProperty(window, "visualViewport", {
      value: {
        height: 650,
        offsetTop: 0,
        scale: 1,
        addEventListener: () => {},
      },
      configurable: true,
    });
    dom.input.blur = () => {
      blurCount += 1;
      Object.defineProperty(document, "activeElement", {
        value: document.body,
        configurable: true,
      });
    };
    dom.input.focus = () => {
      focusCount += 1;
      Object.defineProperty(document, "activeElement", {
        value: dom.input,
        configurable: true,
      });
    };
  });

  function pointerDown(target: Element, pointerType = "touch"): void {
    const event = new window.Event("pointerdown", {
      bubbles: true,
      cancelable: true,
    }) as Event & { pointerType?: string };
    event.pointerType = pointerType;
    target.dispatchEvent(event);
  }

  it("unlocks stale mobile focus when touch lands on the already-active input", () => {
    Object.defineProperty(document, "activeElement", {
      value: dom.input,
      configurable: true,
    });

    pointerDown(dom.input);

    assert.equal(blurCount, 1);
    assert.equal(focusCount, 0);
    assert.equal(document.activeElement, document.body);
  });

  it("unlocks stale mobile focus when touch lands on the input area", () => {
    Object.defineProperty(document, "activeElement", {
      value: dom.input,
      configurable: true,
    });

    pointerDown(dom.inputArea);

    assert.equal(blurCount, 1);
    assert.equal(focusCount, 0);
    assert.equal(document.activeElement, document.body);
  });

  it("does not recover when the virtual keyboard already appears open", () => {
    Object.defineProperty(window, "visualViewport", {
      value: {
        height: 420,
        offsetTop: 0,
        scale: 1,
        addEventListener: () => {},
      },
      configurable: true,
    });
    Object.defineProperty(document, "activeElement", {
      value: dom.input,
      configurable: true,
    });

    pointerDown(dom.input);

    assert.equal(blurCount, 0);
    assert.equal(focusCount, 0);
  });

  it("does not recover when the input is disabled", () => {
    Object.defineProperty(document, "activeElement", {
      value: dom.input,
      configurable: true,
    });
    dom.input.disabled = true;

    pointerDown(dom.input);

    assert.equal(blurCount, 0);
    assert.equal(focusCount, 0);
  });

  it("does not recover for desktop pointer events", () => {
    Object.defineProperty(document, "activeElement", {
      value: dom.input,
      configurable: true,
    });

    pointerDown(dom.input, "mouse");
    pointerDown(dom.input, "pen");

    assert.equal(blurCount, 0);
    assert.equal(focusCount, 0);
  });

  it("does not recover when visualViewport is unavailable", () => {
    Object.defineProperty(window, "visualViewport", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(document, "activeElement", {
      value: dom.input,
      configurable: true,
    });

    pointerDown(dom.input);

    assert.equal(blurCount, 0);
    assert.equal(focusCount, 0);
  });
});
