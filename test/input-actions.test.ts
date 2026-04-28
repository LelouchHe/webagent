import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("input-actions", () => {
  let state: any;
  let dom: any;
  let actions: any;
  let inputModule: any;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.ts");
    await import("../public/js/events.ts");
    await import("../public/js/commands.ts");
    await import("../public/js/images.ts");
    inputModule = await import("../public/js/input.ts");
    void inputModule;
    actions = await import("../public/js/input-actions.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
  });

  describe("default mode", () => {
    it("idle paints attach + send", () => {
      actions.applyInputActions();
      assert.equal(dom.attachBtn.textContent, "^U");
      assert.equal(dom.sendBtn.textContent, "↵");
      assert.equal(dom.input.disabled, false);
    });

    it("busy + no command paints attach + cancel", () => {
      state.busy = true;
      actions.applyInputActions();
      assert.equal(dom.attachBtn.textContent, "^U");
      assert.equal(dom.sendBtn.textContent, "^C");
      assert.ok(dom.sendBtn.classList.contains("cancel"));
    });

    it("busy + slash command shows ↵ (no cancel modifier)", () => {
      state.busy = true;
      dom.input.value = "/help";
      actions.applyInputActions();
      assert.equal(dom.sendBtn.textContent, "↵");
      assert.ok(!dom.sendBtn.classList.contains("cancel"));
    });
  });

  describe("preview mode", () => {
    it("paints discard + publish and disables textarea", () => {
      state.previewToken = "tok123";
      actions.applyInputActions();
      assert.equal(dom.attachBtn.textContent, "^D");
      assert.ok(dom.attachBtn.classList.contains("discard"));
      assert.equal(dom.attachBtn.title, "Discard preview (Ctrl+D)");

      assert.equal(dom.sendBtn.textContent, "^P");
      assert.ok(dom.sendBtn.classList.contains("publish"));
      assert.equal(dom.sendBtn.title, "Publish preview (Ctrl+P)");

      assert.equal(dom.input.disabled, true);
    });

    it("clears modifier classes when leaving preview mode", () => {
      state.previewToken = "tok123";
      actions.applyInputActions();
      assert.ok(dom.sendBtn.classList.contains("publish"));

      state.previewToken = null;
      actions.applyInputActions();
      assert.ok(!dom.sendBtn.classList.contains("publish"));
      assert.ok(!dom.attachBtn.classList.contains("discard"));
      assert.equal(dom.input.disabled, false);
    });

    it("preview takes priority over busy", () => {
      state.busy = true;
      state.previewToken = "tok123";
      actions.applyInputActions();
      // Should NOT show ^C — preview slots win.
      assert.equal(dom.sendBtn.textContent, "^P");
      assert.equal(dom.attachBtn.textContent, "^D");
    });
  });

  describe("handler routing", () => {
    it("right-slot click in default+busy+empty calls cancel handler", () => {
      let canceled = 0;
      let sent = 0;
      actions.registerInputHandlers({
        send: () => sent++,
        cancel: () => canceled++,
        attach: () => {},
        publish: () => {},
        discard: () => {},
      });
      state.busy = true;
      actions.applyInputActions();
      dom.sendBtn.click();
      assert.equal(canceled, 1);
      assert.equal(sent, 0);
    });

    it("right-slot click re-evaluates command at click time (not just paint time)", () => {
      let canceled = 0;
      let sent = 0;
      actions.registerInputHandlers({
        send: () => sent++,
        cancel: () => canceled++,
        attach: () => {},
        publish: () => {},
        discard: () => {},
      });
      state.busy = true;
      actions.applyInputActions(); // paints as ^C (no command yet)
      dom.input.value = "/help"; // user types after paint, no input event
      dom.sendBtn.click();
      // Should send (because /help is a command), not cancel
      assert.equal(sent, 1);
      assert.equal(canceled, 0);
    });
  });
});
