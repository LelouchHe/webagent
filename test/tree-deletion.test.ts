import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { TaskBusyError, TaskManager } from "../src/task-manager.ts";
import { TaskStateManager } from "../src/task-state.ts";
import { ExecutionAdapter } from "../src/execution-adapter.ts";
import {
  ExecutionAuthority,
  GenerationLedger,
} from "../src/execution-authority.ts";

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
    store = new Store(dataDir, "agent-a");
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
      authority: new ExecutionAuthority(new GenerationLedger()),
      adapter: adapterA,
      adapters: [adapterB],
      isAgentConfigured: () => true,
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
    store.createTask("parent", dataDir, "auto", "same-sid", rootId());
    const b = new Store(dataDir, "agent-b");
    b.createTask("child", dataDir, "auto", "same-sid", "parent");
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

  it("resets Root across every agent, retiring each execution once", async () => {
    seedCrossAgentTree();

    const result = await tasks.resetRootTask(bridgeA);

    assert.deepEqual(result.affected.map((entry) => entry.id).sort(), [
      "child",
      "parent",
    ]);
    assert.deepEqual(retiredA, ["same-sid"]);
    assert.deepEqual(retiredB, ["same-sid"]);
    const root = store.getCurrentExecutionBinding("root");
    assert.ok(root, "the Root keeps an empty owner slot");
    assert.equal(root.agent_key, "agent-a");
    assert.equal(root.agent_session_id, "");
  });
});
