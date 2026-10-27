import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { TaskManager } from "../src/task-manager.ts";
import { TaskStateManager, type StatePatchEvent } from "../src/task-state.ts";
import { ExecutionAdapter } from "../src/execution-adapter.ts";
import {
  ExecutionAuthority,
  GenerationLedger,
} from "../src/execution-authority.ts";

/**
 * A1 / A8: the two properties that only exist because the runtime is no longer
 * built around "there is exactly one execution container".
 *
 * - A1: one task has exactly one `seq` source. Rotating the owner must not
 *   restart the ledger, or every client that validates `state_patch` against
 *   its own last seq drops the post-rotation snapshots and desyncs (stuck
 *   busy).
 * - A8: public reads stay filtered by the caller's agent, even though internal
 *   lifecycle work is now global.
 */
describe("runtime authority regressions", () => {
  let dataDir: string;
  let store: Store;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "webagent-authority-"));
    store = new Store(dataDir, "agent-a");
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

  it("keeps one seq source across an A to B rotation", async () => {
    const state = new TaskStateManager();
    const authority = new ExecutionAuthority(new GenerationLedger());
    const makeManager = (agentId: string) =>
      new TaskManager({
        store,
        defaultCwd: dataDir,
        dataDir,
        state,
        authority,
        adapter: new ExecutionAdapter(agentId),
        isAgentConfigured: () => true,
      });
    const managerA = makeManager("agent-a");
    const managerB = makeManager("agent-b");
    try {
      const { taskId } = await managerA.createTask(
        fakeBridge("session-a"),
        dataDir,
      );

      const patches: StatePatchEvent[] = [];
      state.onPatch((event) => patches.push(event));
      for (let i = 0; i < 3; i++) {
        state.patch(taskId, {
          runtime: { plan: [{ status: "pending", content: `${i}` }] },
        });
      }
      const seqBeforeRotation = state.getState(taskId).seq;
      assert.ok(seqBeforeRotation >= 3);

      // The second adapter's runtime rotates the task. Both runtimes share the
      // injected ledger, so the seq keeps counting instead of restarting.
      await managerB.clearTask(fakeBridge("session-b"), taskId);

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
    }
  });

  it("keeps public reads filtered by the caller's agent", () => {
    store.createTask("a-task", dataDir, "auto", "session-a");
    const b = new Store(dataDir, "agent-b");
    b.createTask("b-task", dataDir, "auto", "session-b");
    b.close();

    assert.deepEqual(
      store.listTasks().map((task) => task.id),
      ["a-task"],
    );
    assert.equal(store.getTask("b-task"), undefined);
    assert.equal(store.listTasks({ source: "auto" }).length, 1);
    // The internal read is deliberately global: lifecycle paths must see a
    // task whose owner is another agent.
    assert.ok(store.getTaskIncludingDeleted("b-task"));
  });
});
