import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

/**
 * `Created task @x` rows keep naming a task after it is deleted. The mark is
 * derived, never stored: the applied task list is a base, and the live
 * `task_created` / `task_deleted` events observed by this connection are
 * incremental exceptions to it.
 *
 * The forbidden outcome is calling a live task exited, so every unknown state
 * (no list, failed read, superseded generation) must leave a row unmarked.
 */

describe("task-reference marks", () => {
  let state: any;
  let dom: any;
  let render: typeof import("../public/js/render.ts");
  let marks: typeof import("../public/js/task-ref-marks.ts");
  let topology: typeof import("../public/js/task-topology.ts");

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    render = await import("../public/js/render.ts");
    marks = await import("../public/js/task-ref-marks.ts");
    topology = await import("../public/js/task-topology.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
  });

  function renderCreatedRow(taskId: string): HTMLElement {
    return render.addSystemMessage({
      title: "Created task @child",
      body: `Task ID    ${taskId}`,
      taskRef: { kind: "task_created", taskId },
    });
  }

  it("claims nothing before a task list has arrived", () => {
    const row = renderCreatedRow("child");
    assert.equal(row.hasAttribute("data-exited"), false);

    // A delete learned from the stream without a list is still no claim.
    marks.noteTaskDeleted("child");
    assert.equal(row.hasAttribute("data-exited"), false);
  });

  it("marks a listed task once it is deleted, and a stale list cannot revive it", () => {
    marks.applyTaskListSnapshot(["root", "child"]);
    const row = renderCreatedRow("child");
    assert.equal(row.hasAttribute("data-exited"), false);

    marks.noteTaskDeleted("child");
    assert.equal(row.hasAttribute("data-exited"), true);

    // A list read issued before the delete resolves after it: the union must
    // not resurrect the deleted task.
    marks.applyTaskListSnapshot(["root", "child"]);
    assert.equal(row.hasAttribute("data-exited"), true);
  });

  it("does not mark a task created after the applied snapshot", () => {
    // The read was taken before the child existed; the create event arrived
    // after it resolved.
    marks.applyTaskListSnapshot(["root"]);
    marks.noteTaskCreated("child");

    const row = renderCreatedRow("child");
    assert.equal(row.hasAttribute("data-exited"), false);

    // A snapshot that still predates the create cannot overturn the event.
    marks.applyTaskListSnapshot(["root"]);
    assert.equal(row.hasAttribute("data-exited"), false);
  });

  it("re-evaluates rows already rendered when the list arrives", () => {
    // History replay renders before the boot list read resolves.
    const row = renderCreatedRow("gone");
    assert.equal(row.hasAttribute("data-exited"), false);

    marks.applyTaskListSnapshot(["root"]);
    assert.equal(row.hasAttribute("data-exited"), true);
  });

  it("drops a list that resolves after the connection generation changed", async () => {
    const row = renderCreatedRow("gone");
    const previous = globalThis.fetch;
    let resolveResponse: (value: Response) => void = () => {};
    globalThis.fetch = () =>
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
    try {
      const pending = topology.loadTaskList();
      // The stream dropped while the read was in flight.
      topology.beginTaskTopologyGeneration();
      resolveResponse(new Response(JSON.stringify([{ id: "root" }])));
      await pending;
    } finally {
      globalThis.fetch = previous;
    }
    // `gone` is absent from that list, but the list belongs to a dead
    // generation: no claim may be made from it.
    assert.equal(row.hasAttribute("data-exited"), false);
  });

  it("leaves rows unmarked when the list read fails", async () => {
    const row = renderCreatedRow("gone");
    const previous = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "no" }), {
        status: 503,
      });
    try {
      await assert.rejects(topology.loadTaskList());
    } finally {
      globalThis.fetch = previous;
    }
    assert.equal(row.hasAttribute("data-exited"), false);
  });
});
