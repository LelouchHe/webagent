// Input availability has one writer and must never be written to an equal
// value. iOS drops focus and the software keyboard when `disabled` is written
// on the focused textarea — even to the same value — and every repaint caused
// by a remote event lands exactly while the user is tapping or typing.
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

const MODEL_OPTION = {
  id: "model",
  name: "Model",
  currentValue: "mock-model-1",
  options: [
    { value: "mock-model-1", name: "Mock Model 1" },
    { value: "mock-model-2", name: "Mock Model 2" },
  ],
};

describe("input availability writes", () => {
  let state: any;
  let dom: any;
  let stateMod: any;
  let events: any;

  before(async () => {
    setupDOM();
    stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.ts");
    events = await import("../public/js/events.ts");
    // Registers the action refresher that setBusy / updateModeUI call.
    await import("../public/js/input-actions.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    delete dom.input.disabled;
    resetState(state, dom);
  });

  afterEach(() => {
    // The spy is an own property; removing it restores the prototype accessor.
    delete dom.input.disabled;
  });

  /** Record every assignment to `dom.input.disabled`, keeping the real
   *  property behaviour (reads and writes) intact. */
  function spyOnDisabled(): boolean[] {
    const writes: boolean[] = [];
    let value = dom.input.disabled;
    Object.defineProperty(dom.input, "disabled", {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (next: boolean) => {
        writes.push(Boolean(next));
        value = Boolean(next);
      },
    });
    return writes;
  }

  it("remote-triggered repaints never write the input", () => {
    const writes = spyOnDisabled();
    state.taskId = "task-1";
    state.clientId = null;

    // Busy flapping and mode repaints: both call refreshInputActions().
    stateMod.setBusy(true);
    stateMod.setBusy(false);
    stateMod.updateModeUI();
    stateMod.updateModeUI();
    // The two remote events that repaint the mode UI while a user may be
    // tapping the input.
    events.handleEvent({
      type: "config_option_update",
      taskId: "task-1",
      configOptions: [MODEL_OPTION],
    });
    events.handleEvent({
      type: "task_runtime_warmed",
      taskId: "task-1",
      agentId: "mock",
      configOptions: [MODEL_OPTION],
      agentCommands: { epoch: "server-a", revision: 1, commands: [] },
    });
    stateMod.updateModeUI();

    assert.deepEqual(writes, [], "no write may reach an unchanged input");
    assert.equal(dom.input.disabled, false);
  });

  it("preview entry and exit each write exactly once", () => {
    const writes = spyOnDisabled();
    state.taskId = "task-1";

    state.previewToken = "preview-token";
    stateMod.updateModeUI();
    assert.deepEqual(writes, [true], "entering preview disables once");
    assert.equal(dom.input.disabled, true);

    // A repaint while already in preview is not a second write.
    stateMod.updateModeUI();
    stateMod.setBusy(true);
    stateMod.setBusy(false);
    assert.deepEqual(writes, [true]);

    state.previewToken = null;
    stateMod.updateModeUI();
    assert.deepEqual(writes, [true, false], "leaving preview enables once");
    assert.equal(dom.input.disabled, false);

    stateMod.updateModeUI();
    assert.deepEqual(writes, [true, false]);
  });

  it("resetTaskUI restores a preview-disabled input", () => {
    const writes = spyOnDisabled();
    state.taskId = "task-1";
    state.previewToken = "preview-token";
    stateMod.updateModeUI();
    assert.deepEqual(writes, [true]);

    stateMod.resetTaskUI();
    assert.equal(dom.input.disabled, false, "input is usable after a reset");
    assert.deepEqual(writes, [true, false]);

    // A second reset is idempotent: nothing to write.
    stateMod.resetTaskUI();
    assert.deepEqual(writes, [true, false]);
  });

  it("task_created restores a preview-disabled input", () => {
    const writes = spyOnDisabled();
    state.taskId = null;
    state.previewToken = "preview-token";
    stateMod.updateModeUI();
    assert.deepEqual(writes, [true]);

    // Navigation clears the preview before the new task is installed.
    state.previewToken = null;
    events.handleEvent({
      type: "task_created",
      taskId: "task-1",
      agentId: "mock",
      cwd: "/tmp",
      title: null,
      configOptions: [],
    });
    assert.equal(dom.input.disabled, false, "the new task is typeable");
    assert.deepEqual(writes, [true, false]);
  });
});
