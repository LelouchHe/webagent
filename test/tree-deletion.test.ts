import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyExecutionSlot, Store } from "../src/store.ts";
import { AgentUnavailableError } from "../src/agent-registry.ts";
import { TaskBusyError, TaskManager } from "../src/task-manager.ts";
import { TaskStateManager } from "../src/task-state.ts";
import { ExecutionAdapter } from "../src/execution-adapter.ts";
import { StaticAgentEnvironment } from "../src/agent-registry.ts";
import { ExecutionAuthority } from "../src/execution-authority.ts";

/**
 * Deletion cascades follow the task tree, not an agent, and every retired
 * execution is routed to the adapter of the agent that owned it. `(agentId,
 * sessionId)` is the identity, so two agents returning the same session id are
 * still two different executions.
 */
describe("task-tree deletion across agents", () => {
  let dataDir: string;
  let store: Store;
  let tasks: TaskManager;
  let retiredA: string[];
  let retiredB: string[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "webagent-tree-"));
    store = new Store(dataDir);
    retiredA = [];
    retiredB = [];
    // The primary adapter has no bridge of its own until the runtime attaches
    // the caller's bridge (`bridgeA` below), which is exactly how the server
    // wires it. The secondary adapter keeps its own bridge.
    const adapterA = new ExecutionAdapter("agent-a");
    const adapterB = new ExecutionAdapter("agent-b");
    adapterB.bindBridge({
      retireExecution: async (sessionId: string) => {
        retiredB.push(sessionId);
      },
    });
    tasks = new TaskManager({
      store,
      defaultCwd: dataDir,
      dataDir,
      state: new TaskStateManager(),
      authority: new ExecutionAuthority(),
      agents: new StaticAgentEnvironment(
        adapterA.agentId,
        [adapterA, adapterB],
        { isConfigured: () => true },
      ),
    });
  });

  afterEach(() => {
    tasks.dispose();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function rootId(): string {
    return store.ensureRootTask(dataDir).id;
  }

  /** One parent owned by agent-a with a child owned by agent-b. */
  function seedCrossAgentTree(): void {
    store.attachAgentSession(rootId(), "agent-a", "root-session");
    store.createTask(
      "parent",
      dataDir,
      "auto",
      "agent-a",
      "same-sid",
      rootId(),
    );
    const b = new Store(dataDir);
    b.createTask("child", dataDir, "auto", "agent-b", "same-sid", "parent");
    b.saveEvent(
      "child",
      "user_message",
      { text: "keep?" },
      { from_ref: "user" },
    );
    b.close();
  }

  const bridgeA = {
    async newSession() {
      throw new Error("deletion must not create a session");
    },
    async retireExecution(sessionId: string) {
      retiredA.push(sessionId);
    },
    async setConfigOption() {
      return [];
    },
    async loadSession(taskId: string) {
      return { taskId, configOptions: [] };
    },
  };

  it("deletes the whole subtree and retires each execution in its own adapter", async () => {
    seedCrossAgentTree();

    const result = await tasks.deleteTask(bridgeA, "parent");

    assert.deepEqual(result.affected.map((entry) => entry.id).sort(), [
      "child",
      "parent",
    ]);
    // Both executions share one session id; the agent is what routes them.
    assert.deepEqual(
      result.affected.find((entry) => entry.id === "parent")?.agentId,
      "agent-a",
    );
    assert.deepEqual(
      result.affected.find((entry) => entry.id === "child")?.agentId,
      "agent-b",
    );
    assert.deepEqual(retiredA, ["same-sid"]);
    assert.deepEqual(retiredB, ["same-sid"]);
    assert.equal(store.getTaskIncludingDeleted("child"), undefined);
    assert.equal(store.getEvents("child").length, 0);
  });

  it("refuses to delete a parent whose foreign child is busy", async () => {
    seedCrossAgentTree();
    tasks.activePrompts.add("child");

    await assert.rejects(
      () => tasks.deleteTask(bridgeA, "parent"),
      TaskBusyError,
    );
    assert.deepEqual(retiredA, []);
    assert.deepEqual(retiredB, []);
    assert.ok(store.getTaskIncludingDeleted("child"));
  });

  it("refuses a Root exit while a foreign descendant is busy", async () => {
    seedCrossAgentTree();
    tasks.activePrompts.add("child");

    await assert.rejects(() => tasks.exitRoot(bridgeA), TaskBusyError);
    assert.deepEqual(retiredA, []);
    assert.deepEqual(retiredB, []);
    assert.ok(store.getTaskIncludingDeleted("child"));
  });

  it("leaves Root live and idle when the exit returns, like a created task", async () => {
    seedCrossAgentTree();
    const exitBridge = {
      ...bridgeA,
      async newSession() {
        return { sessionId: "rebuilt-session", configOptions: [] };
      },
    };

    const oldRootId = store.rootTaskId;
    const result = await tasks.exitRoot(exitBridge);

    assert.deepEqual(
      result.affected.map((entry) => entry.id).sort(),
      ["child", "parent", oldRootId].sort(),
    );
    assert.equal(store.rootTaskId, result.rootTaskId);
    // The exit owns the wake-up: a client that reads Root after this response
    // must find the task it would have found had it created one instead of
    // exiting one.
    assert.ok(
      tasks.liveTasks.has(store.rootTaskId),
      "Root is rebuilt before the exit returns",
    );
    assert.equal(
      store.getCurrentExecutionBinding(store.rootTaskId)?.agent_session_id,
      "rebuilt-session",
    );
    assert.equal(tasks.getBusyKind(store.rootTaskId), null);
    assert.equal(tasks.state.getState(store.rootTaskId).runtime.busy, null);
  });

  it("counts the rebuild as work of its own", () => {
    seedCrossAgentTree();
    // The claim has to stand on its own: the rebuild's first await is the
    // agent resolution, which happens before any ACP session exists, so a
    // rotation or a second exit arriving there must already see the task busy.
    tasks.rebuildingTasks.add(store.rootTaskId);
    try {
      assert.equal(tasks.getGateBusyKind(store.rootTaskId), "agent");
      assert.equal(tasks.getBusyKind(store.rootTaskId), "agent");
    } finally {
      tasks.rebuildingTasks.delete(store.rootTaskId);
    }
    assert.equal(tasks.getGateBusyKind(store.rootTaskId), null);
  });

  it("holds the rebuild against a clear and a second exit", async () => {
    seedCrossAgentTree();
    let releaseNewSession!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseNewSession = resolve;
    });
    let reached!: () => void;
    const inNewSession = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const exitBridge = {
      ...bridgeA,
      async newSession() {
        reached();
        await gate;
        return { sessionId: "rebuilt-session", configOptions: [] };
      },
    };

    const oldRootId = store.rootTaskId;
    const exiting = tasks.exitRoot(exitBridge);
    await inNewSession;

    // The rebuild owns Root's binding until it commits it. A rotation or a
    // second exit that started here would act on the binding this rebuild is
    // about to replace, and the binding's last writer would silently win.
    await assert.rejects(
      () => tasks.clearTask(exitBridge, store.rootTaskId),
      TaskBusyError,
    );
    await assert.rejects(() => tasks.exitRoot(exitBridge), TaskBusyError);

    releaseNewSession();
    const result = await exiting;
    assert.deepEqual(
      result.affected.map((entry) => entry.id).sort(),
      ["child", "parent", oldRootId].sort(),
    );
    assert.equal(
      store.getCurrentExecutionBinding(store.rootTaskId)?.agent_session_id,
      "rebuilt-session",
    );
    assert.equal(tasks.getBusyKind(store.rootTaskId), null);
  });

  it("refuses the exit when Root's agent cannot start, and deletes nothing", async () => {
    seedCrossAgentTree();

    // No bridge is attached to agent-a, so resolving it fails. The exit must
    // refuse *before* destroying anything: there is no point clearing the tree
    // around a Root that cannot be rebuilt.
    const rootTaskId = store.rootTaskId;
    await assert.rejects(() => tasks.exitRoot(), AgentUnavailableError);
    assert.equal(store.rootTaskId, rootTaskId, "Root was not replaced");

    assert.ok(store.getTaskIncludingDeleted("parent"), "the tree is untouched");
    assert.ok(store.getTaskIncludingDeleted("child"));
    assert.equal(store.getEvents("child").length, 1);
    assert.equal(
      store.getCurrentExecutionBinding(store.rootTaskId)?.agent_session_id,
      "root-session",
    );
    assert.deepEqual(retiredA, [], "nothing was retired");
    assert.deepEqual(retiredB, []);
  });

  it("exits Root across every agent, retiring each execution once", async () => {
    seedCrossAgentTree();

    const oldRootId = store.rootTaskId;
    const result = await tasks.exitRoot(bridgeA);

    assert.deepEqual(
      result.affected.map((entry) => entry.id).sort(),
      ["child", "parent", oldRootId].sort(),
    );
    // The old Root's execution is retired through its recorded agent, and so
    // are the descendants'.
    assert.deepEqual(retiredA.sort(), ["root-session", "same-sid"]);
    assert.deepEqual(retiredB, ["same-sid"]);
    const root = store.getCurrentExecutionBinding(store.rootTaskId);
    assert.ok(root, "the new Root keeps the agent as an empty owner slot");
    assert.equal(root.agent_key, "agent-a");
    assert.equal(root.agent_session_id, emptyExecutionSlot(store.rootTaskId));
  });
});
