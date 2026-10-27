import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { isReservedRootTaskId, ROOT_TASK_ID, Store } from "../src/store.ts";
import { generateShareToken } from "../src/tokens.ts";

describe("Store", () => {
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

  describe("tasks", () => {
    it("stores WebAgent and ACP task identities separately", () => {
      store.createTask("web-1", "/tmp/cwd", "auto", "agent-1");

      assert.equal(store.getAgentSessionId("web-1"), "agent-1");
      assert.equal(store.getTaskId("agent-1"), "web-1");
    });

    it("rotates the ACP binding without changing the WebAgent task", () => {
      store.createTask("web-1", "/tmp/cwd", "auto", "agent-1");

      store.replaceAgentSession("web-1", "agent-2");

      assert.equal(store.getAgentSessionId("web-1"), "agent-2");
      // The retired binding row is removed; its execution is explicitly
      // retired by the caller and never accepts WebAgent events again.
      assert.equal(store.getTaskId("agent-1"), undefined);
      assert.equal(store.getTaskId("agent-2"), "web-1");
      assert.equal(store.getTask("web-1")?.id, "web-1");
      const row = store["db"]
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_sessions WHERE agent_key = ?",
        )
        .get("test-agent") as { count: number };
      assert.equal(row.count, 1);
    });

    it("persists a requested cwd even when rotation is a no-op (same agent id)", () => {
      store.createTask("web-1", "/a", "auto", "agent-1");

      store.replaceAgentSession("web-1", "agent-1", "/b");

      assert.equal(store.getTask("web-1")?.cwd, "/b");
      assert.equal(store.getAgentSessionId("web-1"), "agent-1");
    });

    it("keeps internal ACP tasks out of the user task list", () => {
      store.registerInternalAgentSession("agent-title");

      assert.equal(store.getTaskId("agent-title"), undefined);
      assert.deepEqual(store.listTasks(), []);
    });

    it("only exposes tasks owned by the current agent", () => {
      store.createTask("web-a", "/a", "auto", "agent-a");
      store.close();

      const other = new Store(tmpDir, "other-agent");
      other.createTask("web-b", "/b", "auto", "agent-b");

      assert.deepEqual(
        other.listTasks().map((task) => task.id),
        ["web-b"],
      );
      assert.equal(other.getTask("web-a"), undefined);
      assert.equal(other.getTaskIncludingDeleted("web-a")?.id, "web-a");
      other.close();

      store = new Store(tmpDir, "test-agent");
      assert.equal(store.getTask("web-a")?.id, "web-a");
      assert.equal(store.getAgentSessionId("web-a"), "agent-a");
      assert.equal(store.getTask("web-b"), undefined);
    });

    it("uses the literal `root` identity for every agent key", () => {
      const root = store.ensureRootTask("/tmp/root");
      assert.equal(root.id, "root");
      assert.equal(root.parent_id, null);
      assert.equal(store.rootTaskId, "root");
      store.close();

      store = new Store(tmpDir, "test-agent");
      assert.equal(store.ensureRootTask("/tmp/changed").id, "root");
      assert.equal(store.getTaskIncludingDeleted("root")?.cwd, "/tmp/root");
      store.close();

      const other = new Store(tmpDir, "other-agent");
      assert.equal(other.rootTaskId, "root");
      assert.equal(other.ensureRootTask("/tmp/other").id, "root");
      other.close();
      store = new Store(tmpDir, "test-agent");
    });

    it("refuses a second agent's attach to the shared Root", () => {
      // Task semantics: Root is one task with one current execution. A second
      // agent may not append a binding of its own; the ownership change has to
      // go through the replace path with its guards.
      const root = store.ensureRootTask("/tmp/root");
      store.attachAgentSession(root.id, "session-a");
      store.close();

      const other = new Store(tmpDir, "other-agent");
      assert.throws(
        () => other.attachAgentSession("root", "session-b"),
        /already has an execution binding/,
      );
      assert.equal(other.getAgentSessionId("root"), undefined);
      assert.equal(
        other.getCurrentExecutionBinding("root")?.agent_session_id,
        "session-a",
      );
      other.close();

      store = new Store(tmpDir, "test-agent");
      assert.equal(store.getAgentSessionId("root"), "session-a");
    });

    it("keeps Root anchored and reparents a corrupted Root to NULL", () => {
      store.createTask("malformed-parent", "/parent");
      const rootId = store.rootTaskId;
      store.attachAgentSession(rootId, "root-session");
      store["db"]
        .prepare("UPDATE tasks SET parent_id = ?, title = NULL WHERE id = ?")
        .run("malformed-parent", rootId);

      const root = store.ensureRootTask("/must-not-change-cwd");
      assert.equal(root.parent_id, null);
      assert.equal(root.title, "root");
      assert.equal(root.cwd, "/parent");
      assert.equal(
        store.getTaskIncludingDeleted("malformed-parent")?.parent_id,
        rootId,
      );
      assert.equal(store.getAgentSessionId(rootId), "root-session");
    });

    it("creates and retrieves a task", () => {
      const task = store.createTask("sess-1", "/tmp/cwd");
      assert.equal(task.id, "sess-1");
      assert.equal(task.cwd, "/tmp/cwd");
      // Without an explicit title, the stable task id is the default title
      // so every live task has a non-empty, unique display name.
      assert.equal(task.title, "sess-1");
    });

    it("stores an optional parent WebAgent task", () => {
      store.attachAgentSession(
        store.ensureRootTask("/tmp/root").id,
        "agent-root",
      );
      const child = store.createTask(
        "child",
        "/tmp/child",
        "auto",
        "agent-child",
        "root",
      );

      assert.equal(child.parent_id, "root");
      assert.equal(store.getTask("child")?.parent_id, "root");
    });

    it("creates the Root from the first task write and keeps its cwd", () => {
      store.createTask("old-1", "/tmp/one", "auto", "agent-one");
      store.createTask("old-2", "/tmp/two", "auto", "agent-two");

      const root = store.ensureRootTask("/tmp/root");

      assert.equal(root.id, store.rootTaskId);
      assert.equal(root.parent_id, null);
      assert.equal(root.title, "root");
      // The first createTask supplied the Root cwd; ensureRootTask does not
      // overwrite the existing anchor.
      assert.equal(root.cwd, "/tmp/one");
      assert.equal(store.getTaskIncludingDeleted("old-1")?.parent_id, "root");
      assert.equal(store.getTaskIncludingDeleted("old-2")?.parent_id, "root");
      assert.deepEqual(
        store
          .listTasks()
          .map((task) => task.id)
          .sort(),
        ["old-1", "old-2"],
      );

      assert.equal(store.ensureRootTask("/tmp/other").cwd, "/tmp/one");
      assert.equal(store.ensureRootTask("/tmp/other").title, "root");
    });

    it("creates the literal Root on the first direct task write", () => {
      const task = store.createTask("t1", "/tmp/x");

      const root = store.getTaskIncludingDeleted("root")!;
      assert.equal(root.id, "root");
      assert.equal(root.parent_id, null);
      assert.equal(root.source, "root");
      assert.equal(root.title, "root");
      assert.equal(root.cwd, "/tmp/x");
      assert.equal(task.parent_id, "root");

      const parentless = store["db"]
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id IS NULL")
        .get() as { n: number };
      assert.equal(parentless.n, 1);

      // A Store-produced database reopens without legacy refusal.
      store.close();
      store = new Store(tmpDir, "test-agent");
      assert.equal(store.getTaskIncludingDeleted("root")?.id, "root");
      assert.equal(store.getTask("t1")?.parent_id, "root");
    });

    it("keeps a user-renamed Root title across restarts", () => {
      store.ensureRootTask("/tmp/root");
      store.updateTaskTitle(store.rootTaskId, "工作台");

      assert.equal(store.ensureRootTask("/tmp/root").title, "工作台");
    });

    it("names a task by its root-relative tree path", () => {
      store.ensureRootTask("/tmp/root");
      store.createTask(
        "path-parent",
        "/tmp/root",
        "auto",
        "agent-p",
        store.rootTaskId,
      );
      store.createTask(
        "path-child",
        "/tmp/root",
        "auto",
        "agent-c",
        "path-parent",
      );
      store.updateTaskTitle("path-parent", "Bench");
      store.updateTaskTitle("path-child", "Review notes");

      // Root is the path origin, never a segment, and a segment with a space is
      // quoted so the result pastes straight into the input.
      assert.equal(store.getTaskPath("path-child"), '@/Bench/"Review notes"');
      assert.equal(store.getTaskPath("path-parent"), "@/Bench");
      assert.equal(store.getTaskPath(store.rootTaskId), "@/");
      assert.equal(store.getTaskPath("missing-task"), undefined);
    });

    it("persists and clears one pending compact summary with its assistant event", () => {
      store.createTask("web-1", "/tmp/root", "auto", "agent-1");

      store.saveCompactSummary("web-1", "Current goal and next action");

      const pending = store.getPendingCompactSummary("web-1");
      assert.deepEqual(pending, {
        summary: "Current goal and next action",
        seq: 1,
        raw: JSON.stringify({
          summary: "Current goal and next action",
          seq: 1,
        }),
      });
      const summary = store
        .getEvents("web-1")
        .find((event) => event.type === "assistant_message");
      assert.deepEqual(JSON.parse(summary!.data), {
        text: "Current goal and next action",
        compact: { prev: null },
      });
      assert.equal(
        store.clearPendingCompactSummary("web-1", "wrong summary"),
        false,
      );
      assert.equal(
        store.clearPendingCompactSummary(
          "web-1",
          JSON.stringify({
            summary: "Current goal and next action",
            seq: 1,
          }),
        ),
        true,
      );
      assert.equal(store.getPendingCompactSummary("web-1"), null);

      // Plain-text values from before the envelope format remain readable.
      store["db"]
        .prepare("UPDATE tasks SET pending_compact_summary = ? WHERE id = ?")
        .run("legacy summary", "web-1");
      assert.deepEqual(store.getPendingCompactSummary("web-1"), {
        summary: "legacy summary",
        seq: null,
        raw: "legacy summary",
      });
      assert.equal(store.clearPendingCompactSummary("web-1", "wrong"), false);
      assert.equal(
        store.clearPendingCompactSummary("web-1", "legacy summary"),
        true,
      );
    });

    it("links compact summaries to the preceding compact event", () => {
      store.createTask("web-1", "/tmp/root");
      const first = store.saveCompactSummary("web-1", "first");
      const second = store.saveCompactSummary("web-1", "second");
      assert.deepEqual(JSON.parse(first.data).compact, { prev: null });
      assert.deepEqual(JSON.parse(second.data).compact, { prev: first.seq });
      assert.equal(store.getPendingCompactSummary("web-1")?.seq, second.seq);
    });

    it("binds an ACP execution to an existing Root record", () => {
      store.ensureRootTask("/tmp/root");

      store.attachAgentSession(store.rootTaskId, "agent-root");

      assert.equal(store.getAgentSessionId(store.rootTaskId), "agent-root");
      assert.equal(store.getTask(store.rootTaskId)?.id, store.rootTaskId);
    });

    it("protects the Root task from deletion", () => {
      store.ensureRootTask("/tmp/root");

      assert.throws(
        () => store.deleteTask(store.rootTaskId),
        /Root task cannot be deleted/,
      );
    });

    it("does not garbage-collect the Root task when it is empty", () => {
      store.ensureRootTask("/tmp/root");
      store.attachAgentSession(store.rootTaskId, "agent-root");

      assert.deepEqual(store.deleteEmptyTasks(0), []);
      assert.equal(store.getTask(store.rootTaskId)?.id, store.rootTaskId);
    });

    it("lists tasks ordered by last_active_at desc", () => {
      store.createTask("old", "/a");
      store.createTask("new", "/b");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      store.updateTaskLastActive("old"); // touch "old" to make it most recent

      const list = store.listTasks();
      assert.equal(list[0].id, "old");
      assert.equal(list[1].id, "new");
    });

    it("stores last_active_at as unix milliseconds", () => {
      store.createTask("s1", "/x");
      const before = Date.now();
      store.updateTaskLastActive("s1");

      const task = store.getTask("s1")!;
      assert.equal(typeof task.last_active_at, "number");
      assert.ok(Number.isInteger(task.last_active_at));
      assert.ok(task.last_active_at >= before);
    });

    it("returns undefined for non-existent task", () => {
      assert.equal(store.getTask("nope"), undefined);
    });

    it("updates title", () => {
      store.createTask("s1", "/x");
      store.updateTaskTitle("s1", "My Title");
      assert.equal(store.getTask("s1")!.title, "My Title");
    });

    it("updates config options (model, mode, reasoning_effort)", () => {
      store.createTask("s1", "/x");
      store.updateTaskConfig("s1", "model", "claude-sonnet");
      store.updateTaskConfig("s1", "mode", "plan");
      store.updateTaskConfig("s1", "reasoning_effort", "high");
      const s = store.getTask("s1")!;
      assert.equal(s.model, "claude-sonnet");
      assert.equal(s.mode, "plan");
      assert.equal(s.reasoning_effort, "high");

      store.updateTaskConfig("s1", "thought_level", "xhigh");
      assert.equal(store.getTask("s1")!.reasoning_effort, "xhigh");
    });

    it("ignores unknown config option ids", () => {
      store.createTask("s1", "/x");
      store.updateTaskConfig("s1", "unknown_thing", "value");
      // Should not throw, just no-op
      assert.equal(store.getTask("s1")!.model, null);
    });

    it("deletes task and its events", () => {
      store.createTask("s1", "/x", "auto", "agent-s1");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );
      store.deleteTask("s1");

      assert.equal(store.getTask("s1"), undefined);
      assert.deepEqual(store.getEvents("s1"), []);
      assert.equal(store.getTaskId("agent-s1"), undefined);
    });
  });

  describe("reserved Root namespace and ownership", () => {
    it("uses the literal id `root`", () => {
      assert.equal(ROOT_TASK_ID, "root");
      assert.equal(store.rootTaskId, "root");
    });

    it("reserves only the exact literal id", () => {
      assert.equal(isReservedRootTaskId("root"), true);
      assert.equal(isReservedRootTaskId("root-2f3a"), false);
      assert.equal(isReservedRootTaskId("root-forged"), false);
      assert.equal(isReservedRootTaskId("Root"), false);
    });

    it("rejects only the exact literal Root as ordinary creation", () => {
      assert.throws(
        () => store.createTask("root", "/tmp/forged"),
        /Reserved Root id cannot be created/,
      );
      // Prefix-shaped ids are ordinary tasks again; the reservation is exact.
      store.createTask("root-forged", "/tmp/forged");
      store.createTask("root-2f3a", "/tmp/hashy");
      assert.equal(store.getTask("root-forged")?.id, "root-forged");
      assert.equal(store.getTask("root-2f3a")?.id, "root-2f3a");
    });

    it("refuses generic delete, reap, and GC on the literal Root", () => {
      const rootId = store.ensureRootTask("/root").id;
      store.attachAgentSession(rootId, "root-session");

      assert.throws(
        () => store.deleteTask(rootId),
        /Root task cannot be deleted/,
      );
      assert.equal(store.reapTombstoneIfOrphaned(rootId), false);
      assert.deepEqual(store.deleteEmptyTasks(0), []);
      assert.equal(store.getTask(rootId)?.id, "root");

      // Even a corrupted tombstone flag must not let reap claim Root.
      store["db"]
        .prepare("UPDATE tasks SET deleted_at = ? WHERE id = ?")
        .run(Date.now(), rootId);
      assert.equal(store.reapTombstoneIfOrphaned(rootId), false);
      assert.ok(store.getTaskIncludingDeleted(rootId));
    });

    it("accepts the global Root as a parent for another agent's task", () => {
      store.ensureRootTask("/root");
      const other = new Store(tmpDir, "foreign-backend");
      other.attachAgentSession("root", "foreign-root-session");
      assert.equal(other.getParentTask("root")?.id, "root");
      other.close();
    });
  });

  describe("survivor ownership fallback", () => {
    it("reparents a uniquely bound survivor to the global Root", () => {
      const rootId = store.ensureRootTask("/root").id;
      store.createTask("a-parent", "/a", "auto", "a-parent-session", rootId);
      store.close();

      const b = new Store(tmpDir, "backend-b");
      b.createTask("b-survivor", "/b", "auto", "b-child-session", "a-parent");
      b.saveEvent(
        "b-survivor",
        "user_message",
        { text: "preserve" },
        { from_ref: "user" },
      );
      const token = generateShareToken();
      b.insertSharePreview({ token, taskId: "b-survivor", snapshotSeq: 1 });
      b.close();

      store = new Store(tmpDir, "test-agent");
      store.deleteTask("a-parent");
      const check = new Store(tmpDir, "backend-b");
      assert.equal(check.getTask("b-survivor")?.parent_id, "root");
      assert.equal(check.getEvents("b-survivor").length, 1);
      assert.ok(check.getShareByToken(token));
      assert.equal(check.getAgentSessionId("b-survivor"), "b-child-session");
      check.close();
    });

    it("keeps a single current owner instead of accumulating bindings", () => {
      // Rewritten from the old alias contract ("a multiply-owned survivor"):
      // one task can never be bound by two agents at once, so the replacement
      // is the only way ownership moves, and the old owner stops resolving.
      const rootId = store.ensureRootTask("/root").id;
      store.createTask("a-parent", "/a", "auto", "parent-session", rootId);
      const b = new Store(tmpDir, "backend-b");
      b.createTask("single-owner", "/b", "auto", "b-session", "a-parent");
      b.saveEvent(
        "single-owner",
        "assistant_message",
        { text: "preserve" },
        { from_ref: "agent" },
      );
      b.close();

      const c = new Store(tmpDir, "backend-c");
      assert.throws(
        () => c.attachAgentSession("single-owner", "c-session"),
        /already has an execution binding/,
      );
      // The sanctioned move is an explicit replacement.
      c.replaceAgentSession("single-owner", "c-session");
      c.close();

      const bCheck = new Store(tmpDir, "backend-b");
      const cCheck = new Store(tmpDir, "backend-c");
      assert.equal(bCheck.getAgentSessionId("single-owner"), undefined);
      assert.equal(cCheck.getAgentSessionId("single-owner"), "c-session");
      const rows = store["db"]
        .prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE task_id = ?")
        .get("single-owner") as { n: number };
      assert.equal(rows.n, 1);
      bCheck.close();
      cCheck.close();
    });

    it("reparents an unbound survivor without losing its history, share, or attachment", () => {
      const rootId = store.ensureRootTask("/root").id;
      store.createTask("a-parent", "/a", "auto", "parent-session", rootId);
      store.createTask(
        "unbound-child",
        "/child",
        "auto",
        "child-session",
        "a-parent",
      );
      store["db"]
        .prepare(
          "DELETE FROM agent_sessions WHERE agent_key = ? AND task_id = ?",
        )
        .run(store.agentKey, "unbound-child");
      store.saveEvent(
        "unbound-child",
        "assistant_message",
        { text: "retain" },
        { from_ref: "agent" },
      );
      store.insertAttachment({
        id: "unbound-attachment",
        taskId: "unbound-child",
        kind: "file",
        name: "retained.txt",
        mime: "text/plain",
        size: 1,
        realpath: "/tmp/retained.txt",
      });
      const token = generateShareToken();
      store.insertSharePreview({
        token,
        taskId: "unbound-child",
        snapshotSeq: 1,
      });
      store.activateShare(token);

      store.deleteTask("a-parent");

      const survivor = store.getTaskIncludingDeleted("unbound-child")!;
      assert.equal(survivor.parent_id, "root");
      assert.equal(survivor.deleted_at, null);
      assert.equal(store.getEvents("unbound-child").length, 1);
      assert.equal(
        store.getAttachment("unbound-child", "unbound-attachment")?.realpath,
        "/tmp/retained.txt",
      );
      assert.ok(store.getShareByToken(token));
    });

    it("detaches a foreign survivor when the global Root title namespace collides", () => {
      const rootId = store.ensureRootTask("/root").id;
      store.createTask("a-parent", "/a", "auto", "parent-session", rootId);
      store.createTask(
        "collision",
        "/b/one",
        "auto",
        "collision-session",
        rootId,
        {
          title: "duplicate",
        },
      );
      const b = new Store(tmpDir, "backend-b");
      b.createTask(
        "survivor",
        "/b/two",
        "auto",
        "survivor-session",
        "a-parent",
        {
          title: "duplicate",
        },
      );
      b.saveEvent(
        "survivor",
        "assistant_message",
        { text: "keep" },
        { from_ref: "agent" },
      );
      b.close();

      store.deleteTask("a-parent");
      const survivor = store.getTaskIncludingDeleted("survivor")!;
      assert.equal(survivor.parent_id, null);
      assert.equal(store.getEvents("survivor").length, 1);
      assert.equal(store.getTask("collision")?.title, "duplicate");
    });

    it("detaches a foreign survivor when the Root anchor was corrupted away", () => {
      store.createTask("a-parent", "/a", "auto", "parent-session");
      const b = new Store(tmpDir, "backend-b");
      b.createTask("survivor", "/b", "auto", "survivor-session", "a-parent");
      b.saveEvent(
        "survivor",
        "assistant_message",
        { text: "keep" },
        { from_ref: "agent" },
      );
      b.close();

      // Simulate a hand-corrupted DB after the invariant was established.
      store["db"]
        .prepare("UPDATE tasks SET parent_id = NULL WHERE id = 'a-parent'")
        .run();
      store["db"].prepare("DELETE FROM tasks WHERE id = 'root'").run();

      store.deleteTask("a-parent");
      const survivor = store.getTaskIncludingDeleted("survivor")!;
      assert.equal(survivor.parent_id, null);
      assert.equal(store.getEvents("survivor").length, 1);
    });
  });

  describe("binding write authority", () => {
    it("refuses a foreign attach and records no fact for it", () => {
      store.createTask("t1", "/a", "auto", "session-a");
      const batches: unknown[][] = [];
      store.onBindingsCommitted((changes) => batches.push([...changes]));

      const other = new Store(tmpDir, "other-agent");
      assert.throws(
        () => other.attachAgentSession("t1", "session-b"),
        /already has an execution binding/,
      );
      other.close();

      assert.deepEqual(batches, []);
      assert.equal(
        store.getCurrentExecutionBinding("t1")?.agent_session_id,
        "session-a",
      );
    });

    it("treats the same session id from another agent as a different execution", () => {
      store.createTask("t1", "/a", "auto", "shared-id");
      store.close();
      store = new Store(tmpDir, "test-agent");

      const other = new Store(tmpDir, "other-agent");
      const batches: Array<Array<{ before: unknown; after: unknown }>> = [];
      other.onBindingsCommitted((changes) => {
        batches.push(changes.map((change) => ({ ...change })));
      });
      other.replaceAgentSession("t1", "shared-id");
      other.close();

      // Same session string, different ownership: the binding really moved.
      assert.equal(batches.length, 1);
      assert.deepEqual(batches[0][0].before, {
        agentId: "test-agent",
        sessionId: "shared-id",
      });
      assert.deepEqual(batches[0][0].after, {
        agentId: "other-agent",
        sessionId: "shared-id",
      });
    });

    it("detaches the current binding and reports the removal", () => {
      store.createTask("t1", "/a", "auto", "session-a");

      const removed = store.detachAgentSession("t1");

      assert.equal(removed?.agent_session_id, "session-a");
      assert.equal(store.getCurrentExecutionBinding("t1"), undefined);
    });

    it("emits one batch per outermost commit and one fact per task", () => {
      const batches: string[][] = [];
      store.onBindingsCommitted((changes) => {
        batches.push(changes.map((change) => change.taskId));
      });
      store.ensureRootTask("/root");
      store.attachAgentSession("root", "root-session");
      store.createTask("child", "/c", "auto", "child-session", "root");

      // Root reset replaces Root's execution and deletes the child in one
      // outermost transaction: one batch, one fact per task.
      store.resetRootTask();

      assert.deepEqual(batches, [["root"], ["child"], ["child", "root"]]);
      const rootFacts = batches[2].filter((id) => id === "root");
      assert.equal(rootFacts.length, 1);
      assert.equal(
        store.getCurrentExecutionBinding("root")?.agent_session_id,
        "",
      );
    });

    it("discards a rolled-back batch instead of leaking it into the next commit", () => {
      const batches: unknown[] = [];
      store.createTask("t1", "/a", "auto", "session-a");
      store.onBindingsCommitted((changes) => batches.push([...changes]));

      // A nested scope replaces the binding and then the outermost scope
      // fails: the replacement is rolled back, so its fact must not survive
      // into the next successful commit.
      assert.throws(() =>
        store["writeBindings"](() => {
          store.replaceAgentSession("t1", "session-b");
          throw new Error("outer failure");
        }),
      );
      assert.deepEqual(batches, []);
      assert.equal(
        store.getCurrentExecutionBinding("t1")?.agent_session_id,
        "session-a",
      );

      store.replaceAgentSession("t1", "session-c");
      assert.equal(batches.length, 1);
      assert.equal(
        (batches[0] as Array<{ before: { sessionId: string } }>)[0].before
          .sessionId,
        "session-a",
      );
    });
  });

  describe("cascade deletion", () => {
    it("lists all transitive descendants", () => {
      store.createTask("parent", "/a", "auto", "agent-parent");
      store.createTask("child", "/b", "auto", "agent-child", "parent");
      store.createTask("grandchild", "/c", "auto", "agent-grandchild", "child");
      store.createTask("sibling", "/d", "auto", "agent-sibling", "parent");

      assert.deepEqual(store.getDescendantTaskIds("parent").sort(), [
        "child",
        "grandchild",
        "sibling",
      ]);
      assert.deepEqual(store.getDescendantTaskIds("child"), ["grandchild"]);
      assert.deepEqual(store.getDescendantTaskIds("leaf"), []);
    });

    it("hard-deletes a parent together with its live descendants", () => {
      store.createTask("parent", "/a", "auto", "agent-parent");
      store.createTask("child", "/b", "auto", "agent-child", "parent");
      store.createTask("grandchild", "/c", "auto", "agent-grandchild", "child");

      const result = store.deleteTask("parent");

      assert.equal(result.mode, "hard");
      assert.deepEqual(result.affected.map((entry) => entry.id).sort(), [
        "child",
        "grandchild",
        "parent",
      ]);
      for (const id of ["parent", "child", "grandchild"]) {
        assert.equal(store.getTaskIncludingDeleted(id), undefined);
        assert.equal(store.getAgentSessionId(id), undefined);
      }
      const count = store["db"]
        .prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE agent_key = ?")
        .get("test-agent") as { n: number };
      assert.equal(count.n, 0);
    });

    it("tombstones a share-backed child and re-parents it under Root", () => {
      store.ensureRootTask("/root");
      store.attachAgentSession(store.rootTaskId, "agent-root");
      store.createTask("parent", "/a", "auto", "agent-parent");
      store.createTask("child", "/b", "auto", "agent-child", "parent");
      const token = generateShareToken();
      store.insertSharePreview({ token, taskId: "child", snapshotSeq: 1 });
      store.activateShare(token);

      const result = store.deleteTask("parent");

      assert.equal(result.mode, "hard");
      const child = store.getTaskIncludingDeleted("child")!;
      assert.notEqual(child.deleted_at, null); // kept for the share viewer
      assert.equal(child.parent_id, "root"); // preserved under the global anchor
      assert.equal(store.getTask("parent"), undefined);
      assert.equal(
        result.affected.find((entry) => entry.id === "child")?.agentSessionId,
        "agent-child",
      );
    });

    it("re-parents tombstoned descendants under Root when reaping a tombstone", () => {
      store.ensureRootTask("/root");
      store.attachAgentSession(store.rootTaskId, "agent-root");
      store.createTask("parent", "/a", "auto", "agent-parent");
      store.createTask("child", "/b", "auto", "agent-child", "parent");
      const parentToken = generateShareToken();
      store.insertSharePreview({
        token: parentToken,
        taskId: "parent",
        snapshotSeq: 1,
      });
      store.activateShare(parentToken);
      const childToken = generateShareToken();
      store.insertSharePreview({
        token: childToken,
        taskId: "child",
        snapshotSeq: 1,
      });
      store.activateShare(childToken);
      store.saveEvent(
        "child",
        "assistant_message",
        { text: "preserve nested share history" },
        { from_ref: "agent" },
      );
      store.insertAttachment({
        id: "shared-child-file",
        taskId: "child",
        kind: "file",
        name: "shared.txt",
        mime: "text/plain",
        size: 1,
        realpath: "/tmp/shared.txt",
      });

      // Both tasks are tombstoned (kept alive by their shares).
      const soft = store.deleteTask("parent");
      assert.equal(soft.mode, "soft");
      assert.equal(
        store.getTaskIncludingDeleted("child")!.deleted_at !== null,
        true,
      );

      // Reap the parent once its last share is revoked.
      assert.equal(store.revokeShare(parentToken), true);
      assert.equal(store.reapTombstoneIfOrphaned("parent"), true);

      // The child's tombstone survives under the global Root anchor.
      const child = store.getTaskIncludingDeleted("child")!;
      assert.equal(child.parent_id, "root");
      assert.notEqual(child.deleted_at, null);
      assert.equal(store.getEvents("child").length, 1);
      assert.equal(
        store.getAttachment("child", "shared-child-file")?.realpath,
        "/tmp/shared.txt",
      );
      assert.equal(store.hasActiveShare("child"), true);
      assert.ok(store.getShareByToken(childToken));
    });

    it("unbinds the ACP binding when a task is tombstoned", () => {
      store.createTask("s1", "/a", "auto", "agent-s1");
      const token = generateShareToken();
      store.insertSharePreview({ token, taskId: "s1", snapshotSeq: 1 });
      store.activateShare(token);

      const result = store.deleteTask("s1");

      assert.equal(result.affected[0].mode, "soft");
      assert.equal(result.affected[0].agentSessionId, "agent-s1");
      assert.equal(store.getAgentSessionId("s1"), undefined);
      assert.equal(store.getTaskId("agent-s1"), undefined);
    });

    it("re-parents an empty GC'd task's children under Root", () => {
      store.ensureRootTask("/root");
      store.attachAgentSession(store.rootTaskId, "agent-root");
      store.createTask("junk-parent", "/a", "auto", "agent-parent");
      store.createTask("child", "/b", "auto", "agent-child", "junk-parent");
      // Child has events, so it is not itself GC'd.
      store.saveEvent(
        "child",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );

      const removed = store.deleteEmptyTasks(0);

      assert.ok(removed.some((entry) => entry.id === "junk-parent"));
      assert.equal(store.getTaskIncludingDeleted("junk-parent"), undefined);
      assert.equal(store.getTask("child")!.parent_id, store.rootTaskId);
    });
  });

  describe("Root reset and deletion", () => {
    it("clears Root history, resources, and descendants, leaving lazy ownership", () => {
      const root = store.ensureRootTask("/root");
      store.attachAgentSession(root.id, "root-session");
      store.saveEvent(
        root.id,
        "user_message",
        { text: "sentinel" },
        { from_ref: "user" },
      );
      store.saveCompactSummary(root.id, "compact sentinel");
      store.saveClientOp(root.id, "op-a", { status: 200, body: { a: true } });
      store.insertAttachment({
        id: "attachment-a",
        taskId: root.id,
        kind: "file",
        name: "a.txt",
        mime: "text/plain",
        size: 1,
        realpath: "/tmp/a.txt",
      });
      const preview = generateShareToken();
      store.insertSharePreview({
        token: preview,
        taskId: root.id,
        snapshotSeq: 1,
      });
      store.createTask("a-task", "/a", "auto", "agent-a", root.id);
      store.saveEvent(
        "a-task",
        "user_message",
        { text: "a" },
        { from_ref: "user" },
      );

      const result = store.resetRootTask();
      assert.deepEqual(
        result.affected.map((entry) => entry.id),
        ["a-task"],
      );
      assert.equal(result.retiredAgentSessionId, "root-session");
      assert.equal(store.getEvents(root.id).length, 0);
      assert.equal(store.getPendingCompactSummary(root.id), null);
      assert.equal(store.getClientOp(root.id, "op-a"), null);
      assert.deepEqual(store.listAttachmentRealpaths(root.id), []);
      assert.equal(store.getShareByToken(preview), undefined);
      assert.equal(store.getTaskIncludingDeleted("a-task"), undefined);
      // DB-only reset keeps the anchor visible and owned, with an empty
      // execution id as the lazy-materialization marker.
      const after = store.getTask(root.id)!;
      assert.equal(after.parent_id, null);
      assert.equal(store.getAgentSessionId(root.id), "");
      assert.equal(store.getTaskOwnerAgentKey(root.id), store.agentKey);
    });

    it("blocks reset while Root has an active share", () => {
      const rootId = store.ensureRootTask("/root").id;
      const token = generateShareToken();
      store.insertSharePreview({ token, taskId: rootId, snapshotSeq: 1 });
      store.activateShare(token);

      assert.throws(() => store.resetRootTask(), /active share/);
      assert.equal(store.revokeShare(token), true);
      assert.deepEqual(store.resetRootTask().affected, []);
    });

    it("preserves an unbound shared tombstone when resetting Root", () => {
      const rootId = store.ensureRootTask("/root").id;
      store.attachAgentSession(rootId, "root-session");
      store.createTask("a-task", "/a", "auto", "agent-a", rootId);
      // A share tombstone under Root: the row survives, its binding is gone,
      // so no agent owns it.
      store.createTask("orphan", "/o", "auto", "agent-orphan", rootId);
      const token = generateShareToken();
      store.insertSharePreview({ token, taskId: "orphan", snapshotSeq: 1 });
      store.activateShare(token);
      assert.equal(store.deleteTask("orphan").mode, "soft");

      const result = store.resetRootTask();
      assert.deepEqual(result.affected.map((entry) => entry.id).sort(), [
        "a-task",
      ]);
      const orphan = store.getTaskIncludingDeleted("orphan")!;
      assert.equal(orphan.id, "orphan");
      assert.notEqual(orphan.deleted_at, null);
    });

    it("reparents a foreign survivor under the global Root", () => {
      const rootId = store.ensureRootTask("/root").id;
      store.attachAgentSession(rootId, "root-session");
      store.createTask("a-parent", "/a", "auto", "agent-a", rootId);
      store.close();

      const other = new Store(tmpDir, "other-agent");
      other.createTask("b-child", "/b", "auto", "agent-b", "a-parent");
      other.saveEvent(
        "b-child",
        "user_message",
        { text: "b" },
        { from_ref: "user" },
      );
      other.close();

      store = new Store(tmpDir, "test-agent");
      const result = store.deleteTask("a-parent");
      assert.deepEqual(
        result.affected.map((entry) => entry.id),
        ["a-parent"],
      );
      const survivor = store.getTaskIncludingDeleted("b-child")!;
      assert.equal(survivor.id, "b-child");
      assert.equal(survivor.parent_id, "root");

      const check = new Store(tmpDir, "other-agent");
      assert.equal(check.getTask("b-child")?.id, "b-child");
      assert.equal(check.getEvents("b-child").length, 1);
      check.close();
    });
  });

  describe("events", () => {
    it("saves and retrieves events with auto-incrementing seq", () => {
      store.createTask("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hello" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "world" },
        { from_ref: "agent" },
      );

      const events = store.getEvents("s1");
      assert.equal(events.length, 2);
      assert.equal(events[0].seq, 1);
      assert.equal(events[1].seq, 2);
      assert.equal(events[0].type, "user_message");
      assert.deepEqual(JSON.parse(events[0].data), { text: "hello" });
    });

    it("reports actionable duplicate seqs before creating the unique index", () => {
      const duplicateDir = mkdtempSync(
        join(tmpdir(), "webagent-duplicate-events-"),
      );
      const duplicateStore = new Store(duplicateDir, "test-agent");
      duplicateStore.createTask("duplicate-task", "/x");
      duplicateStore.saveEvent(
        "duplicate-task",
        "user_message",
        { text: "one" },
        { from_ref: "user" },
      );
      duplicateStore["db"].exec("DROP INDEX idx_events_task_seq");
      duplicateStore["db"]
        .prepare(
          "INSERT INTO events (task_id, seq, type, data, created_at, from_ref) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          "duplicate-task",
          1,
          "assistant_message",
          '{"text":"two"}',
          Date.now(),
          "agent",
        );
      duplicateStore.close();

      assert.throws(
        () => new Store(duplicateDir, "test-agent"),
        /task_id=duplicate-task.*seq=1.*duplicate_rows=2.*Resolve duplicate events before upgrading/,
      );
      rmSync(duplicateDir, { recursive: true, force: true });
    });

    it("excludes thinking events when requested", () => {
      store.createTask("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "thinking",
        { text: "hmm..." },
        { from_ref: "agent" },
      );
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "ok" },
        { from_ref: "agent" },
      );

      const all = store.getEvents("s1");
      assert.equal(all.length, 3);

      const noThinking = store.getEvents("s1", { excludeThinking: true });
      assert.equal(noThinking.length, 2);
      assert.ok(noThinking.every((e) => e.type !== "thinking"));
    });

    it("returns empty array for task with no events", () => {
      store.createTask("s1", "/x");
      assert.deepEqual(store.getEvents("s1"), []);
    });

    it("returns the latest event time per requested task", () => {
      store.createTask("s1", "/x");
      store.createTask("s2", "/x");
      store.createTask("empty", "/x");
      store.saveEvent("s1", "user_message", {}, { from_ref: "user" });
      store.saveEvent("s1", "assistant_message", {}, { from_ref: "agent" });
      store.saveEvent("s2", "user_message", {}, { from_ref: "user" });
      for (const [taskId, seq, at] of [
        ["s1", 1, Date.UTC(2026, 0, 1, 0, 0, 0, 1)],
        ["s1", 2, Date.UTC(2026, 0, 1, 0, 0, 2, 1)],
        ["s2", 1, Date.UTC(2026, 0, 1, 0, 0, 3, 1)],
      ] as const) {
        store["db"]
          .prepare(
            "UPDATE events SET created_at = ? WHERE task_id = ? AND seq = ?",
          )
          .run(at, taskId, seq);
      }

      const times = store.getLatestEventTimes(["s1", "s2", "empty", "missing"]);
      // `s1` reports its newest event, `empty`/`missing` are absent, and no
      // unrelated task leaks in.
      assert.deepEqual([...times.entries()].sort(), [
        ["s1", Date.UTC(2026, 0, 1, 0, 0, 2, 1)],
        ["s2", Date.UTC(2026, 0, 1, 0, 0, 3, 1)],
      ]);
      assert.deepEqual(store.getLatestEventTimes([]), new Map());
    });

    it("filters events by afterSeq", () => {
      store.createTask("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "a" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "b" },
        { from_ref: "agent" },
      );
      store.saveEvent(
        "s1",
        "user_message",
        { text: "c" },
        { from_ref: "user" },
      );

      const after1 = store.getEvents("s1", { afterSeq: 1 });
      assert.equal(after1.length, 2);
      assert.equal(after1[0].seq, 2);
      assert.equal(after1[1].seq, 3);

      const after3 = store.getEvents("s1", { afterSeq: 3 });
      assert.equal(after3.length, 0);
    });

    it("combines afterSeq with excludeThinking", () => {
      store.createTask("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "a" },
        { from_ref: "user" },
      );
      store.saveEvent("s1", "thinking", { text: "hmm" }, { from_ref: "agent" });
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "b" },
        { from_ref: "agent" },
      );

      const events = store.getEvents("s1", {
        afterSeq: 1,
        excludeThinking: true,
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "assistant_message");
    });
  });

  describe("deleteEmptyTasks", () => {
    it("deletes old empty tasks and returns their IDs", () => {
      store.createTask("empty-old", "/a");
      store.createTask("has-events", "/b");
      store.saveEvent(
        "has-events",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );

      // With minAgeS=0, all empty tasks are eligible
      const deleted = store.deleteEmptyTasks(0);
      assert.deepEqual(deleted, [
        { id: "empty-old", agentSessionId: "empty-old" },
      ]);
      assert.equal(store.getTask("empty-old"), undefined);
      assert.ok(store.getTask("has-events")); // preserved
    });

    it("skips empty tasks younger than minAgeS", () => {
      store.createTask("fresh-empty", "/a");

      // With a large minAgeS, the just-created task is too young
      const deleted = store.deleteEmptyTasks(3600);
      assert.deepEqual(deleted, []);
      assert.ok(store.getTask("fresh-empty")); // still there
    });

    it("does not delete empty tasks owned by another agent", () => {
      store.createTask("other-empty", "/a");
      store.close();

      const other = new Store(tmpDir, "other-agent");
      assert.deepEqual(other.deleteEmptyTasks(0), []);
      assert.equal(
        other.getTaskIncludingDeleted("other-empty")?.id,
        "other-empty",
      );
      other.close();

      store = new Store(tmpDir, "test-agent");
    });

    it("deletes multiple old empty tasks", () => {
      store.createTask("e1", "/a");
      store.createTask("e2", "/b");
      store.createTask("e3", "/c");
      store.saveEvent(
        "e2",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );

      const deleted = store.deleteEmptyTasks(0);
      assert.equal(deleted.length, 2);
      assert.ok(deleted.some((entry) => entry.id === "e1"));
      assert.ok(deleted.some((entry) => entry.id === "e3"));
      assert.equal(store.getTask("e1"), undefined);
      assert.equal(store.getTask("e3"), undefined);
      assert.ok(store.getTask("e2")); // has events, kept
    });

    it("returns empty array when no empty tasks exist", () => {
      store.createTask("s1", "/a");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );

      const deleted = store.deleteEmptyTasks(0);
      assert.deepEqual(deleted, []);
    });
  });

  describe("schema reset policy", () => {
    it("rejects a pre-1.0 sessions database and asks for a data reset", () => {
      store.close();
      rmSync(join(tmpDir, "webagent.db"), { force: true });
      const legacy = new Database(join(tmpDir, "webagent.db"));
      legacy.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      legacy.close();

      assert.throws(
        () => new Store(tmpDir, "test-agent"),
        /pre-1\.0.*delete.*data/i,
      );

      rmSync(join(tmpDir, "webagent.db"), { force: true });
      store = new Store(tmpDir, "test-agent");
    });

    it("is idempotent — opening the current DB twice works", () => {
      store.createTask("s1", "/x");
      store.close();

      // Re-open same current-format DB
      const store2 = new Store(tmpDir, "test-agent");
      const task = store2.getTask("s1");
      assert.equal(task!.id, "s1");
      store2.close();

      // Replace store so afterEach doesn't double-close
      store = new Store(tmpDir, "test-agent");
    });
  });

  describe("hasInterruptedTurn", () => {
    it("returns false for task with no events", () => {
      store.createTask("s1", "/x");
      assert.equal(store.hasInterruptedTurn("s1"), false);
    });

    it("returns true when user_message has no following prompt_done", () => {
      store.createTask("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hello" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "partial..." },
        { from_ref: "agent" },
      );
      assert.equal(store.hasInterruptedTurn("s1"), true);
    });

    it("returns false when prompt_done follows user_message", () => {
      store.createTask("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hello" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "full response" },
        { from_ref: "agent" },
      );
      store.saveEvent(
        "s1",
        "prompt_done",
        { stopReason: "end_turn" },
        { from_ref: "agent" },
      );
      assert.equal(store.hasInterruptedTurn("s1"), false);
    });

    it("returns false when an error follows user_message", () => {
      store.createTask("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hello" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "error",
        { message: "provider failed" },
        { from_ref: "agent" },
      );
      assert.equal(store.hasInterruptedTurn("s1"), false);
    });

    it("detects interrupted turn after a completed turn", () => {
      store.createTask("s1", "/x");
      // First turn — completed
      store.saveEvent(
        "s1",
        "user_message",
        { text: "first" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "reply" },
        { from_ref: "agent" },
      );
      store.saveEvent(
        "s1",
        "prompt_done",
        { stopReason: "end_turn" },
        { from_ref: "agent" },
      );
      // Second turn — interrupted
      store.saveEvent(
        "s1",
        "user_message",
        { text: "second" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "partial..." },
        { from_ref: "agent" },
      );
      assert.equal(store.hasInterruptedTurn("s1"), true);
    });

    it("returns false when only non-prompt events follow prompt_done", () => {
      store.createTask("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hello" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "prompt_done",
        { stopReason: "end_turn" },
        { from_ref: "agent" },
      );
      // Bash command (not a prompt turn)
      store.saveEvent(
        "s1",
        "bash_command",
        { command: "ls" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "bash_result",
        { output: "file.txt", code: 0, signal: null },
        { from_ref: "system" },
      );
      assert.equal(store.hasInterruptedTurn("s1"), false);
    });
  });

  describe("recentPaths", () => {
    it("touchRecentPath inserts a new path", () => {
      store.touchRecentPath("/projects/a");
      const paths = store.listRecentPaths();
      assert.equal(paths.length, 1);
      assert.equal(paths[0].cwd, "/projects/a");
    });

    it("touchRecentPath updates last_used_at on duplicate", () => {
      store.touchRecentPath("/projects/a");
      const before = store.listRecentPaths()[0].last_used_at;
      store.touchRecentPath("/projects/a");
      const after = store.listRecentPaths()[0].last_used_at;
      assert.equal(store.listRecentPaths().length, 1);
      assert.ok(after >= before);
    });

    it("listRecentPaths returns paths sorted by last_used_at DESC", () => {
      store.touchRecentPath("/a");
      store.touchRecentPath("/b");
      store.touchRecentPath("/c");
      // Touch /a again to make it most recent
      store.touchRecentPath("/a");
      const paths = store.listRecentPaths();
      assert.equal(paths[0].cwd, "/a");
    });

    it("listRecentPaths respects limit option", () => {
      store.touchRecentPath("/a");
      store.touchRecentPath("/b");
      store.touchRecentPath("/c");
      const paths = store.listRecentPaths({ limit: 2 });
      assert.equal(paths.length, 2);
    });

    it("listRecentPaths limit=0 returns all paths", () => {
      store.touchRecentPath("/a");
      store.touchRecentPath("/b");
      store.touchRecentPath("/c");
      const paths = store.listRecentPaths({ limit: 0 });
      assert.equal(paths.length, 3);
    });

    it("listRecentPaths cleans up paths older than ttlDays", () => {
      store.touchRecentPath("/old");
      // Manually backdate the path to 60 days ago
      (store as any).db
        .prepare("UPDATE recent_paths SET last_used_at = ?")
        .run(Date.now() - 60 * 86_400_000);
      store.touchRecentPath("/fresh");

      const paths = store.listRecentPaths({ ttlDays: 30 });
      assert.equal(paths.length, 1);
      assert.equal(paths[0].cwd, "/fresh");
      // Verify the old one was actually deleted from DB
      const all = store.listRecentPaths({ ttlDays: 0 });
      assert.equal(all.length, 1);
    });

    it("listRecentPaths with ttlDays=0 skips cleanup", () => {
      store.touchRecentPath("/old");
      (store as any).db
        .prepare("UPDATE recent_paths SET last_used_at = ?")
        .run(Date.now() - 9999 * 86_400_000);
      const paths = store.listRecentPaths({ ttlDays: 0 });
      assert.equal(paths.length, 1);
    });

    it("deleteRecentPath removes a single path", () => {
      store.touchRecentPath("/a");
      store.touchRecentPath("/b");
      store.deleteRecentPath("/a");
      const paths = store.listRecentPaths();
      assert.equal(paths.length, 1);
      assert.equal(paths[0].cwd, "/b");
    });

    it("deleteRecentPath is a no-op for non-existent path", () => {
      store.touchRecentPath("/a");
      store.deleteRecentPath("/nonexistent");
      assert.equal(store.listRecentPaths().length, 1);
    });
  });

  describe("client_ops (idempotency)", () => {
    beforeEach(() => {
      store.createTask("s1", "/tmp");
    });

    it("getClientOp returns null for unseen op", () => {
      assert.equal(store.getClientOp("s1", "op-xyz"), null);
    });

    it("saveClientOp + getClientOp round-trips the cached result", () => {
      store.saveClientOp("s1", "op-1", { status: 200, body: { ok: true } });
      const cached = store.getClientOp("s1", "op-1");
      assert.deepEqual(cached, { status: 200, body: { ok: true } });
    });

    it("saveClientOp is idempotent (INSERT OR IGNORE)", () => {
      store.saveClientOp("s1", "op-1", { status: 200, body: { a: 1 } });
      store.saveClientOp("s1", "op-1", { status: 500, body: { a: 2 } });
      assert.deepEqual(store.getClientOp("s1", "op-1"), {
        status: 200,
        body: { a: 1 },
      });
    });

    it("scopes op ids per task", () => {
      store.createTask("s2", "/tmp");
      store.saveClientOp("s1", "op-shared", { status: 200, body: "a" });
      store.saveClientOp("s2", "op-shared", { status: 200, body: "b" });
      assert.equal(
        (store.getClientOp("s1", "op-shared") as { body: string }).body,
        "a",
      );
      assert.equal(
        (store.getClientOp("s2", "op-shared") as { body: string }).body,
        "b",
      );
    });

    it("pruneClientOps removes rows older than cutoff", () => {
      store.saveClientOp("s1", "stale", { status: 200, body: {} });
      // Force stale row's created_at back by 10 days
      (
        store as unknown as {
          db: { prepare: (s: string) => { run: (...args: unknown[]) => void } };
        }
      ).db
        .prepare(
          "UPDATE client_ops SET created_at = ? WHERE client_op_id = 'stale'",
        )
        .run(Date.now() - 10 * 86_400_000);
      store.saveClientOp("s1", "fresh", { status: 200, body: {} });
      store.pruneClientOps(7 * 24 * 3600 * 1000);
      assert.equal(store.getClientOp("s1", "stale"), null);
      assert.ok(store.getClientOp("s1", "fresh"));
    });

    it("deleteTask cascades to client_ops", () => {
      store.saveClientOp("s1", "op-1", { status: 200, body: {} });
      store.deleteTask("s1");
      assert.equal(store.getClientOp("s1", "op-1"), null);
    });
  });
});
