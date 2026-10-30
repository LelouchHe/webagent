import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CapabilityStore } from "../src/mcp/capability.ts";
import { createMcpEndpoint } from "../src/mcp/server.ts";
import type { McpCallerPrincipal } from "../src/mcp/tools.ts";
import { createMcpTaskToolHost } from "../src/mcp/task-host.ts";
import { TaskManager, type DeliveryBridge } from "../src/task-manager.ts";
import { TaskStateManager } from "../src/task-state.ts";
import { StaticAgentEnvironment } from "../src/agent-registry.ts";
import {
  ExecutionAuthority,
  GenerationLedger,
} from "../src/execution-authority.ts";
import { Store } from "../src/store.ts";

/**
 * The MCP control plane is where a capability's authority has to be real.
 *
 * Every test here assembles the **production host** (`createMcpTaskToolHost`)
 * and the production endpoint over a real Store, generation ledger, and task
 * runtime — no stand-in that re-implements the check being tested. A stand-in
 * would prove nothing about the wiring, which is exactly how an unwired
 * validator survived the first review.
 */

interface Endpoint {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startEndpoint(
  options: Parameters<typeof createMcpEndpoint>[0],
): Promise<Endpoint> {
  const endpoint = createMcpEndpoint({ ...options, path: "/mcp" });
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

async function rpc(
  baseUrl: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function initialize(baseUrl: string, token: string): Promise<number> {
  const response = await rpc(baseUrl, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "multi-agent-test", version: "1.0.0" },
    },
  });
  return response.status;
}

