import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { TaskBusyError, TaskManager } from "../src/task-manager.ts";
import { CapabilityStore } from "../src/mcp/capability.ts";
import { createMcpEndpoint } from "../src/mcp/server.ts";
import type { ConfigOption } from "../src/types.ts";

async function startMcpTestServer(
  capabilities: CapabilityStore,
  isActive: (taskId: string) => boolean,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const endpoint = createMcpEndpoint({
    capabilities,
    isTaskActive: isActive,
  });
  const server = http.createServer((req, res) => {
    void endpoint(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function assertMcpInitialize(
  url: string,
  authorization: string,
): Promise<void> {
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "task-manager-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(response.status, 200);
}

describe("TaskManager", () => {
  let store: Store;
  let sm: TaskManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-test-"));
    store = new Store(tmpDir, "test-agent");
    sm = new TaskManager(store, tmpDir, tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("hydrate", () => {
    it("populates taskHasTitle from DB", () => {
      store.createTask("s1", "/x");
      store.updateTaskTitle("s1", "My Title");
      store.createTask("s2", "/y"); // no title

      sm.hydrate();

      assert.ok(sm.taskHasTitle.has("s1"));
      assert.ok(!sm.taskHasTitle.has("s2"));
    });
  });

  describe("MCP capability lifecycle", () => {
    it("allows MCP auto-connect while a new ACP task is being created", async () => {
      const capabilities = new CapabilityStore();
      const mcpTaskManagerRef: { current?: TaskManager } = {};
      const mcpServer = await startMcpTestServer(capabilities, (taskId) =>
        mcpTaskManagerRef.current!.isMcpSessionActive(taskId),
      );
      const mcpTaskManager = new TaskManager(
        store,
        tmpDir,
        tmpDir,
        capabilities,
        mcpServer.baseUrl,
      );
      mcpTaskManagerRef.current = mcpTaskManager;

      const bridge = {
        async newSession(_cwd: string, options?: { mcpServers?: any[] }) {
          const entry = options?.mcpServers?.[0] as {
            headers: Array<{ name: string; value: string }>;
          };
          const authorization = entry.headers.find(
            (header) => header.name === "Authorization",
          )?.value;
          assert.ok(authorization);
          const taskId = capabilities.resolve(
            authorization.replace(/^Bearer\s+/, ""),
          );
          assert.ok(taskId);
          assert.equal(mcpTaskManager.liveTasks.has(taskId), false);
          assert.equal(mcpTaskManager.isMcpSessionActive(taskId), true);
          await assertMcpInitialize(mcpServer.baseUrl, authorization);
          return { sessionId: "agent-new", configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      try {
        const created = await mcpTaskManager.createTask(bridge);
        assert.equal(mcpTaskManager.liveTasks.has(created.taskId), true);
        assert.equal(mcpTaskManager.isMcpSessionActive(created.taskId), true);
      } finally {
        await mcpServer.close();
      }
    });

    it("allows MCP auto-connect while an ACP task is being restored", async () => {
      const taskId = "restore-mcp";
      store.createTask(taskId, tmpDir);
      const capabilities = new CapabilityStore();
      const mcpTaskManagerRef: { current?: TaskManager } = {};
      const mcpServer = await startMcpTestServer(capabilities, (activeTaskId) =>
        mcpTaskManagerRef.current!.isMcpSessionActive(activeTaskId),
      );
      const mcpTaskManager = new TaskManager(
        store,
        tmpDir,
        tmpDir,
        capabilities,
        mcpServer.baseUrl,
      );
      mcpTaskManagerRef.current = mcpTaskManager;

      const bridge = {
        async newSession() {
          throw new Error("newSession should not be called");
        },
        async setConfigOption() {
          return [];
        },
        async loadSession(
          _webTaskId: string,
          _cwd: string,
          mcpServers?: any[],
        ) {
          const entry = mcpServers?.[0] as {
            headers: Array<{ name: string; value: string }>;
          };
          const authorization = entry.headers.find(
            (header) => header.name === "Authorization",
          )?.value;
          assert.ok(authorization);
          assert.equal(mcpTaskManager.liveTasks.has(taskId), false);
          assert.equal(mcpTaskManager.isMcpSessionActive(taskId), true);
          await assertMcpInitialize(mcpServer.baseUrl, authorization);
          return { taskId, configOptions: [] };
        },
      };

      try {
        await mcpTaskManager.resumeTask(bridge, taskId);
        assert.equal(mcpTaskManager.liveTasks.has(taskId), true);
      } finally {
        await mcpServer.close();
      }
    });

    it("revokes a capability when ACP task creation fails", async () => {
      const capabilities = new CapabilityStore();
      let mintedTaskId: string | null = null;
      let mintedToken: string | null = null;
      const mcpTaskManager = new TaskManager(
        store,
        tmpDir,
        tmpDir,
        capabilities,
        "http://127.0.0.1:1",
      );
      const bridge = {
        async newSession(_cwd: string, options?: { mcpServers?: any[] }) {
          const entry = options?.mcpServers?.[0] as {
            headers: Array<{ name: string; value: string }>;
          };
          const authorization = entry.headers[0]?.value;
          assert.ok(authorization);
          mintedToken = authorization.replace(/^Bearer\s+/, "");
          mintedTaskId = capabilities.resolve(mintedToken);
          throw new Error("ACP startup failed");
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      await assert.rejects(() => mcpTaskManager.createTask(bridge), {
        message: "ACP startup failed",
      });
      assert.ok(mintedTaskId);
      assert.ok(mintedToken);
      assert.equal(capabilities.resolve(mintedToken), null);
      assert.equal(mcpTaskManager.isMcpSessionActive(mintedTaskId), false);
    });
  });

  describe("deleteTask", () => {
    it("cleans up all state", async () => {
      store.createTask("s1", "/x");
      sm.liveTasks.add("s1");
      sm.taskHasTitle.add("s1");
      sm.assistantBuffers.set("s1", "partial");
      sm.thinkingBuffers.set("s1", "hmm");
      sm.updateAgentCommands("s1", [
        { name: "context", description: "Show context usage" },
      ]);

      await sm.deleteTask(undefined, "s1");

      assert.ok(!sm.liveTasks.has("s1"));
      assert.ok(!sm.taskHasTitle.has("s1"));
      assert.ok(!sm.assistantBuffers.has("s1"));
      assert.ok(!sm.thinkingBuffers.has("s1"));
      const commands = sm.getAgentCommands("s1");
      assert.ok(commands.epoch);
      assert.deepEqual(commands, {
        epoch: commands.epoch,
        revision: 0,
        commands: [],
      });
      assert.equal(store.getTask("s1"), undefined);
    });

    it("cascades to descendants, cleaning their runtime state and retiring executions", async () => {
      store.createTask("parent", "/a", "auto", "agent-parent");
      store.createTask("child", "/b", "auto", "agent-child", "parent");
      sm.liveTasks.add("parent");
      sm.liveTasks.add("child");
      sm.assistantBuffers.set("child", "partial answer");
      const retired: string[] = [];
      const bridge = {
        async newSession() {
          return { sessionId: "ignored", configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("unused");
        },
        async retireExecution(agentSessionId: string) {
          retired.push(agentSessionId);
        },
      };

      const result = await sm.deleteTask(bridge, "parent");

      assert.deepEqual(result.affected.map((entry) => entry.id).sort(), [
        "child",
        "parent",
      ]);
      assert.deepEqual(retired.sort(), ["agent-child", "agent-parent"]);
      assert.ok(!sm.liveTasks.has("parent"));
      assert.ok(!sm.liveTasks.has("child"));
      assert.ok(!sm.assistantBuffers.has("child"));
      assert.ok(!sm.pendingPromptSubmissions.has("child"));
    });

    it("skips retirement when no bridge is available", async () => {
      store.createTask("s1", "/x", "auto", "agent-s1");

      const result = await sm.deleteTask(undefined, "s1");

      assert.equal(result.mode, "hard");
      assert.equal(store.getTask("s1"), undefined);
    });

    it("rejects deleting a subtree with active work", async () => {
      store.createTask("parent", "/a", "auto", "agent-parent");
      store.createTask("child", "/b", "auto", "agent-child", "parent");
      sm.activePrompts.add("child");

      await assert.rejects(() => sm.deleteTask(undefined, "parent"), {
        name: TaskBusyError.name,
      });
      assert.ok(store.getTask("parent"));
      assert.ok(store.getTask("child"));
      sm.activePrompts.delete("child");
    });
  });

  describe("agent command snapshots", () => {
    it("replaces commands and increments the per-task revision", () => {
      const first = sm.updateAgentCommands("s1", [
        { name: "context", description: "Show context usage" },
      ]);
      const second = sm.updateAgentCommands("s1", [
        {
          name: "compact",
          description: "Compact conversation",
          input: { hint: "focus instructions" },
        },
      ]);

      assert.deepEqual(first, {
        epoch: first.epoch,
        revision: 1,
        commands: [{ name: "context", description: "Show context usage" }],
      });
      assert.deepEqual(second, {
        epoch: first.epoch,
        revision: 2,
        commands: [
          {
            name: "compact",
            description: "Compact conversation",
            input: { hint: "focus instructions" },
          },
        ],
      });
      assert.deepEqual(sm.getAgentCommands("s1"), second);
    });

    it("clears all snapshots with a newer revision", () => {
      sm.updateAgentCommands("s1", [
        { name: "context", description: "Show context usage" },
      ]);
      sm.updateAgentCommands("s2", [
        { name: "usage", description: "Show usage" },
      ]);

      const cleared = sm.clearAgentCommands();
      const epoch = sm.getAgentCommands("s1").epoch;

      assert.deepEqual(cleared, [
        { taskId: "s1", epoch, revision: 2, commands: [] },
        { taskId: "s2", epoch, revision: 2, commands: [] },
      ]);
      assert.deepEqual(sm.getAgentCommands("s1"), {
        epoch,
        revision: 2,
        commands: [],
      });
    });
  });

  describe("createTask", () => {
    it("inherits config from the source task", async () => {
      store.createTask("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );
      store.updateTaskConfig("s1", "model", "claude-sonnet-4.6");
      store.updateTaskConfig("s1", "mode", "plan-mode");
      store.updateTaskConfig("s1", "reasoning_effort", "high");
      sm.cachedConfigOptions = [
        {
          type: "select",
          id: "model",
          name: "Model",
          currentValue: "mock-model",
          options: [],
        },
        {
          type: "select",
          id: "mode",
          name: "Mode",
          currentValue: "agent",
          options: [],
        },
        {
          type: "select",
          id: "reasoning_effort",
          name: "Reasoning",
          currentValue: "medium",
          options: [],
        },
      ];

      const configCalls: Array<{
        taskId: string;
        configId: string;
        value: string;
      }> = [];
      const bridge = {
        async newSession(cwd: string) {
          assert.equal(cwd, tmpDir);
          return {
            sessionId: "s2",
            configOptions: sm.cachedConfigOptions,
          };
        },
        async setConfigOption(taskId: string, configId: string, value: string) {
          configCalls.push({ taskId, configId, value });
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      const created = await sm.createTask(bridge, undefined, "s1");

      // mode is intentionally NOT inherited — new tasks always start in default (agent) mode
      assert.deepEqual(configCalls, [
        {
          taskId: created.taskId,
          configId: "model",
          value: "claude-sonnet-4.6",
        },
        {
          taskId: created.taskId,
          configId: "reasoning_effort",
          value: "high",
        },
      ]);
      assert.match(
        created.taskId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert.notEqual(created.taskId, "s2");
      assert.equal(store.getAgentSessionId(created.taskId), "s2");
      assert.ok(sm.liveTasks.has(created.taskId));
      assert.ok(!sm.liveTasks.has("s2"));
      assert.deepEqual(
        created.configOptions.map((opt) => ({
          id: opt.id,
          currentValue: opt.currentValue,
        })),
        [
          { id: "model", currentValue: "claude-sonnet-4.6" },
          { id: "mode", currentValue: "agent" },
          { id: "reasoning_effort", currentValue: "high" },
        ],
      );
      assert.equal(store.getTask(created.taskId)!.model, "claude-sonnet-4.6");
      assert.equal(store.getTask(created.taskId)!.mode, "agent");
      assert.equal(store.getTask(created.taskId)!.reasoning_effort, "high");
    });

    it("inherits thinking through an agent's thought_level option", async () => {
      store.createTask("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );
      store.updateTaskConfig("s1", "reasoning_effort", "high");
      const configOptions: ConfigOption[] = [
        {
          type: "select",
          id: "thought_level",
          category: "thought_level",
          name: "Thinking",
          currentValue: "medium",
          options: [
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
          ],
        },
      ];
      const configCalls: Array<{ configId: string; value: string }> = [];
      const bridge = {
        async newSession() {
          return { sessionId: "agent-s2", configOptions };
        },
        async setConfigOption(
          _taskId: string,
          configId: string,
          value: string,
        ) {
          configCalls.push({ configId, value });
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      const created = await sm.createTask(bridge, undefined, "s1");

      assert.deepEqual(configCalls, [
        { configId: "thought_level", value: "high" },
      ]);
      assert.equal(created.configOptions[0]?.currentValue, "high");
      assert.equal(store.getTask(created.taskId)!.reasoning_effort, "high");
    });

    it("does not set config when no source task is provided", async () => {
      let configCalled = false;
      const bridge = {
        async newSession() {
          return { sessionId: "s2", configOptions: [] };
        },
        async setConfigOption() {
          configCalled = true;
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      const created = await sm.createTask(bridge);

      assert.equal(configCalled, false);
      assert.notEqual(created.taskId, "s2");
      assert.match(
        created.taskId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert.deepEqual(created.configOptions, []);
      assert.equal(store.getTask(created.taskId)!.model, null);
      assert.equal(store.getAgentSessionId(created.taskId), "s2");
    });

    it("creates new tasks as Root children when Root exists", async () => {
      store.ensureRootTask(tmpDir);
      const bridge = {
        async newSession() {
          return { sessionId: "agent-child", configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      const created = await sm.createTask(bridge);

      assert.equal(store.getTask(created.taskId)?.parent_id, "root");
    });

    it("expands home shorthand before creating a task", async () => {
      let agentCwd = "";
      const bridge = {
        async newSession(cwd: string) {
          agentCwd = cwd;
          return { sessionId: "agent-home", configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          return { taskId: "agent-home", configOptions: [] };
        },
      };

      const created = await sm.createTask(bridge, "~");

      assert.equal(agentCwd, homedir());
      assert.equal(store.getTask(created.taskId)?.cwd, homedir());
    });

    it("rejects a non-existent cwd", async () => {
      const bridge = {
        async newSession() {
          return { sessionId: "s2", configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("should not be called");
        },
      };

      await assert.rejects(() => sm.createTask(bridge, "/no/such/path"), {
        message: "Directory does not exist: /no/such/path",
      });
    });

    it("cleans up old empty tasks and removes them from liveTasks", async () => {
      // Create an empty task and mark it as live (simulating a prior createTask)
      store.createTask("empty-old", "/x");
      sm.liveTasks.add("empty-old");
      // Backdate created_at so it's older than the threshold
      store["db"]
        .prepare(
          "UPDATE tasks SET created_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-120 seconds') WHERE id = ?",
        )
        .run("empty-old");

      // Create a task with events — should not be cleaned
      store.createTask("has-events", "/x");
      store.saveEvent(
        "has-events",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );
      sm.liveTasks.add("has-events");

      let nextId = 0;
      const bridge = {
        async newSession() {
          return { sessionId: `new-${nextId++}`, configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("should not be called");
        },
      };

      await sm.createTask(bridge);

      // empty-old should be gone from both DB and liveTasks
      assert.equal(store.getTask("empty-old"), undefined);
      assert.ok(!sm.liveTasks.has("empty-old"));
      // has-events should still exist
      assert.ok(store.getTask("has-events"));
      assert.ok(sm.liveTasks.has("has-events"));
    });

    it("does not clean recently created empty tasks", async () => {
      // Create an empty task that's fresh (just now)
      store.createTask("fresh-empty", "/x");
      sm.liveTasks.add("fresh-empty");

      const bridge = {
        async newSession() {
          return { sessionId: "new-1", configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("should not be called");
        },
      };

      await sm.createTask(bridge);

      // fresh-empty should still exist (too young to clean)
      assert.ok(store.getTask("fresh-empty"));
      assert.ok(sm.liveTasks.has("fresh-empty"));
    });
  });

  describe("clearTask", () => {
    it("rotates the ACP execution while preserving the WebAgent task", async () => {
      store.createTask("web-1", tmpDir, "auto", "agent-old");
      store.updateTaskConfig("web-1", "model", "model-old");
      store.updateTaskConfig("web-1", "mode", "plan");
      sm.liveTasks.add("web-1");
      const configCalls: Array<{ id: string; value: string }> = [];
      const retired: string[] = [];

      const bridge = {
        async newSession() {
          return { sessionId: "agent-new", configOptions: [] };
        },
        async setConfigOption(_taskId: string, id: string, value: string) {
          configCalls.push({ id, value });
          return [];
        },
        async retireExecution(agentSessionId: string) {
          retired.push(agentSessionId);
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      const result = await sm.clearTask(bridge, "web-1");

      assert.equal(result.taskId, "web-1");
      assert.deepEqual(
        store.listTasks().map((task) => task.id),
        ["web-1"],
      );
      assert.equal(store.getAgentSessionId("web-1"), "agent-new");
      assert.equal(store.getTaskId("agent-old"), undefined);
      // The retired execution is explicitly removed, not just unbound.
      assert.deepEqual(retired, ["agent-old"]);
      assert.deepEqual(configCalls, [
        { id: "mode", value: "plan" },
        { id: "model", value: "model-old" },
      ]);
    });

    it("never retires the current execution when the agent returns the same id", async () => {
      store.createTask("web-1", tmpDir, "auto", "agent-same");
      sm.liveTasks.add("web-1");
      const retired: string[] = [];
      const bridge = {
        async newSession() {
          return { sessionId: "agent-same", configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
        async retireExecution(agentSessionId: string) {
          retired.push(agentSessionId);
        },
      };

      await sm.clearTask(bridge, "web-1");

      // rotateAgentSession is a no-op, so the still-authoritative execution
      // must not be retired; retiring it would kill the live binding.
      assert.equal(store.getAgentSessionId("web-1"), "agent-same");
      assert.deepEqual(retired, []);
    });

    it("restores thinking through the replacement execution's thought_level option", async () => {
      store.createTask("web-1", tmpDir, "auto", "agent-old");
      store.updateTaskConfig("web-1", "reasoning_effort", "high");
      sm.liveTasks.add("web-1");
      const configCalls: Array<{ id: string; value: string }> = [];
      const configOptions: ConfigOption[] = [
        {
          type: "select",
          id: "thought_level",
          category: "thought_level",
          name: "Thinking",
          currentValue: "medium",
          options: [{ value: "high", name: "High" }],
        },
      ];
      const bridge = {
        async newSession() {
          return { sessionId: "agent-new", configOptions };
        },
        async setConfigOption(_taskId: string, id: string, value: string) {
          configCalls.push({ id, value });
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      await sm.clearTask(bridge, "web-1");

      assert.deepEqual(configCalls, [{ id: "thought_level", value: "high" }]);
    });

    it("clears runtime buffers and command snapshots for the replacement execution", async () => {
      store.createTask("web-1", tmpDir, "auto", "agent-old");
      sm.liveTasks.add("web-1");
      sm.assistantBuffers.set("web-1", "partial answer");
      sm.thinkingBuffers.set("web-1", "partial thought");
      sm.activePrompts.add("web-1");
      sm.updateAgentCommands("web-1", [
        { name: "old-command", description: "old" },
      ]);

      const bridge = {
        async newSession() {
          return { sessionId: "agent-new", configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      await sm.clearTask(bridge, "web-1");

      assert.equal(sm.assistantBuffers.has("web-1"), false);
      assert.equal(sm.thinkingBuffers.has("web-1"), false);
      assert.equal(sm.activePrompts.has("web-1"), false);
      assert.deepEqual(sm.getAgentCommands("web-1").commands, []);
      assert.equal(sm.state.getState("web-1").runtime.busy, null);
    });

    it("keeps the runtime state seq monotonic across rotation", async () => {
      // A task with history has applied patches (seq > 0). The client
      // validates incremental state_patch events and snapshots against its
      // own lastStateSeq; if rotation restarted the server seq at 0, every
      // post-clear snapshot would look "superseded" and be dropped, leaving
      // the client permanently desynced (stuck busy).
      store.createTask("web-1", tmpDir, "auto", "agent-old");
      sm.liveTasks.add("web-1");
      sm.state.patch("web-1", {
        runtime: {
          busy: { kind: "agent", since: "t0", promptId: "prompt-1" },
          pendingPermissions: [
            {
              requestId: "r1",
              toolName: "shell",
              title: "Run ls",
              options: [{ optionId: "allow", label: "Allow" }],
            },
          ],
        },
      });
      const seqBefore = sm.state.getState("web-1").seq;
      assert.ok(seqBefore > 0);

      const bridge = {
        async newSession() {
          return { sessionId: "agent-new", configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      await sm.clearTask(bridge, "web-1");

      const after = sm.state.getState("web-1");
      assert.equal(after.runtime.busy, null);
      assert.equal(after.runtime.pendingPermissions.length, 0);
      assert.ok(
        after.seq > seqBefore,
        `seq must continue from ${seqBefore}, not restart at 0 (got ${after.seq})`,
      );
    });

    it("rotates MCP capability only after the replacement execution succeeds", async () => {
      store.createTask("web-1", tmpDir, "auto", "agent-old");
      sm.liveTasks.add("web-1");
      const capabilities = new CapabilityStore();
      const oldToken = capabilities.mint("web-1");
      let newToken: string | undefined;
      const manager = new TaskManager(
        store,
        tmpDir,
        tmpDir,
        capabilities,
        "http://127.0.0.1:6800",
      );

      const bridge = {
        async newSession(_cwd: string, options?: { mcpServers?: any[] }) {
          const authorization = options?.mcpServers?.[0]?.headers[0]?.value;
          newToken = authorization?.replace(/^Bearer\s+/, "");
          return { sessionId: "agent-new", configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      await manager.clearTask(bridge, "web-1");

      assert.equal(capabilities.resolve(oldToken), null);
      assert.equal(newToken && capabilities.resolve(newToken), "web-1");
    });

    it("does not reset the state ledger when replacement creation fails", async () => {
      store.createTask("web-1", tmpDir, "auto", "agent-old");
      sm.liveTasks.add("web-1");
      sm.state.patch("web-1", {
        runtime: { busy: { kind: "agent", since: "t0", promptId: "prompt-1" } },
      });
      const seqBefore = sm.state.getState("web-1").seq;

      const bridge = {
        async newSession() {
          throw new Error("replacement failed");
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      await assert.rejects(
        () => sm.clearTask(bridge, "web-1"),
        /replacement failed/,
      );
      // The rotation barrier patch (busy=true) bumps seq even on failure; the
      // ledger itself must survive an aborted rotation so clients can still
      // reconcile after the error.
      assert.ok(sm.state.getState("web-1").seq > seqBefore);
    });

    it("keeps the current MCP capability when replacement creation fails", async () => {
      store.createTask("web-1", tmpDir, "auto", "agent-old");
      sm.liveTasks.add("web-1");
      const capabilities = new CapabilityStore();
      const oldToken = capabilities.mint("web-1");
      const manager = new TaskManager(
        store,
        tmpDir,
        tmpDir,
        capabilities,
        "http://127.0.0.1:6800",
      );

      const bridge = {
        async newSession() {
          throw new Error("replacement failed");
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      await assert.rejects(
        () => manager.clearTask(bridge, "web-1"),
        /replacement failed/,
      );
      assert.equal(capabilities.resolve(oldToken), "web-1");
      assert.equal(store.getAgentSessionId("web-1"), "agent-old");
    });
  });

  describe("Root execution", () => {
    it("binds one ACP execution to the existing Root task", async () => {
      store.ensureRootTask(tmpDir);
      let newTaskCalls = 0;
      const bridge = {
        async newSession() {
          newTaskCalls++;
          return { sessionId: "agent-root", configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      await sm.ensureRootTask(bridge);
      await sm.ensureRootTask(bridge);

      assert.equal(newTaskCalls, 1);
      assert.equal(store.getAgentSessionId("root"), "agent-root");
      assert.deepEqual(
        store.listTasks().map((task) => task.id),
        ["root"],
      );
    });
  });

  describe("task-tree mutation locking", () => {
    it("does not hold Root lock while ACP setup is pending", async () => {
      store.ensureRootTask(tmpDir);
      store.createTask("a", tmpDir, "auto", "agent-a", "root");

      let releaseRootCreate!: () => void;
      const rootCreateReleased = new Promise<void>((resolve) => {
        releaseRootCreate = resolve;
      });
      let rootCreateStarted!: () => void;
      const rootCreateStartedPromise = new Promise<void>((resolve) => {
        rootCreateStarted = resolve;
      });
      let newSessionCalls = 0;
      const bridge = {
        async newSession() {
          const call = ++newSessionCalls;
          if (call === 1) {
            rootCreateStarted();
            await rootCreateReleased;
          }
          return { sessionId: `agent-new-${call}`, configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      const rootCreate = sm.createTask(bridge, tmpDir, undefined, "auto", {
        parentId: "root",
      });
      await rootCreateStartedPromise;
      const branchTask = await sm.createTask(
        bridge,
        tmpDir,
        undefined,
        "auto",
        {
          parentId: "a",
        },
      );
      assert.equal(store.getTask(branchTask.taskId)?.parent_id, "a");
      releaseRootCreate();
      const rootTask = await rootCreate;
      assert.equal(store.getTask(rootTask.taskId)?.parent_id, "root");
    });

    it("does not block sibling task creation on another branch", async () => {
      store.ensureRootTask(tmpDir);
      store.createTask("a", tmpDir, "auto", "agent-a", "root");
      store.createTask("b", tmpDir, "auto", "agent-b", "root");

      let releaseSessions!: () => void;
      const sessionsReleased = new Promise<void>((resolve) => {
        releaseSessions = resolve;
      });
      let sessionsStarted!: () => void;
      const bothSessionsStarted = new Promise<void>((resolve) => {
        sessionsStarted = resolve;
      });
      let newSessionCalls = 0;
      const bridge = {
        async newSession() {
          const call = ++newSessionCalls;
          if (call === 2) sessionsStarted();
          await sessionsReleased;
          return {
            sessionId: `agent-new-${call}`,
            configOptions: [],
          };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      const first = sm.createTask(bridge, tmpDir, undefined, "auto", {
        parentId: "a",
      });
      const second = sm.createTask(bridge, tmpDir, undefined, "auto", {
        parentId: "b",
      });

      await bothSessionsStarted;
      assert.equal(newSessionCalls, 2);
      releaseSessions();
      const [firstTask, secondTask] = await Promise.all([first, second]);
      assert.equal(store.getTask(firstTask.taskId)?.parent_id, "a");
      assert.equal(store.getTask(secondTask.taskId)?.parent_id, "b");
    });

    it("rejects Root reset when a just-created descendant is still initializing", async () => {
      store.ensureRootTask(tmpDir);
      store.bindAgentSession("root", "agent-root");
      store.createTask("a", tmpDir, "auto", "agent-a", "root");
      store.updateTaskConfig("a", "model", "model-old");
      sm.liveTasks.add("root");

      let releaseInheritance!: () => void;
      const inheritanceReleased = new Promise<void>((resolve) => {
        releaseInheritance = resolve;
      });
      let inheritanceStarted!: () => void;
      const inheritanceStartedPromise = new Promise<void>((resolve) => {
        inheritanceStarted = resolve;
      });
      let newSessionCalls = 0;
      const bridge = {
        async newSession() {
          newSessionCalls++;
          return {
            sessionId: `agent-child-${newSessionCalls}`,
            configOptions: [],
          };
        },
        async setConfigOption() {
          inheritanceStarted();
          await inheritanceReleased;
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      const create = sm.createTask(bridge, tmpDir, "a", "auto", {
        parentId: "a",
      });
      await inheritanceStartedPromise;
      const reset = sm.resetRootTask(bridge);
      await assert.rejects(reset, { name: TaskBusyError.name });
      assert.ok(store.getTaskIncludingDeleted("a"));
      releaseInheritance();
      const created = await create;
      assert.equal(store.getTask(created.taskId)?.parent_id, "a");
    });

    it("creates a task after a concurrent Root reset, never during it", async () => {
      store.ensureRootTask(tmpDir);
      store.bindAgentSession("root", "agent-root");
      sm.liveTasks.add("root");

      let releaseRotation!: () => void;
      const rotationReleased = new Promise<void>((resolve) => {
        releaseRotation = resolve;
      });
      let resetStarted!: () => void;
      const resetStartedPromise = new Promise<void>((resolve) => {
        resetStarted = resolve;
      });
      let newSessionCalls = 0;
      const bridge = {
        async newSession() {
          newSessionCalls++;
          if (newSessionCalls === 1) {
            resetStarted();
            await rotationReleased;
          }
          return {
            sessionId: `agent-${newSessionCalls}`,
            configOptions: [],
          };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      const reset = sm.resetRootTask(bridge);
      await resetStartedPromise;
      const create = sm.createTask(bridge, tmpDir, undefined, "auto", {
        parentId: "root",
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        newSessionCalls,
        1,
        "creation must wait behind the exclusive Root reset lock",
      );

      releaseRotation();
      await reset;
      const created = await create;
      assert.equal(store.getTask(created.taskId)?.parent_id, "root");
      assert.ok(store.getTask(created.taskId));
    });
  });

  describe("buffer management", () => {
    it("appends and flushes assistant buffer", () => {
      store.createTask("s1", "/x");

      sm.appendAssistant("s1", "Hello ");
      sm.appendAssistant("s1", "world");
      assert.equal(sm.assistantBuffers.get("s1"), "Hello world");

      sm.flushBuffers("s1");

      assert.ok(!sm.assistantBuffers.has("s1"));
      const events = store.getEvents("s1");
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "assistant_message");
      assert.deepEqual(JSON.parse(events[0].data), { text: "Hello world" });
    });

    it("appends and flushes thinking buffer", () => {
      store.createTask("s1", "/x");

      sm.appendThinking("s1", "Let me think...");
      sm.flushBuffers("s1");

      const events = store.getEvents("s1");
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "thinking");
    });

    it("flush is a no-op when buffers are empty", () => {
      store.createTask("s1", "/x");
      sm.flushBuffers("s1"); // should not throw
      assert.deepEqual(store.getEvents("s1"), []);
    });

    it("discards late buffers for a deleted task", () => {
      store.createTask("s1", "/x");
      store.deleteTask("s1");
      sm.assistantBuffers.set("s1", "late answer");
      sm.thinkingBuffers.set("s1", "late thought");

      assert.doesNotThrow(() => {
        sm.flushBuffers("s1");
      });
      assert.equal(sm.assistantBuffers.has("s1"), false);
      assert.equal(sm.thinkingBuffers.has("s1"), false);
    });

    it("flushAssistantBuffer saves only the assistant buffer", () => {
      store.createTask("s1", "/x");
      sm.appendAssistant("s1", "Hello");
      sm.appendThinking("s1", "hmm");

      sm.flushAssistantBuffer("s1");

      // Assistant saved, thinking still buffered
      assert.ok(!sm.assistantBuffers.has("s1"));
      assert.equal(sm.thinkingBuffers.get("s1"), "hmm");
      const events = store.getEvents("s1");
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "assistant_message");
    });

    it("flushThinkingBuffer saves only the thinking buffer", () => {
      store.createTask("s1", "/x");
      sm.appendAssistant("s1", "Hello");
      sm.appendThinking("s1", "hmm");

      sm.flushThinkingBuffer("s1");

      // Thinking saved, assistant still buffered
      assert.ok(!sm.thinkingBuffers.has("s1"));
      assert.equal(sm.assistantBuffers.get("s1"), "Hello");
      const events = store.getEvents("s1");
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "thinking");
    });
  });

  describe("getTaskCwd", () => {
    it("returns task cwd when exists", () => {
      store.createTask("s1", "/my/project");
      assert.equal(sm.getTaskCwd("s1"), "/my/project");
    });

    it("returns default cwd when task not found", () => {
      assert.equal(sm.getTaskCwd("nonexistent"), tmpDir);
    });
  });

  describe("getBusyKind", () => {
    it("reports agent busy tasks", () => {
      sm.activePrompts.add("s1");
      assert.equal(sm.getBusyKind("s1"), "agent");
    });

    it("preserves agent busy while local bash also runs", () => {
      sm.activePrompts.add("s1");
      sm.runningBashProcs.set("s1", {} as any);
      assert.equal(sm.getBusyKind("s1"), "agent");
    });

    it("clears runtime busy when a pending submission is released", () => {
      const submissionId = sm.reservePromptSubmission("s1");
      assert.ok(submissionId);
      sm.syncBusy("s1");
      assert.equal(sm.state.getState("s1").runtime.busy?.kind, "agent");

      sm.releasePromptSubmission("s1", submissionId);

      assert.equal(sm.getBusyKind("s1"), null);
      assert.equal(sm.state.getState("s1").runtime.busy, null);
    });

    it("keeps cancellation tombstones scoped to their submission", () => {
      const first = sm.reservePromptSubmission("s1");
      assert.ok(first);
      assert.equal(sm.cancelPendingPromptSubmission("s1"), true);
      sm.pendingPromptSubmissions.clear();

      const second = sm.reservePromptSubmission("s1");
      assert.ok(second);
      assert.notEqual(second, first);
      assert.equal(sm.isPromptSubmissionCancelled(second), false);
      assert.equal(sm.isPromptSubmissionCancelled(first), true);

      sm.releasePromptSubmission("s1", second);
      assert.equal(sm.isPromptSubmissionCancelled(first), true);
      sm.releasePromptSubmission("s1", first);
      assert.equal(sm.isPromptSubmissionCancelled(first), false);
    });
  });

  describe("autoRetryIfNeeded", () => {
    it("returns false when task has no interrupted turn", () => {
      store.createTask("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hello" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "response" },
        { from_ref: "agent" },
      );
      store.saveEvent(
        "s1",
        "prompt_done",
        { stopReason: "end_turn" },
        { from_ref: "agent" },
      );

      const promptCalls: string[] = [];
      const bridge = {
        async prompt(taskId: string, text: string) {
          promptCalls.push(text);
        },
      };

      assert.equal(sm.autoRetryIfNeeded(bridge, "s1"), false);
      assert.equal(promptCalls.length, 0);
      assert.ok(!sm.activePrompts.has("s1"));
    });

    it("auto-retries when turn was interrupted", () => {
      store.createTask("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hello" },
        { from_ref: "user" },
      );
      store.saveEvent(
        "s1",
        "assistant_message",
        { text: "partial..." },
        { from_ref: "agent" },
      );

      const promptCalls: Array<{ taskId: string; text: string }> = [];
      const bridge = {
        async prompt(taskId: string, text: string) {
          promptCalls.push({ taskId, text });
        },
      };

      assert.equal(sm.autoRetryIfNeeded(bridge, "s1"), true);
      assert.ok(sm.activePrompts.has("s1"));
      assert.equal(promptCalls.length, 1);
      assert.equal(promptCalls[0].taskId, "s1");
      assert.ok(promptCalls[0].text.includes("interrupted"));
    });

    it("skips if task is already actively prompting", () => {
      store.createTask("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hello" },
        { from_ref: "user" },
      );
      // No prompt_done — interrupted turn
      sm.activePrompts.add("s1");

      const promptCalls: string[] = [];
      const bridge = {
        async prompt(_sid: string, text: string) {
          promptCalls.push(text);
        },
      };

      assert.equal(sm.autoRetryIfNeeded(bridge, "s1"), false);
      assert.equal(promptCalls.length, 0);
    });

    it("cleans up activePrompts on prompt failure", async () => {
      store.createTask("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hello" },
        { from_ref: "user" },
      );

      let rejectPrompt: (err: Error) => void;
      const bridge = {
        prompt(_sid: string, _text: string) {
          return new Promise<void>((_resolve, reject) => {
            rejectPrompt = reject;
          });
        },
      };

      assert.equal(sm.autoRetryIfNeeded(bridge, "s1"), true);
      assert.ok(sm.activePrompts.has("s1"));

      // Simulate prompt failure
      rejectPrompt!(new Error("agent died"));
      // Allow microtask queue to process the .catch()
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(!sm.activePrompts.has("s1"));
    });
  });

  describe("ensureResumed", () => {
    it("is a no-op when task is already live", async () => {
      store.createTask("s1", "/x");
      sm.liveTasks.add("s1");

      let loadCalled = false;
      const bridge = {
        async newSession() {
          return { sessionId: "", configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          loadCalled = true;
          return { taskId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(loadCalled, false);
    });

    it("calls loadSession for non-live tasks", async () => {
      store.createTask("s1", "/x");
      sm.cachedConfigOptions = [
        {
          type: "select",
          id: "model",
          name: "Model",
          currentValue: "m",
          options: [],
        },
      ];

      let loadCalled = false;
      const bridge = {
        async newSession() {
          return { sessionId: "", configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          loadCalled = true;
          return { taskId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(loadCalled, true);
      assert.ok(sm.liveTasks.has("s1"));
    });

    it("deduplicates concurrent resume calls", async () => {
      store.createTask("s1", "/x");
      sm.cachedConfigOptions = [];

      let loadCount = 0;
      let resolveLoad: (() => void) | undefined;
      const bridge = {
        async newSession() {
          return { sessionId: "", configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        loadSession() {
          loadCount++;
          return new Promise<{ taskId: string; configOptions: never[] }>(
            (resolve) => {
              resolveLoad = () => {
                resolve({ taskId: "s1", configOptions: [] });
              };
            },
          );
        },
      };

      // Fire two concurrent calls
      const p1 = sm.ensureResumed(bridge, "s1");
      const p2 = sm.ensureResumed(bridge, "s1");

      // Only one loadSession call should have been made
      assert.equal(loadCount, 1);

      resolveLoad!();
      await Promise.all([p1, p2]);
      assert.ok(sm.liveTasks.has("s1"));
    });

    it("propagates errors to all waiters", async () => {
      store.createTask("s1", "/x");

      const bridge = {
        async newSession() {
          return { sessionId: "", configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("ACP timeout");
        },
      };

      const p1 = sm.ensureResumed(bridge, "s1");
      const p2 = sm.ensureResumed(bridge, "s1");

      await assert.rejects(p1, { message: "ACP timeout" });
      await assert.rejects(p2, { message: "ACP timeout" });
      assert.ok(!sm.liveTasks.has("s1"));
    });
  });

  describe("resume-time cache warming", () => {
    // ACP's loadSession does not return configOptions (only newSession /
    // setConfigOption do). When the global cache is empty (e.g. after
    // bridge.restart), piggyback on the user's own resume: call
    // setConfigOption with the task's own stored value (idempotent) to
    // pull the full schema from the agent.

    it("warms cachedConfigOptions on first resume when cache is empty and task has stored mode", async () => {
      store.createTask("s1", "/x");
      store.updateTaskConfig("s1", "mode", "#plan");
      sm.cachedConfigOptions = [];

      const setCalls: Array<{ id: string; value: string }> = [];
      const bridge = {
        async newSession() {
          return { sessionId: "", configOptions: [] };
        },
        async setConfigOption(_sid: string, id: string, value: string) {
          setCalls.push({ id, value });
          return [
            {
              type: "select" as const,
              id: "mode",
              name: "Mode",
              currentValue: "#plan",
              options: [
                { value: "agent", name: "agent" },
                { value: "#plan", name: "plan" },
                { value: "#autopilot", name: "autopilot" },
              ],
            },
            {
              type: "select" as const,
              id: "model",
              name: "Model",
              currentValue: "gpt-5.4",
              options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
            },
          ];
        },
        async loadSession() {
          return { taskId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(setCalls.length, 1);
      assert.equal(setCalls[0].id, "mode");
      assert.equal(setCalls[0].value, "#plan");
      assert.equal(sm.cachedConfigOptions.length, 2);
      assert.ok(sm.liveTasks.has("s1"));
    });

    it("skips warming when cache is already populated", async () => {
      store.createTask("s1", "/x");
      store.updateTaskConfig("s1", "mode", "#plan");
      sm.cachedConfigOptions = [
        {
          type: "select",
          id: "mode",
          name: "Mode",
          currentValue: "agent",
          options: [{ value: "agent", name: "agent" }],
        },
      ];

      let setCalled = false;
      const bridge = {
        async newSession() {
          return { sessionId: "", configOptions: [] };
        },
        async setConfigOption() {
          setCalled = true;
          return [];
        },
        async loadSession() {
          return { taskId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(setCalled, false);
    });

    it("skips warming when task has no stored config at all", async () => {
      store.createTask("s1", "/x");
      sm.cachedConfigOptions = [];

      let setCalled = false;
      const bridge = {
        async newSession() {
          return { sessionId: "", configOptions: [] };
        },
        async setConfigOption() {
          setCalled = true;
          return [];
        },
        async loadSession() {
          return { taskId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(setCalled, false);
      assert.equal(sm.cachedConfigOptions.length, 0);
      assert.ok(sm.liveTasks.has("s1"));
    });

    it("prefers mode > reasoning_effort > model when picking the warming key", async () => {
      store.createTask("s1", "/x");
      store.updateTaskConfig("s1", "reasoning_effort", "medium");
      store.updateTaskConfig("s1", "model", "gpt-5.4");
      sm.cachedConfigOptions = [];

      const setCalls: Array<{ id: string; value: string }> = [];
      const bridge = {
        async newSession() {
          return { sessionId: "", configOptions: [] };
        },
        async setConfigOption(_sid: string, id: string, value: string) {
          setCalls.push({ id, value });
          return [
            {
              type: "select" as const,
              id,
              name: "Thinking",
              currentValue: value,
              options: [{ value, name: value }],
            },
          ];
        },
        async loadSession() {
          return { taskId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.deepEqual(setCalls, [{ id: "reasoning_effort", value: "medium" }]);
    });

    it("falls back to thought_level when reasoning_effort is unsupported", async () => {
      store.createTask("s1", "/x");
      store.updateTaskConfig("s1", "reasoning_effort", "medium");
      sm.cachedConfigOptions = [];

      const setCalls: Array<{ id: string; value: string }> = [];
      const bridge = {
        async newSession() {
          return { sessionId: "", configOptions: [] };
        },
        async setConfigOption(_sid: string, id: string, value: string) {
          setCalls.push({ id, value });
          if (id === "reasoning_effort") {
            throw new Error("Unknown config option: reasoning_effort");
          }
          return [
            {
              type: "select" as const,
              id: "thought_level",
              category: "thought_level" as const,
              name: "Thinking",
              currentValue: value,
              options: [{ value: "medium", name: "Medium" }],
            },
            {
              type: "select" as const,
              id: "model",
              name: "Model",
              currentValue: "gpt-5.4",
              options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
            },
          ];
        },
        async loadSession() {
          return { taskId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.deepEqual(setCalls, [
        { id: "reasoning_effort", value: "medium" },
        { id: "thought_level", value: "medium" },
      ]);
      assert.equal(sm.cachedConfigOptions.length, 2);
      assert.ok(sm.liveTasks.has("s1"));
    });

    it("resume still succeeds when setConfigOption throws", async () => {
      store.createTask("s1", "/x");
      store.updateTaskConfig("s1", "mode", "#plan");
      sm.cachedConfigOptions = [];

      const bridge = {
        async newSession() {
          return { sessionId: "", configOptions: [] };
        },
        async setConfigOption() {
          throw new Error("agent boom");
        },
        async loadSession() {
          return { taskId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(sm.cachedConfigOptions.length, 0);
      assert.ok(
        sm.liveTasks.has("s1"),
        "resume must succeed even if warming fails",
      );
    });

    it("does not overwrite task DB row with agent defaults in the warm response", async () => {
      // Probe responses carry agent in-memory defaults for unrelated keys
      // (e.g. setConfigOption(mode, #plan) response's model.currentValue is
      // NOT the user's preference). Warming must never write these back.
      store.createTask("s1", "/x");
      store.updateTaskConfig("s1", "mode", "#plan");
      store.updateTaskConfig("s1", "model", "gpt-5.4");
      sm.cachedConfigOptions = [];

      const bridge = {
        async newSession() {
          return { sessionId: "", configOptions: [] };
        },
        async setConfigOption() {
          return [
            {
              type: "select" as const,
              id: "mode",
              name: "Mode",
              currentValue: "#plan",
              options: [{ value: "#plan", name: "plan" }],
            },
            {
              type: "select" as const,
              id: "model",
              currentValue: "gpt-5.2",
              name: "Model",
              options: [
                { value: "gpt-5.2", name: "5.2" },
                { value: "gpt-5.4", name: "5.4" },
              ],
            },
          ];
        },
        async loadSession() {
          return { taskId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      const row = store.getTask("s1")!;
      assert.equal(row.model, "gpt-5.4", "DB model must stay as user's choice");
    });
  });

  describe("attachment label cache", () => {
    beforeEach(() => {
      store.createTask("s1", "/x");
    });

    it("getLabelMap lazy-builds from store on first call", () => {
      store.insertAttachment({
        id: "abc12345-1111",
        taskId: "s1",
        kind: "file",
        name: "report.pdf",
        mime: "application/pdf",
        size: 1,
        realpath: "/r/abc.pdf",
      });
      const m = sm.getLabelMap("s1");
      assert.equal(m.get("/r/abc.pdf"), "report.pdf [#abc1]");
    });

    it("returns cached map on subsequent calls (same Map instance)", () => {
      store.insertAttachment({
        id: "abc12345-1111",
        taskId: "s1",
        kind: "file",
        name: "x.pdf",
        mime: "application/pdf",
        size: 1,
        realpath: "/r/x.pdf",
      });
      const first = sm.getLabelMap("s1");
      const second = sm.getLabelMap("s1");
      assert.equal(first, second, "same Map reference (cached)");
    });

    it("invalidateLabelCache forces rebuild on next access", () => {
      store.insertAttachment({
        id: "1111aaaa",
        taskId: "s1",
        kind: "file",
        name: "a.txt",
        mime: "text/plain",
        size: 1,
        realpath: "/r/a.txt",
      });
      const before = sm.getLabelMap("s1");
      assert.equal(before.size, 2); // realpath + basename

      store.insertAttachment({
        id: "2222bbbb",
        taskId: "s1",
        kind: "file",
        name: "b.txt",
        mime: "text/plain",
        size: 1,
        realpath: "/r/b.txt",
      });
      // Without invalidation, stale cache is returned.
      assert.equal(sm.getLabelMap("s1"), before);

      sm.invalidateLabelCache("s1");
      const after = sm.getLabelMap("s1");
      assert.notEqual(after, before, "new Map after invalidation");
      assert.equal(after.get("/r/b.txt"), "b.txt [#2222]");
    });

    it("isolates per-task caches", () => {
      store.createTask("s2", "/y");
      store.insertAttachment({
        id: "aaaa1111",
        taskId: "s1",
        kind: "file",
        name: "in1.txt",
        mime: "text/plain",
        size: 1,
        realpath: "/r/1.txt",
      });
      store.insertAttachment({
        id: "bbbb2222",
        taskId: "s2",
        kind: "file",
        name: "in2.txt",
        mime: "text/plain",
        size: 1,
        realpath: "/r/2.txt",
      });
      const m1 = sm.getLabelMap("s1");
      const m2 = sm.getLabelMap("s2");
      assert.ok(m1.has("/r/1.txt"));
      assert.ok(!m1.has("/r/2.txt"));
      assert.ok(m2.has("/r/2.txt"));
      assert.ok(!m2.has("/r/1.txt"));
    });

    it("deleteTask invalidates label cache", async () => {
      store.insertAttachment({
        id: "abc12345",
        taskId: "s1",
        kind: "file",
        name: "x.txt",
        mime: "text/plain",
        size: 1,
        realpath: "/r/x.txt",
      });
      sm.getLabelMap("s1"); // populate cache
      await sm.deleteTask(undefined, "s1");
      // Re-create task and request map — must NOT see stale entry.
      store.createTask("s1", "/x");
      const m = sm.getLabelMap("s1");
      assert.equal(m.size, 0);
    });

    it("returns empty map for task with no attachments", () => {
      assert.equal(sm.getLabelMap("s1").size, 0);
    });
  });
});
