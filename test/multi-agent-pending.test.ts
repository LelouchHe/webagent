import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AgentBridge } from "../src/bridge.ts";
import { AgentRegistry } from "../src/agent-registry.ts";
import { CapabilityStore } from "../src/mcp/capability.ts";
import { createMcpEndpoint } from "../src/mcp/server.ts";
import { createMcpTaskToolHost } from "../src/mcp/task-host.ts";
import type { McpTaskToolHost } from "../src/mcp/tools.ts";
import {
  ExecutionAuthority,
  GenerationLedger,
} from "../src/execution-authority.ts";
import { Store } from "../src/store.ts";
import { TaskStateManager } from "../src/task-state.ts";
import { TaskManager } from "../src/task-manager.ts";

/**
 * A real ACP agent process connecting to `/mcp` from inside `session/new`.
 *
 * This is the pending window the contract names: the session that carries the
 * token is still being created, so the task may not even exist yet. The
 * handshake must succeed and every business tool must answer `initializing`;
 * once the binding commits, the same token works.
 */

const FIXTURE = fileURLToPath(
  new URL("./fixtures/multi-agent-acp-agent.ts", import.meta.url),
);

interface Call {
  method: string;
  params: Record<string, unknown>;
}

describe("pending capability over a real ACP session", () => {
  it("allows the handshake, refuses business tools, then promotes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-pending-"));
    const callsPath = join(dir, "calls.jsonl");
    writeFileSync(callsPath, "");
    const store = new Store(dir);
    store.ensureRootTask(dir);
    const capabilities = new CapabilityStore();
    const authority = new ExecutionAuthority(new GenerationLedger());
    const calls = (): Call[] =>
      readFileSync(callsPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Call);

    // The endpoint needs the runtime's liveness and the host needs the manager,
    // so both are wired in the order the server uses. They are assigned once,
    // after construction, and read through the getter below.
    // eslint-disable-next-line prefer-const
    let tasks: TaskManager;
    // eslint-disable-next-line prefer-const
    let taskTools: McpTaskToolHost | undefined;
    const endpoint = createMcpEndpoint({
      capabilities,
      isTaskActive: (taskId) => tasks.isMcpSessionActive(taskId),
      get taskTools() {
        return taskTools;
      },
    });
    const server = http.createServer((req, res) => {
      void endpoint(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;

    const registry = new AgentRegistry({
      agents: { "agent-a": { cmd: "configured" } },
      defaultAgentId: "agent-a",
      createTransport: (agentId) =>
        new AgentBridge(
          [
            process.execPath,
            "--experimental-strip-types",
            FIXTURE,
            "shared",
            callsPath,
            "0",
            "none",
            "1",
          ].join(" "),
          store.sessionView(agentId),
          agentId,
        ),
    });
    tasks = new TaskManager({
      store,
      defaultCwd: dir,
      dataDir: dir,
      capabilities,
      mcpBaseUrl: `http://127.0.0.1:${port}`,
      state: new TaskStateManager(),
      authority,
      agents: registry,
    });
    taskTools = createMcpTaskToolHost({ store, tasks });

    try {
      const created = await tasks.createTask(
        await tasks.resolveAgentTransport("agent-a"),
        dir,
        undefined,
        "agent",
      );

      const initialize = calls().find(
        (call) => call.method === "mcp-initialize",
      );
      const tool = calls().find((call) => call.method === "mcp-tool");
      assert.ok(initialize, "the agent connected during session/new");
      assert.ok(tool, "the agent called a business tool during session/new");
      assert.equal(initialize.params.status, 200);
      assert.equal(
        tool.params.status,
        200,
        "the tool call is answered, not refused at the transport",
      );
      assert.match(String(tool.params.body), /initializing/);

      // Nothing was created by the refused call: only the task itself exists.
      assert.deepEqual(
        store
          .listTasks()
          .filter((task) => task.id !== store.rootTaskId)
          .map((task) => task.id),
        [created.taskId],
      );

      // The same token works after the promotion.
      const authorization = String(initialize.params.authorization);
      const token = authorization.replace(/^Bearer\s+/, "");
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "task_list", arguments: {} },
        }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        result?: { content?: Array<{ text?: string }> };
        error?: unknown;
      };
      assert.equal(body.error, undefined);
      assert.equal(
        capabilities.resolve(token)?.state,
        "active",
        "the token reads as promoted",
      );
    } finally {
      tasks.dispose();
      await registry.shutdownAll();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
