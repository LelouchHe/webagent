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
    store.updateTaskWorkflowStatus("root", "done");
    store.updateTaskWorkflowStatus("alpha", "running");
    store.updateTaskWorkflowStatus("alpha-child", "blocked");
    const stamp = Date.UTC(2026, 8, 13, 21, 0, 1, 1);
    for (const id of ["root", "alpha", "alpha-child"]) {
      store.saveEvent(
        id,
        "assistant_message",
        { text: id },
        { from_ref: "agent" },
      );
      store["db"]
        .prepare("UPDATE events SET created_at = ? WHERE task_id = ?")
        .run(stamp, id);
    }
    const host = createMcpTaskToolHost({ store, tasks, getBridge: () => null });
    const listed = host.list("alpha");
    assert.deepEqual(
      listed.map(({ id, relation }) => ({ id, relation })),
      [
        { id: "alpha", relation: "self" },
        { id: "root", relation: "parent" },
        { id: "alpha-child", relation: "child" },
        { id: "beta", relation: "sibling" },
      ],
    );
    assert.equal(
      listed.find((item) => item.id === "root")?.workflowStatus,
      "done",
    );
    assert.equal(
      listed.find((item) => item.id === "alpha")?.workflowStatus,
      "running",
    );
    assert.ok(listed.every((item) => item.executionState === "idle"));
    // Positive case: a constant `idle` would satisfy the check above, so pin
    // the live runtime source while a turn is active.
    tasks.activePrompts.add("alpha-child");
    assert.equal(
      host.list("alpha").find((item) => item.id === "alpha-child")
        ?.executionState,
      "agent",
    );
    assert.equal(listed.find((item) => item.id === "beta")?.lastEventAt, null);
    assert.equal(
      listed.find((item) => item.id === "beta")?.lastAgentActivityAt,
      null,
    );
    assert.equal(
      listed.find((item) => item.id === "alpha")?.lastEventAt,
      "2026-09-13T21:00:01.001Z",
    );
    assert.match(
      listed.find((item) => item.id === "alpha")?.lastEventAt ?? "",
      /Z$/,
    );
    tasks.noteAgentActivity("alpha");
    const afterActivity = host.list("alpha");
    assert.match(
      afterActivity.find((item) => item.id === "alpha")?.lastAgentActivityAt ??
        "",
      /Z$/,
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

  it("pushes a bounded range down to Store.getEvents", () => {
    for (let i = 0; i < 30; i++) {
      store.saveEvent(
        "alpha",
        "user_message",
        { text: String(i) },
        { from_ref: "user" },
      );
    }
    const originalGetEvents = store.getEvents.bind(store);
    let observed: { afterSeq?: number; beforeSeq?: number } | undefined;
    store.getEvents = (
      taskId: string,
      options?: Parameters<Store["getEvents"]>[1],
    ) => {
      observed = options;
      return originalGetEvents(taskId, options);
    };
    try {
      const host = createMcpTaskToolHost({
        store,
        tasks,
        getBridge: () => null,
      });
      assert.deepEqual(
        host.query("alpha", { range: [-20, -1] }).rows.map((row) => row.seq),
        Array.from({ length: 20 }, (_, i) => i + 11),
      );
      assert.deepEqual(observed, { afterSeq: 10, beforeSeq: 31 });
    } finally {
      store.getEvents = originalGetEvents;
    }
  });

  it("truncates projections and keeps centered search windows visible", () => {
    const long = "a".repeat(150) + "Needle" + "b".repeat(150);
    const maxNeedle = "N".repeat(128);
    store.saveEvent(
      "alpha",
      "assistant_message",
      { text: long },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "assistant_message",
      { text: "a".repeat(100) + maxNeedle + "b".repeat(100) },
      { from_ref: "agent" },
    );
    store.saveEvent(
      "alpha",
      "user_message",
      { text: "short" },
      { from_ref: "user" },
    );
    store.saveEvent(
      "alpha",
      "plan",
      { entries: [{ content: long }] },
      { from_ref: "agent" },
    );
    const host = createMcpTaskToolHost({ store, tasks, getBridge: () => null });
    const rows = host.query("alpha", {}).rows;
    assert.equal(Array.from(rows[0].text ?? "").length, 200);
    assert.match(rows[0].text ?? "", /…$/);
    assert.equal((rows[2].text ?? "").includes("…"), false);
    const found = host.query("alpha", { text: "needle" }).rows;
    assert.equal(found.length, 2);
    const projected = found.find((row) => row.type === "assistant_message")!;
    assert.match(projected.text ?? "", /Needle/);
    assert.match(projected.text ?? "", /^…/);
    assert.match(projected.text ?? "", /…$/);
    assert.ok(Array.from(projected.text ?? "").length <= 200);
    const maxFound = host.query("alpha", { text: maxNeedle }).rows[0];
    assert.match(maxFound.text ?? "", new RegExp(maxNeedle));
    assert.ok(Array.from(maxFound.text ?? "").length <= 200);
    const unprojected = found.find((row) => row.type === "plan")!;
    assert.equal(unprojected.unprojected, true);
    assert.equal(unprojected.field, "entries[0].content");
    assert.match(unprojected.text ?? "", /Needle/);
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
    assert.throws(
      () => host.query("alpha", {}),
      (error: unknown) => {
        const parsed = JSON.parse(String((error as Error).message)) as {
          error: string;
          required_bytes: number;
          limit_bytes: number;
          max_seq: number;
          hint: { range: [number, number] };
        };
        assert.equal(parsed.error, "response_too_large");
        assert.equal(typeof parsed.required_bytes, "number");
        assert.equal(parsed.limit_bytes, 256 * 1024);
        assert.equal(parsed.max_seq, 6_000);
        assert.deepEqual(parsed.hint.range, [-50, -1]);
        return true;
      },
    );
  });

  it("cancels only a direct child and records the reason", async () => {
    let cancelCalls = 0;
    const bridge = {
      cancel: async () => {
        cancelCalls++;
      },
    } as unknown as import("../src/bridge.ts").AgentBridge;
    tasks.activePrompts.add("alpha-child");
    tasks.syncBusy("alpha-child", "prompt-1");
    const host = createMcpTaskToolHost({
      store,
      tasks,
      getBridge: () => bridge,
    });
    assert.deepEqual(
      await host.cancel("alpha", "alpha-child", "No longer needed"),
      {
        accepted: true,
        taskId: "alpha-child",
        status: "cancelling",
      },
    );
    assert.equal(cancelCalls, 1);
    assert.match(
      store.getEvents("alpha-child").at(-1)?.data ?? "",
      /No longer needed/,
    );
    await assert.rejects(
      () => host.cancel("alpha", "beta", "wrong scope"),
      /target_not_allowed/,
    );
  });

  it("returns idle when a direct child has no active execution", async () => {
    const host = createMcpTaskToolHost({ store, tasks, getBridge: () => null });
    assert.deepEqual(
      await host.cancel("alpha", "alpha-child", "stop before start"),
      {
        accepted: true,
        taskId: "alpha-child",
        status: "idle",
      },
    );
  });

  it("creates a direct child with inherited and requested configuration", async () => {
    let createCall:
      | {
          cwd?: string;
          inheritFromTaskId?: string;
          source: string;
          options: Record<string, unknown>;
        }
      | undefined;
    const fakeTasks = {
      createTask: async (
        _bridge: unknown,
        cwd: string,
        inheritFromTaskId: string,
        source: string,
        options: Record<string, unknown>,
      ) => {
        createCall = { cwd, inheritFromTaskId, source, options };
        return { taskId: "created-child" };
      },
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
    assert.deepEqual(createCall, {
      cwd: join(dir, "subdir"),
      inheritFromTaskId: "alpha",
      source: "agent",
      options: {
        parentId: "alpha",
        title: "New child",
        model: "m",
        thinking: "high",
      },
    });
    assert.match(store.getEvents("alpha").at(-1)?.data ?? "", /created-child/);
  });

  it("queues an agent message without returning delivery metadata", async () => {
    const host = createMcpTaskToolHost({ store, tasks, getBridge: () => null });
    await host.send("alpha", "beta", "hello beta");
    const messages = store
      .getEvents("beta")
      .filter((event) => event.type === "system_message");
    assert.equal(messages.length, 1);
    assert.match(messages[0].data, /hello beta/);
  });
});
