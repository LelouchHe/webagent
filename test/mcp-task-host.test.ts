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

  it("paginates past skipped normal completions without losing visible records", () => {
    store.saveEvent(
      "alpha",
      "user_message",
      { text: "oldest" },
      { from_ref: "user" },
    );
    store.saveEvent(
      "alpha",
      "prompt_done",
      { stopReason: "end_turn" },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "assistant_message",
      { text: "middle" },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "prompt_done",
      { stopReason: "end_turn" },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "task_update",
      { status: "done", body: "latest" },
      { from_ref: "agent" },
    );
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => null,
    });

    const newest = host.query("alpha", { limit: 2 });
    assert.deepEqual(
      newest.records.map((record) => record.seq),
      [5],
    );
    assert.ok(newest.nextCursor);

    const middle = host.query("alpha", { cursor: newest.nextCursor, limit: 2 });
    assert.deepEqual(
      middle.records.map((record) => record.seq),
      [3],
    );
    assert.ok(middle.nextCursor);

    const oldest = host.query("alpha", { cursor: middle.nextCursor, limit: 2 });
    assert.deepEqual(
      oldest.records.map((record) => record.seq),
      [1],
    );
    assert.equal(oldest.hasMore, false);
  });

  it("reads one complete persisted record by seq", () => {
    store.saveEvent(
      "alpha",
      "tool_call",
      { id: "tool-1", title: "bash", kind: "execute" },
      { from_ref: "agent" },
    );
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => null,
    });

    assert.deepEqual(host.getRecord("alpha", { seq: 1 }), {
      taskId: "alpha",
      record: {
        id: 1,
        taskId: "alpha",
        seq: 1,
        type: "tool_call",
        data: '{"id":"tool-1","title":"bash","kind":"execute"}',
        fromRef: "agent",
        createdAt: store.getEvent("alpha", 1)?.created_at,
      },
    });
    assert.throws(
      () => host.getRecord("alpha", { seq: 2 }),
      /record_not_found/,
    );
    assert.throws(() => host.getRecord("alpha", { seq: 0 }), /invalid_seq/);
  });

  it("does not expose thinking records through raw lookup", () => {
    store.saveEvent(
      "alpha",
      "thinking",
      { text: "private reasoning" },
      { from_ref: "agent" },
    );
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => null,
    });

    assert.throws(
      () => host.getRecord("alpha", { seq: 1 }),
      /record_not_found/,
    );
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
    assert.equal(result.records[0].text, "User:\nkeep this");
  });

  it("returns small text projections and skips normal completion noise", () => {
    store.saveEvent(
      "alpha",
      "assistant_message",
      { text: "The task is ready." },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "tool_call",
      {
        id: "tool-1",
        title: "edit",
        kind: "edit",
        rawInput: { path: "src/mcp/server.ts", oldText: "x".repeat(8_000) },
      },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "tool_call_update",
      {
        id: "tool-1",
        status: "failed",
        title: "edit",
        content: [{ content: { text: "Replacement did not match" } }],
      },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "permission_request",
      {
        requestId: "perm-1",
        title: "Run command?",
        options: [
          { optionId: "allow_once", label: "Allow once" },
          { optionId: "deny_once", label: "Deny" },
        ],
      },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "system_message",
      {
        kind: "collaboration",
        sourceLabel: "Beta",
        targetLabel: "Alpha",
        body: "Please review the API.",
      },
      { from_ref: "msg:1" },
    );
    store.saveEvent(
      "alpha",
      "task_update",
      { status: "blocked", body: "Waiting for API details" },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "bash_result",
      { output: "done", code: 0, signal: null },
      { from_ref: "system" },
    );
    store.saveEvent(
      "alpha",
      "prompt_done",
      { stopReason: "end_turn" },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "error",
      { message: "ACP connection closed" },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "future_event",
      { raw: "unrecognized" },
      { from_ref: "system" },
    );
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => null,
    });

    const result = host.query("alpha", { limit: 20 });
    assert.deepEqual(
      result.records.map(({ type, text }) => ({ type, text })),
      [
        { type: "assistant_message", text: "Assistant:\nThe task is ready." },
        {
          type: "tool_call",
          text: "Tool started: edit (edit)\nPath: src/mcp/server.ts",
        },
        {
          type: "tool_call_update",
          text: "Tool failed: edit\nResult:\nReplacement did not match",
        },
        {
          type: "permission_request",
          text: "Permission requested: Run command?\nOptions: Allow once, Deny",
        },
        {
          type: "system_message",
          text: "Collaboration message (Beta → Alpha):\nPlease review the API.",
        },
        {
          type: "task_update",
          text: "Task blocked:\nWaiting for API details",
        },
        {
          type: "bash_result",
          text: "Shell finished: exit 0\nOutput:\ndone",
        },
        { type: "error", text: "Error:\nACP connection closed" },
        {
          type: "future_event",
          text: "Unrecognized future_event event; raw payload omitted.",
        },
      ],
    );
    assert.equal(
      result.records.some((record) => "data" in record),
      false,
    );
    assert.equal(result.records[1].text.includes("x".repeat(100)), false);
    assert.equal(
      result.records.at(-1)?.rawSize,
      Buffer.byteLength('{"raw":"unrecognized"}', "utf8"),
    );
  });

  it("marks shortened text and reports its original payload size", () => {
    store.saveEvent(
      "alpha",
      "assistant_message",
      { text: "a".repeat(3_000) },
      { from_ref: "agent" },
    );
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => null,
    });

    const record = host.query("alpha", { limit: 1 }).records[0];
    assert.equal(record.truncated, true);
    assert.equal(
      record.rawSize,
      Buffer.byteLength(store.getEvents("alpha")[0].data, "utf8"),
    );
    assert.ok(record.text.length <= 801);
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
