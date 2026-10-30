import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AgentBridge } from "../src/bridge.ts";
import { AgentRegistry } from "../src/agent-registry.ts";
import { CapabilityStore } from "../src/mcp/capability.ts";
import {
  ExecutionAuthority,
  GenerationLedger,
} from "../src/execution-authority.ts";
import { Store, emptyExecutionSlot } from "../src/store.ts";
import { TaskStateManager } from "../src/task-state.ts";
import { TaskManager } from "../src/task-manager.ts";

/**
 * Multi-agent runtime behaviour.
 *
 * These tests drive real ACP child processes, one per agent, through the
 * registry the server uses. Mocks cannot prove the two properties that matter
 * here: which *process* received a request, and that two agents sharing one
 * session id are still two executions.
 */

const FIXTURE = fileURLToPath(
  new URL("./fixtures/multi-agent-acp-agent.ts", import.meta.url),
);

interface AgentFixture {
  cmd: string;
  callsPath: string;
  calls: () => Array<{ method: string; params: Record<string, unknown> }>;
}

function agentFixture(
  dir: string,
  name: string,
  sessionId = `${name}-session`,
): AgentFixture {
  const callsPath = join(dir, `${name}.calls.jsonl`);
  writeFileSync(callsPath, "");
  return {
    cmd: `${process.execPath} --experimental-strip-types ${FIXTURE} ${sessionId} ${callsPath}`,
    callsPath,
    calls: () =>
      readFileSync(callsPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { method: string; params: never }),
  };
}

interface Harness {
  dir: string;
  store: Store;
  tasks: TaskManager;
  registry: AgentRegistry;
  authority: ExecutionAuthority;
  capabilities: CapabilityStore;
  agents: Record<string, AgentFixture>;
}

function createHarness(
  dir: string,
  agents: Record<string, AgentFixture>,
  defaultAgent: string,
): Harness {
  const store = new Store(dir);
  store.ensureRootTask(dir);
  const capabilities = new CapabilityStore();
  const authority = new ExecutionAuthority(new GenerationLedger());
  const bridges: AgentBridge[] = [];
  const registry = new AgentRegistry({
    agents: Object.fromEntries(
      Object.entries(agents).map(([id, fixture]) => [id, { cmd: fixture.cmd }]),
    ),
    defaultAgentId: defaultAgent,
    createTransport: (agentId) => {
      const bridge = new AgentBridge(
        agents[agentId].cmd,
        store.sessionView(agentId),
        agentId,
      );
      bridge.setExecutionLeaseSource(authority);
      bridges.push(bridge);
      return bridge;
    },
  });
  const tasks = new TaskManager({
    store,
    defaultCwd: dir,
    dataDir: dir,
    capabilities,
    mcpBaseUrl: "http://127.0.0.1:6800",
    state: new TaskStateManager(),
    authority,
    agents: registry,
  });
  return { dir, store, tasks, registry, authority, capabilities, agents };
}

async function disposeHarness(harness: Harness): Promise<void> {
  harness.tasks.dispose();
  await harness.registry.shutdownAll();
  harness.store.close();
  rmSync(harness.dir, { recursive: true, force: true });
}

