import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CapabilityStore } from "../src/mcp/capability.ts";
import { createMcpEndpoint } from "../src/mcp/server.ts";
import type { McpCallerPrincipal, McpTaskToolHost } from "../src/mcp/tools.ts";
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
  let host: McpTaskToolHost;
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
    host = createMcpTaskToolHost({ store, tasks });
    endpoint = await startEndpoint({
      capabilities,
      isTaskActive: (taskId) => tasks.isMcpSessionActive(taskId),
      taskTools: host,
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

    assert.equal(await initialize(endpoint.baseUrl, token), 200);
    // A real HTTP `tools/call`: it goes through the endpoint's principal
    // construction, the MCP request parsing, and the host's dispatch, and it
    // parks inside `newSession`.
    const pending = callTool(endpoint.baseUrl, token, "task_create", {
      title: "child in flight",
    });

    await reachedInsideSession;
    // A real rotation: same owner, new execution, higher generation.
    newSessionHook = undefined;
    await tasks.clearTask(bridge, source.taskId);
    release();

    const refused = await pending;
    const refusedResult = refused.json.result as
      | { isError?: boolean; content?: Array<{ text?: string }> }
      | undefined;
    assert.equal(refused.status, 200, "the tool call itself is answered");
    assert.equal(refusedResult?.isError, true, "the tool reports an error");
    assert.match(
      refusedResult.content?.[0]?.text ?? "",
      /execution_replaced/,
      "the stale dispatch is refused at the submission boundary",
    );
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
    // The control asserts the effective result: a created child, not just a
    // 200 envelope.
    const allowedResult = allowed.json.result as
      | { isError?: boolean; content?: Array<{ text?: string }> }
      | undefined;
    assert.notEqual(allowedResult?.isError, true);
    const created = JSON.parse(allowedResult?.content?.[0]?.text ?? "{}") as {
      taskId?: string;
    };
    assert.ok(created.taskId, "the fresh token created a child");
    assert.equal(
      store.listTasks().filter((task) => task.id !== store.rootTaskId).length,
      2,
      "the source and the new child exist",
    );

    // The rotation revoked the old token, so even authentication fails.
    const stale = await callTool(endpoint.baseUrl, token, "task_create", {
      title: "from the old token",
    });
    assert.equal(stale.status, 401);
    assert.equal(
      (stale.json.error as { message?: string } | undefined)?.message,
      "Unauthorized",
    );
  });

  it("re-checks the caller after waiting for the tree lock", async () => {
    const source = await tasks.createTask(bridge, dir, undefined, "agent");
    const lease = authority.leaseFor(source.taskId);
    assert.ok(lease);
    const token = capabilities.mint(source.taskId, "agent-a", lease.generation);

    // Hold the tree lock the child's persistence needs, so the request parks
    // *between* the two caller checks: the first one already passed, and only
    // the post-lock re-check can see the rotation.
    const lock = tasks["treeLock"] as unknown as {
      acquire: (spec: { exclusive: string[] }) => Promise<() => void>;
    };
    const releaseLock = await lock.acquire({ exclusive: [source.taskId] });

    let newSessions = 0;
    const innerNewSession = bridge.newSession.bind(bridge);
    bridge.newSession = async (cwd: string, options?: never) => {
      newSessions++;
      return innerNewSession(cwd, options);
    };

    const pending = callTool(endpoint.baseUrl, token, "task_create", {
      title: "waits for the lock",
    });
    const deadline = Date.now() + 5000;
    while (newSessions === 0 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 5));
    }
    assert.equal(newSessions, 1, "the ACP session was created");
    assert.equal(
      store.listTasks().filter((task) => task.id !== store.rootTaskId).length,
      1,
      "the task is not persisted while the lock is held",
    );

    // Rotate the source while the request is parked on the lock.
    await tasks.clearTask(bridge, source.taskId);
    releaseLock();

    const refused = await pending;
    const result = refused.json.result as
      | { isError?: boolean; content?: Array<{ text?: string }> }
      | undefined;
    assert.ok(result);
    assert.equal(result.isError, true);
    assert.match(
      result.content?.[0]?.text ?? "",
      /execution_replaced/,
      "the post-lock check refuses the stale create",
    );
    assert.equal(
      store.listTasks().filter((task) => task.id !== store.rootTaskId).length,
      1,
      "no task was persisted after the rotation",
    );
  });

  it("re-checks the caller after the cancel request returns", async () => {
    const source = await tasks.createTask(bridge, dir, undefined, "agent");
    const child = await tasks.createTask(bridge, dir, source.taskId, "agent", {
      parentId: source.taskId,
    });
    const lease = authority.leaseFor(source.taskId);
    assert.ok(lease);
    const token = capabilities.mint(source.taskId, "agent-a", lease.generation);
    // The child has to be busy for the cancel to await the transport.
    tasks.activePrompts.add(child.taskId);
    tasks.syncBusy(child.taskId);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const inCancel = new Promise<void>((resolve) => {
      reached = resolve;
    });
    bridge.cancel = async () => {
      reached();
      await gate;
    };

    const pending = callTool(endpoint.baseUrl, token, "task_cancel", {
      target: child.taskId,
      reason: "no longer needed",
    });
    await inCancel;
    // Rotate the caller's own task while the cancel is in flight.
    await tasks.clearTask(bridge, source.taskId);
    release();

    const refused = await pending;
    const result = refused.json.result as
      | { isError?: boolean; content?: Array<{ text?: string }> }
      | undefined;
    assert.ok(result);
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /execution_replaced/);
    // The cancel reached the transport, but its record was not written under
    // the replaced authority.
    assert.equal(
      store.getEvents(child.taskId).filter((e) => e.type === "task_cancel")
        .length,
      0,
      "no cancellation record was written for a replaced caller",
    );
    tasks.activePrompts.delete(child.taskId);
  });

  it("re-checks the caller before writing the source after a child create", async () => {
    const source = await tasks.createTask(bridge, dir, undefined, "agent");
    // A stored model makes the child inherit configuration from the source,
    // which is an await *after* the child has been persisted.
    store.updateTaskConfig(source.taskId, "model", "chosen-model");
    const lease = authority.leaseFor(source.taskId);
    assert.ok(lease);
    const token = capabilities.mint(source.taskId, "agent-a", lease.generation);

    const modelOption = {
      type: "select" as const,
      id: "model",
      name: "Model",
      currentValue: "base-model",
      options: [
        { value: "base-model", name: "Base" },
        { value: "chosen-model", name: "Chosen" },
      ],
    };
    let sessions = 10;
    bridge.newSession = async () => ({
      sessionId: `child-session-${sessions++}`,
      configOptions: [modelOption],
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const inInherit = new Promise<void>((resolve) => {
      reached = resolve;
    });
    bridge.setConfigOption = async (taskId: string) => {
      // The child's inheritance is the await this test parks in; the source's
      // own config replay during the clear must not block.
      if (taskId !== source.taskId) {
        reached();
        await gate;
      }
      return [modelOption];
    };

    const pending = host.create(principalFor(token), { title: "kept child" });
    await inInherit;
    // The source rotates while the child's inheritance is still in flight.
    await tasks.clearTask(bridge, source.taskId);
    release();

    await assert.rejects(() => pending, /execution_replaced/);
    // The child was committed before the rotation and stays: the missing step
    // is only the source-side commit.
    const children = store.getDescendantTaskIds(source.taskId);
    assert.equal(children.length, 1, "the child task is kept");
    assert.ok(store.getTask(children[0]));
    // No source transcript row and no broadcast for a request that lost its
    // authority before that write.
    assert.equal(
      store
        .getEvents(source.taskId)
        .filter((event) => event.data.includes("kept child")).length,
      0,
      "the source transcript was not written",
    );
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
