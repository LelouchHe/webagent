import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
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

  it("refuses a Root reset while a foreign descendant is busy", async () => {
    seedCrossAgentTree();
    tasks.activePrompts.add("child");

    await assert.rejects(() => tasks.resetRootTask(bridgeA), TaskBusyError);
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

    const result = await tasks.resetRootTask(exitBridge);

    assert.deepEqual(result.affected.map((entry) => entry.id).sort(), [
      "child",
      "parent",
    ]);
    // The exit owns the wake-up: a client that reads Root after this response
    // must find the task it would have found had it created one instead of
    // exiting one.
    assert.ok(
      tasks.liveTasks.has("root"),
      "Root is rebuilt before the exit returns",
    );
    assert.equal(
      store.getCurrentExecutionBinding("root")?.agent_session_id,
      "rebuilt-session",
    );
    assert.equal(tasks.getBusyKind("root"), null);
    assert.equal(tasks.state.getState("root").runtime.busy, null);
  });

  it("refuses the exit when Root's agent cannot start, and deletes nothing", async () => {
    seedCrossAgentTree();

    // No bridge is attached to agent-a, so resolving it fails. The exit must
    // refuse *before* destroying anything: there is no point clearing the tree
    // around a Root that cannot be rebuilt.
    await assert.rejects(() => tasks.resetRootTask(), AgentUnavailableError);

    assert.ok(store.getTaskIncludingDeleted("parent"), "the tree is untouched");
    assert.ok(store.getTaskIncludingDeleted("child"));
    assert.equal(store.getEvents("child").length, 1);
    assert.equal(
      store.getCurrentExecutionBinding("root")?.agent_session_id,
      "root-session",
    );
    assert.deepEqual(retiredA, [], "nothing was retired");
    assert.deepEqual(retiredB, []);
  });

  it("resets Root across every agent, retiring each execution once", async () => {
    seedCrossAgentTree();

    const result = await tasks.resetRootTask(bridgeA);

    assert.deepEqual(result.affected.map((entry) => entry.id).sort(), [
      "child",
      "parent",
    ]);
    // Root's own execution is retired through its recorded agent, then the
    // descendants'.
    assert.deepEqual(retiredA.sort(), ["root-session", "same-sid"]);
    assert.deepEqual(retiredB, ["same-sid"]);
    const root = store.getCurrentExecutionBinding("root");
    assert.ok(root, "the Root keeps an empty owner slot");
    assert.equal(root.agent_key, "agent-a");
    assert.equal(root.agent_session_id, "");
  });
});