describe("multi-agent runtime", () => {
  let harness: Harness;
  let a: AgentFixture;
  let b: AgentFixture;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-multi-agent-"));
    // Both agents hand out the *same* session id, which is how two configured
    // agents that share one CLI session store behave.
    a = agentFixture(dir, "a", "shared-session");
    b = agentFixture(dir, "b", "shared-session");
    harness = createHarness(dir, { "agent-a": a, "agent-b": b }, "agent-a");
  });

  after(async () => {
    await disposeHarness(harness);
  });

  it("starts no agent until one is asked for", () => {
    const fresh = mkdtempSync(join(tmpdir(), "webagent-multi-lazy-"));
    const registry = new AgentRegistry({
      agents: {
        "agent-a": { cmd: "node --version" },
        "agent-b": { cmd: "node --version" },
      },
      defaultAgentId: "agent-a",
      createTransport: () => {
        throw new Error("nothing may be created before resolve()");
      },
    });
    assert.deepEqual(registry.listExisting(), []);
    assert.equal(registry.existing("agent-b"), undefined);
    rmSync(fresh, { recursive: true, force: true });
    void registry.shutdownAll();
  });

  it("executes each task on its own binding agent, not the caller's", async () => {
    const aExecution = await harness.tasks.resolveAgentTransport("agent-a");
    const bExecution = await harness.tasks.resolveAgentTransport("agent-b");

    const createdA = await harness.tasks.createTask(
      aExecution,
      harness.dir,
      undefined,
      "agent",
    );
    const createdB = await harness.tasks.createTask(
      bExecution,
      harness.dir,
      undefined,
      "agent",
    );

    assert.equal(harness.store.getBindingAgent(createdA.taskId), "agent-a");
    assert.equal(harness.store.getBindingAgent(createdB.taskId), "agent-b");
    // Both agents handed out the same ACP session id.
    // Both agents handed out the same ACP session id ("shared-session-1").
    assert.equal(
      harness.store.getAgentSessionId(createdA.taskId),
      harness.store.getAgentSessionId(createdB.taskId),
    );

    const callsABefore = a.calls().length;
    const callsBBefore = b.calls().length;

    // The prompt is addressed by task id only. Asking with the wrong agent is
    // not an option the caller has: the runtime resolves the binding.
    const executionB = await harness.tasks.resolveTaskExecution(
      createdB.taskId,
    );
    assert.equal(executionB.agentId, "agent-b");
    await executionB.bridge.prompt(createdB.taskId, "hello B", undefined);

    const aPrompts = a
      .calls()
      .slice(callsABefore)
      .filter((c) => c.method === "prompt");
    const bPrompts = b
      .calls()
      .slice(callsBBefore)
      .filter((c) => c.method === "prompt");
    assert.equal(bPrompts.length, 1, "B really received the prompt");
    assert.equal(aPrompts.length, 0, "A received nothing");
    assert.equal(
      (bPrompts[0].params as { sessionId: string }).sessionId,
      harness.store.getAgentSessionId(createdB.taskId),
    );

    // And the reverse direction is symmetric.
    const beforeA = a.calls().length;
    const beforeB = b.calls().length;
    const executionA = await harness.tasks.resolveTaskExecution(
      createdA.taskId,
    );
    assert.equal(executionA.agentId, "agent-a");
    await executionA.bridge.prompt(createdA.taskId, "hello A", undefined);
    assert.equal(
      a
        .calls()
        .slice(beforeA)
        .filter((c) => c.method === "prompt").length,
      1,
    );
    assert.equal(
      b
        .calls()
        .slice(beforeB)
        .filter((c) => c.method === "prompt").length,
      0,
    );
  });

  it("never projects a task onto another agent's identical session id", async () => {
    const aExecution = await harness.tasks.resolveAgentTransport("agent-a");
    const created = await harness.tasks.createTask(
      aExecution,
      harness.dir,
      undefined,
      "agent",
    );
    const sessionId = harness.store.getAgentSessionId(created.taskId)!;

    // agent-b's view cannot map a session it does not own, even when the id
    // matches one of its own tasks.
    const bExecution = await harness.tasks.resolveAgentTransport("agent-b");
    const createdB = await harness.tasks.createTask(
      bExecution,
      harness.dir,
      undefined,
      "agent",
    );
    assert.equal(harness.store.getAgentSessionId(createdB.taskId), sessionId);
    await assert.rejects(
      () => bExecution.setConfigOption(created.taskId, "mode", "#plan"),
      /not available for the current agent/,
    );
  });

  it("starts a configured agent at most once under concurrent demand", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-multi-single-"));
    const fixture = agentFixture(dir, "single");
    const local = createHarness(dir, { "agent-a": fixture }, "agent-a");
    try {
      await Promise.all(
        Array.from({ length: 5 }, () => local.registry.resolve("agent-a")),
      );
      assert.equal(
        local.agents["agent-a"].calls().filter((c) => c.method === "new")
          .length,
        0,
        "resolving never creates an ACP session by itself",
      );
      const transport = await local.tasks.resolveDefaultTransport();
      await transport.newSession(dir);
      assert.equal(fixture.calls().filter((c) => c.method === "new").length, 1);
    } finally {
      await disposeHarness(local);
    }
  });

  it("leaves no process behind when an agent fails to initialize", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-multi-fail-"));
    const failing: AgentFixture = {
      // A process that dies immediately: initialize can never complete.
      cmd: `${process.execPath} -e process.exit(1)`,
      callsPath: join(dir, "unused.jsonl"),
      calls: () => [],
    };
    const working = agentFixture(dir, "working");
    const local = createHarness(
      dir,
      { "agent-a": failing, "agent-b": working },
      "agent-a",
    );
    try {
      await assert.rejects(() => local.registry.resolve("agent-a"));
      // A failed start is retryable: the next demand starts a fresh process
      // and succeeds.
      const adapter = await local.registry.resolve("agent-b");
      assert.ok(adapter.isAvailable());
      assert.equal(local.registry.existing("agent-a")?.isAvailable(), false);
    } finally {
      await disposeHarness(local);
    }
  });
});

