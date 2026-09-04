import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Store } from "../src/store.ts";
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

      store.rotateAgentSession("web-1", "agent-2");

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

      store.rotateAgentSession("web-1", "agent-1", "/b");

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

    it("creates and retrieves a task", () => {
      const task = store.createTask("sess-1", "/tmp/cwd");
      assert.equal(task.id, "sess-1");
      assert.equal(task.cwd, "/tmp/cwd");
      assert.equal(task.title, null);
    });

    it("stores an optional parent WebAgent task", () => {
      store.createTask("root", "/tmp/root", "root", "agent-root");
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

    it("creates a non-destructive Root and adopts existing top-level tasks", () => {
      store.createTask("old-1", "/tmp/one", "auto", "agent-one");
      store.createTask("old-2", "/tmp/two", "auto", "agent-two");

      const root = store.ensureRootTask("/tmp/root");

      assert.equal(root.id, "root");
      assert.equal(root.parent_id, null);
      assert.equal(root.title, "root");
      assert.equal(store.getTaskIncludingDeleted("old-1")?.parent_id, "root");
      assert.equal(store.getTaskIncludingDeleted("old-2")?.parent_id, "root");
      assert.deepEqual(
        store
          .listTasks()
          .map((task) => task.id)
          .sort(),
        ["old-1", "old-2"],
      );

      assert.equal(store.ensureRootTask("/tmp/other").cwd, "/tmp/root");
      assert.equal(store.ensureRootTask("/tmp/other").title, "root");
    });

    it("keeps a user-renamed Root title across restarts", () => {
      store.ensureRootTask("/tmp/root");
      store.updateTaskTitle("root", "工作台");

      assert.equal(store.ensureRootTask("/tmp/root").title, "工作台");
    });

    it("persists and clears one pending compact summary with its assistant event", () => {
      store.createTask("web-1", "/tmp/root", "auto", "agent-1");

      store.saveCompactSummary("web-1", "Current goal and next action");

      assert.equal(
        store.getPendingCompactSummary("web-1"),
        "Current goal and next action",
      );
      const summary = store
        .getEvents("web-1")
        .find((event) => event.type === "assistant_message");
      assert.equal(
        JSON.parse(summary!.data).text,
        "Current goal and next action",
      );
      assert.equal(
        store.clearPendingCompactSummary("web-1", "wrong summary"),
        false,
      );
      assert.equal(
        store.clearPendingCompactSummary(
          "web-1",
          "Current goal and next action",
        ),
        true,
      );
      assert.equal(store.getPendingCompactSummary("web-1"), null);
    });

    it("binds an ACP execution to an existing Root record", () => {
      store.ensureRootTask("/tmp/root");

      store.bindAgentSession("root", "agent-root");

      assert.equal(store.getAgentSessionId("root"), "agent-root");
      assert.equal(store.getTask("root")?.id, "root");
    });

    it("protects the Root task from deletion", () => {
      store.ensureRootTask("/tmp/root");

      assert.throws(
        () => store.deleteTask("root"),
        /Root task cannot be deleted/,
      );
    });

    it("does not garbage-collect the Root task when it is empty", () => {
      store.ensureRootTask("/tmp/root");
      store.bindAgentSession("root", "agent-root");

      assert.deepEqual(store.deleteEmptyTasks(0), []);
      assert.equal(store.getTask("root")?.id, "root");
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

    it("stores last_active_at with fractional-second precision", () => {
      store.createTask("s1", "/x");
      store.updateTaskLastActive("s1");

      const task = store.getTask("s1")!;
      assert.match(
        task.last_active_at,
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/,
      );
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
      store.bindAgentSession("root", "agent-root");
      store.createTask("parent", "/a", "auto", "agent-parent");
      store.createTask("child", "/b", "auto", "agent-child", "parent");
      const token = generateShareToken();
      store.insertSharePreview({ token, taskId: "child", snapshotSeq: 1 });
      store.activateShare(token);

      const result = store.deleteTask("parent");

      assert.equal(result.mode, "hard");
      const child = store.getTaskIncludingDeleted("child")!;
      assert.notEqual(child.deleted_at, null); // kept for the share viewer
      assert.equal(child.parent_id, "root"); // no dangling FK
      assert.equal(store.getTask("parent"), undefined);
      assert.equal(
        result.affected.find((entry) => entry.id === "child")?.agentSessionId,
        "agent-child",
      );
    });

    it("re-parents tombstoned descendants under Root when reaping a tombstone", () => {
      store.ensureRootTask("/root");
      store.bindAgentSession("root", "agent-root");
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

      // The child's tombstone survives and holds no dangling reference.
      const child = store.getTaskIncludingDeleted("child")!;
      assert.equal(child.parent_id, "root");
      assert.notEqual(child.deleted_at, null);
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
      store.bindAgentSession("root", "agent-root");
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
      assert.equal(store.getTask("child")!.parent_id, "root");
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
      // SQLite fractional-second timestamps — a tight loop may produce the same ms,
      // so just verify no error and the path is still there.
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
        .prepare(
          "UPDATE recent_paths SET last_used_at = datetime('now', '-60 days')",
        )
        .run();
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
        .prepare(
          "UPDATE recent_paths SET last_used_at = datetime('now', '-9999 days')",
        )
        .run();
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
          db: { prepare: (s: string) => { run: () => void } };
        }
      ).db
        .prepare(
          "UPDATE client_ops SET created_at = datetime('now', '-10 days') WHERE client_op_id = 'stale'",
        )
        .run();
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
