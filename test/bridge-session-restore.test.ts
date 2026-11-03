import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentBridge } from "../src/bridge.ts";
import { Store } from "../src/store.ts";
import type { TaskManager } from "../src/task-manager.ts";
import { createTaskManager } from "../src/task-manager.ts";
import { CapabilityStore } from "../src/mcp/capability.ts";
import { abbreviateHomePath } from "../src/home-path.ts";
import type { AgentEvent } from "../src/types.ts";
import { handleAgentEvent } from "../src/event-handler.ts";
import { makeEventHandlerConfig } from "./fixtures.ts";

async function startAgent(t: TestContext, profile: string) {
  const dir = mkdtempSync(join(tmpdir(), "webagent-session-restore-"));
  const resources: {
    store?: Store;
    tasks?: TaskManager;
    bridge?: AgentBridge;
  } = {};
  t.after(async () => {
    try {
      if (resources.bridge) {
        resources.bridge.reloading = true;
        await resources.bridge.shutdown();
      }
    } finally {
      resources.tasks?.dispose();
      resources.store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const callsPath = join(dir, "calls.jsonl");
  writeFileSync(callsPath, "");
  const store = new Store(dir);
  resources.store = store;
  const capabilities = new CapabilityStore();
  const tasks = createTaskManager(
    store,
    dir,
    dir,
    capabilities,
    "http://127.0.0.1:6800",
    "session-fixture",
  );
  resources.tasks = tasks;
  const fixture = fileURLToPath(
    new URL("./fixtures/acp-session-agent.ts", import.meta.url),
  );
  const bridge = new AgentBridge(
    `${process.execPath} --experimental-strip-types ${fixture} ${profile} ${callsPath}`,
    store.sessionView("session-fixture"),
  );
  resources.bridge = bridge;
  await bridge.start();
  const calls = (): Array<{ method: string; params: unknown }> =>
    readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { bridge, store, tasks, calls, dir, capabilities };
}

describe("ACP capability-driven restore", { timeout: 20_000 }, () => {
  for (const [profile, method] of [
    ["resume-only", "resume"],
    ["load-only", "load"],
    ["both", "resume"],
  ]) {
    it(`${profile}: restores through ${method} only with config and cache intact`, async (t) => {
      const { bridge, store, tasks, calls, dir, capabilities } =
        await startAgent(t, profile);
      store.createTask("web-1", dir, "auto", "session-fixture", "agent-1");
      store.updateTaskConfig("web-1", "mode", "#plan");
      const before = store.getTask("web-1");
      const events: AgentEvent[] = [];
      const leases: Array<{ taskId: string; generation: number } | undefined> =
        [];
      bridge.on("event", (event: AgentEvent) => {
        // The internal lease stamp is not part of the client surface; assert it
        // separately instead of folding it into the payload comparison.
        const { executionLease, ...rest } = event as AgentEvent & {
          executionLease?: { taskId: string; generation: number };
        };
        leases.push(executionLease);
        events.push(rest);
      });

      const result = await tasks.resumeTask(bridge, "web-1");

      const recorded = calls();
      assert.deepEqual(
        recorded.map((call) => call.method),
        [method, "config"],
        "must select exactly one restore method, never create a new session",
      );
      const restore = recorded[0].params as {
        sessionId: string;
        cwd: string;
        mcpServers: Array<{
          type: string;
          name: string;
          url: string;
          headers: Array<{ name: string; value: string }>;
        }>;
      };
      assert.equal(restore.sessionId, "agent-1");
      assert.equal(restore.cwd, dir);
      assert.equal(restore.mcpServers.length, 1);
      assert.equal(restore.mcpServers[0].type, "http");
      assert.equal(restore.mcpServers[0].name, "webagent");
      assert.equal(restore.mcpServers[0].url, "http://127.0.0.1:6800/mcp");
      const authorization = restore.mcpServers[0].headers.find(
        (header) => header.name === "Authorization",
      )?.value;
      assert.ok(authorization);
      assert.ok(authorization.startsWith("Bearer "));
      assert.equal(
        capabilities.resolve(authorization.slice("Bearer ".length))?.taskId,
        "web-1",
      );
      assert.deepEqual(recorded[1], {
        method: "config",
        params: { sessionId: "agent-1", configId: "mode", value: "#plan" },
      });
      const agentOptions = [
        {
          type: "select",
          id: "mode",
          name: "Mode",
          currentValue: "agent",
          options: [
            { value: "agent", name: "Agent" },
            { value: "#plan", name: "Plan" },
          ],
        },
      ];
      const storedOptions = [{ ...agentOptions[0], currentValue: "#plan" }];
      assert.ok(leases.length > 0);
      assert.ok(
        leases.every((lease) => lease?.taskId === "web-1"),
        "every execution-scoped event carries the generation it was written for",
      );
      assert.deepEqual(events, [
        {
          type: "task_created",
          taskId: "web-1",
          agentId: "session-fixture",
          cwd: dir,
          cwdDisplay: abbreviateHomePath(dir),
          configOptions: agentOptions,
        },
      ]);
      assert.deepEqual(result, {
        type: "task_created",
        rootTaskId: store.rootTaskId,
        taskId: "web-1",
        agentId: "session-fixture",
        cwd: dir,
        cwdDisplay: abbreviateHomePath(dir),
        title: "web-1",
        configOptions: storedOptions,
      });
      assert.deepEqual(tasks.cachedConfigOptions, storedOptions);
      assert.equal(tasks.liveTasks.has("web-1"), true);
      assert.equal(tasks.restoringTasks.has("web-1"), false);
      assert.deepEqual(store.getTask("web-1"), before);
      assert.equal(store.getAgentSessionId("web-1"), "agent-1");
    });
  }

  it("neither: rejects through the existing restore failure path, without calling an unadvertised method", async (t) => {
    const { bridge, store, tasks, calls } = await startAgent(t, "neither");
    store.createTask("web-1", "/repo", "auto", "session-fixture", "agent-1");
    const events: AgentEvent[] = [];
    bridge.on("event", (event: AgentEvent) => events.push(event));

    await assert.rejects(tasks.resumeTask(bridge, "web-1"), /\/new/);

    assert.deepEqual(calls(), []);
    assert.deepEqual(events, []);
    assert.equal(tasks.liveTasks.has("web-1"), false);
    assert.equal(tasks.restoringTasks.has("web-1"), false);
    assert.equal(tasks.isMcpSessionActive("web-1"), false);
    assert.equal(store.getAgentSessionId("web-1"), "agent-1");
  });

  for (const profile of ["close", "delete"]) {
    it(`retirement calls advertised ${profile} from initialize.agentCapabilities`, async (t) => {
      const { bridge, calls } = await startAgent(t, profile);

      await bridge.retireExecution("agent-old");

      assert.deepEqual(calls(), [
        { method: profile, params: { sessionId: "agent-old" } },
      ]);
    });
  }

  it("resume resource-not-found keeps the actionable error and never tries load/new", async (t) => {
    const { bridge, store, tasks, calls } = await startAgent(
      t,
      "resume-missing",
    );
    store.createTask("web-1", "/repo", "auto", "session-fixture", "agent-1");

    await assert.rejects(tasks.resumeTask(bridge, "web-1"), (err: Error) => {
      assert.match(err.message, /agent no longer remembers task/);
      assert.match(err.message, /\/new/);
      assert.equal((err.cause as { code: number }).code, -32002);
      return true;
    });

    const recorded = calls();
    assert.deepEqual(
      recorded.map((call) => call.method),
      ["resume"],
    );
    const params = recorded[0].params as {
      sessionId: string;
      cwd: string;
      mcpServers: unknown[];
    };
    assert.equal(params.sessionId, "agent-1");
    assert.equal(params.cwd, "/repo");
    assert.equal(params.mcpServers.length, 1);
    assert.equal(tasks.liveTasks.has("web-1"), false);
    assert.equal(tasks.restoringTasks.has("web-1"), false);
  });

  // A start that fails before initialize must not leave the previous
  // process's capability flags behind: a later restore would otherwise act on
  // an advertisement that no live agent ever made, and report a raw transport
  // error instead of the actionable "does not support restoring" message.
  it("a failed start clears capability state from the previous process", async (t) => {
    const { bridge } = await startAgent(t, "resume-only");
    assert.ok(
      (bridge as any).sessionCapabilities?.resume,
      "precondition: the fixture advertised resume",
    );

    const previous = (bridge as any).proc;
    previous.kill("SIGKILL");
    await once(previous, "exit");

    // Spawns successfully and exits without completing the ACP handshake.
    (bridge as any).agentCmd = `${process.execPath} -e process.exit(0)`;
    await assert.rejects(() => bridge.start());

    assert.equal((bridge as any).sessionCapabilities, null);
    assert.equal((bridge as any).loadSessionSupported, false);
  });

  it("drops events from an execution whose generation was replaced", async (t) => {
    const { bridge, store, tasks, dir } = await startAgent(t, "load-only");
    store.createTask("web-1", dir, "auto", "session-fixture", "agent-1");
    await tasks.resumeTask(bridge, "web-1");

    const events: AgentEvent[] = [];
    bridge.on("event", (event: AgentEvent) => events.push(event));
    const emitForSession = (
      bridge as unknown as {
        emitForSession(sessionId: string, event: AgentEvent): void;
      }
    ).emitForSession.bind(bridge);

    emitForSession("agent-1", {
      type: "message_chunk",
      taskId: "web-1",
      text: "current",
    });
    assert.equal(events.length, 1, "the current execution may still write");

    // Rotate the task outside the bridge: the old execution's lease dies with
    // it. The terminal `prompt_done`/`error` path emits by task id without a
    // session lookup, so the lease is the only fence it has.
    store.replaceAgentSession("web-1", "session-fixture", "agent-2");
    emitForSession("agent-1", {
      type: "message_chunk",
      taskId: "web-1",
      text: "late tail",
    });
    assert.equal(events.length, 1, "a replaced execution writes nothing");

    // A session that never became current in this process is refused too.
    emitForSession("agent-unknown", {
      type: "message_chunk",
      taskId: "web-1",
      text: "unknown",
    });
    assert.equal(events.length, 1);
  });

  it("does not resolve a death notice for an ACP session key as a task id", async (t) => {
    // F3 reproduction: `/compact` prompts by ACP session id, so the bridge's
    // pending-abort entry is keyed by a session id. Without a captured lease
    // and a fail-closed entry, the death notice is emitted with that session id
    // as `taskId`, the entry accepts it (no ledger entry for "agent-1"), and the
    // downstream write hits a FOREIGN KEY that names no real task.
    const { bridge, store, tasks, dir } = await startAgent(t, "load-only");
    store.createTask("web-1", dir, "auto", "session-fixture", "agent-1");
    await tasks.resumeTask(bridge, "web-1");
    bridge.on("event", (event: AgentEvent) => {
      handleAgentEvent(event, tasks, store, bridge, makeEventHandlerConfig(), {
        broadcast: () => {},
      } as unknown as Parameters<typeof handleAgentEvent>[5]);
    });

    const pending = bridge.promptForText("agent-1", "summarize the task");
    await new Promise<void>((resolve) => setImmediate(resolve));
    (
      bridge as unknown as { markAgentDead(reason: string): void }
    ).markAgentDead("boom");
    await assert.rejects(() => pending);
    // Nothing wrote an event for a task that does not exist.
    assert.equal(store.getEvents("agent-1").length, 0);
  });

  it("attributes a death notice to the task whose prompt captured the lease", async (t) => {
    const { bridge, store, tasks, dir } = await startAgent(t, "load-only");
    store.createTask("web-1", dir, "auto", "session-fixture", "agent-1");
    await tasks.resumeTask(bridge, "web-1");

    const errors: AgentEvent[] = [];
    bridge.on("event", (event: AgentEvent) => {
      if (event.type === "error") errors.push(event);
    });

    // `prompt` registers its abort entry (with the captured lease) before its
    // first await, so the death lands on a known prompt.
    const prompted = bridge
      .prompt("web-1", "hello", undefined, "prompt-1")
      .catch(() => undefined);
    (
      bridge as unknown as { markAgentDead(reason: string): void }
    ).markAgentDead("boom");
    await prompted;

    // The death notice plus the aborted prompt's own failure, both attributed
    // to the task under the lease its prompt captured. Nothing is unattributed.
    assert.ok(errors.length >= 1);
    for (const error of errors) {
      const attributed = error as AgentEvent & {
        taskId?: string;
        executionLease?: { taskId: string; generation: number };
      };
      assert.equal(attributed.taskId, "web-1");
      assert.equal(attributed.executionLease?.taskId, "web-1");
      assert.equal(tasks.acceptsEventLease(error), true);
    }
  });

  it("never re-resolves the current generation for a death notice", async (t) => {
    const { bridge, store, tasks, dir } = await startAgent(t, "load-only");
    store.createTask("web-1", dir, "auto", "session-fixture", "agent-1");
    await tasks.resumeTask(bridge, "web-1");
    const promptLease = tasks.authority.leaseFor("web-1");
    assert.ok(promptLease);

    const errors: AgentEvent[] = [];
    bridge.on("event", (event: AgentEvent) => {
      if (event.type === "error") errors.push(event);
    });
    const prompted = bridge
      .prompt("web-1", "hello", undefined, "prompt-1")
      .catch(() => undefined);

    // The execution is replaced while the prompt is in flight. A death notice
    // must be attributed to the generation the prompt captured, not to whatever
    // generation the task has by the time the agent dies.
    store.replaceAgentSession("web-1", "session-fixture", "session-2");
    const current = tasks.authority.leaseFor("web-1");
    assert.ok(current);
    assert.equal(current.generation, promptLease.generation + 1);

    (
      bridge as unknown as { markAgentDead(reason: string): void }
    ).markAgentDead("boom");
    await prompted;

    assert.ok(errors.length >= 1);
    for (const error of errors) {
      assert.equal(
        tasks.acceptsEventLease(error),
        false,
        "a notice stamped with the replaced generation is refused",
      );
      const lease = (
        error as AgentEvent & {
          executionLease?: { generation: number };
        }
      ).executionLease;
      assert.equal(lease?.generation, promptLease.generation);
    }
  });

  it("never lets a warm-cache response from a replaced execution reach the cache", async (t) => {
    const { bridge, store, tasks, dir } = await startAgent(t, "load-only");
    store.createTask("web-1", dir, "auto", "session-fixture", "agent-1");
    store.updateTaskConfig("web-1", "mode", "#plan");

    const modeOptions = [
      {
        type: "select" as const,
        id: "mode",
        name: "Mode",
        currentValue: "#plan",
        options: [
          { value: "agent", name: "Agent" },
          { value: "#plan", name: "Plan" },
        ],
      },
    ];
    // Only the underlying ACP response is replaced: the real bridge, its codec,
    // and its config path all stay in play.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessions: string[] = [];
    (
      bridge as unknown as {
        connection: {
          setSessionConfigOption(params: { sessionId: string }): Promise<{
            configOptions: unknown[];
          }>;
        };
      }
    ).connection.setSessionConfigOption = async (params) => {
      sessions.push(params.sessionId);
      await gate;
      return { configOptions: modeOptions };
    };

    const restoring = tasks.resumeTask(bridge, "web-1");
    const deadline = Date.now() + 5000;
    while (sessions.length === 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(
      sessions,
      ["agent-1"],
      "the warm-up started on the old execution",
    );

    // The task is rotated while the config request is in flight.
    store.replaceAgentSession("web-1", "session-fixture", "session-2");
    release();

    await assert.rejects(() => restoring, /Execution replaced/);
    assert.deepEqual(
      sessions,
      ["agent-1"],
      "no request was sent to a later execution",
    );
    assert.deepEqual(
      tasks.cachedConfigOptions,
      [],
      "the replaced execution's schema was not cached",
    );
  });

  it("never finishes a config restore for a replaced execution", async (t) => {
    const { bridge, store, tasks, dir } = await startAgent(t, "load-only");
    store.createTask("web-1", dir, "auto", "session-fixture", "agent-1");
    store.updateTaskConfig("web-1", "mode", "#plan");

    const modeOptions = [
      {
        type: "select" as const,
        id: "mode",
        name: "Mode",
        currentValue: "#plan",
        options: [
          { value: "agent", name: "Agent" },
          { value: "#plan", name: "Plan" },
        ],
      },
    ];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessions: string[] = [];
    (
      bridge as unknown as {
        connection: {
          setSessionConfigOption(params: { sessionId: string }): Promise<{
            configOptions: unknown[];
          }>;
        };
      }
    ).connection.setSessionConfigOption = async (params) => {
      sessions.push(params.sessionId);
      await gate;
      return { configOptions: modeOptions };
    };

    // `clearTask` replaces the execution and then replays the stored config.
    const rotating = tasks.clearTask(bridge, "web-1");
    const deadline = Date.now() + 5000;
    while (sessions.length === 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(sessions.length > 0, "the config replay started");
    const requestsBeforeRotation = sessions.length;

    // A second rotation lands while the replay's request is in flight.
    store.replaceAgentSession("web-1", "session-fixture", "session-3");
    release();

    await assert.rejects(() => rotating, /Execution replaced/);
    assert.equal(
      sessions.length,
      requestsBeforeRotation,
      "the replay sent nothing after the execution was replaced",
    );
    assert.deepEqual(
      tasks.cachedConfigOptions,
      [],
      "the replaced execution's schema was not cached",
    );
  });

  it("refuses an ACP session id inside the reserved empty-execution namespace", async (t) => {
    const { bridge, store, tasks, dir } = await startAgent(t, "load-only");
    // The agent is free to return this: ACP session ids are opaque strings.
    (
      bridge as unknown as {
        connection: {
          newSession(): Promise<{
            sessionId: string;
            configOptions: unknown[];
          }>;
        };
      }
    ).connection.newSession = async () => ({
      sessionId: "no-execution:real-agent-session",
      configOptions: [],
    });

    await assert.rejects(
      () => tasks.createTask(bridge, dir),
      /reserved empty-execution namespace/,
    );
    // Rejected before storage: no task and no binding came into existence.
    assert.deepEqual(store.listTasks(), []);
    const stored = store["db"]
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_sessions WHERE agent_session_id LIKE 'no-execution:%'",
      )
      .get() as { n: number };
    assert.equal(stored.n, 0);
  });

  it("restores a real session id that merely shares the reserved prefix", async (t) => {
    const { bridge, store, tasks, dir, calls } = await startAgent(
      t,
      "load-only",
    );
    store.createTask("web-1", dir, "auto", "session-fixture", "agent-1");
    // A database written before the write-boundary guard may hold such an id.
    store["db"]
      .prepare(
        "UPDATE agent_sessions SET agent_session_id = ? WHERE task_id = ?",
      )
      .run("no-execution:real-agent-session", "web-1");

    const event = await tasks.resumeTask(bridge, "web-1");

    assert.equal(event.type, "task_created");
    const methods = calls().map((call) => call.method);
    assert.equal(
      methods[0],
      "load",
      "a real session id is restored, never treated as lazy materialization",
    );
    assert.equal(
      store.getCurrentExecutionBinding("web-1")?.agent_session_id,
      "no-execution:real-agent-session",
    );
  });
});
