import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ConfigOption } from "../src/types.ts";
import { Store } from "../src/store.ts";
import {
  createTaskManager,
  type DeliveryBridge,
  type TaskManager,
} from "../src/task-manager.ts";

/**
 * A read answers immediately; the warm-up it starts reports back.
 *
 * `warmTaskInBackground` is what replaced the bounded wait on the read path:
 * the response is served with whatever is known, the restore runs on its own,
 * and a completed restore publishes `task_runtime_warmed` exactly once, for the
 * task and none other.
 */

const MODEL_OPTIONS: ConfigOption[] = [
  {
    type: "select",
    id: "model",
    name: "Model",
    currentValue: "mock-model-2",
    options: [
      { value: "mock-model", name: "Mock Model" },
      { value: "mock-model-2", name: "Mock Model 2" },
    ],
  },
];

interface WarmedEvent {
  taskId: string;
  agentId: string;
  configOptions: ConfigOption[];
  agentCommands: { epoch: string; revision: number; commands: unknown[] };
}

function makeBridge(
  load: (
    taskId: string,
  ) => Promise<{ taskId: string; configOptions: ConfigOption[] }>,
): DeliveryBridge & { loads: number } {
  let loads = 0;
  const bridge = {
    get loads() {
      return loads;
    },
    async newSession() {
      return { sessionId: "created-session", configOptions: MODEL_OPTIONS };
    },
    async setConfigOption() {
      return MODEL_OPTIONS;
    },
    async loadSession(taskId: string) {
      loads++;
      return load(taskId);
    },
    async prompt() {},
    async cancel() {},
    resolvePermission: () => {},
    denyPermission: () => {},
    isAvailable: () => true,
  } as DeliveryBridge & { loads: number };
  return bridge;
}

describe("background warm-up", () => {
  let dir: string;
  let store: Store;
  let tasks: TaskManager;
  let warmed: WarmedEvent[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "webagent-warm-"));
    store = new Store(dir);
    store.ensureRootTask(dir);
    tasks = createTaskManager(store, dir, dir, undefined, undefined, "agent-a");
    warmed = [];
    tasks.setRuntimeWarmBroadcast((event) => warmed.push(event));
  });

  afterEach(() => {
    tasks.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A task with an existing binding, so the warm-up takes the restore path. */
  function seedTask(id = "warm-task"): string {
    store.createTask(id, dir, "auto", "agent-a", "existing-session");
    // The store write above happened before the manager could observe it.
    tasks.authority.adopt(id);
    return id;
  }

  it("publishes the restored schema and commands once", async () => {
    const bridge = makeBridge(async (taskId) => ({
      taskId,
      configOptions: MODEL_OPTIONS,
    }));
    tasks.attachExecutionBridge(bridge);
    const taskId = seedTask();

    tasks.warmTaskInBackground(taskId);
    await new Promise<void>((done) => setImmediate(done));
    await new Promise<void>((done) => setImmediate(done));

    assert.equal(bridge.loads, 1);
    assert.equal(warmed.length, 1);
    assert.equal(warmed[0].taskId, taskId);
    assert.equal(warmed[0].agentId, "agent-a");
    assert.equal(
      warmed[0].configOptions.find((option) => option.id === "model")
        ?.currentValue,
      "mock-model-2",
    );
    // The commands advertised by the restored session are carried too.
    assert.equal(warmed[0].agentCommands.revision, 0);
    assert.deepEqual(warmed[0].agentCommands.commands, []);

    // A second read of the same live task does not publish again.
    tasks.warmTaskInBackground(taskId);
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(warmed.length, 1);
  });

  it("carries the commands the restore advertised", async () => {
    const bridge = makeBridge(async (taskId) => {
      // The real path records commands through the ACP update; here the load
      // hook writes the snapshot the same way before returning.
      tasks.updateAgentCommands(taskId, [
        { name: "warm-extra", description: "Only a restore reports this" },
      ]);
      return { taskId, configOptions: MODEL_OPTIONS };
    });
    tasks.attachExecutionBridge(bridge);
    const taskId = seedTask();

    tasks.warmTaskInBackground(taskId);
    await new Promise<void>((done) => setImmediate(done));
    await new Promise<void>((done) => setImmediate(done));

    assert.equal(warmed.length, 1);
    assert.deepEqual(
      warmed[0].agentCommands.commands.map(
        (command) => (command as { name: string }).name,
      ),
      ["warm-extra"],
    );
  });

  it("publishes nothing when the warm-up fails", async () => {
    const bridge = makeBridge(async () => {
      throw new Error("agent exploded during restore");
    });
    tasks.attachExecutionBridge(bridge);
    const taskId = seedTask();

    tasks.warmTaskInBackground(taskId);
    await new Promise<void>((done) => setImmediate(done));
    await new Promise<void>((done) => setImmediate(done));

    assert.equal(bridge.loads, 1, "the warm-up was attempted");
    assert.deepEqual(warmed, [], "a failed warm-up is silent");
    // The task is still readable and still bound.
    assert.ok(store.getTask(taskId));
    assert.equal(store.getBindingAgent(taskId), "agent-a");
  });

  it("publishes nothing for a warm-up that outlived a rotation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const inLoad = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const bridge = makeBridge(async (taskId) => {
      reached();
      await gate;
      return { taskId, configOptions: MODEL_OPTIONS };
    });
    tasks.attachExecutionBridge(bridge);
    const taskId = seedTask();

    tasks.warmTaskInBackground(taskId);
    await inLoad;
    // The execution is replaced while the restore is in flight. `/clear` is
    // busy-gated during a restore, so this uses the storage transition the
    // implicit-owner-rotation and GC paths make directly; the manager's
    // binding observer advances the generation, which is what the late
    // publish must notice.
    store.replaceAgentSession(taskId, "agent-a", "replacement-session");
    assert.notEqual(
      tasks.authority.leaseFor(taskId)?.generation,
      undefined,
      "the replacement committed a generation",
    );
    release();
    await new Promise<void>((done) => setImmediate(done));
    await new Promise<void>((done) => setImmediate(done));

    assert.deepEqual(
      warmed,
      [],
      "a late warm-up must not describe the replaced execution",
    );
  });

  it("deduplicates concurrent warm-ups into one restore", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = makeBridge(async (taskId) => {
      await gate;
      return { taskId, configOptions: MODEL_OPTIONS };
    });
    tasks.attachExecutionBridge(bridge);
    const taskId = seedTask();

    tasks.warmTaskInBackground(taskId);
    tasks.warmTaskInBackground(taskId);
    tasks.warmTaskInBackground(taskId);
    release();
    await new Promise<void>((done) => setImmediate(done));
    await new Promise<void>((done) => setImmediate(done));

    assert.equal(bridge.loads, 1, "one restore for concurrent reads");
    assert.equal(warmed.length, 1);
  });

  it("publishes nothing for a task that was deleted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const inLoad = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const bridge = makeBridge(async (taskId) => {
      reached();
      await gate;
      return { taskId, configOptions: MODEL_OPTIONS };
    });
    tasks.attachExecutionBridge(bridge);
    const taskId = seedTask();

    tasks.warmTaskInBackground(taskId);
    await inLoad;
    // Deletion is busy-gated too; the GC path deletes at the store level.
    store.deleteTask(taskId);
    assert.equal(store.getTask(taskId), undefined);
    release();
    await new Promise<void>((done) => setImmediate(done));
    await new Promise<void>((done) => setImmediate(done));

    assert.deepEqual(warmed, []);
  });
});
