import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CapabilityStore } from "../src/mcp/capability.ts";
import {
  createMcpEndpoint,
  type McpEndpointOptions,
} from "../src/mcp/server.ts";
import type { McpCallerPrincipal, McpTaskToolHost } from "../src/mcp/tools.ts";

/**
 * The MCP control plane is the agent's only way to reach another Task, so it
 * is where a capability's authorization has to be real:
 *
 * - a token minted for a session that is still being created may complete the
 *   handshake but must not run a business tool;
 * - a request that was authenticated before a rotation must not write after it,
 *   even though its token still parses.
 */

interface Endpoint {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startEndpoint(
  options: Omit<McpEndpointOptions, "path">,
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

describe("pending capabilities", () => {
  let endpoint: Endpoint;
  let capabilities: CapabilityStore;
  let created: string[];

  before(async () => {
    capabilities = new CapabilityStore();
    created = [];
    const host: McpTaskToolHost = {
      list: () => [],
      query: () => ({ task_id: "t", max_seq: 0, rows: [] }),
      read: () => ({ task_id: "t", rows: [] }),
      cancel: async () => ({ accepted: true, taskId: "t", status: "idle" }),
      create: async (_source, input) => {
        created.push(input.title);
        return { taskId: "child" };
      },
      send: async () => {},
      update: async () => {},
    };
    endpoint = await startEndpoint({
      capabilities,
      isTaskActive: () => true,
      taskAgent: () => "agent-a",
      generationFor: () => 1,
      acceptsGeneration: () => true,
      taskTools: host,
    });
  });

  after(async () => {
    await endpoint.close();
  });

  it("allows the handshake but not a business tool while initializing", async () => {
    const token = capabilities.mintInitializing("pending-task", "agent-a");
    assert.equal(await initialize(endpoint.baseUrl, token), 200);

    const response = await rpc(endpoint.baseUrl, token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "task_create",
        arguments: { title: "should not exist" },
      },
    });
    assert.match(toolErrorText(response.json), /initializing/);
    assert.deepEqual(created, [], "no business tool ran in the pending window");

    // Promotion is what makes the same token usable.
    capabilities.promote(token);
    const promoted = await rpc(endpoint.baseUrl, token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "task_create", arguments: { title: "now allowed" } },
    });
    assert.equal(promoted.status, 200);
    assert.deepEqual(created, ["now allowed"]);
  });

  it("rejects a token from a replaced generation after its request authenticated", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const host: McpTaskToolHost = {
      list: () => [],
      query: () => ({ task_id: "t", max_seq: 0, rows: [] }),
      read: () => ({ task_id: "t", rows: [] }),
      cancel: async () => ({ accepted: true, taskId: "t", status: "idle" }),
      create: async () => ({ taskId: "child" }),
      // The host mirrors the real one: it re-checks the caller at its own
      // submission boundary, immediately before the first side effect.
      send: async function (
        this: { validateCaller?: (p: McpCallerPrincipal) => string | null },
        principal,
      ) {
        await gate;
        const rejection = this.validateCaller?.(principal);
        if (rejection) throw new Error(rejection);
        writes++;
      },
      update: async () => {
        await gate;
        writes++;
      },
    };
    let currentGeneration = 7;
    const staleEndpoint = await startEndpoint({
      capabilities,
      isTaskActive: () => true,
      taskAgent: () => "agent-a",
      generationFor: () => currentGeneration,
      acceptsGeneration: (_taskId, generation) =>
        generation === currentGeneration,
      taskTools: host,
    });
    try {
      const token = capabilities.mint("slow-task", "agent-a");
      const pendingCall = rpc(staleEndpoint.baseUrl, token, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "task_send", arguments: { target: "x", body: "b" } },
      });
      // Let the request authenticate and enter the tool.
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The task rotates: the old generation is gone.
      currentGeneration = 8;
      release();
      const response = await pendingCall;
      assert.match(toolErrorText(response.json), /execution_replaced/);
      assert.equal(writes, 0, "no write landed after the rotation");

      // A new token against the new generation works: the guard is not simply
      // rejecting everything.
      const fresh = capabilities.mint("slow-task", "agent-a");
      const ok = await rpc(staleEndpoint.baseUrl, fresh, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "task_send", arguments: { target: "x", body: "b" } },
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.error, undefined);
      assert.equal(writes, 1);
    } finally {
      await staleEndpoint.close();
    }
  });

  it("refuses an unknown or revoked token before any protocol work", async () => {
    assert.equal(await initialize(endpoint.baseUrl, "mcp_unknown"), 401);
    const token = capabilities.mint("gone-task", "agent-a");
    capabilities.revokeByTask("gone-task");
    assert.equal(await initialize(endpoint.baseUrl, token), 401);
  });
});

describe("caller principal shape", () => {
  it("is a frozen request-scoped value, not a shared mutable slot", async () => {
    const capabilities = new CapabilityStore();
    let captured: McpCallerPrincipal | null = null;
    const endpoint = await startEndpoint({
      capabilities,
      isTaskActive: () => true,
      taskAgent: () => "agent-a",
      generationFor: () => 3,
      acceptsGeneration: () => true,
      taskTools: {
        list: (principal) => {
          captured = principal;
          return [];
        },
        query: () => ({ task_id: "t", max_seq: 0, rows: [] }),
        read: () => ({ task_id: "t", rows: [] }),
        cancel: async () => ({ accepted: true, taskId: "t", status: "idle" }),
        create: async () => ({ taskId: "child" }),
        send: async () => {},
        update: async () => {},
      },
    });
    try {
      const token = capabilities.mint("frozen-task", "agent-a");
      await initialize(endpoint.baseUrl, token);
      await rpc(endpoint.baseUrl, token, {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "task_list", arguments: {} },
      });
      assert.ok(captured);
      const principal: McpCallerPrincipal = captured;
      assert.deepEqual(principal, {
        taskId: "frozen-task",
        agentId: "agent-a",
        generation: 3,
        initializing: false,
      });
      assert.equal(Object.isFrozen(principal), true);
      assert.throws(() => {
        (principal as { taskId: string }).taskId = "other";
      });
    } finally {
      await endpoint.close();
    }
  });
});
