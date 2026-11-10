import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";
import { buildCollaborationBroadcast } from "../src/collaboration-message.ts";

/**
 * A row that names another task keeps naming it after it is renamed or
 * deleted. The mark is derived, never stored: the applied task list is a base,
 * and the live `task_created` / `task_deleted` / `task_title_updated` events
 * observed by this connection are incremental exceptions to it.
 *
 * A reference has four states — live, renamed, exited, unknown — and the
 * forbidden outcome is calling a live task exited, so every unknown state (no
 * list, failed read, superseded generation, missing raw label, unplaceable
 * reference) must leave the reference alone.
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

  /** Apply a list read given as `id → title` pairs. */
  function snapshot(titles: Record<string, string | null>): void {
    marks.applyTaskListSnapshot(
      Object.entries(titles).map(([id, title]) => ({ id, title })),
    );
  }

  function renderCreatedRow(taskId: string, taskTitle = "child"): HTMLElement {
    return render.addSystemMessage({
      title: `Created task @${taskTitle}`,
      body: `Task ID    ${taskId}`,
      taskRef: { kind: "task_created", taskId, taskTitle },
    });
  }

  /** Every reference span in the row, in title order. */
  function refSpans(row: HTMLElement): HTMLElement[] {
    return [...row.querySelectorAll<HTMLElement>(".task-ref")];
  }

  /** The one reference span in a row that carries exactly one. */
  function refSpan(row: HTMLElement): HTMLElement {
    const spans = refSpans(row);
    assert.equal(spans.length, 1, "expected exactly one reference span");
    return spans[0];
  }

  interface RefView {
    /** The declared state: `exited` / `renamed`, or null when none is claimed. */
    state: string | null;
    /** The row's own reference text, the strike target. */
    name: string | null;
    /** The appended current name, present only for a renamed reference. */
    current: string | null;
    /** The screen-reader note, present only for a declared state. */
    sr: string | null;
  }

  function textOf(parent: HTMLElement, selector: string): string | null {
    const found = parent.querySelector(selector);
    return found ? found.textContent : null;
  }

  function view(ref: HTMLElement): RefView {
    return {
      state: ref.getAttribute("data-ref-state"),
      name: textOf(ref, ".task-ref-name"),
      current: textOf(ref, ".task-ref-current"),
      sr: textOf(ref, ".visually-hidden"),
    };
  }

  /** The row's visible text, with the screen-reader-only notes removed. */
  function visibleText(el: HTMLElement): string {
    const clone = el.cloneNode(true) as HTMLElement;
    for (const hidden of clone.querySelectorAll(".visually-hidden")) {
      hidden.remove();
    }
    return clone.textContent;
  }

  function summaryOf(row: HTMLElement): HTMLElement {
    const summary = row.querySelector("summary");
    assert.ok(summary, "expected a summary element");
    return summary;
  }

  function assertLive(ref: HTMLElement, name: string): void {
    assert.deepEqual(view(ref), {
      state: null,
      name,
      current: null,
      sr: null,
    });
  }

  describe("the four reference states", () => {
    it("claims nothing before a task list has arrived", () => {
      const row = renderCreatedRow("child");
      assertLive(refSpan(row), "@child");

      // A delete learned from the stream without a list is still no claim.
      marks.noteTaskDeleted("child");
      assertLive(refSpan(row), "@child");
    });

    it("leaves a live reference completely unmarked", () => {
      snapshot({ root: null, child: "child" });
      const row = renderCreatedRow("child");
      assertLive(refSpan(row), "@child");
      // The row itself carries no state: it is history, never marked.
      assert.equal(row.hasAttribute("data-exited"), false);
      assert.equal(row.getAttribute("style"), null);
      assert.equal(visibleText(summaryOf(row)), "Created task @child");
    });

    it("strikes the recorded name and appends the current one after a rename", () => {
      snapshot({ root: null, child: "child" });
      const row = renderCreatedRow("child");

      marks.noteTaskTitleUpdated("child", "renamed child");
      const ref = refSpan(row);
      assert.equal(view(ref).state, "renamed");
      // The row's own words are struck; the current name follows them.
      assert.equal(view(ref).name, "@child");
      assert.equal(view(ref).current, ' @"renamed child"');
      // The non-color carrier for assistive technology.
      assert.equal(view(ref).sr, " (renamed)");
      assert.equal(
        visibleText(summaryOf(row)),
        'Created task @child @"renamed child"',
      );
      // The row's wording is never rewritten.
      assert.match(
        row.querySelector("summary")?.innerHTML ?? "",
        /^Created task /,
      );
    });

    it("strikes only, and appends nothing, once a renamed task exits", () => {
      snapshot({ root: null, child: "child" });
      const row = renderCreatedRow("child");

      marks.noteTaskTitleUpdated("child", "renamed child");
      assert.equal(view(refSpan(row)).state, "renamed");

      // Exited wins over renamed: the current name no longer exists to offer.
      marks.noteTaskDeleted("child");
      const ref = refSpan(row);
      assert.deepEqual(view(ref), {
        state: "exited",
        name: "@child",
        current: null,
        sr: " (exited)",
      });
      assert.equal(visibleText(summaryOf(row)), "Created task @child");
    });

    it("returns to live when the task is renamed back", () => {
      snapshot({ root: null, child: "child" });
      const row = renderCreatedRow("child");
      const ref = refSpan(row);

      marks.noteTaskTitleUpdated("child", "other");
      assert.equal(view(ref).state, "renamed");
      marks.noteTaskTitleUpdated("child", "child");
      // Every part of the mark is removed again, not left behind.
      assertLive(ref, "@child");
      assert.equal(visibleText(summaryOf(row)), "Created task @child");
    });

    it("shows only the latest name across several renames", () => {
      snapshot({ root: null, child: "v1" });
      const row = renderCreatedRow("child", "v1");
      const ref = refSpan(row);

      marks.noteTaskTitleUpdated("child", "v2");
      assert.equal(view(ref).current, " @v2");
      marks.noteTaskTitleUpdated("child", "v3");
      // No history is recorded: the row only learns the name to use now.
      assert.equal(view(ref).name, "@v1");
      assert.equal(view(ref).current, " @v3");
      assert.equal(ref.querySelectorAll(".task-ref-current").length, 1);
      assert.equal(ref.querySelectorAll(".visually-hidden").length, 1);
    });

    it("strikes a reference whose task is gone, and clears when it returns", () => {
      snapshot({ root: null, child: "child" });
      const row = renderCreatedRow("child");
      const ref = refSpan(row);

      marks.noteTaskDeleted("child");
      assert.deepEqual(view(ref), {
        state: "exited",
        name: "@child",
        current: null,
        sr: " (exited)",
      });
      // A delete is sticky within a generation, but a new collection can
      // legitimately re-derive the reference as live.
      marks.resetTaskRefMarks();
      snapshot({ child: "child" });
      assertLive(ref, "@child");
    });

    it("makes no claim for a listed task whose title is unknown", () => {
      // The id exists, so it is not exited; without a title there is nothing
      // to compare, so it is not renamed either.
      snapshot({ root: null, child: null });
      const row = renderCreatedRow("child");
      assertLive(refSpan(row), "@child");
    });

    it("refreshes a reference from a title update for a task it is not viewing", () => {
      state.taskId = "parent";
      state.taskTitle = "parent";
      snapshot({ parent: "parent", child: "child" });
      const row = renderCreatedRow("child");

      // The rename is broadcast while the client is watching another task.
      events.handleEvent({
        type: "task_title_updated",
        taskId: "child",
        title: "renamed child",
      });

      const ref = refSpan(row);
      assert.equal(view(ref).state, "renamed");
      assert.equal(view(ref).current, ' @"renamed child"');
      // The current task's own header is untouched by another task's rename.
      assert.equal(state.taskTitle, "parent");
    });

    it("applies a rename broadcast before the row is rendered", () => {
      snapshot({ child: "child" });
      events.handleEvent({
        type: "task_title_updated",
        taskId: "child",
        title: "renamed child",
      });
      const row = renderCreatedRow("child");
      assert.equal(view(refSpan(row)).state, "renamed");
      assert.equal(view(refSpan(row)).current, ' @"renamed child"');
    });
  });

  describe("collection derivation", () => {
    it("marks a listed task once it is deleted, and a stale list cannot revive it", () => {
      snapshot({ root: null, child: "child" });
      const row = renderCreatedRow("child");
      assertLive(refSpan(row), "@child");

      marks.noteTaskDeleted("child");
      assert.equal(view(refSpan(row)).state, "exited");

      // A list read issued before the delete resolves after it: the union must
      // not resurrect the deleted task.
      snapshot({ root: null, child: "child" });
      assert.equal(view(refSpan(row)).state, "exited");
    });

    it("does not mark a task created after the applied snapshot", () => {
      // The read was taken before the child existed; the create event arrived
      // after it resolved.
      snapshot({ root: null });
      marks.noteTaskCreated("child", "child");

      const row = renderCreatedRow("child");
      assertLive(refSpan(row), "@child");

      // A snapshot that still predates the create cannot overturn the event.
      snapshot({ root: null });
      assertLive(refSpan(row), "@child");
    });

    it("keeps a listed title when the create event carries none", () => {
      snapshot({ child: "child" });
      marks.noteTaskCreated("child");
      const row = renderCreatedRow("child");
      assertLive(refSpan(row), "@child");
    });

    it("clears an exited mark when the created task arrives", () => {
      // The list predates the create, so the reference looks dead; the create
      // event is newer and must undo that claim.
      snapshot({ root: null });
      const row = renderCreatedRow("child");
      assert.equal(view(refSpan(row)).state, "exited");

      marks.noteTaskCreated("child", "child");
      assertLive(refSpan(row), "@child");
    });

    it("stops calling a reference exited when the missed create arrives", () => {
      // The scenario the creation broadcast closes: a client is viewing the
      // parent, its list predates the child, and the child is created by
      // another initiator. Before the event the reference looks dead.
      state.taskId = "parent";
      state.taskTitle = "parent";
      snapshot({ parent: "parent" });
      const row = renderCreatedRow("child");
      assert.equal(view(refSpan(row)).state, "exited");

      // The announced creation is the client's only evidence, and it carries
      // the id and the name the reference is judged against.
      events.handleEvent({
        type: "task_created",
        taskId: "child",
        title: "child",
        configOptions: [],
      });

      assert.equal(state.taskId, "parent", "the client stays on its task");
      assertLive(refSpan(row), "@child");
    });

    it("judges by task id, not by the name the row shares with another task", () => {
      // Titles are unique per sibling, not globally: another live task may
      // carry the name this reference was written with. The id decides.
      snapshot({ a: "shared", b: "other" });
      const row = renderCreatedRow("gone", "shared");
      assert.equal(
        view(refSpan(row)).state,
        "exited",
        "a same-named live task must not revive a deleted one",
      );
      // Renaming the live same-named task changes nothing about this row.
      marks.noteTaskTitleUpdated("a", "a2");
      assert.equal(view(refSpan(row)).state, "exited");
    });

    it("re-evaluates rows already rendered when the list arrives", () => {
      // History replay renders before the boot list read resolves.
      const row = renderCreatedRow("gone", "gone");
      assertLive(refSpan(row), "@gone");

      snapshot({ root: null });
      assert.equal(view(refSpan(row)).state, "exited");
    });

    it("marks a live row from its target id when another task is deleted", () => {
      // A second client watching the parent: the row and the delete both arrive
      // over the live envelope, where `taskId` is the row's own (live) task and
      // `targetTaskId` is the task it names.
      state.taskId = "parent";
      snapshot({ parent: "parent", child: "child" });

      events.handleEvent({
        type: "system_message",
        taskId: "parent",
        kind: "task_created",
        messageId: "m1",
        sourceTaskId: "parent",
        targetTaskId: "child",
        role: "source",
        taskTitle: "child",
        title: "Created task @child",
        body: "Task ID    child",
      });

      const rows = dom.messages.querySelectorAll(".system-msg");
      assert.equal(rows.length, 1);
      assertLive(refSpan(rows[0]), "@child");

      // The child is deleted while this client is viewing the parent: the
      // delete must still re-evaluate the row, and it must be resolved through
      // `targetTaskId` (a live-task row would never be marked otherwise).
      events.handleEvent({
        type: "task_deleted",
        taskId: "child",
        agentId: null,
      });
      assert.equal(state.taskId, "parent");
      assert.equal(view(refSpan(rows[0])).state, "exited");
    });

    it("drops a list that resolves after the connection generation changed", async () => {
      const row = renderCreatedRow("gone", "gone");
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
        resolveResponse(
          new Response(JSON.stringify([{ id: "root", title: null }])),
        );
        await pending;
      } finally {
        globalThis.fetch = previous;
      }
      // `gone` is absent from that list, but the list belongs to a dead
      // generation: no claim may be made from it.
      assertLive(refSpan(row), "@gone");
    });

    it("leaves references unmarked when the list read fails", async () => {
      const row = renderCreatedRow("gone", "gone");
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
      assertLive(refSpan(row), "@gone");
    });
  });

  describe("which references a row names", () => {
    /**
     * One collaboration row, projected exactly as replay builds it: the row's
     * own id plus both ids and both raw labels.
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
          sourceLabel:
            input.sourceLabel === undefined ? "a" : input.sourceLabel,
          targetTaskId: "b",
          targetLabel:
            input.targetLabel === undefined ? "b" : input.targetLabel,
        },
      });
    }

    it("judges every reference of a collaboration row on its own id", () => {
      snapshot({ a: "a", b: "b" });
      const row = renderCollaborationRow({
        title: "@a sent @b",
        ownTaskId: "a",
      });
      const spans = refSpans(row);
      assert.deepEqual(
        spans.map((span) => span.textContent),
        ["@a", "@b"],
      );
      for (const span of spans) assert.equal(view(span).state, null);
      assert.equal(
        row.querySelector("summary")?.textContent,
        "@a sent @b",
        "the row's wording is unchanged",
      );

      // The target exits: only its own reference is marked.
      marks.noteTaskDeleted("b");
      assertLive(spans[0], "@a");
      assert.equal(view(spans[1]).state, "exited");

      // The source is renamed: only its own reference is marked.
      marks.noteTaskTitleUpdated("a", "a2");
      assert.equal(view(spans[0]).state, "renamed");
      assert.equal(view(spans[0]).current, " @a2");
      assert.equal(view(spans[1]).state, "exited");
    });

    it("marks the source reference on the target-side projection", () => {
      snapshot({ a: "a", b: "b" });
      const row = renderCollaborationRow({
        title: "@a sent @b",
        ownTaskId: "b",
      });
      const spans = refSpans(row);
      assert.equal(spans[0].textContent, "@a");
      assert.equal(spans[1].textContent, "@b");

      marks.noteTaskDeleted("a");
      assert.equal(view(spans[0]).state, "exited");
      assertLive(spans[1], "@b");
    });

    it("judges both references of a supervisor copy, which is neither side", () => {
      // A message between tasks under different parents is also projected to
      // their common ancestor. That row is neither endpoint, but each reference
      // still belongs to a task id, so each is judged on its own.
      snapshot({});
      const row = renderCollaborationRow({
        title: "@a sent @b",
        ownTaskId: "lca",
      });
      const spans = refSpans(row);
      assert.deepEqual(
        spans.map((span) => view(span).state),
        ["exited", "exited"],
      );

      marks.resetTaskRefMarks();
      snapshot({ a: "a" });
      const liveSource = renderCollaborationRow({
        title: "@a sent @b",
        ownTaskId: "lca",
      });
      const revived = refSpans(liveSource);
      assertLive(revived[0], "@a");
      assert.equal(view(revived[1]).state, "exited");
    });

    it("marks the other task on both sides of a cancellation row", () => {
      snapshot({ a: "a", b: "b" });
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
      const sourceSpans = refSpans(sourceSide);
      assert.deepEqual(
        sourceSpans.map((span) => span.textContent),
        ["@a", "@b"],
      );
      assert.equal(refSpan(targetSide).textContent, "@a");

      marks.noteTaskDeleted("a");
      // The canceller left: both rows lose the reference that named it, and the
      // cancelled task on the source side is untouched.
      assert.equal(view(sourceSpans[0]).state, "exited");
      assertLive(sourceSpans[1], "@b");
      assert.equal(view(refSpan(targetSide)).state, "exited");

      marks.noteTaskDeleted("b");
      assert.equal(view(sourceSpans[1]).state, "exited");
    });

    it("claims nothing when the raw labels are missing", () => {
      snapshot({});
      // Rows written before the raw labels existed still name their tasks in
      // `data`, but no reference can be rebuilt: nothing is claimed, and the
      // row is not marked either.
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
      assert.equal(refSpans(legacy).length, 0);
      assert.equal(
        legacy.querySelector("summary")?.textContent,
        "Cancelled by @a",
      );
      assert.equal(legacy.hasAttribute("data-exited"), false);

      const created = render.addSystemMessage({
        title: "Created task @child",
        taskRef: { kind: "task_created", ownTaskId: "a", taskId: "child" },
      });
      assert.equal(refSpans(created).length, 0);
      assert.equal(created.textContent, "Created task @child");
    });

    it("marks the live collaboration envelope from its raw labels", () => {
      // A second client watching the source task: row and delete both arrive live.
      state.taskId = "a";
      snapshot({ a: "a", b: "b" });
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
      const row = dom.messages.querySelector(
        ".system-msg",
      ) as HTMLElement | null;
      assert.ok(row);
      const spans = refSpans(row);
      assert.deepEqual(
        spans.map((span) => span.textContent),
        ["@a", "@b"],
      );

      events.handleEvent({ type: "task_deleted", taskId: "b", agentId: null });
      assert.equal(view(spans[1]).state, "exited");
      assertLive(spans[0], "@a");

      // A rename of the source refreshes the same live row.
      events.handleEvent({
        type: "task_title_updated",
        taskId: "a",
        title: "a2",
      });
      assert.equal(view(spans[0]).state, "renamed");
      assert.equal(view(spans[0]).current, " @a2");
    });
  });

  describe("anchoring", () => {
    it("resolves or refuses a reference by task id, never by text shape", () => {
      // Adversarial titles: a reference is either placed exactly where its id
      // says it is, or not placed at all. Every accepted result must be a
      // single reference at the anchored edge — never a title-wide or
      // arbitrary match.
      const cases: Array<{
        name: string;
        title: string;
        sourceLabel: string;
        targetLabel: string;
        expectedSource: string | null;
        expectedTarget: string | null;
        sourceStart?: number;
      }> = [
        // Equal labels: the naive `indexOf` answer would be the prefix twice.
        {
          name: "identical titles",
          title: "@same sent @same",
          sourceLabel: "same",
          targetLabel: "same",
          expectedSource: "@same",
          expectedTarget: "@same",
          sourceStart: 0,
        },
        // A label that contains the separator word itself.
        {
          name: 'label containing " sent "',
          title: '@"a sent b" sent @c',
          sourceLabel: "a sent b",
          targetLabel: "c",
          expectedSource: '@"a sent b"',
          expectedTarget: "@c",
        },
        // Quotes, a backslash, a newline, a tab, and a full-width space.
        {
          name: "quoted labels",
          title: '@"he said \\"hi\\"" sent @"x\ty"',
          sourceLabel: 'he said "hi"',
          targetLabel: "x\ty",
          expectedSource: '@"he said \\"hi\\""',
          expectedTarget: '@"x\ty"',
        },
        {
          name: "newline and full-width space",
          title: '@"a\n\u3000b" sent @c',
          sourceLabel: "a\n\u3000b",
          targetLabel: "c",
          expectedSource: '@"a\n\u3000b"',
          expectedTarget: "@c",
        },
        {
          name: "label that is exactly the separator word",
          title: "@sent sent @cancelled",
          sourceLabel: "sent",
          targetLabel: "cancelled",
          expectedSource: "@sent",
          expectedTarget: "@cancelled",
        },
        {
          // A label that is not in the title cannot be proven: neither
          // reference is struck, because the two must anchor against each
          // other at the two edges.
          name: "label not present in the title",
          title: "@a sent @b",
          sourceLabel: "a",
          targetLabel: "zz",
          expectedSource: null,
          expectedTarget: null,
        },
        {
          name: "ids that do not agree with the title",
          title: "@a sent @b",
          sourceLabel: "b",
          targetLabel: "a",
          expectedSource: null,
          expectedTarget: null,
        },
      ];
      for (const testCase of cases) {
        const resolved = marks.resolveTaskRefs({
          kind: "collaboration",
          title: testCase.title,
          ownTaskId: "a",
          sourceTaskId: "a",
          sourceLabel: testCase.sourceLabel,
          targetTaskId: "b",
          targetLabel: testCase.targetLabel,
        });
        const byId = new Map(resolved.map((target) => [target.taskId, target]));
        const expectations: Array<[string, string | null, number | undefined]> =
          [
            ["a", testCase.expectedSource, testCase.sourceStart],
            ["b", testCase.expectedTarget, undefined],
          ];
        for (const [taskId, expected, start] of expectations) {
          const target = byId.get(taskId);
          assert.ok(target, `${testCase.name}: ${taskId} is still named`);
          if (expected === null) {
            assert.equal(
              target.anchor,
              null,
              `${testCase.name}: ${taskId} must not strike`,
            );
            continue;
          }
          const anchor = target.anchor;
          assert.ok(anchor, `${testCase.name}: ${taskId} must strike`);
          assert.equal(anchor.text, expected, `${testCase.name}: text`);
          assert.equal(
            testCase.title.slice(anchor.start, anchor.end),
            anchor.text,
            `${testCase.name}: the span is exactly the reference`,
          );
          assert.ok(
            anchor.end - anchor.start < testCase.title.length,
            `${testCase.name}: the span is one reference, not the whole title`,
          );
          if (start !== undefined) {
            assert.equal(anchor.start, start, `${testCase.name}: start`);
          }
        }
      }
    });

    it("rejects a reference that does not sit at its anchored edge", () => {
      // The same words at the other end do not satisfy the anchor: placement is
      // decided by the ids, and the rebuilt text must land exactly there.
      const resolved = marks.resolveTaskRefs({
        kind: "task_created",
        title: "@child was created",
        taskId: "child",
        taskTitle: "child",
      });
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].taskId, "child");
      assert.equal(resolved[0].anchor, null);

      // A cancellation row whose title does not end with the other task cannot
      // be placed either, even though the reference occurs in the title.
      const cancel = marks.resolveTaskRefs({
        kind: "task_cancel",
        title: "@a sent @b",
        ownTaskId: "b",
        sourceTaskId: "a",
        sourceLabel: "a",
        targetTaskId: "b",
        targetLabel: "b",
      });
      assert.equal(cancel.length, 1);
      assert.equal(cancel[0].anchor, null);
    });

    it("leaves an unplaceable reference unmarked while the row is text", () => {
      snapshot({});
      const row = render.addSystemMessage({
        title: "@child was created",
        taskRef: { kind: "task_created", taskId: "child", taskTitle: "child" },
      });
      assert.equal(refSpans(row).length, 0);
      assert.equal(row.textContent, "@child was created");
    });
  });
});
