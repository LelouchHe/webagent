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
      { title: "Alpha child" },
    );
    tasks = new TaskManager(store, dir, dir);
  });

  afterEach(() => {
    tasks.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists the family with relation and status", () => {
    store.updateTaskWorkflowStatus("alpha", "running");
    const host = createMcpTaskToolHost({ store, tasks, getBridge: () => null });
    assert.deepEqual(
      host.list("alpha").map(({ id, relation }) => ({ id, relation })),
      [
        { id: "alpha", relation: "self" },
        { id: "root", relation: "parent" },
        { id: "alpha-child", relation: "child" },
        { id: "beta", relation: "sibling" },
      ],
    );
  });

  it("indexes every event including thinking and exposes search context", () => {
    store.saveEvent(
      "alpha",
      "thinking",
      { text: "internal plan" },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "tool_call",
      {
        id: "tool-1",
        title: "edit",
        rawInput: { path: "src/needle.ts", oldText: "not the projection" },
      },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "tool_call_update",
      {
        id: "tool-1",
        status: "completed",
        content: [{ content: { text: "done" } }],
      },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "permission_request",
      {
        requestId: "permission-1",
        title: "Run?",
        toolCallId: "tool-1",
        options: [],
      },
      { from_ref: "agent" },
    );
    const host = createMcpTaskToolHost({ store, tasks, getBridge: () => null });
    const all = host.query("alpha", {});
    assert.deepEqual(
      all.rows.map((row) => row.seq),
      [1, 2, 3, 4],
    );
    assert.equal(all.rows[0].type, "thinking");
    assert.equal(all.rows[1].group, "tool-1");
    assert.equal(all.rows[3].group, "tool-1");
    const found = host.query("alpha", { text: "needle" });
    assert.equal(found.rows.length, 1);
    assert.equal(found.rows[0].field, "rawInput.path");
    assert.match(found.rows[0].text ?? "", /needle/i);
  });

  it("normalizes negative ranges, reverse ranges, and clamps endpoints", () => {
    for (let i = 0; i < 30; i++) {
      store.saveEvent(
        "alpha",
        "user_message",
        { text: String(i) },
        { from_ref: "user" },
      );
    }
    const host = createMcpTaskToolHost({ store, tasks, getBridge: () => null });
    assert.deepEqual(
      host.query("alpha", { range: [-20, -1] }).rows.map((r) => r.seq),
      Array.from({ length: 20 }, (_, i) => i + 11),
    );
    assert.deepEqual(
      host.query("alpha", { range: [20, 10] }).rows.map((r) => r.seq),
      Array.from({ length: 11 }, (_, i) => i + 10),
    );
    assert.deepEqual(
      host.query("alpha", { range: [1, 0] }).rows.map((r) => r.seq),
      [1],
    );
  });

  it("reads original structured data in one batch, including thinking", () => {
    const original = { text: "hello", nested: ["x", { value: 2 }] };
    const event = store.saveEvent("alpha", "thinking", original, {
      from_ref: "agent",
    });
    const host = createMcpTaskToolHost({ store, tasks, getBridge: () => null });
    const result = host.read("alpha", {
      taskId: "alpha",
      seqs: [event.seq, event.seq],
    });
    assert.deepEqual(result.rows, [
      {
        seq: event.seq,
        type: "thinking",
        at: new Date(event.created_at).toISOString(),
        from: "agent",
        data: original,
      },
    ]);
  });

  it("rejects unknown and out-of-family targets identically", () => {
    const host = createMcpTaskToolHost({ store, tasks, getBridge: () => null });
    assert.throws(
      () => host.query("alpha", { taskId: "missing" }),
      /target_not_allowed/,
    );
    assert.throws(
      () => host.read("alpha", { taskId: "missing", seqs: [1] }),
      /target_not_allowed/,
    );
    assert.throws(
      () => host.query("alpha", { taskId: "unrelated" }),
      /target_not_allowed/,
    );
    store.createTask("unrelated", dir, "auto", "session-unrelated", null, {
      title: "Unrelated",
    });
    assert.throws(
      () => host.query("alpha", { taskId: "unrelated" }),
      /target_not_allowed/,
    );
  });

  it("rejects missing seqs without partial rows", () => {
    store.saveEvent(
      "alpha",
      "user_message",
      { text: "x" },
      { from_ref: "user" },
    );
    const host = createMcpTaskToolHost({ store, tasks, getBridge: () => null });
    assert.throws(
      () => host.read("alpha", { taskId: "alpha", seqs: [1, 99] }),
      /unknown_seq/,
    );
  });

  it("reads a large single payload under the global response limit", () => {
    const payload = { text: "payload-" + "x".repeat(258_000) };
    const event = store.saveEvent("alpha", "assistant_message", payload, {
      from_ref: "agent",
    });
    const host = createMcpTaskToolHost({ store, tasks, getBridge: () => null });
    const result = host.read("alpha", { taskId: "alpha", seqs: [event.seq] });
    assert.deepEqual(result.rows[0].data, payload);
    assert.ok(
      Buffer.byteLength(JSON.stringify(result), "utf8") < 4 * 1024 * 1024,
    );
  });

  it("rejects an over-limit response with required_bytes and no partial rows", () => {
    const event = store.saveEvent(
      "alpha",
      "assistant_message",
      { text: "x".repeat(4 * 1024 * 1024) },
      { from_ref: "agent" },
    );
    const host = createMcpTaskToolHost({ store, tasks, getBridge: () => null });
    assert.throws(
      () => host.read("alpha", { taskId: "alpha", seqs: [event.seq] }),
      (error: unknown) => {
        const parsed = JSON.parse(String((error as Error).message)) as Record<
          string,
          unknown
        >;
        assert.equal(parsed.error, "response_too_large");
        assert.equal(typeof parsed.required_bytes, "number");
        assert.equal(parsed.limit_bytes, 4 * 1024 * 1024);
        return true;
      },
    );
  });

  it("rejects an over-limit query without returning a partial page", () => {
    for (let i = 0; i < 6_000; i++) {
      store.saveEvent("alpha", "future_event", {}, { from_ref: "system" });
    }
    const host = createMcpTaskToolHost({ store, tasks, getBridge: () => null });
    assert.throws(() => host.query("alpha", {}), /response_too_large/);
  });

  it("creates a direct child with requested configuration", async () => {
    const fakeTasks = {
      createTask: async () => ({ taskId: "created-child" }),
    } as unknown as TaskManager;
    const host = createMcpTaskToolHost({
      store,
      tasks: fakeTasks,
      getBridge: () => ({}) as import("../src/bridge.ts").AgentBridge,
    });
    assert.deepEqual(
      await host.create("alpha", {
        title: "New child",
        cwd: "subdir",
        model: "m",
        thinking: "high",
      }),
      { taskId: "created-child" },
    );
  });
});
