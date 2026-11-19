import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";

/**
 * Archive is a structural move, not a stored state: a live task with no parent
 * that is not Root is the top of an archived tree. These tests pin the
 * structure, the one system message, and the list filters derived from it.
 */
describe("task archive", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "webagent-archive-"));
    store = new Store(dir);
    store.ensureRootTask(dir);
    // area
    //   └ work
    // other
    store.createTask(
      "area",
      dir,
      "auto",
      "agent-a",
      "area-session",
      undefined,
      {
        title: "area",
      },
    );
    store.createTask("work", dir, "auto", "agent-a", "work-session", "area", {
      title: "work",
    });
    store.createTask(
      "other",
      dir,
      "auto",
      "agent-a",
      "other-session",
      undefined,
      { title: "other" },
    );
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function ids(tasks: Array<{ id: string }>): string[] {
    return tasks.map((task) => task.id).sort();
  }

  it("detaches the task and its subtree from the active list", () => {
    const result = store.archiveTask("area");
    assert.ok(result);
    assert.equal(result.status, "archived");
    assert.equal(result.parentId, store.rootTaskId);
    assert.equal(result.parentPath, "@/");
    assert.equal(store.getTask("area")?.parent_id, null);
    // The child still belongs to the archived top.
    assert.equal(store.getTask("work")?.parent_id, "area");

    // The store's default range is every live task; only the REST list and
    // explicit active-only callers exclude archived trees.
    assert.deepEqual(
      ids(store.listTasks()),
      ["area", "other", "work", store.rootTaskId].sort(),
    );
    assert.deepEqual(
      ids(store.listTasks({ archived: "exclude" })),
      ["other", store.rootTaskId].sort(),
    );
    assert.deepEqual(ids(store.listTasks({ archived: "only" })), [
      "area",
      "work",
    ]);
    assert.deepEqual([...store.listArchivedTaskIds()].sort(), ["area", "work"]);
  });

  it("writes exactly one system message on the archived task, naming the parent", () => {
    const before = store.getEvents("work");
    const result = store.archiveTask("work");
    assert.ok(result);
    assert.equal(result.status, "archived");
    assert.equal(result.parentPath, "@/area");

    const events = store.getEvents("work");
    assert.equal(events.length, before.length + 1);
    const last = events.at(-1)!;
    assert.equal(last.type, "system_message");
    const data = JSON.parse(last.data) as {
      kind: string;
      title: string;
      body: string;
      originalParentId: string;
      originalParentPath: string;
    };
    assert.equal(data.kind, "task_archive");
    assert.equal(data.title, "Task archived");
    assert.equal(data.originalParentId, "area");
    assert.equal(data.originalParentPath, "@/area");
    assert.match(data.body, /@\/area/);
    assert.match(data.body, new RegExp("area"));

    // The children stay attached, so only the detached task gets a row.
    assert.equal(store.getEvents("area").length, 0);
    assert.equal(store.getEvents("other").length, 0);
  });

  it("can archive a deeper task out of an already archived tree", () => {
    store.archiveTask("area");
    const result = store.archiveTask("work");
    assert.ok(result);
    assert.equal(result.status, "archived");
    assert.equal(result.parentId, "area");
    assert.equal(result.parentPath, "@/area");
    assert.equal(store.getTask("work")?.parent_id, null);

    assert.deepEqual(ids(store.listTasks({ archived: "only" })), [
      "area",
      "work",
    ]);
    assert.deepEqual(
      ids(store.listTasks({ archived: "exclude" })),
      ["other", store.rootTaskId].sort(),
    );
  });

  it("does nothing when the task is already an archived top", () => {
    store.archiveTask("area");
    const count = store.getEvents("area").length;
    const result = store.archiveTask("area");
    assert.equal(result?.status, "already_archived");
    assert.equal(store.getTask("area")?.parent_id, null);
    assert.equal(store.getEvents("area").length, count);
  });

  it("rolls back detach, transcript, and delivery marks as one transaction", () => {
    store.createCollaborationMessage({
      id: "cross-message",
      deliveryId: "cross-delivery",
      sourceTaskId: "other",
      directTargetTaskId: "area",
      sourceActor: "agent",
      body: "cross",
    });
    store.createCollaborationMessage({
      id: "internal-message",
      deliveryId: "internal-delivery",
      sourceTaskId: "area",
      directTargetTaskId: "work",
      sourceActor: "agent",
      body: "internal",
    });
    const eventsBefore = store.getEvents("area").length;
    store["db"].exec(
      `CREATE TRIGGER fail_archive_delivery
       BEFORE UPDATE ON deliveries
       BEGIN SELECT RAISE(ABORT, 'injected archive failure'); END;`,
    );
    try {
      assert.throws(
        () => store.archiveTask("area"),
        /injected archive failure/,
      );
    } finally {
      store["db"].exec("DROP TRIGGER fail_archive_delivery");
    }

    // The detach and its system message rolled back with the delivery write.
    assert.equal(store.getTask("area")?.parent_id, store.rootTaskId);
    assert.equal(store.getEvents("area").length, eventsBefore);
    assert.equal(
      store.getCollaborationDelivery("cross-delivery")?.status,
      "queued",
    );
    assert.equal(
      store.getCollaborationDelivery("internal-delivery")?.status,
      "queued",
    );
    // A retry now succeeds and commits everything.
    assert.equal(store.archiveTask("area")?.status, "archived");
    assert.equal(store.getTask("area")?.parent_id, null);
  });

  it("cuts queued work across the subtree boundary, both directions", () => {
    // Sibling trees: area (being archived, with child work) and other.
    store.createTask(
      "other-child",
      dir,
      "auto",
      "agent-a",
      "oc-session",
      "other",
    );
    const messages: Array<[string, string, string]> = [
      ["root-to-area", store.rootTaskId, "area"],
      ["area-to-root", "area", store.rootTaskId],
      ["area-to-sibling", "area", "other"],
      ["sibling-to-area", "other", "area"],
      ["area-to-internal", "area", "work"],
      ["internal-to-area", "work", "area"],
      ["other-internal", "other", "other-child"],
    ];
    for (const [id, source, target] of messages) {
      store.createCollaborationMessage({
        id,
        deliveryId: `d-${id}`,
        sourceTaskId: source,
        directTargetTaskId: target,
        sourceActor: "agent",
        body: id,
      });
    }

    store.archiveTask("area");

    for (const id of [
      "root-to-area",
      "area-to-root",
      "area-to-sibling",
      "sibling-to-area",
    ]) {
      assert.equal(
        store.getCollaborationDelivery(`d-${id}`)?.status,
        "failed",
        id,
      );
      assert.equal(
        store.getCollaborationDelivery(`d-${id}`)?.failure_reason,
        "archived_edge_cut",
        id,
      );
    }
    for (const id of ["area-to-internal", "internal-to-area"]) {
      assert.equal(
        store.getCollaborationDelivery(`d-${id}`)?.status,
        "queued",
        id,
      );
    }
    assert.equal(
      store.getCollaborationDelivery("d-other-internal")?.status,
      "queued",
    );
  });

  it("GC detaches children inside an archived tree instead of re-rooting them", () => {
    store.archiveTask("area");
    store.createTask("empty", dir, "auto", "agent-a", "empty-session", "area");
    store.createTask(
      "grandchild",
      dir,
      "auto",
      "agent-a",
      "grandchild-session",
      "empty",
    );
    // Keep the child out of the empty-task GC snapshot.
    store.saveEvent(
      "grandchild",
      "user_message",
      { text: "keep" },
      { from_ref: "user" },
    );

    const removed = store.deleteEmptyTasks(0).map((entry) => entry.id);
    assert.ok(removed.includes("empty"));
    assert.equal(store.getTask("empty"), undefined);
    // Inside an archived tree the survivor detaches as its own archived top;
    // it must not be pulled back under the Root.
    assert.equal(store.getTask("grandchild")?.parent_id, null);

    // Control: the same shape outside an archived tree still re-parents to Root.
    store.createTask("active-empty", dir, "auto", "agent-a", "ae-session");
    store.createTask(
      "active-child",
      dir,
      "auto",
      "agent-a",
      "ac-session",
      "active-empty",
    );
    store.saveEvent(
      "active-child",
      "user_message",
      { text: "keep" },
      {
        from_ref: "user",
      },
    );
    store.deleteEmptyTasks(0);
    assert.equal(store.getTask("active-empty"), undefined);
    assert.equal(store.getTask("active-child")?.parent_id, store.rootTaskId);
  });

  it("refuses to archive Root", () => {
    assert.throws(
      () => store.archiveTask(store.rootTaskId),
      /Root task cannot be archived/,
    );
    assert.equal(store.getTask(store.rootTaskId)?.parent_id, null);
  });

  it("returns undefined for an unknown task", () => {
    assert.equal(store.archiveTask("missing"), undefined);
  });

  it("survives a Root exit: archived trees are not under Root", () => {
    store.archiveTask("area");
    const areaEvents = store.getEvents("area").length;
    const oldRoot = store.rootTaskId;

    const { rootTaskId: newRoot } = store.replaceRoot(oldRoot);

    assert.notEqual(newRoot, oldRoot);
    assert.equal(store.getTask("area")?.parent_id, null);
    assert.equal(store.getTask("work")?.parent_id, "area");
    assert.equal(store.getEvents("area").length, areaEvents);
    assert.deepEqual(ids(store.listTasks({ archived: "exclude" })), [newRoot]);
    assert.deepEqual(ids(store.listTasks({ archived: "only" })), [
      "area",
      "work",
    ]);
  });
});