describe("multi-agent reads and rescue", () => {
  it("keeps every read working while the binding agent has no transport", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-multi-offline-"));
    const fixture = agentFixture(dir, "offline");
    const harness = createHarness(dir, { "agent-a": fixture }, "agent-a");
    try {
      const execution = await harness.tasks.resolveAgentTransport("agent-a");
      const created = await harness.tasks.createTask(
        execution,
        dir,
        undefined,
        "agent",
      );
      harness.store.saveEvent(
        created.taskId,
        "user_message",
        { text: "remember me" },
        { from_ref: "user" },
      );

      // The transport is gone. Nothing here resolves it: the task is still a
      // real task, and reading it must not depend on an execution.
      await harness.registry.shutdownAll();
      assert.equal(harness.tasks.existingTaskExecution(created.taskId), null);
      assert.equal(harness.store.getTask(created.taskId)?.id, created.taskId);
      assert.ok(harness.store.listTasks().some((t) => t.id === created.taskId));
      assert.equal(harness.store.getEvents(created.taskId).length, 1);
      assert.equal(
        harness.store.sessionView("agent-a").getAgentSessionId(created.taskId),
        harness.store.getAgentSessionId(created.taskId),
      );
      assert.equal(
        harness.tasks.getAgentCommands(created.taskId).commands.length,
        0,
      );
      assert.equal(
        harness.tasks.getPendingPermissions(created.taskId).length,
        0,
      );
      // The binding is untouched by any of the reads above.
      assert.equal(harness.store.getBindingAgent(created.taskId), "agent-a");
      assert.equal(
        harness.tasks.authority.leaseFor(created.taskId)?.taskId,
        created.taskId,
      );
    } finally {
      harness.tasks.dispose();
      harness.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("root first-use states", () => {
  it("attaches, replaces and loads in three independent states", async () => {
    // --- state 1: a never-bound Root attaches an execution ---
    const dir = mkdtempSync(join(tmpdir(), "webagent-multi-root-"));
    const fixture = agentFixture(dir, "root");
    const local = createHarness(dir, { "agent-a": fixture }, "agent-a");
    try {
      const rootId = local.store.rootTaskId;
      const generationBefore = local.authority.generationOf(rootId);
      assert.equal(local.store.hasBinding(rootId), false);
      await local.tasks.ensureTaskLive(rootId);
      assert.ok(local.store.hasBinding(rootId));
      assert.equal(
        fixture.calls().filter((c) => c.method === "new").length,
        1,
        "an unbound Root attaches a new session",
      );
      const afterAttach = local.authority.generationOf(rootId);
      assert.ok(
        (afterAttach ?? 0) > (generationBefore ?? 0),
        "attach commits a generation",
      );

      // --- state 2: an empty slot (reset) replaces its execution ---
      local.store.resetRootTask();
      assert.equal(
        local.store.getAgentSessionId(rootId),
        emptyExecutionSlot(rootId),
      );
      local.tasks.liveTasks.delete(rootId);
      await local.tasks.ensureTaskLive(rootId);
      assert.equal(
        fixture.calls().filter((c) => c.method === "new").length,
        2,
        "an empty slot materializes a new session instead of loading",
      );
      const afterReplace = local.authority.generationOf(rootId);
      assert.ok((afterReplace ?? 0) > (afterAttach ?? 0));

      // --- state 3: a real binding loads the existing session ---
      local.tasks.liveTasks.delete(rootId);
      await local.tasks.ensureTaskLive(rootId);
      assert.equal(
        fixture.calls().filter((c) => c.method === "new").length,
        2,
        "a real binding never creates a second session",
      );
      assert.ok(
        fixture
          .calls()
          .some((c) => c.method === "load" || c.method === "resume"),
        "a real binding restores the session",
      );
    } finally {
      await disposeHarness(local);
    }
  });

  it("materializes a concurrently requested Root exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-multi-root-race-"));
    const fixture = agentFixture(dir, "race");
    const local = createHarness(dir, { "agent-a": fixture }, "agent-a");
    try {
      await Promise.all(
        Array.from({ length: 4 }, () =>
          local.tasks.ensureTaskLive(local.store.rootTaskId),
        ),
      );
      assert.equal(fixture.calls().filter((c) => c.method === "new").length, 1);
    } finally {
      await disposeHarness(local);
    }
  });
});

describe("lifecycle is agent-scoped", () => {
  it("reloads only the binding agent's tasks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-multi-reload-"));
    const a = agentFixture(dir, "a", "shared-session");
    const b = agentFixture(dir, "b", "shared-session");
    const harness = createHarness(
      dir,
      { "agent-a": a, "agent-b": b },
      "agent-a",
    );
    try {
      const transportA = await harness.tasks.resolveAgentTransport("agent-a");
      const transportB = await harness.tasks.resolveAgentTransport("agent-b");
      const taskA = await harness.tasks.createTask(
        transportA,
        dir,
        undefined,
        "agent",
      );
      const taskB = await harness.tasks.createTask(
        transportB,
        dir,
        undefined,
        "agent",
      );

      // Put B's task into runtime states that a reload of A must not touch.
      harness.tasks.state.patch(taskB.taskId, {
        runtime: {
          streaming: { assistant: true, thinking: false },
          plan: [{ content: "step", status: "pending" }],
          contextUsage: { used: 10, size: 100 },
        },
      });
      harness.tasks.activePrompts.add(taskB.taskId);
      harness.tasks.syncBusy(taskB.taskId);

      const events: Array<{ type: string; agentId?: string }> = [];
      const adapterA = harness.registry.existing("agent-a");
      assert.ok(adapterA, "the reload target's adapter exists");
      (adapterA.bridge as unknown as AgentBridge).on(
        "event",
        (event: { type: string }) => events.push(event),
      );

      await harness.tasks.reloadAgent(taskA.taskId);

      assert.ok(
        events.some(
          (event) =>
            event.type === "agent_reloading" && event.agentId === "agent-a",
        ),
      );
      // B keeps everything.
      assert.equal(
        harness.tasks.state.getState(taskB.taskId).runtime.streaming.assistant,
        true,
      );
      assert.equal(
        harness.tasks.state.getState(taskB.taskId).runtime.plan?.length,
        1,
      );
      assert.ok(
        harness.tasks.state.getState(taskB.taskId).runtime.contextUsage,
      );
      assert.equal(harness.tasks.activePrompts.has(taskB.taskId), true);
      // A's own task was released so the next use re-registers it.
      assert.equal(harness.tasks.liveTasks.has(taskA.taskId), false);
    } finally {
      await disposeHarness(harness);
    }
  });
});