async function callTool(
  baseUrl: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return rpc(baseUrl, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function toolErrorText(json: Record<string, unknown>): string {
  const error = json.error as { message?: string } | undefined;
  if (error?.message) return error.message;
  const result = json.result as
    | { content?: Array<{ text?: string }>; isError?: boolean }
    | undefined;
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return "";
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    return parsed.error ?? parsed.message ?? text;
  } catch {
    return text;
  }
}

/** One MCP server entry as it appears in an ACP `newSession` request. */
interface McpEntry {
  headers: Array<{ name: string; value: string }>;
}

/**
 * A controllable ACP transport for the real TaskManager. `hook` runs inside
 * `newSession`, which is exactly the window the contract cares about.
 */
function makeBridge(
  getHook: () =>
    | ((options?: { mcpServers?: McpEntry[] }) => Promise<void>)
    | undefined,
): DeliveryBridge {
  let sessions = 0;
  return {
    async newSession(_cwd: string, options?: { mcpServers?: McpEntry[] }) {
      sessions++;
      await getHook()?.(options);
      return { sessionId: `session-${sessions}`, configOptions: [] };
    },
    async setConfigOption() {
      return [];
    },
    async loadSession(taskId: string) {
      return { taskId, configOptions: [] };
    },
    async prompt() {},
    async cancel() {},
    resolvePermission: () => {},
    denyPermission: () => {},
    isAvailable: () => true,
  } as DeliveryBridge;
}

describe("mcp authority over the production host", () => {
  let dir: string;
  let store: Store;
  let capabilities: CapabilityStore;
  let authority: ExecutionAuthority;
  let tasks: TaskManager;
  let endpoint: Endpoint;
  let bridge: DeliveryBridge;
  let newSessionHook:
    | ((options?: { mcpServers?: McpEntry[] }) => Promise<void>)
    | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "webagent-mcp-authority-"));
    store = new Store(dir);
    store.ensureRootTask(dir);
    capabilities = new CapabilityStore();
    authority = new ExecutionAuthority(new GenerationLedger());
    newSessionHook = undefined;
    bridge = makeBridge(() => newSessionHook);
    tasks = new TaskManager({
      store,
      defaultCwd: dir,
      dataDir: dir,
      capabilities,
      mcpBaseUrl: "http://127.0.0.1:1",
      state: new TaskStateManager(),
      authority,
      agents: new StaticAgentEnvironment("agent-a"),
    });
    tasks.attachExecutionBridge(bridge);
    endpoint = await startEndpoint({
      capabilities,
      isTaskActive: (taskId) => tasks.isMcpSessionActive(taskId),
      taskTools: createMcpTaskToolHost({ store, tasks }),
    });
  });

  afterEach(async () => {
    await endpoint.close();
    tasks.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The principal the endpoint builds for one token. */
  function principalFor(token: string): McpCallerPrincipal {
    const grant = capabilities.resolve(token);
    assert.ok(grant, "the token must resolve");
    return Object.freeze({
      taskId: grant.taskId,
      agentId: grant.agentId,
      generation: grant.generation,
      initializing: grant.state === "initializing",
    });
  }

  it("refuses a business tool until the capability is promoted, then allows it", async () => {
    // The task is created by the real runtime while `newSession` holds the
    // MCP server entry, exactly as a real agent would receive it.
    const insideSession: {
      token: string;
      handshake: number;
      initializingCall: string;
    }[] = [];
    newSessionHook = async (options) => {
      const entry = options?.mcpServers?.[0];
      assert.ok(entry);
      const token = entry.headers[0].value.replace(/^Bearer\s+/, "");
      const handshake = await initialize(endpoint.baseUrl, token);
      const call = await callTool(endpoint.baseUrl, token, "task_create", {
        title: "must not exist",
      });
      insideSession.push({
        token,
        handshake,
        initializingCall: toolErrorText(call.json),
      });
    };

    const created = await tasks.createTask(bridge, dir, undefined, "agent");

    assert.equal(
      insideSession.length,
      1,
      "the handshake ran inside newSession",
    );
    assert.equal(insideSession[0].handshake, 200, "the handshake is allowed");
    assert.match(
      insideSession[0].initializingCall,
      /initializing/,
      "a business tool is refused while initializing",
    );
    // Nothing was created during the pending window.
    assert.deepEqual(
      store
        .listTasks()
        .filter((task) => task.id !== store.rootTaskId)
        .map((task) => task.id),
      [created.taskId],
    );

    // The same token works once the binding has committed.
    const promoted = await callTool(
      endpoint.baseUrl,
      insideSession[0].token,
      "task_create",
      { title: "now allowed" },
    );
    assert.equal(promoted.status, 200);
    assert.equal(promoted.json.error, undefined);
    assert.equal(
      store.listTasks().filter((task) => task.id !== store.rootTaskId).length,
      2,
    );
  });

  it("refuses an in-flight request after a real rotation, with no side effect", async () => {
    const source = await tasks.createTask(bridge, dir, undefined, "agent");
    const sourceLease = authority.leaseFor(source.taskId);
    assert.ok(sourceLease);
    // A restore-style token: the task already exists and is active.
    const token = capabilities.mint(
      source.taskId,
      "agent-a",
      sourceLease.generation,
    );
    assert.equal(await initialize(endpoint.baseUrl, token), 200);

    // The child creation pauses inside `newSession`, where a rotation can land.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let openedInsideSession!: () => void;
    const reachedInsideSession = new Promise<void>((resolve) => {
      openedInsideSession = resolve;
    });
    newSessionHook = async () => {
      openedInsideSession();
      await gate;
    };

    const principal = principalFor(token);
    // The captured principal, not a fresh read: a rotation revokes the token,
    // and the point of the boundary is that the *request's* identity is stale.
    const assertCaller = (): void => {
      if (principal.generation === null) throw new Error("execution_replaced");
      if (store.getBindingAgent(principal.taskId) !== principal.agentId) {
        throw new Error("execution_replaced");
      }
      if (
        !authority.accepts({
          taskId: principal.taskId,
          generation: principal.generation,
        })
      ) {
        throw new Error("execution_replaced");
      }
    };
    const pending = tasks.createTask(bridge, dir, source.taskId, "agent", {
      parentId: source.taskId,
      title: "child in flight",
      assertCaller,
    });

    await reachedInsideSession;
    // A real rotation: same owner, new execution, higher generation.
    newSessionHook = undefined;
    await tasks.clearTask(bridge, source.taskId);
    release();

    await assert.rejects(() => pending, /execution_replaced/);
    // No child row survived the refusal, and the source recorded nothing.
    assert.equal(
      store.listTasks().filter((task) => task.id !== store.rootTaskId).length,
      1,
      "only the source task exists",
    );
    assert.equal(
      store
        .getEvents(source.taskId)
        .filter((event) => event.data.includes("child in flight")).length,
      0,
    );

    // Control: a token for the new generation works, so the refusal was about
    // the generation, not about the tool being broken.
    const freshLease = authority.leaseFor(source.taskId);
    assert.ok(freshLease);
    const fresh = capabilities.mint(
      source.taskId,
      "agent-a",
      freshLease.generation,
    );
    assert.equal(await initialize(endpoint.baseUrl, fresh), 200);
    const allowed = await callTool(endpoint.baseUrl, fresh, "task_create", {
      title: "after rotation",
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.error, undefined);

    // The rotation revoked the old token, so even authentication fails.
    const stale = await callTool(endpoint.baseUrl, token, "task_create", {
      title: "from the old token",
    });
    assert.equal(stale.status, 401);
    assert.equal(
      (stale.json.error as { message?: string } | undefined)?.message,
      "Unauthorized",
    );
    void principal;
  });

  it("refuses a token whose task moved to another agent", async () => {
    const source = await tasks.createTask(bridge, dir, undefined, "agent");
    const lease = authority.leaseFor(source.taskId);
    assert.ok(lease);
    const token = capabilities.mint(source.taskId, "agent-a", lease.generation);
    // The binding moves under the same process (a real replacement the caller
    // did not perform).
    store.replaceAgentSession(source.taskId, "agent-b", "other-session");
    authority.applyBindingChanges([
      {
        taskId: source.taskId,
        before: { agentId: "agent-a", sessionId: "session-1" },
        after: { agentId: "agent-b", sessionId: "other-session" },
      },
    ]);

    const response = await callTool(endpoint.baseUrl, token, "task_create", {
      title: "wrong agent",
    });
    assert.match(toolErrorText(response.json), /execution_replaced/);
  });

  it("revokes the Root token on a Root reset", async () => {
    // Root is the one task a reset keeps, so nothing in the descendant cleanup
    // releases its capability. Without an explicit revoke, the old token would
    // be usable while the next session is materializing.
    await tasks.ensureRootLive();
    const lease = authority.leaseFor(store.rootTaskId);
    assert.ok(lease);
    const token = capabilities.mint(
      store.rootTaskId,
      "agent-a",
      lease.generation,
    );
    assert.equal(await initialize(endpoint.baseUrl, token), 200);

    await tasks.resetRootTask();

    assert.equal(capabilities.resolve(token), null);
    assert.equal(await initialize(endpoint.baseUrl, token), 401);
  });

  it("refuses an unknown or revoked token before any protocol work", async () => {
    assert.equal(await initialize(endpoint.baseUrl, "mcp_unknown"), 401);
    const token = capabilities.mint("gone", "agent-a", 1);
    capabilities.revokeByTask("gone");
    assert.equal(await initialize(endpoint.baseUrl, token), 401);
  });

  it("keeps the caller principal frozen", async () => {
    const source = await tasks.createTask(bridge, dir, undefined, "agent");
    const lease = authority.leaseFor(source.taskId);
    assert.ok(lease);
    const token = capabilities.mint(source.taskId, "agent-a", lease.generation);
    assert.equal(await initialize(endpoint.baseUrl, token), 200);
    const principal = principalFor(token);
    assert.equal(Object.isFrozen(principal), true);
    assert.throws(() => {
      (principal as { taskId: string }).taskId = "other";
    });
  });
});
