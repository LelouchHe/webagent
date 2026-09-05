import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CapabilityStore } from "../src/mcp/capability.ts";
import { buildMcpServerEntry, createMcpEndpoint } from "../src/mcp/server.ts";

// --- CapabilityStore ---

describe("CapabilityStore", () => {
  it("mints capability tokens with a mcp_ prefix that resolve back to the task", () => {
    const caps = new CapabilityStore();
    const token = caps.mint("web-1");
    assert.match(token, /^mcp_/);
    assert.equal(caps.resolve(token), "web-1");
  });

  it("minting again for the same task invalidates the previous token", () => {
    const caps = new CapabilityStore();
    const first = caps.mint("web-1");
    const second = caps.mint("web-1");
    assert.notEqual(first, second);
    assert.equal(caps.resolve(first), null);
    assert.equal(caps.resolve(second), "web-1");
  });

  it("can keep the previous token valid while a replacement execution starts", () => {
    const caps = new CapabilityStore();
    const first = caps.mint("web-1");
    const second = caps.mintAdditional("web-1");

    assert.equal(caps.resolve(first), "web-1");
    assert.equal(caps.resolve(second), "web-1");

    caps.revokeOtherTokens("web-1", second);
    assert.equal(caps.resolve(first), null);
    assert.equal(caps.resolve(second), "web-1");
  });

  it("revokes per task and fails closed for unknown tokens", () => {
    const caps = new CapabilityStore();
    const token = caps.mint("web-1");
    caps.revokeByTask("web-1");
    assert.equal(caps.resolve(token), null);
    assert.equal(caps.resolve("mcp_nope"), null);
    assert.equal(caps.resolve(""), null);
  });

  it("revoking an unknown task is a no-op", () => {
    const caps = new CapabilityStore();
    caps.revokeByTask("never-minted");
    assert.doesNotThrow(() => {
      caps.revokeByTask("never-minted");
    });
  });

  it("clear drops every capability", () => {
    const caps = new CapabilityStore();
    const a = caps.mint("web-1");
    const b = caps.mint("web-2");
    caps.clear();
    assert.equal(caps.resolve(a), null);
    assert.equal(caps.resolve(b), null);
  });
});

describe("buildMcpServerEntry", () => {
  it("builds an HTTP ACP server entry with direct tools enabled", () => {
    assert.deepEqual(
      buildMcpServerEntry("mcp_test", "http://127.0.0.1:6800/"),
      {
        type: "http",
        name: "webagent",
        url: "http://127.0.0.1:6800/mcp",
        headers: [{ name: "Authorization", value: "Bearer mcp_test" }],
        _meta: { directTools: true },
      },
    );
  });
});

// --- createMcpEndpoint over real HTTP ---

