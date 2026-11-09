import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";
import { buildCollaborationBroadcast } from "../src/collaboration-message.ts";

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
  let events: typeof import("../public/js/events.ts");

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    render = await import("../public/js/render.ts");
    marks = await import("../public/js/task-ref-marks.ts");
    topology = await import("../public/js/task-topology.ts");
    events = await import("../public/js/events.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    marks.resetTaskRefMarks();
  });

  function renderCreatedRow(taskId: string, taskTitle = "child"): HTMLElement {
    return render.addSystemMessage({
      title: `Created task @${taskTitle}`,
      body: `Task ID    ${taskId}`,
      taskRef: { kind: "task_created", taskId, taskTitle },
    });
  }

  /** The one reference span in the last rendered row, if it has one. */
  function refSpan(row: HTMLElement): HTMLElement | null {
    return row.querySelector<HTMLElement>(".task-ref");
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

  it("marks a live row from its target id when another task is deleted", () => {
    // A second client watching the parent: the row and the delete both arrive
    // over the live envelope, where `taskId` is the row's own (live) task and
    // `targetTaskId` is the task it names.
    state.taskId = "parent";
    marks.applyTaskListSnapshot(["parent", "child"]);

    events.handleEvent({
      type: "system_message",
      taskId: "parent",
      kind: "task_created",
      messageId: "m1",
      sourceTaskId: "parent",
      targetTaskId: "child",
      role: "source",
      title: "Created task @child",
      body: "Task ID    child",
    });
    const rows = dom.messages.querySelectorAll(".system-msg");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hasAttribute("data-exited"), false);

    // The child is deleted while this client is viewing the parent: the
    // delete must still re-evaluate the row, and it must be resolved through
    // `targetTaskId` (a live-task row would never be marked otherwise).
    events.handleEvent({
      type: "task_deleted",
      taskId: "child",
      agentId: null,
    });
    assert.equal(state.taskId, "parent");
    assert.equal(rows[0].hasAttribute("data-exited"), true);
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

  /**
   * One collaboration row, projected exactly as replay builds it: the row's own
   * id plus both ids and both raw labels.
   */
  function renderCollaborationRow(input: {
    title: string;
    ownTaskId: string;
    sourceLabel?: string | null;
    targetLabel?: string | null;
  }): HTMLElement {
    return render.addSystemMessage({
      title: input.title,
      body: "hello",
      taskRef: {
        kind: "collaboration",
        ownTaskId: input.ownTaskId,
        sourceTaskId: "a",
        sourceLabel: input.sourceLabel === undefined ? "a" : input.sourceLabel,
        targetTaskId: "b",
        targetLabel: input.targetLabel === undefined ? "b" : input.targetLabel,
      },
    });
  }

  it("strikes only the target reference of a source-side collaboration row", () => {
    marks.applyTaskListSnapshot(["a", "b"]);
    const row = renderCollaborationRow({ title: "@a sent @b", ownTaskId: "a" });
    const span = refSpan(row);
    assert.ok(span, "the target reference must be its own span");
    assert.equal(span.textContent, "@b");
    assert.equal(row.querySelector("summary")?.textContent, "@a sent @b");
    assert.equal(row.hasAttribute("data-exited"), false);
    assert.equal(span.hasAttribute("data-exited"), false);

    // The target exits: the row and the target reference are marked together,
    // and the row's own address is not a span at all, so it cannot be struck.
    marks.noteTaskDeleted("b");
    assert.equal(row.hasAttribute("data-exited"), true);
    assert.equal(span.hasAttribute("data-exited"), true);
    assert.equal(row.querySelectorAll(".task-ref").length, 1);

    // A later delete of the row's own task is not this row's business.
    marks.applyTaskListSnapshot(["a", "b"]);
    assert.equal(row.hasAttribute("data-exited"), true);
  });

  it("strikes the source reference on the target-side projection", () => {
    marks.applyTaskListSnapshot(["a", "b"]);
    const row = renderCollaborationRow({ title: "@a sent @b", ownTaskId: "b" });
    const span = refSpan(row);
    assert.ok(span);
    // The same title, projected to the target: the other task is the source,
    // and its reference sits at the front.
    assert.equal(span.textContent, "@a");
    assert.equal(span.nextSibling?.textContent, " sent @b");

    marks.noteTaskDeleted("a");
    assert.equal(row.hasAttribute("data-exited"), true);
    assert.equal(span.hasAttribute("data-exited"), true);

    // A collection that still has the source clears both: the row names the
    // source here, and the target's own exit is not this row's claim.
    marks.resetTaskRefMarks();
    marks.applyTaskListSnapshot(["a"]);
    assert.equal(span.hasAttribute("data-exited"), false);
    assert.equal(row.hasAttribute("data-exited"), false);
  });

  it("strikes the other task on both sides of a cancellation row", () => {
    marks.applyTaskListSnapshot(["a", "b"]);
    const sourceSide = render.addSystemMessage({
      title: "@a cancelled @b",
      body: "reason: stop",
      taskRef: {
        kind: "task_cancel",
        ownTaskId: "a",
        sourceTaskId: "a",
        sourceLabel: "a",
        targetTaskId: "b",
        targetLabel: "b",
      },
    });
    const targetSide = render.addSystemMessage({
      title: "Cancelled by @a",
      body: "reason: stop",
      taskRef: {
        kind: "task_cancel",
        ownTaskId: "b",
        sourceTaskId: "a",
        sourceLabel: "a",
        targetTaskId: "b",
        targetLabel: "b",
      },
    });
    assert.equal(refSpan(sourceSide)?.textContent, "@b");
    assert.equal(refSpan(targetSide)?.textContent, "@a");

    marks.noteTaskDeleted("a");
    // The canceller left: the cancelled task's own row loses its only reference.
    assert.equal(sourceSide.hasAttribute("data-exited"), false);
    assert.equal(refSpan(sourceSide)?.hasAttribute("data-exited"), false);
    assert.equal(targetSide.hasAttribute("data-exited"), true);
    assert.equal(refSpan(targetSide)?.hasAttribute("data-exited"), true);

    marks.noteTaskDeleted("b");
    assert.equal(sourceSide.hasAttribute("data-exited"), true);
    assert.equal(refSpan(sourceSide)?.hasAttribute("data-exited"), true);
  });

  it("claims nothing on a supervisor copy, which is neither side of the edge", () => {
    // A message between tasks under different parents is also projected to
    // their common ancestor. That row names both sides without being either,
    // so no single address can be attributed: it is neither muted nor struck.
    marks.applyTaskListSnapshot([]);
    const row = render.addSystemMessage({
      title: "@a sent @b",
      body: "hello",
      taskRef: {
        kind: "collaboration",
        ownTaskId: "lca",
        sourceTaskId: "a",
        sourceLabel: "a",
        targetTaskId: "b",
        targetLabel: "b",
      },
    });
    assert.equal(row.hasAttribute("data-exited"), false);
    assert.equal(refSpan(row), null);
    assert.equal(row.querySelector("summary")?.textContent, "@a sent @b");
    assert.equal(
      marks.resolveTaskRef({
        kind: "collaboration",
        title: "@a sent @b",
        ownTaskId: "lca",
        sourceTaskId: "a",
        sourceLabel: "a",
        targetTaskId: "b",
        targetLabel: "b",
      }),
      null,
    );
  });

  it("downgrades to a muted row when the raw title is missing", () => {
    marks.applyTaskListSnapshot([]);
    // Rows written before the raw labels existed still name their tasks in
    // `data`, so the row can be muted; nothing may be struck.
    const legacy = render.addSystemMessage({
      title: "Cancelled by @a",
      body: "reason: stop",
      taskRef: {
        kind: "task_cancel",
        ownTaskId: "b",
        sourceTaskId: "a",
        targetTaskId: "b",
      },
    });
    assert.equal(legacy.hasAttribute("data-exited"), true);
    assert.equal(refSpan(legacy), null);
    assert.equal(
      legacy.querySelector("summary")?.textContent,
      "Cancelled by @a",
    );

    const created = render.addSystemMessage({
      title: "Created task @child",
      taskRef: { kind: "task_created", ownTaskId: "a", taskId: "child" },
    });
    assert.equal(created.hasAttribute("data-exited"), true);
    assert.equal(refSpan(created), null);
  });

  it("resolves or refuses a reference by task id, never by text shape", () => {
    // Adversarial titles: a reference is either placed exactly where its id
    // says it is, or not placed at all. Every accepted result must be a single
    // reference at the anchored edge — never a title-wide or arbitrary match.
    const cases: Array<{
      name: string;
      title: string;
      sourceLabel: string;
      targetLabel: string;
      own: "a" | "b";
      expected: string | null;
      start?: number;
    }> = [
      // Equal labels: the naive `indexOf` answer would be the prefix.
      {
        name: "identical titles",
        title: "@same sent @same",
        sourceLabel: "same",
        targetLabel: "same",
        own: "a",
        expected: "@same",
        start: 11,
      },
      // A label that contains the separator word itself.
      {
        name: 'label containing " sent "',
        title: '@"a sent b" sent @c',
        sourceLabel: "a sent b",
        targetLabel: "c",
        own: "a",
        expected: "@c",
        start: 17,
      },
      // Quotes, a backslash, a newline, a tab, and a full-width space.
      {
        name: "quoted labels",
        title: '@"he said \\"hi\\"" sent @"x\ty"',
        sourceLabel: 'he said "hi"',
        targetLabel: "x\ty",
        own: "a",
        expected: '@"x\ty"',
      },
      {
        name: "newline and full-width space",
        title: '@"a\n\u3000b" sent @c',
        sourceLabel: "a\n\u3000b",
        targetLabel: "c",
        own: "a",
        expected: "@c",
      },
      {
        name: "label that is exactly the separator word",
        title: "@sent sent @cancelled",
        sourceLabel: "sent",
        targetLabel: "cancelled",
        own: "a",
        expected: "@cancelled",
      },
      {
        // The monotone title still names the row's own task first: a wrong
        // label must not be found anywhere else.
        name: "label not present in the title",
        title: "@a sent @b",
        sourceLabel: "a",
        targetLabel: "zz",
        own: "a",
        expected: null,
      },
      {
        name: "ids that do not agree with the title",
        title: "@a sent @b",
        sourceLabel: "b",
        targetLabel: "a",
        own: "a",
        expected: null,
      },
    ];
    for (const testCase of cases) {
      const resolved = marks.resolveTaskRef({
        kind: "collaboration",
        title: testCase.title,
        ownTaskId: testCase.own === "a" ? "a" : "b",
        sourceTaskId: "a",
        sourceLabel: testCase.sourceLabel,
        targetTaskId: "b",
        targetLabel: testCase.targetLabel,
      });
      assert.ok(
        resolved,
        `${testCase.name}: the row still names its other task`,
      );
      if (testCase.expected === null) {
        assert.equal(
          resolved.anchor,
          null,
          `${testCase.name}: must not strike`,
        );
        continue;
      }
      const anchor = resolved.anchor;
      assert.ok(anchor, `${testCase.name}: must strike`);
      assert.equal(anchor.text, testCase.expected, `${testCase.name}: text`);
      assert.equal(
        testCase.title.slice(anchor.start, anchor.end),
        anchor.text,
        `${testCase.name}: the span is exactly the reference`,
      );
      assert.ok(
        anchor.end - anchor.start < testCase.title.length,
        `${testCase.name}: the span is one reference, not the whole title`,
      );
      if (testCase.start !== undefined) {
        assert.equal(anchor.start, testCase.start, `${testCase.name}: start`);
      }
    }
  });

  it("rejects a reference that does not sit at its anchored edge", () => {
    // The same words at the other end do not satisfy the anchor: placement is
    // decided by the ids, and the rebuilt text must land exactly there.
    const resolved = marks.resolveTaskRef({
      kind: "task_created",
      title: "@child was created",
      taskId: "child",
      taskTitle: "child",
    });
    assert.equal(resolved?.taskId, "child");
    assert.equal(resolved.anchor, null);

    // A cancellation row whose title does not end with the other task cannot
    // be placed either, even though the reference occurs in the title.
    const cancel = marks.resolveTaskRef({
      kind: "task_cancel",
      title: "@a sent @b",
      ownTaskId: "b",
      sourceTaskId: "a",
      sourceLabel: "a",
      targetTaskId: "b",
      targetLabel: "b",
    });
    assert.equal(cancel?.anchor, null);
  });

  it("marks the live collaboration envelope from its raw labels", () => {
    // A second client watching the source task: row and delete both arrive live.
    state.taskId = "a";
    marks.applyTaskListSnapshot(["a", "b"]);
    events.handleEvent(
      buildCollaborationBroadcast({
        messageId: "m1",
        sourceTaskId: "a",
        sourceLabel: "a",
        targetTaskId: "b",
        targetLabel: "b",
        role: "source",
        taskId: "a",
        body: "hello",
      }),
    );
    const row = dom.messages.querySelector(".system-msg") as HTMLElement | null;
    assert.ok(row);
    assert.equal(refSpan(row)?.textContent, "@b");

    events.handleEvent({ type: "task_deleted", taskId: "b", agentId: null });
    assert.equal(row.hasAttribute("data-exited"), true);
    assert.equal(refSpan(row)?.hasAttribute("data-exited"), true);
  });
});
