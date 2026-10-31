import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { TaskManager } from "../src/task-manager.ts";
import { TaskStateManager, type StatePatchEvent } from "../src/task-state.ts";
import { ExecutionAdapter } from "../src/execution-adapter.ts";
import { StaticAgentEnvironment } from "../src/agent-registry.ts";
import {
  ExecutionAuthority,
  GenerationLedger,
} from "../src/execution-authority.ts";

/**
 * The two properties that only exist because the runtime is no longer built
 * around "there is exactly one execution container".
 *
 * - One task has exactly one `seq` source. Rotating the owner must not restart
 *   the ledger, or every client that validates `state_patch` against its own
 *   last seq drops the post-rotation snapshots and desyncs (stuck busy).
 * - Public reads stay filtered by the caller's agent, even though internal
 *   lifecycle work is now global.
 */
describe("runtime authority regressions", () => {
  let dataDir: string;
  let store: Store;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "webagent-authority-"));
    store = new Store(dataDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function fakeBridge(sessionId: string) {
    return {
      async newSession() {
        return { sessionId, configOptions: [] };
      },
      async setConfigOption() {
        return [];
      },
      async loadSession(taskId: string) {
        return { taskId, configOptions: [] };
      },
    };
  }

  it("keeps one seq source across a real A to B rotation", async () => {
    // Two agents, two Stores: the second agent's binding write is what moves
    // the task, so "owner changed" is real rather than a relabelled adapter.
    const state = new TaskStateManager();
    const authority = new ExecutionAuthority(new GenerationLedger());
    const storeA = store;
    const storeB = new Store(dataDir);
    const managerA = new TaskManager({
      store: storeA,
      defaultCwd: dataDir,
      dataDir,
      state,
      authority,
      agents: new StaticAgentEnvironment(
        "agent-a",
        [new ExecutionAdapter("agent-a")],
        { isConfigured: () => true },
      ),
    });
    const managerB = new TaskManager({
      store: storeB,
      defaultCwd: dataDir,
      dataDir,
      state,
      authority,
      agents: new StaticAgentEnvironment(
        "agent-b",
        [new ExecutionAdapter("agent-b")],
        { isConfigured: () => true },
      ),
    });
    try {
      const { taskId } = await managerA.createTask(
        fakeBridge("session-a"),
        dataDir,
      );
      const before = storeA.getCurrentExecutionBinding(taskId);
      assert.ok(before);
      assert.equal(before.agent_key, "agent-a");

      const patches: StatePatchEvent[] = [];
      state.onPatch((event) => patches.push(event));
      for (let i = 0; i < 3; i++) {
        state.patch(taskId, {
          runtime: { plan: [{ status: "pending", content: `${i}` }] },
        });
      }
      const seqBeforeRotation = state.getState(taskId).seq;
      assert.ok(seqBeforeRotation >= 3);

      await managerB.clearTask(fakeBridge("session-b"), taskId);

      // The owner really moved: a different agent and a different session.
      const after = storeA.getCurrentExecutionBinding(taskId);
      assert.ok(after);
      assert.equal(after.agent_key, "agent-b");
      assert.notEqual(after.agent_session_id, before.agent_session_id);

      const seqAfterRotation = state.getState(taskId).seq;
      assert.ok(seqAfterRotation > seqBeforeRotation);

      // Two clients, each validating against its own cursor. Every patch must
      // be acceptable to both: strictly increasing per task, no reset to zero.
      const cursors = [0, 0];
      for (const patch of patches) {
        assert.equal(patch.taskId, taskId);
        for (let client = 0; client < cursors.length; client++) {
          assert.ok(
            patch.seq > cursors[client],
            `client ${client} would drop seq ${patch.seq} after ${cursors[client]}`,
          );
          cursors[client] = patch.seq;
        }
      }
      // A snapshot taken after the rotation is never "superseded" by the
      // client's cursor.
      assert.ok(state.getState(taskId).seq >= cursors[0]);
    } finally {
      managerA.dispose();
      managerB.dispose();
      storeB.close();
    }
  });

  it("reads tasks globally and narrows only when asked", () => {
    store.createTask("a-task", dataDir, "auto", "agent-a", "session-a");
    const b = new Store(dataDir);
    b.createTask("b-task", dataDir, "auto", "agent-b", "session-b");
    b.close();

    assert.deepEqual(
      store
        .listTasks()
        .map((task) => task.id)
        .sort(),
      ["a-task", "b-task", store.rootTaskId].sort(),
    );
    assert.equal(store.getTask("b-task")?.id, "b-task");
    assert.deepEqual(
      store.listTasks({ agentId: "agent-a" }).map((task) => task.id),
      ["a-task"],
    );
    // Execution identity is still agent-scoped: the same sid under another
    // agent names a different execution.
    assert.equal(
      store.sessionView("agent-a").getTaskId("session-b"),
      undefined,
    );
    assert.equal(store.sessionView("agent-b").getTaskId("session-b"), "b-task");
  });
});
