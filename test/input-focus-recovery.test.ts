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

  function setInputActive(): void {
    Object.defineProperty(document, "activeElement", {
      value: dom.input,
      configurable: true,
    });
  }

  function pointer(
    type: "pointerdown" | "pointerup" | "pointercancel",
    target: Element,
    opts: {
      pointerType?: string;
      pointerId?: number;
      clientX?: number;
      clientY?: number;
      timeStamp?: number;
    } = {},
  ): void {
    const event = new window.Event(type, {
      bubbles: true,
      cancelable: true,
    }) as Event & {
      pointerType?: string;
      pointerId?: number;
      clientX?: number;
      clientY?: number;
    };
    event.pointerType = opts.pointerType ?? "touch";
    event.pointerId = opts.pointerId ?? 1;
    event.clientX = opts.clientX ?? 0;
    event.clientY = opts.clientY ?? 0;
    Object.defineProperty(event, "timeStamp", {
      value: opts.timeStamp ?? 0,
      configurable: true,
    });
    target.dispatchEvent(event);
  }

  function shortTap(target: Element): void {
    pointer("pointerdown", target, {
      timeStamp: 100,
      clientX: 10,
      clientY: 10,
    });
    pointer("pointerup", target, { timeStamp: 180, clientX: 12, clientY: 12 });
  }

  it("does not blur on pointerdown so long-press menus can start", () => {
    setInputActive();

    pointer("pointerdown", dom.input, { timeStamp: 100 });

    assert.equal(blurCount, 0);
    assert.equal(focusCount, 0);
    assert.equal(document.activeElement, dom.input);
  });

  it("unlocks stale mobile focus on a short tap of the already-active input", () => {
    setInputActive();

    shortTap(dom.input);

    assert.equal(blurCount, 1);
    assert.equal(focusCount, 0);
    assert.equal(document.activeElement, document.body);
  });

  it("does not recover from touches on the surrounding input area", () => {
    setInputActive();

    shortTap(dom.inputArea);

    assert.equal(blurCount, 0);
    assert.equal(focusCount, 0);
    assert.equal(document.activeElement, dom.input);
  });

  it("does not recover from a long press", () => {
    setInputActive();

    pointer("pointerdown", dom.input, {
      timeStamp: 100,
      clientX: 10,
      clientY: 10,
    });
    pointer("pointerup", dom.input, {
      timeStamp: 700,
      clientX: 10,
      clientY: 10,
    });

    assert.equal(blurCount, 0);
    assert.equal(focusCount, 0);
    assert.equal(document.activeElement, dom.input);
  });

  it("does not recover after pointer movement", () => {
    setInputActive();

    pointer("pointerdown", dom.input, {
      timeStamp: 100,
      clientX: 10,
      clientY: 10,
    });
    pointer("pointerup", dom.input, {
      timeStamp: 180,
      clientX: 40,
      clientY: 10,
    });

    assert.equal(blurCount, 0);
    assert.equal(focusCount, 0);
    assert.equal(document.activeElement, dom.input);
  });

  it("does not recover after pointer cancellation", () => {
    setInputActive();

    pointer("pointerdown", dom.input, { timeStamp: 100 });
    pointer("pointercancel", dom.input, { timeStamp: 120 });
    pointer("pointerup", dom.input, { timeStamp: 180 });

    assert.equal(blurCount, 0);
    assert.equal(focusCount, 0);
    assert.equal(document.activeElement, dom.input);
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
    setInputActive();

    shortTap(dom.input);

    assert.equal(blurCount, 0);
    assert.equal(focusCount, 0);
  });

  it("does not recover when the input is disabled", () => {
    setInputActive();
    dom.input.disabled = true;

    shortTap(dom.input);

    assert.equal(blurCount, 0);
    assert.equal(focusCount, 0);
  });

  it("does not recover for desktop pointer events", () => {
    setInputActive();

    pointer("pointerdown", dom.input, { pointerType: "mouse", timeStamp: 100 });
    pointer("pointerup", dom.input, { pointerType: "mouse", timeStamp: 180 });
    pointer("pointerdown", dom.input, { pointerType: "pen", timeStamp: 200 });
    pointer("pointerup", dom.input, { pointerType: "pen", timeStamp: 280 });

    assert.equal(blurCount, 0);
    assert.equal(focusCount, 0);
  });

  it("does not recover when visualViewport is unavailable", () => {
    Object.defineProperty(window, "visualViewport", {
      value: undefined,
      configurable: true,
    });
    setInputActive();

    shortTap(dom.input);

    assert.equal(blurCount, 0);
    assert.equal(focusCount, 0);
  });
});