describe("createMcpEndpoint", () => {
  let server: http.Server;
  let baseUrl: string;
  const live = new Set<string>();
  const caps = new CapabilityStore();
  const calls: Array<unknown> = [];
  const taskTools = {
    list: (taskId: string) => [
      { id: taskId, title: "Current", brief: null, relation: "self" as const },
    ],
    query: (_sourceTaskId: string, input: unknown) => {
      calls.push({ kind: "query", input });
      return {
        workflowStatus: "idle" as const,
        records: [],
        hasMore: false,
      };
    },
    send: async (...args: unknown[]) => {
      calls.push({ kind: "send", args });
    },
    update: async (...args: unknown[]) => {
      calls.push({ kind: "update", args });
    },
  };

  before(async () => {
    const handler = createMcpEndpoint({
      capabilities: caps,
      isTaskActive: (id) => live.has(id),
      taskTools,
    });
    server = http.createServer((req, res) => {
      void handler(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    caps.clear();
    await new Promise<void>((r) =>
      server.close(() => {
        r();
      }),
    );
  });

  function mcpPost(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  function auth(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  it("leaves non-mcp paths for the router (returns false)", async () => {
    const handler = createMcpEndpoint({
      capabilities: caps,
      isTaskActive: (id) => live.has(id),
      taskTools,
    });
    const req = new http.IncomingMessage(null as never);
    const res = new http.ServerResponse(req);
    const handled = await handler(req, res);
    assert.equal(handled, false);
  });

  it("rejects GET with 405 (stateless has no SSE stream)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "GET" });
    assert.equal(res.status, 405);
    const body = (await res.json()) as { error?: { code: number } };
    assert.equal(body.error?.code, -32000);
  });

  it("rejects POST without a capability with 401", async () => {
    const res = await mcpPost("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    assert.equal(res.status, 401);
  });

  it("rejects POST with an unknown or revoked capability with 401", async () => {
    const unknown = await mcpPost("/mcp", {}, auth("mcp_bogus"));
    assert.equal(unknown.status, 401);

    const token = caps.mint("web-1");
    caps.revokeByTask("web-1");
    const revoked = await mcpPost("/mcp", {}, auth(token));
    assert.equal(revoked.status, 401);
  });

  it("rejects a valid capability for a task that is not live with 401", async () => {
    const token = caps.mint("web-ghost");
    const res = await mcpPost("/mcp", {}, auth(token));
    assert.equal(res.status, 401);
  });

  it("serves the four Task control-plane tools", async () => {
    const token = caps.mint("web-1");
    live.add("web-1");

    const init = await mcpPost(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      },
      auth(token),
    );
    assert.equal(init.status, 200);
    const initBody = (await init.json()) as {
      result?: { serverInfo?: { name: string } };
    };
    assert.equal(initBody.result?.serverInfo?.name, "webagent");

    // notifications/initialized — fire and forget, must not error
    const notif = await mcpPost(
      "/mcp",
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      auth(token),
    );
    assert.equal(notif.status, 202);

    const list = await mcpPost(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      },
      auth(token),
    );
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as {
      result?: {
        tools?: Array<{
          name: string;
          inputSchema?: {
            required?: string[];
            properties?: Record<string, { anyOf?: Array<{ type?: string }> }>;
          };
        }>;
      };
    };
    const tools = listBody.result?.tools ?? [];
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "task_list",
      "task_query",
      "task_send",
      "task_update",
    ]);
    const querySchema = tools.find(
      (tool) => tool.name === "task_query",
    )?.inputSchema;
    assert.deepEqual(querySchema?.required ?? [], []);
    for (const name of ["task_id", "text", "cursor", "limit"]) {
      assert.equal(
        querySchema?.properties?.[name]?.anyOf?.some(
          (variant) => variant.type === "null",
        ),
        true,
      );
    }

    const call = await mcpPost(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "task_list", arguments: {} },
      },
      auth(token),
    );
    assert.equal(call.status, 200);
    const callBody = (await call.json()) as {
      result?: {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
      };
    };
    assert.notEqual(callBody.result?.isError, true);

    const query = await mcpPost(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "task_query",
          arguments: {
            task_id: null,
            text: "history",
            cursor: null,
            limit: 2,
          },
        },
      },
      auth(token),
    );
    assert.equal(query.status, 200);

    const send = await mcpPost(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "task_send",
          arguments: { target: "task-2", body: "hello" },
        },
      },
      auth(token),
    );
    assert.equal(send.status, 200);

    const update = await mcpPost(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "task_update",
          arguments: { status: "done", body: "finished" },
        },
      },
      auth(token),
    );
    assert.equal(update.status, 200);
    assert.deepEqual(calls, [
      {
        kind: "query",
        input: {
          taskId: undefined,
          text: "history",
          cursor: undefined,
          limit: 2,
        },
      },
      { kind: "send", args: ["web-1", "task-2", "hello"] },
      { kind: "update", args: ["web-1", "done", "finished"] },
    ]);

    live.delete("web-1");
  });
});
