import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, emptyExecutionSlot } from "../src/store.ts";
import { TaskManager } from "../src/task-manager.ts";
import { TaskStateManager } from "../src/task-state.ts";
import { ExecutionAdapter } from "../src/execution-adapter.ts";
import { StaticAgentEnvironment } from "../src/agent-registry.ts";
import {
  ExecutionAuthority,
  GenerationLedger,
} from "../src/execution-authority.ts";

/**
 * Replacing the owner is an *implicit* rotation only when the current owner has
 * been removed from configuration. A configured agent that is merely
 * not running is still the configured owner and must not be displaced.
 */
describe("implicit owner rotation", () => {
  let dataDir: string;
  let stores: Store[];
  let managers: TaskManager[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "webagent-owner-"));
    stores = [];
    managers = [];
  });

  afterEach(() => {
    for (const manager of managers) manager.dispose();
    for (const store of stores) store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function openStore(): Store {
    const store = new Store(dataDir);
    stores.push(store);
    return store;
  }

  function makeManager(
    store: Store,
    agentId: string,
    configured: string[],
  ): TaskManager {
    const manager = new TaskManager({
      store,
      defaultCwd: dataDir,
      dataDir,
      state: new TaskStateManager(),
      authority: new ExecutionAuthority(new GenerationLedger()),
      agents: new StaticAgentEnvironment(
        agentId,
        [new ExecutionAdapter(agentId)],
        { isConfigured: (id) => configured.includes(id) },
      ),
    });
    managers.push(manager);
    return manager;
  }

  function bridgeRecorder() {
    const created: Array<{ cwd: string }> = [];
    const prompts: string[] = [];
    return {
      created,
      prompts,
      bridge: {
        async newSession(cwd: string) {
          created.push({ cwd });
          return { sessionId: `session-${created.length}`, configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession(taskId: string) {
          return { taskId, configOptions: [] };
        },
        async prompt(_taskId: string, text: string) {
          prompts.push(text);
        },
      },
    };
  }

  function seedRootOwnedBy(owner: string, sessionId: string): void {
    const ownerStore = openStore();
    ownerStore.ensureRootTask(dataDir);
    ownerStore.attachAgentSession(ownerStore.rootTaskId, owner, sessionId);
  }

  function rootBinding(store: Store) {
    return store.getCurrentExecutionBinding(store.rootTaskId);
  }

  function rotationEvents(store: Store) {
    return store
      .getEvents(store.rootTaskId)
      .filter((event) => event.type === "system_message")
      .map((event) => JSON.parse(event.data) as Record<string, unknown>)
      .filter((data) => data.kind === "agent_rotation");
  }

  it("never displaces an owner that is still configured", async () => {
    seedRootOwnedBy("agent-a", "session-a");
    const store = openStore();
    const tasks = makeManager(store, "agent-b", ["agent-a", "agent-b"]);
    const { bridge, created } = bridgeRecorder();

    tasks.attachExecutionBridge(bridge);
    // The owner is still configured, so resolving the task targets it — and
    // this process cannot start it. Nothing is displaced.
    await assert.rejects(() => tasks.ensureRootTask(), /not available/);
    assert.deepEqual(created, [], "a configured owner must not be replaced");
    assert.equal(rootBinding(store)?.agent_key, "agent-a");
    assert.equal(rootBinding(store)?.agent_session_id, "session-a");
    assert.deepEqual(rotationEvents(store), []);

    // The same guard applies to a restore attempt through another transport.
    await assert.rejects(() => tasks.resumeTask(bridge, store.rootTaskId));
    assert.equal(rootBinding(store)?.agent_key, "agent-a");
  });

  it("takes over Root from an agent that is no longer configured", async () => {
    seedRootOwnedBy("agent-a", "session-a");
    const store = openStore();
    const tasks = makeManager(store, "agent-b", ["agent-b"]);
    const { bridge, created } = bridgeRecorder();
    const generationBefore = tasks.authority.generationOf(store.rootTaskId);

    tasks.attachExecutionBridge(bridge);
    await tasks.resolveTaskExecution(store.rootTaskId);

    assert.deepEqual(created, [], "the takeover materializes lazily");
    const binding = rootBinding(store);
    assert.ok(binding, "the takeover binds the configured agent");
    assert.equal(binding.agent_key, "agent-b");
    assert.equal(binding.agent_session_id, "");
    assert.ok(
      (tasks.authority.generationOf(store.rootTaskId) ?? 0) >
        (generationBefore ?? 0),
      "the takeover bumps the generation",
    );
    const events = rotationEvents(store);
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "owner_removed");
    assert.equal(events[0].fromAgent, "agent-a");
    assert.equal(events[0].toAgent, "agent-b");
  });

  it("materializes the taken-over Root through a normal prompt", async () => {
    seedRootOwnedBy("agent-a", "session-a");
    const store = openStore();
    const tasks = makeManager(store, "agent-b", ["agent-b"]);
    const { bridge, created } = bridgeRecorder();

    tasks.attachExecutionBridge(bridge);
    await tasks.ensureRootTask();
    const event = await tasks.resumeTask(bridge, store.rootTaskId);

    assert.equal(created.length, 1);
    assert.equal(event.type, "task_created");
    assert.equal(rootBinding(store)?.agent_key, "agent-b");
    assert.equal(rootBinding(store)?.agent_session_id, "session-1");
    assert.equal(tasks.liveTasks.has(store.rootTaskId), true);
  });

  it("keeps the obligation and truncates the transport on an implicit rotation", async () => {
    const store = openStore();
    store.ensureRootTask(dataDir);
    store.createTask(
      "parent",
      dataDir,
      "agent",
      "agent-b",
      "parent-session",
      "root",
    );
    store.createTask(
      "child",
      dataDir,
      "agent",
      "agent-b",
      "child-session",
      "parent",
    );
    // Re-home both tasks onto the agent that is about to disappear.
    const owner = openStore();
    owner.replaceAgentSession("parent", "agent-a", "parent-session");
    owner.replaceAgentSession("child", "agent-a", "child-session");
    const tasks = makeManager(store, "agent-b", ["agent-b"]);
    const { bridge, prompts } = bridgeRecorder();
    tasks.attachExecutionBridge(bridge);
    store.createCollaborationMessage({
      id: "implicit-rotation-dispatch",
      deliveryId: "implicit-rotation-delivery",
      sourceTaskId: "parent",
      directTargetTaskId: "child",
      sourceActor: "agent",
      body: "OLD BODY",
    });
    const armed = tasks.getObligation("parent", "child");
    assert.ok(armed);
    (
      tasks as unknown as { pendingDispatchRetries: Map<string, string[]> }
    ).pendingDispatchRetries.set("child", ["implicit-rotation-delivery"]);

    await tasks.resumeTask(bridge, "child");

    const rotated = tasks.getObligation("parent", "child");
    assert.ok(rotated);
    assert.equal(rotated.openingMessageId, armed.openingMessageId);
    assert.equal(rotated.state, "reminder_due");
    assert.equal(
      (
        tasks as unknown as {
          pendingDispatchRetries: Map<string, string[]>;
        }
      ).pendingDispatchRetries.has("child"),
      false,
    );
    // The old body is never handed to the replacement execution.
    const deadline = Date.now() + 2000;
    while (prompts.length === 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(
      prompts.some((text) => text.includes("OLD BODY")),
      false,
    );
    const events = store
      .getEvents("child")
      .filter((event) => event.type === "system_message")
      .map((event) => JSON.parse(event.data) as Record<string, unknown>);
    assert.ok(events.some((data) => data.kind === "agent_rotation"));
  });

  it("gives each task its own empty execution slot", async () => {
    // Root holds the empty slot after a takeover, exactly as it does after a
    // Root reset. Ordinary tasks need their own placeholder: `agent_sessions`
    // is keyed by (agent_key, agent_session_id), so a shared sentinel would
    // collide with Root and with each other.
    seedRootOwnedBy("agent-a", "session-a");
    const store = openStore();
    const tasks = makeManager(store, "agent-b", ["agent-b"]);
    const { bridge } = bridgeRecorder();
    tasks.attachExecutionBridge(bridge);
    await tasks.resolveTaskExecution(store.rootTaskId);
    const rootSlot = store.getCurrentExecutionBinding(store.rootTaskId);
    assert.ok(rootSlot);
    assert.equal(rootSlot.agent_session_id, emptyExecutionSlot("root"));

    // Both ordinary tasks are owned by the agent that just disappeared.
    const owner = openStore();
    owner.createTask("t1", dataDir, "auto", "owner-session-1");
    owner.createTask("t2", dataDir, "auto", "owner-session-2");

    // Session creation fails, so each rotation keeps its empty slot: this is
    // the sequence that hits the (agent_key, agent_session_id) key.
    const failing = {
      ...bridge,
      async newSession(): Promise<{ sessionId: string; configOptions: [] }> {
        throw new Error("no session");
      },
    };
    await assert.rejects(() => tasks.resumeTask(failing, "t1"), /no session/);
    await assert.rejects(() => tasks.resumeTask(failing, "t2"), /no session/);

    const first = store.getCurrentExecutionBinding("t1");
    const second = store.getCurrentExecutionBinding("t2");
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.agent_key, "agent-b");
    assert.equal(second.agent_key, "agent-b");
    assert.equal(first.agent_session_id, emptyExecutionSlot("t1"));
    assert.equal(second.agent_session_id, emptyExecutionSlot("t2"));
    assert.notEqual(first.agent_session_id, second.agent_session_id);

    // Both rotations are real: each task was taken over and can materialize.
    const event = await tasks.resumeTask(bridge, "t1");
    assert.equal(event.type, "task_created");
    assert.equal(
      store.getCurrentExecutionBinding("t1")?.agent_session_id,
      "session-1",
    );
  });
});
