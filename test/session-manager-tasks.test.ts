import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { SessionManager } from "../src/session-manager.ts";
import { CapabilityStore } from "../src/mcp/capability.ts";

function makeBridge() {
  const calls: { newSessionCwd: string[] } = { newSessionCwd: [] };
  return {
    bridge: {
      async newSession(cwd: string) {
        calls.newSessionCwd.push(cwd);
        return {
          sessionId: `agent-${calls.newSessionCwd.length}`,
          configOptions: [],
        };
      },
      async setConfigOption() {
        return [];
      },
      async loadSession() {
        throw new Error("loadSession should not be called");
      },
      sessionMapped() {},
    },
    calls,
  };
}

describe("SessionManager task lifecycle", () => {
  let store: Store;
  let sm: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-test-"));
    store = new Store(tmpDir, "test-agent");
    sm = new SessionManager(store, tmpDir, tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("createSession binds to task", () => {
    it("legacy create auto-creates a child task under Root and binds the session", async () => {
      const { bridge } = makeBridge();
      const { sessionId } = await sm.createSession(bridge);

      const root = store.listTasks().find((t) => t.parent_id === null);
      assert.ok(root);
      const children = store.listTasks().filter((t) => t.parent_id === root.id);
      assert.equal(children.length, 1);
      assert.equal(children[0].cwd, tmpDir);

      const row = store.getSession(sessionId);
      assert.equal(row?.task_id, children[0].id);
      assert.equal(sm.getLiveSessionForTask(children[0].id), sessionId);
    });

    it("two legacy creates = two child tasks, no single-live violation", async () => {
      const { bridge } = makeBridge();
      const a = await sm.createSession(bridge);
      const b = await sm.createSession(bridge);
      assert.notEqual(a.sessionId, b.sessionId);

      const root = store.listTasks().find((t) => t.parent_id === null)!;
      const children = store.listTasks().filter((t) => t.parent_id === root.id);
      assert.equal(children.length, 2);
      // each child has its own live session (distinct tasks, no collision)
      for (const child of children) {
        assert.equal(
          store.getTaskLiveSession(child.id)?.id,
          sm.getLiveSessionForTask(child.id),
        );
      }
    });

    it("explicit taskId binds to that task without creating a child", async () => {
      const tid = "manual-task";
      store.createTask({ id: tid, name: "manual", cwd: tmpDir });
      const { bridge } = makeBridge();
      const { sessionId } = await sm.createSession(
        bridge,
        tmpDir,
        undefined,
        "auto",
        {
          taskId: tid,
        },
      );
      assert.equal(store.getTask(sessionId), undefined); // a session is not a task
      assert.equal(store.getSession(sessionId)?.task_id, tid);
      assert.equal(sm.getLiveSessionForTask(tid), sessionId);
      assert.equal(store.listTasks().filter((t) => t.parent_id).length, 0);
    });
  });

  describe("clearTask", () => {
    it("retires the old execution (records kept) and spawns a fresh one on the same task", async () => {
      const tid = "clr";
      store.createTask({ id: tid, name: "clr", cwd: tmpDir });
      const { bridge } = makeBridge();
      const first = await sm.createSession(bridge, tmpDir, undefined, "auto", {
        taskId: tid,
      });
      store.saveEvent(
        first.sessionId,
        "user_message",
        { text: "before" },
        { from_ref: "user" },
      );

      const second = await sm.clearTask(bridge, tid);
      assert.notEqual(second.sessionId, first.sessionId);

      // the old execution retires (row kept + deleted_at), records stay with the task
      const retired = store.getSessionIncludingDeleted(first.sessionId);
      assert.ok(retired);
      assert.ok(retired.deleted_at !== null);
      assert.equal(store.getTaskEvents(tid).length, 1);
      assert.equal(
        (JSON.parse(store.getTaskEvents(tid)[0].data) as { text: string }).text,
        "before",
      );

      // the new execution binds to the same task; mirror moves; old one is no longer current
      assert.equal(store.getSession(second.sessionId)?.task_id, tid);
      assert.equal(sm.getLiveSessionForTask(tid), second.sessionId);
      assert.equal(store.getTaskLiveSession(tid)?.id, second.sessionId);
      assert.equal(sm.isCurrentExecution(first.sessionId), false);
      assert.equal(sm.isCurrentExecution(second.sessionId), true);
    });

    it("revokes the retired session capability (clear under capability manager works)", async () => {
      const capabilities = new CapabilityStore();
      const mcpSm = new SessionManager(
        store,
        tmpDir,
        tmpDir,
        capabilities,
        "http://127.0.0.1:1",
      );
      const tid = "clr-cap";
      store.createTask({ id: tid, name: "clr", cwd: tmpDir });
      const { bridge } = makeBridge();
      const first = await mcpSm.createSession(
        bridge,
        tmpDir,
        undefined,
        "auto",
        { taskId: tid },
      );
      const second = await mcpSm.clearTask(bridge, tid);
      assert.notEqual(second.sessionId, first.sessionId);
      assert.equal(mcpSm.getLiveSessionForTask(tid), second.sessionId);
      // cleaned up: the old execution is no longer live (its capability was revoked in clear)
      assert.equal(mcpSm.liveSessions.has(first.sessionId), false);
      assert.equal(mcpSm.isCurrentExecution(first.sessionId), false);
    });

    it("throws when the task does not exist", async () => {
      const { bridge } = makeBridge();
      await assert.rejects(
        () => sm.clearTask(bridge, "nope"),
        /task not found/,
      );
    });
  });

  describe("isCurrentExecution fence", () => {
    it("allows creating/restoring windows and the live session", () => {
      const tid = "fence";
      store.createTask({ id: tid, name: "fence", cwd: tmpDir });
      sm.creatingSessions.add("creating-1");
      assert.equal(sm.isCurrentExecution("creating-1"), true);
      sm.creatingSessions.delete("creating-1");
      assert.equal(sm.isCurrentExecution("not-a-session"), true); // internal/unknown rows stay allowed

      store.createSession("live", tmpDir, "auto", "live", tid);
      sm.rebuildTaskLiveSessions();
      assert.equal(sm.isCurrentExecution("live"), true);
      store.retireSession("live");
      sm.rebuildTaskLiveSessions();
      assert.equal(sm.isCurrentExecution("live"), false);
    });

    it("rebuildTaskLiveSessions recovers the mirror from the store", () => {
      const tid = "mirror";
      store.createTask({ id: tid, name: "mirror", cwd: tmpDir });
      store.createSession("v1", tmpDir, "auto", "v1", tid);
      store.retireSession("v1");
      store.createSession("v2", tmpDir, "auto", "v2", tid);

      const sm2 = new SessionManager(store, tmpDir, tmpDir);
      sm2.rebuildTaskLiveSessions();
      assert.equal(sm2.getLiveSessionForTask(tid), "v2");
      assert.equal(sm2.isCurrentExecution("v1"), false);
      assert.equal(sm2.isCurrentExecution("v2"), true);
    });
  });
});
