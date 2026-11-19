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

  it("detaches the task and its subtree from the default list", () => {
    const result = store.archiveTask("area");
    assert.ok(result);
    assert.equal(result.status, "archived");
    assert.equal(result.parentId, store.rootTaskId);
    assert.equal(result.parentPath, "@/");
    assert.equal(store.getTask("area")?.parent_id, null);
    // The child still belongs to the archived top.
    assert.equal(store.getTask("work")?.parent_id, "area");

    assert.deepEqual(
      ids(store.listTasks()),
      ["other", store.rootTaskId].sort(),
    );
    assert.deepEqual(ids(store.listTasks({ archived: "only" })), [
      "area",
      "work",
    ]);
    assert.deepEqual(
      ids(store.listTasks({ archived: "include" })),
      ["area", "other", "work", store.rootTaskId].sort(),
    );
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
      ids(store.listTasks()),
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
    assert.deepEqual(ids(store.listTasks()), [newRoot]);
    assert.deepEqual(ids(store.listTasks({ archived: "only" })), [
      "area",
      "work",
    ]);
  });
});
