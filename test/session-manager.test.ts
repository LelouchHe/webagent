import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { SessionManager } from "../src/session-manager.ts";
import { CapabilityStore } from "../src/mcp/capability.ts";
import { createMcpEndpoint } from "../src/mcp/server.ts";
import type { ConfigOption } from "../src/types.ts";

async function startMcpTestServer(
  capabilities: CapabilityStore,
  isActive: (sessionId: string) => boolean,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const endpoint = createMcpEndpoint({
    capabilities,
    isSessionActive: isActive,
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
        clientInfo: { name: "session-manager-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(response.status, 200);
}

describe("SessionManager", () => {
  let store: Store;
  let sm: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-test-"));
    store = new Store(tmpDir, "test-agent");
    sm = new SessionManager(store, tmpDir, tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("hydrate", () => {
    it("populates sessionHasTitle from DB", () => {
      store.createSession("s1", "/x");
      store.updateSessionTitle("s1", "My Title");
      store.createSession("s2", "/y"); // no title

      sm.hydrate();

      assert.ok(sm.sessionHasTitle.has("s1"));
      assert.ok(!sm.sessionHasTitle.has("s2"));
    });
  });

  describe("MCP capability lifecycle", () => {
    it("allows MCP auto-connect while a new ACP session is being created", async () => {
      const capabilities = new CapabilityStore();
      const mcpSessionManagerRef: { current?: SessionManager } = {};
      const mcpServer = await startMcpTestServer(capabilities, (sessionId) =>
        mcpSessionManagerRef.current!.isMcpSessionActive(sessionId),
      );
      const mcpSessionManager = new SessionManager(
        store,
        tmpDir,
        tmpDir,
        capabilities,
        mcpServer.baseUrl,
      );
      mcpSessionManagerRef.current = mcpSessionManager;

      const bridge = {
        async newSession(_cwd: string, options?: { mcpServers?: any[] }) {
          const entry = options?.mcpServers?.[0] as {
            headers: Array<{ name: string; value: string }>;
          };
          const authorization = entry.headers.find(
            (header) => header.name === "Authorization",
          )?.value;
          assert.ok(authorization);
          const sessionId = capabilities.resolve(
            authorization.replace(/^Bearer\s+/, ""),
          );
          assert.ok(sessionId);
          assert.equal(mcpSessionManager.liveSessions.has(sessionId), false);
          assert.equal(mcpSessionManager.isMcpSessionActive(sessionId), true);
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
        const created = await mcpSessionManager.createSession(bridge);
        assert.equal(
          mcpSessionManager.liveSessions.has(created.sessionId),
          true,
        );
        assert.equal(
          mcpSessionManager.isMcpSessionActive(created.sessionId),
          true,
        );
      } finally {
        await mcpServer.close();
      }
    });

    it("allows MCP auto-connect while an ACP session is being restored", async () => {
      const sessionId = "restore-mcp";
      store.createSession(sessionId, tmpDir);
      const capabilities = new CapabilityStore();
      const mcpSessionManagerRef: { current?: SessionManager } = {};
      const mcpServer = await startMcpTestServer(
        capabilities,
        (activeSessionId) =>
          mcpSessionManagerRef.current!.isMcpSessionActive(activeSessionId),
      );
      const mcpSessionManager = new SessionManager(
        store,
        tmpDir,
        tmpDir,
        capabilities,
        mcpServer.baseUrl,
      );
      mcpSessionManagerRef.current = mcpSessionManager;

      const bridge = {
        async newSession() {
          throw new Error("newSession should not be called");
        },
        async setConfigOption() {
          return [];
        },
        async loadSession(
          _webSessionId: string,
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
          assert.equal(mcpSessionManager.liveSessions.has(sessionId), false);
          assert.equal(mcpSessionManager.isMcpSessionActive(sessionId), true);
          await assertMcpInitialize(mcpServer.baseUrl, authorization);
          return { sessionId, configOptions: [] };
        },
      };

      try {
        await mcpSessionManager.resumeSession(bridge, sessionId);
        assert.equal(mcpSessionManager.liveSessions.has(sessionId), true);
      } finally {
        await mcpServer.close();
      }
    });

    it("revokes a capability when ACP session creation fails", async () => {
      const capabilities = new CapabilityStore();
      let mintedSessionId: string | null = null;
      let mintedToken: string | null = null;
      const mcpSessionManager = new SessionManager(
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
          mintedSessionId = capabilities.resolve(mintedToken);
          throw new Error("ACP startup failed");
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      await assert.rejects(() => mcpSessionManager.createSession(bridge), {
        message: "ACP startup failed",
      });
      assert.ok(mintedSessionId);
      assert.ok(mintedToken);
      assert.equal(capabilities.resolve(mintedToken), null);
      assert.equal(
        mcpSessionManager.isMcpSessionActive(mintedSessionId),
        false,
      );
    });
  });

  describe("deleteSession", () => {
    it("cleans up all state", () => {
      store.createSession("s1", "/x");
      sm.liveSessions.add("s1");
      sm.sessionHasTitle.add("s1");
      sm.assistantBuffers.set("s1", "partial");
      sm.thinkingBuffers.set("s1", "hmm");
      sm.updateAgentCommands("s1", [
        { name: "context", description: "Show context usage" },
      ]);

      sm.deleteSession(undefined, "s1");

      assert.ok(!sm.liveSessions.has("s1"));
      assert.ok(!sm.sessionHasTitle.has("s1"));
      assert.ok(!sm.assistantBuffers.has("s1"));
      assert.ok(!sm.thinkingBuffers.has("s1"));
      const commands = sm.getAgentCommands("s1");
      assert.ok(commands.epoch);
      assert.deepEqual(commands, {
        epoch: commands.epoch,
        revision: 0,
        commands: [],
      });
      assert.equal(store.getSession("s1"), undefined);
    });

    it("cascades to descendants, cleaning their runtime state and retiring executions", () => {
      store.createSession("parent", "/a", "auto", "agent-parent");
      store.createSession("child", "/b", "auto", "agent-child", "parent");
      sm.liveSessions.add("parent");
      sm.liveSessions.add("child");
      sm.assistantBuffers.set("child", "partial answer");
      sm.pendingPromptSubmissions.set("child", 7);
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

      const result = sm.deleteSession(bridge, "parent");

      assert.deepEqual(result.affected.map((entry) => entry.id).sort(), [
        "child",
        "parent",
      ]);
      assert.deepEqual(retired.sort(), ["agent-child", "agent-parent"]);
      assert.ok(!sm.liveSessions.has("parent"));
      assert.ok(!sm.liveSessions.has("child"));
      assert.ok(!sm.assistantBuffers.has("child"));
      assert.ok(!sm.pendingPromptSubmissions.has("child"));
    });

    it("skips retirement when no bridge is available", () => {
      store.createSession("s1", "/x", "auto", "agent-s1");

      const result = sm.deleteSession(undefined, "s1");

      assert.equal(result.mode, "hard");
      assert.equal(store.getSession("s1"), undefined);
    });
  });

  describe("agent command snapshots", () => {
    it("replaces commands and increments the per-session revision", () => {
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
        { sessionId: "s1", epoch, revision: 2, commands: [] },
        { sessionId: "s2", epoch, revision: 2, commands: [] },
      ]);
      assert.deepEqual(sm.getAgentCommands("s1"), {
        epoch,
        revision: 2,
        commands: [],
      });
    });
  });

  describe("createSession", () => {
    it("inherits config from the source session", async () => {
      store.createSession("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );
      store.updateSessionConfig("s1", "model", "claude-sonnet-4.6");
      store.updateSessionConfig("s1", "mode", "plan-mode");
      store.updateSessionConfig("s1", "reasoning_effort", "high");
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
        sessionId: string;
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
        async setConfigOption(
          sessionId: string,
          configId: string,
          value: string,
        ) {
          configCalls.push({ sessionId, configId, value });
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      const created = await sm.createSession(bridge, undefined, "s1");

      // mode is intentionally NOT inherited — new sessions always start in default (agent) mode
      assert.deepEqual(configCalls, [
        {
          sessionId: created.sessionId,
          configId: "model",
          value: "claude-sonnet-4.6",
        },
        {
          sessionId: created.sessionId,
          configId: "reasoning_effort",
          value: "high",
        },
      ]);
      assert.match(
        created.sessionId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert.notEqual(created.sessionId, "s2");
      assert.equal(store.getAgentSessionId(created.sessionId), "s2");
      assert.ok(sm.liveSessions.has(created.sessionId));
      assert.ok(!sm.liveSessions.has("s2"));
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
      assert.equal(
        store.getSession(created.sessionId)!.model,
        "claude-sonnet-4.6",
      );
      assert.equal(store.getSession(created.sessionId)!.mode, "agent");
      assert.equal(
        store.getSession(created.sessionId)!.reasoning_effort,
        "high",
      );
    });

    it("inherits thinking through an agent's thought_level option", async () => {
      store.createSession("s1", "/x");
      store.saveEvent(
        "s1",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );
      store.updateSessionConfig("s1", "reasoning_effort", "high");
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
          _sessionId: string,
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

      const created = await sm.createSession(bridge, undefined, "s1");

      assert.deepEqual(configCalls, [
        { configId: "thought_level", value: "high" },
      ]);
      assert.equal(created.configOptions[0]?.currentValue, "high");
      assert.equal(
        store.getSession(created.sessionId)!.reasoning_effort,
        "high",
      );
    });

    it("does not set config when no source session is provided", async () => {
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

      const created = await sm.createSession(bridge);

      assert.equal(configCalled, false);
      assert.notEqual(created.sessionId, "s2");
      assert.match(
        created.sessionId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert.deepEqual(created.configOptions, []);
      assert.equal(store.getSession(created.sessionId)!.model, null);
      assert.equal(store.getAgentSessionId(created.sessionId), "s2");
    });

    it("creates new sessions as Root children when Root exists", async () => {
      store.ensureRootSession(tmpDir);
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

      const created = await sm.createSession(bridge);

      assert.equal(
        store.getSession(created.sessionId)?.parent_session_id,
        "root",
      );
    });

    it("expands home shorthand before creating a session", async () => {
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
          return { sessionId: "agent-home", configOptions: [] };
        },
      };

      const created = await sm.createSession(bridge, "~");

      assert.equal(agentCwd, homedir());
      assert.equal(store.getSession(created.sessionId)?.cwd, homedir());
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

      await assert.rejects(() => sm.createSession(bridge, "/no/such/path"), {
        message: "Directory does not exist: /no/such/path",
      });
    });

    it("cleans up old empty sessions and removes them from liveSessions", async () => {
      // Create an empty session and mark it as live (simulating a prior createSession)
      store.createSession("empty-old", "/x");
      sm.liveSessions.add("empty-old");
      // Backdate created_at so it's older than the threshold
      store["db"]
        .prepare(
          "UPDATE sessions SET created_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-120 seconds') WHERE id = ?",
        )
        .run("empty-old");

      // Create a session with events — should not be cleaned
      store.createSession("has-events", "/x");
      store.saveEvent(
        "has-events",
        "user_message",
        { text: "hi" },
        { from_ref: "user" },
      );
      sm.liveSessions.add("has-events");

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

      await sm.createSession(bridge);

      // empty-old should be gone from both DB and liveSessions
      assert.equal(store.getSession("empty-old"), undefined);
      assert.ok(!sm.liveSessions.has("empty-old"));
      // has-events should still exist
      assert.ok(store.getSession("has-events"));
      assert.ok(sm.liveSessions.has("has-events"));
    });

    it("does not clean recently created empty sessions", async () => {
      // Create an empty session that's fresh (just now)
      store.createSession("fresh-empty", "/x");
      sm.liveSessions.add("fresh-empty");

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

      await sm.createSession(bridge);

      // fresh-empty should still exist (too young to clean)
      assert.ok(store.getSession("fresh-empty"));
      assert.ok(sm.liveSessions.has("fresh-empty"));
    });
  });

  describe("clearSession", () => {
    it("rotates the ACP execution while preserving the WebAgent session", async () => {
      store.createSession("web-1", tmpDir, "auto", "agent-old");
      store.updateSessionConfig("web-1", "model", "model-old");
      store.updateSessionConfig("web-1", "mode", "plan");
      sm.liveSessions.add("web-1");
      const configCalls: Array<{ id: string; value: string }> = [];
      const retired: string[] = [];

      const bridge = {
        async newSession() {
          return { sessionId: "agent-new", configOptions: [] };
        },
        async setConfigOption(_sessionId: string, id: string, value: string) {
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

      const result = await sm.clearSession(bridge, "web-1");

      assert.equal(result.sessionId, "web-1");
      assert.deepEqual(
        store.listSessions().map((session) => session.id),
        ["web-1"],
      );
      assert.equal(store.getAgentSessionId("web-1"), "agent-new");
      assert.equal(store.getWebSessionId("agent-old"), undefined);
      // The retired execution is explicitly removed, not just unbound.
      assert.deepEqual(retired, ["agent-old"]);
      assert.deepEqual(configCalls, [
        { id: "mode", value: "plan" },
        { id: "model", value: "model-old" },
      ]);
    });

    it("never retires the current execution when the agent returns the same id", async () => {
      store.createSession("web-1", tmpDir, "auto", "agent-same");
      sm.liveSessions.add("web-1");
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

      await sm.clearSession(bridge, "web-1");

      // rotateAgentSession is a no-op, so the still-authoritative execution
      // must not be retired; retiring it would kill the live binding.
      assert.equal(store.getAgentSessionId("web-1"), "agent-same");
      assert.deepEqual(retired, []);
    });

    it("restores thinking through the replacement execution's thought_level option", async () => {
      store.createSession("web-1", tmpDir, "auto", "agent-old");
      store.updateSessionConfig("web-1", "reasoning_effort", "high");
      sm.liveSessions.add("web-1");
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
        async setConfigOption(_sessionId: string, id: string, value: string) {
          configCalls.push({ id, value });
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      await sm.clearSession(bridge, "web-1");

      assert.deepEqual(configCalls, [{ id: "thought_level", value: "high" }]);
    });

    it("clears runtime buffers and command snapshots for the replacement execution", async () => {
      store.createSession("web-1", tmpDir, "auto", "agent-old");
      sm.liveSessions.add("web-1");
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

      await sm.clearSession(bridge, "web-1");

      assert.equal(sm.assistantBuffers.has("web-1"), false);
      assert.equal(sm.thinkingBuffers.has("web-1"), false);
      assert.equal(sm.activePrompts.has("web-1"), false);
      assert.deepEqual(sm.getAgentCommands("web-1").commands, []);
      assert.equal(sm.state.getState("web-1").runtime.busy, null);
    });

    it("keeps the runtime state seq monotonic across rotation", async () => {
      // A session with history has applied patches (seq > 0). The client
      // validates incremental state_patch events and snapshots against its
      // own lastStateSeq; if rotation restarted the server seq at 0, every
      // post-clear snapshot would look "superseded" and be dropped, leaving
      // the client permanently desynced (stuck busy).
      store.createSession("web-1", tmpDir, "auto", "agent-old");
      sm.liveSessions.add("web-1");
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

      await sm.clearSession(bridge, "web-1");

      const after = sm.state.getState("web-1");
      assert.equal(after.runtime.busy, null);
      assert.equal(after.runtime.pendingPermissions.length, 0);
      assert.ok(
        after.seq > seqBefore,
        `seq must continue from ${seqBefore}, not restart at 0 (got ${after.seq})`,
      );
    });

    it("rotates MCP capability only after the replacement execution succeeds", async () => {
      store.createSession("web-1", tmpDir, "auto", "agent-old");
      sm.liveSessions.add("web-1");
      const capabilities = new CapabilityStore();
      const oldToken = capabilities.mint("web-1");
      let newToken: string | undefined;
      const manager = new SessionManager(
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

      await manager.clearSession(bridge, "web-1");

      assert.equal(capabilities.resolve(oldToken), null);
      assert.equal(newToken && capabilities.resolve(newToken), "web-1");
    });

    it("does not reset the state ledger when replacement creation fails", async () => {
      store.createSession("web-1", tmpDir, "auto", "agent-old");
      sm.liveSessions.add("web-1");
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
        () => sm.clearSession(bridge, "web-1"),
        /replacement failed/,
      );
      // The rotation barrier patch (busy=true) bumps seq even on failure; the
      // ledger itself must survive an aborted rotation so clients can still
      // reconcile after the error.
      assert.ok(sm.state.getState("web-1").seq > seqBefore);
    });

    it("keeps the current MCP capability when replacement creation fails", async () => {
      store.createSession("web-1", tmpDir, "auto", "agent-old");
      sm.liveSessions.add("web-1");
      const capabilities = new CapabilityStore();
      const oldToken = capabilities.mint("web-1");
      const manager = new SessionManager(
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
        () => manager.clearSession(bridge, "web-1"),
        /replacement failed/,
      );
      assert.equal(capabilities.resolve(oldToken), "web-1");
      assert.equal(store.getAgentSessionId("web-1"), "agent-old");
    });
  });

  describe("Root execution", () => {
    it("binds one ACP execution to the existing Root session", async () => {
      store.ensureRootSession(tmpDir);
      let newSessionCalls = 0;
      const bridge = {
        async newSession() {
          newSessionCalls++;
          return { sessionId: "agent-root", configOptions: [] };
        },
        async setConfigOption() {
          return [];
        },
        async loadSession() {
          throw new Error("loadSession should not be called");
        },
      };

      await sm.ensureRootSession(bridge);
      await sm.ensureRootSession(bridge);

      assert.equal(newSessionCalls, 1);
      assert.equal(store.getAgentSessionId("root"), "agent-root");
      assert.deepEqual(
        store.listSessions().map((session) => session.id),
        ["root"],
      );
    });
  });

  describe("buffer management", () => {
    it("appends and flushes assistant buffer", () => {
      store.createSession("s1", "/x");

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
      store.createSession("s1", "/x");

      sm.appendThinking("s1", "Let me think...");
      sm.flushBuffers("s1");

      const events = store.getEvents("s1");
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "thinking");
    });

    it("flush is a no-op when buffers are empty", () => {
      store.createSession("s1", "/x");
      sm.flushBuffers("s1"); // should not throw
      assert.deepEqual(store.getEvents("s1"), []);
    });

    it("discards late buffers for a deleted session", () => {
      store.createSession("s1", "/x");
      store.deleteSession("s1");
      sm.assistantBuffers.set("s1", "late answer");
      sm.thinkingBuffers.set("s1", "late thought");

      assert.doesNotThrow(() => {
        sm.flushBuffers("s1");
      });
      assert.equal(sm.assistantBuffers.has("s1"), false);
      assert.equal(sm.thinkingBuffers.has("s1"), false);
    });

    it("flushAssistantBuffer saves only the assistant buffer", () => {
      store.createSession("s1", "/x");
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
      store.createSession("s1", "/x");
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

  describe("getSessionCwd", () => {
    it("returns session cwd when exists", () => {
      store.createSession("s1", "/my/project");
      assert.equal(sm.getSessionCwd("s1"), "/my/project");
    });

    it("returns default cwd when session not found", () => {
      assert.equal(sm.getSessionCwd("nonexistent"), tmpDir);
    });
  });

  describe("getBusyKind", () => {
    it("reports agent busy sessions", () => {
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
    it("returns false when session has no interrupted turn", () => {
      store.createSession("s1", "/x");
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
        async prompt(sessionId: string, text: string) {
          promptCalls.push(text);
        },
      };

      assert.equal(sm.autoRetryIfNeeded(bridge, "s1"), false);
      assert.equal(promptCalls.length, 0);
      assert.ok(!sm.activePrompts.has("s1"));
    });

    it("auto-retries when turn was interrupted", () => {
      store.createSession("s1", "/x");
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

      const promptCalls: Array<{ sessionId: string; text: string }> = [];
      const bridge = {
        async prompt(sessionId: string, text: string) {
          promptCalls.push({ sessionId, text });
        },
      };

      assert.equal(sm.autoRetryIfNeeded(bridge, "s1"), true);
      assert.ok(sm.activePrompts.has("s1"));
      assert.equal(promptCalls.length, 1);
      assert.equal(promptCalls[0].sessionId, "s1");
      assert.ok(promptCalls[0].text.includes("interrupted"));
    });

    it("skips if session is already actively prompting", () => {
      store.createSession("s1", "/x");
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
      store.createSession("s1", "/x");
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
    it("is a no-op when session is already live", async () => {
      store.createSession("s1", "/x");
      sm.liveSessions.add("s1");

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
          return { sessionId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(loadCalled, false);
    });

    it("calls loadSession for non-live sessions", async () => {
      store.createSession("s1", "/x");
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
          return { sessionId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(loadCalled, true);
      assert.ok(sm.liveSessions.has("s1"));
    });

    it("deduplicates concurrent resume calls", async () => {
      store.createSession("s1", "/x");
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
          return new Promise<{ sessionId: string; configOptions: never[] }>(
            (resolve) => {
              resolveLoad = () => {
                resolve({ sessionId: "s1", configOptions: [] });
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
      assert.ok(sm.liveSessions.has("s1"));
    });

    it("propagates errors to all waiters", async () => {
      store.createSession("s1", "/x");

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
      assert.ok(!sm.liveSessions.has("s1"));
    });
  });

  describe("resume-time cache warming", () => {
    // ACP's loadSession does not return configOptions (only newSession /
    // setConfigOption do). When the global cache is empty (e.g. after
    // bridge.restart), piggyback on the user's own resume: call
    // setConfigOption with the session's own stored value (idempotent) to
    // pull the full schema from the agent.

    it("warms cachedConfigOptions on first resume when cache is empty and session has stored mode", async () => {
      store.createSession("s1", "/x");
      store.updateSessionConfig("s1", "mode", "#plan");
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
          return { sessionId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(setCalls.length, 1);
      assert.equal(setCalls[0].id, "mode");
      assert.equal(setCalls[0].value, "#plan");
      assert.equal(sm.cachedConfigOptions.length, 2);
      assert.ok(sm.liveSessions.has("s1"));
    });

    it("skips warming when cache is already populated", async () => {
      store.createSession("s1", "/x");
      store.updateSessionConfig("s1", "mode", "#plan");
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
          return { sessionId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(setCalled, false);
    });

    it("skips warming when session has no stored config at all", async () => {
      store.createSession("s1", "/x");
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
          return { sessionId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(setCalled, false);
      assert.equal(sm.cachedConfigOptions.length, 0);
      assert.ok(sm.liveSessions.has("s1"));
    });

    it("prefers mode > reasoning_effort > model when picking the warming key", async () => {
      store.createSession("s1", "/x");
      store.updateSessionConfig("s1", "reasoning_effort", "medium");
      store.updateSessionConfig("s1", "model", "gpt-5.4");
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
          return { sessionId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.deepEqual(setCalls, [{ id: "reasoning_effort", value: "medium" }]);
    });

    it("falls back to thought_level when reasoning_effort is unsupported", async () => {
      store.createSession("s1", "/x");
      store.updateSessionConfig("s1", "reasoning_effort", "medium");
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
          return { sessionId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.deepEqual(setCalls, [
        { id: "reasoning_effort", value: "medium" },
        { id: "thought_level", value: "medium" },
      ]);
      assert.equal(sm.cachedConfigOptions.length, 2);
      assert.ok(sm.liveSessions.has("s1"));
    });

    it("resume still succeeds when setConfigOption throws", async () => {
      store.createSession("s1", "/x");
      store.updateSessionConfig("s1", "mode", "#plan");
      sm.cachedConfigOptions = [];

      const bridge = {
        async newSession() {
          return { sessionId: "", configOptions: [] };
        },
        async setConfigOption() {
          throw new Error("agent boom");
        },
        async loadSession() {
          return { sessionId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      assert.equal(sm.cachedConfigOptions.length, 0);
      assert.ok(
        sm.liveSessions.has("s1"),
        "resume must succeed even if warming fails",
      );
    });

    it("does not overwrite session DB row with agent defaults in the warm response", async () => {
      // Probe responses carry agent in-memory defaults for unrelated keys
      // (e.g. setConfigOption(mode, #plan) response's model.currentValue is
      // NOT the user's preference). Warming must never write these back.
      store.createSession("s1", "/x");
      store.updateSessionConfig("s1", "mode", "#plan");
      store.updateSessionConfig("s1", "model", "gpt-5.4");
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
          return { sessionId: "s1", configOptions: [] };
        },
      };

      await sm.ensureResumed(bridge, "s1");
      const row = store.getSession("s1")!;
      assert.equal(row.model, "gpt-5.4", "DB model must stay as user's choice");
    });
  });

  describe("attachment label cache", () => {
    beforeEach(() => {
      store.createSession("s1", "/x");
    });

    it("getLabelMap lazy-builds from store on first call", () => {
      store.insertAttachment({
        id: "abc12345-1111",
        sessionId: "s1",
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
        sessionId: "s1",
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
        sessionId: "s1",
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
        sessionId: "s1",
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

    it("isolates per-session caches", () => {
      store.createSession("s2", "/y");
      store.insertAttachment({
        id: "aaaa1111",
        sessionId: "s1",
        kind: "file",
        name: "in1.txt",
        mime: "text/plain",
        size: 1,
        realpath: "/r/1.txt",
      });
      store.insertAttachment({
        id: "bbbb2222",
        sessionId: "s2",
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

    it("deleteSession invalidates label cache", () => {
      store.insertAttachment({
        id: "abc12345",
        sessionId: "s1",
        kind: "file",
        name: "x.txt",
        mime: "text/plain",
        size: 1,
        realpath: "/r/x.txt",
      });
      sm.getLabelMap("s1"); // populate cache
      sm.deleteSession(undefined, "s1");
      // Re-create session and request map — must NOT see stale entry.
      store.createSession("s1", "/x");
      const m = sm.getLabelMap("s1");
      assert.equal(m.size, 0);
    });

    it("returns empty map for session with no attachments", () => {
      assert.equal(sm.getLabelMap("s1").size, 0);
    });
  });
});
