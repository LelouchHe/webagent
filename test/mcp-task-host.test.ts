import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { TaskManager } from "../src/task-manager.ts";
import { createMcpTaskToolHost } from "../src/mcp/task-host.ts";

describe("MCP Task tool host", () => {
  let dir: string;
  let store: Store;
  let tasks: TaskManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "webagent-mcp-host-"));
    store = new Store(dir, "test-agent");
    store.createTask("root", dir, "auto", "session-root", null, {
      title: "Root",
    });
    store.createTask("alpha", dir, "auto", "session-alpha", "root", {
      title: "Alpha",
      brief: "Alpha work",
    });
    store.createTask("beta", dir, "auto", "session-beta", "root", {
      title: "Beta",
    });
    store.createTask(
      "alpha-child",
      dir,
      "auto",
      "session-alpha-child",
      "alpha",
      {
        title: "Alpha child",
      },
    );
    tasks = new TaskManager(store, dir, dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists self, parent, children, and siblings with identity data only", () => {
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => null,
    });

    assert.deepEqual(host.list("alpha"), [
      { id: "alpha", title: "Alpha", brief: "Alpha work", relation: "self" },
      { id: "root", title: "Root", brief: null, relation: "parent" },
      {
        id: "alpha-child",
        title: "Alpha child",
        brief: null,
        relation: "child",
      },
      { id: "beta", title: "Beta", brief: null, relation: "sibling" },
    ]);
  });

  it("reads bounded history pages and returns an opaque cursor", () => {
    for (let i = 1; i <= 3; i++) {
      store.saveEvent(
        "alpha",
        "user_message",
        { text: `entry ${i}` },
        { from_ref: "user" },
      );
    }
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => null,
    });

    const first = host.query("alpha", { limit: 2 });
    assert.deepEqual(
      first.records.map((record) => record.seq),
      [2, 3],
    );
    assert.equal(first.workflowStatus, "idle");
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor);

    const older = host.query("alpha", { cursor: first.nextCursor, limit: 2 });
    assert.deepEqual(
      older.records.map((record) => record.seq),
      [1],
    );
    assert.equal(older.hasMore, false);
  });

  it("filters history text in the database before returning records", () => {
    store.saveEvent(
      "alpha",
      "user_message",
      { text: "keep this" },
      { from_ref: "user" },
    );
    store.saveEvent(
      "alpha",
      "assistant_message",
      { text: "other" },
      { from_ref: "agent" },
    );
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => null,
    });

    const result = host.query("alpha", { text: "keep" });
    assert.equal(result.records.length, 1);
    assert.match(result.records[0].data, /keep this/);
  });

  it("rejects queries and sends outside the local family", async () => {
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => null,
    });

    await assert.rejects(
      () => host.send("alpha", "unknown", "hello"),
      /task_not_found/,
    );
    assert.throws(
      () => host.query("alpha", { taskId: "unknown" }),
      /task_not_found/,
    );
  });

  it("queues an agent message without returning delivery metadata", async () => {
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => null,
    });

    await host.send("alpha", "beta", "hello beta");
    const messages = store
      .getEvents("beta", { excludeThinking: true })
      .filter((event) => event.type === "system_message");
    assert.equal(messages.length, 1);
    assert.match(messages[0].data, /hello beta/);
  });

  it("updates its own workflow and sends a parent status message", async () => {
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => null,
    });

    await host.update("alpha", "blocked", "Need API details");
    assert.equal(store.getTask("alpha")?.workflow_status, "blocked");
    assert.match(
      store.getEvents("alpha").at(-1)?.data ?? "",
      /Need API details/,
    );
    const parentUpdate = JSON.parse(
      store.getEvents("root").at(-1)?.data ?? "{}",
    ) as { body?: string };
    assert.equal(parentUpdate.body, "Task status: blocked\nNeed API details");
  });
});