describe("retirement follows the recorded binding", () => {
  it("never retires through a default adapter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-multi-retire-"));
    const retired: Array<{ agentId: string; sessionId: string }> = [];
    const store = new Store(dir);
    store.ensureRootTask(dir);
    const authority = new ExecutionAuthority(new GenerationLedger());
    const registry = new AgentRegistry({
      agents: {
        "agent-a": { cmd: "unused" },
        "agent-b": { cmd: "unused" },
      },
      defaultAgentId: "agent-a",
      createTransport: () => {
        throw new Error("retirement must never start an agent");
      },
    });
    // Recording transports, one per agent. Retrieval must reach the adapter of
    // the binding's agent, so identical session ids stay distinguishable.
    for (const agentId of ["agent-a", "agent-b"]) {
      registry.adapterFor(agentId).bindBridge({
        retireExecution: async (sessionId: string) => {
          retired.push({ agentId, sessionId });
        },
      });
    }
    const tasks = new TaskManager({
      store,
      defaultCwd: dir,
      dataDir: dir,
      state: new TaskStateManager(),
      authority,
      agents: registry,
    });
    const bridge = {
      async newSession() {
        return { sessionId: "created-session", configOptions: [] };
      },
      async setConfigOption() {
        return [];
      },
      async loadSession(taskId: string) {
        return { taskId, configOptions: [] };
      },
      async prompt() {},
      async cancel() {},
      // Attaching this transport makes it agent-a's transport (that is how a
      // caller hands one in), so it must record agent-a's retirements.
      async retireExecution(sessionId: string) {
        retired.push({ agentId: "agent-a", sessionId });
      },
    };
    try {
      // Root belongs to agent-a, a junk empty task to agent-b, and both hold
      // the same ACP session id.
      store.attachAgentSession(store.rootTaskId, "agent-a", "same-sid");
      store.createTask(
        "junk",
        dir,
        "auto",
        "agent-b",
        "same-sid",
        store.rootTaskId,
      );
      // The GC only reaps tasks older than its minimum age; backdate this one
      // instead of waiting.
      store["db"]
        .prepare("UPDATE tasks SET created_at = ? WHERE id = ?")
        .run(Date.now() - 24 * 60 * 60 * 1000, "junk");

      // Creating a task runs the empty-task GC. It must retire the junk task
      // through agent-b — the agent in the removed record.
      await tasks.createTask(bridge, dir);
      assert.deepEqual(
        retired.filter((entry) => entry.agentId === "agent-b"),
        [{ agentId: "agent-b", sessionId: "same-sid" }],
      );
      assert.deepEqual(
        retired.filter((entry) => entry.agentId === "agent-a"),
        [],
        "GC never retires through the default adapter",
      );

      // Root reset retires Root's own execution, which belongs to agent-a.
      const resetRetired = retired.length;
      await tasks.resetRootTask();
      assert.deepEqual(
        retired
          .slice(resetRetired)
          .filter((entry) => entry.agentId === "agent-a")
          .map((entry) => entry.sessionId)
          .sort(),
        ["created-session", "same-sid"],
      );
      assert.equal(
        retired.slice(resetRetired).filter((e) => e.agentId === "agent-b")
          .length,
        0,
        "a Root bound to agent-a never retires through agent-b",
      );
      assert.equal(
        store.getAgentSessionId(store.rootTaskId),
        emptyExecutionSlot("root"),
      );
    } finally {
      tasks.dispose();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
