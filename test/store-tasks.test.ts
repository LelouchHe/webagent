import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";

describe("Store tasks (S1)", () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-test-"));
    store = new Store(tmpDir, "test-agent");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("schema", () => {
    it("creates the tasks table and task_id columns", () => {
      const root = store.createTask({
        id: "root",
        name: "root",
        cwd: "/tmp",
      });
      assert.equal(root.id, "root");
      assert.equal(root.workflow_status, "running");
      assert.equal(root.mode, null);
      assert.equal(root.title, null);

      store.createSession("s1", "/tmp", "auto", "s1", "root");
      const row = store.getSession("s1");
      assert.equal(row?.task_id, "root");
    });

    it("rejects a second live session for the same task (single-live invariant)", () => {
      store.createTask({ id: "root", name: "root", cwd: "/tmp" });
      store.createSession("s1", "/tmp", "auto", "s1", "root");
      assert.throws(() =>
        store.createSession("s2", "/tmp", "auto", "s2", "root"),
      );
    });

    it("saves events with the task_id derived from the session", () => {
      store.createTask({ id: "tsk", name: "t", cwd: "/tmp" });
      store.createSession("s1", "/tmp", "auto", "s1", "tsk");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );
      const events = store.getTaskEvents("tsk");
      assert.equal(events.length, 1);
      assert.equal(events[0].session_id, "s1");
      assert.equal(events[0].task_id, "tsk");
    });

    it("stores attachments with the task_id derived from the session", () => {
      store.createTask({ id: "tsk", name: "t", cwd: "/tmp" });
      store.createSession("s1", "/tmp", "auto", "s1", "tsk");
      store.insertAttachment({
        id: "att-1",
        sessionId: "s1",
        kind: "image",
        name: "a.png",
        mime: "image/png",
        size: 10,
        realpath: "/tmp/a.png",
      });
      const atts = store.getTaskAttachments("tsk");
      assert.equal(atts.length, 1);
      assert.equal(atts[0].task_id, "tsk");
    });
  });

  describe("tasks CRUD", () => {
    it("creates and lists live tasks, hiding deleted ones", () => {
      store.createTask({ id: "root", name: "root", cwd: "/tmp" });
      store.createTask({
        id: "child",
        parentId: "root",
        name: "child-a",
        cwd: "/tmp",
        brief: "do things",
      });
      const listed = store.listTasks();
      // 同秒创建时 last_active_at 可能并列，排序不定——按集合断言
      assert.deepEqual(listed.map((t) => t.id).sort(), ["child", "root"]);
      assert.equal(store.getTask("child")?.brief, "do things");
      assert.equal(store.getTask("gone"), undefined);
    });

    it("enforces name uniqueness per parent; same name under different parents is fine", () => {
      store.createTask({ id: "root", name: "root", cwd: "/tmp" });
      store.createTask({ id: "c1", parentId: "root", name: "dup", cwd: "/a" });
      assert.throws(() =>
        store.createTask({
          id: "c2",
          parentId: "root",
          name: "dup",
          cwd: "/b",
        }),
      );
      store.createTask({ id: "r2", name: "root2", cwd: "/x" });
      // 跨度父同名（跨父可同名）——r2 下也可以叫 dup
      store.createTask({ id: "c3", parentId: "r2", name: "dup", cwd: "/c" });
    });

    it("renames name/title/brief in one call", () => {
      store.createTask({ id: "root", name: "root", cwd: "/tmp", title: "T" });
      store.renameTask("root", { name: "renamed", title: "New T", brief: "b" });
      const task = store.getTask("root");
      assert.ok(task);
      assert.equal(task.name, "renamed");
      assert.equal(task.title, "New T");
      assert.equal(task.brief, "b");
    });

    it("updates task config and touches last_active", () => {
      store.createTask({ id: "root", name: "root", cwd: "/tmp" });
      store.updateTaskConfig("root", "model", "gpt-x");
      store.updateTaskConfig("root", "mode", "autopilot");
      store.updateTaskConfig("root", "thought_level", "high");
      const task = store.getTask("root");
      assert.ok(task);
      assert.equal(task.model, "gpt-x");
      assert.equal(task.mode, "autopilot");
      assert.equal(task.reasoning_effort, "high");

      const before = store.getTask("root")!.last_active_at;
      store.touchTaskLastActive("root");
      const after = store.getTask("root")!.last_active_at;
      assert.ok(after >= before);
    });
  });

  describe("task live session", () => {
    it("resolves the live session of a task", () => {
      store.createTask({ id: "root", name: "root", cwd: "/tmp" });
      assert.equal(store.getTaskLiveSession("root"), undefined);
      store.createSession("s1", "/tmp", "auto", "s1", "root");
      assert.equal(store.getTaskLiveSession("root")?.id, "s1");
    });

    it("returns undefined when the only session is retired", () => {
      store.createTask({ id: "root", name: "root", cwd: "/tmp" });
      store.createSession("s1", "/tmp", "auto", "s1", "root");
      store.retireSession("s1"); // clear 语义：退役，不删记录
      assert.equal(store.getTaskLiveSession("root"), undefined);
      assert.equal(store.getSession("s1"), undefined); // 已退役不可作为活 session
    });
  });

  describe("task events aggregation", () => {
    it("aggregates events across executions in global insertion order", () => {
      store.createTask({ id: "root", name: "root", cwd: "/tmp" });
      store.createSession("s1", "/tmp", "auto", "s1", "root");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "one" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "a" },
        { from_ref: "agent" },
      );
      // clear → 旧 session 退役（记录保留）、新 session 接过
      store.retireSession("s1");
      store.createSession("s2", "/tmp", "auto", "s2", "root");
      store.saveEvent(
        "s2",
        "user_message",
        { text: "two" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s2",
        "assistant_message",
        { text: "b" },
        { from_ref: "agent" },
      );

      assert.equal(store.getTaskLiveSession("root")?.id, "s2");

      const events = store.getTaskEvents("root");
      assert.deepEqual(
        events.map((e) => e.session_id),
        ["s1", "s1", "s2", "s2"],
      );
      // global sequence: ids increase monotonically across sessions
      for (let i = 1; i < events.length; i++) {
        assert.ok(events[i].id > events[i - 1].id);
      }
    });

    it("filters by afterId, excludeThinking, and limit (last N in chronological order)", () => {
      store.createTask({ id: "root", name: "root", cwd: "/tmp" });
      store.createSession("s1", "/tmp", "auto", "s1", "root");
      for (let i = 0; i < 5; i++) {
        store.saveEvent(
          "s1",
          "user_message",
          { text: String(i) },
          { from_ref: "user" },
        );
      }
      store.saveEvent("s1", "thinking", {}, { from_ref: "agent" });

      const all = store.getTaskEvents("root");
      assert.equal(all.length, 6);

      const noThinking = store.getTaskEvents("root", { excludeThinking: true });
      assert.equal(noThinking.length, 5);

      const after = store.getTaskEvents("root", { afterId: all[1].id });
      assert.deepEqual(
        after.map((e) => e.id),
        all.slice(2).map((e) => e.id),
      );

      const last2 = store.getTaskEvents("root", { limit: 2 });
      assert.deepEqual(
        last2.map((e) => e.id),
        all.slice(-2).map((e) => e.id),
      );
      assert.ok(last2[0].id < last2[1].id); // chronological, not reversed
    });

    it("does not leak events of other tasks", () => {
      store.createTask({ id: "a", name: "a", cwd: "/tmp" });
      store.createTask({ id: "b", name: "b", cwd: "/tmp" });
      store.createSession("sa", "/tmp", "auto", "sa", "a");
      store.createSession("sb", "/tmp", "auto", "sb", "b");
      store.saveEvent(
        "sa",
        "user_message",
        { text: "in-a" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "sb",
        "user_message",
        { text: "in-b" },
        { from_ref: "user" },
      );

      const events = store.getTaskEvents("a");
      assert.equal(events.length, 1);
      assert.equal(events[0].session_id, "sa");
      assert.equal(
        (JSON.parse(events[0].data) as { text: string }).text,
        "in-a",
      );
    });
  });

  describe("deleteTask", () => {
    it("refuses to delete the root task", () => {
      store.createTask({ id: "root", name: "root", cwd: "/tmp" });
      assert.throws(() => {
        store.deleteTask("root");
      }, /root/);
    });

    it("cascades through the subtree: tasks, sessions, events, attachments, bindings", () => {
      store.createTask({ id: "root", name: "root", cwd: "/tmp" });
      store.createTask({
        id: "child",
        parentId: "root",
        name: "child",
        cwd: "/tmp",
      });
      store.createTask({
        id: "grand",
        parentId: "child",
        name: "grand",
        cwd: "/tmp",
      });
      // sessions + events under child and grand；cs2 先建后退役（模拟 previous execution）
      store.createSession("cs2", "/tmp", "auto", "cs2", "child");
      store.retireSession("cs2");
      store.createSession("cs", "/tmp", "auto", "cs", "child");
      store.createSession("gs", "/tmp", "auto", "gs", "grand");
      store.saveEvent(
        "cs",
        "user_message",
        { text: "x" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "gs",
        "user_message",
        { text: "y" },
        { from_ref: "user" },
      );
      store.insertAttachment({
        id: "att-1",
        sessionId: "cs",
        kind: "image",
        name: "a.png",
        mime: "image/png",
        size: 10,
        realpath: "/tmp/a.png",
      });
      // a separate task that must survive
      store.createTask({ id: "aunt", name: "aunt", cwd: "/tmp" });
      store.createSession("as", "/tmp", "auto", "as", "aunt");
      store.saveEvent(
        "as",
        "user_message",
        { text: "z" },
        { from_ref: "user" },
      );

      store.deleteTask("child");

      assert.equal(store.getTask("child"), undefined);
      assert.equal(store.getTask("grand"), undefined);
      assert.equal(store.getTask("aunt")?.id, "aunt");
      assert.equal(store.getTaskLiveSession("aunt")?.id, "as");
      assert.equal(store.getTaskEvents("aunt").length, 1);
      assert.equal(store.getSession("cs"), undefined);
      assert.equal(store.getSessionIncludingDeleted("cs2"), undefined);
      assert.equal(store.getSession("gs"), undefined);
      assert.equal(store.getAgentSessionId("cs"), undefined);
      assert.equal(store.getTaskAttachments("aunt").length, 0); // aunt 无附件
    });
  });
});
