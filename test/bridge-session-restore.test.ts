import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentBridge } from "../src/bridge.ts";
import { Store } from "../src/store.ts";
import { TaskManager } from "../src/task-manager.ts";
import { CapabilityStore } from "../src/mcp/capability.ts";
import { abbreviateHomePath } from "../src/home-path.ts";
import type { AgentEvent } from "../src/types.ts";

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
  const store = new Store(dir, "session-fixture");
  resources.store = store;
  const capabilities = new CapabilityStore();
  const tasks = new TaskManager(
    store,
    dir,
    dir,
    capabilities,
    "http://127.0.0.1:6800",
  );
  resources.tasks = tasks;
  const fixture = fileURLToPath(
    new URL("./fixtures/acp-session-agent.ts", import.meta.url),
  );
  const bridge = new AgentBridge(
    `${process.execPath} --experimental-strip-types ${fixture} ${profile} ${callsPath}`,
    store,
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
      store.createTask("web-1", dir, "auto", "agent-1");
      store.updateTaskConfig("web-1", "mode", "#plan");
      const before = store.getTask("web-1");
      const events: AgentEvent[] = [];
      bridge.on("event", (event: AgentEvent) => events.push(event));

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
        capabilities.resolve(authorization.slice("Bearer ".length)),
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
      assert.deepEqual(events, [
        {
          type: "task_created",
          taskId: "web-1",
          cwd: dir,
          cwdDisplay: abbreviateHomePath(dir),
          configOptions: agentOptions,
        },
      ]);
      assert.deepEqual(result, {
        type: "task_created",
        taskId: "web-1",
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
    store.createTask("web-1", "/repo", "auto", "agent-1");
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
    store.createTask("web-1", "/repo", "auto", "agent-1");

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
});
