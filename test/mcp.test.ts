import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CapabilityStore } from "../src/mcp/capability.ts";
import { buildTaskServerEntry, createMcpEndpoint } from "../src/mcp/server.ts";

// --- CapabilityStore ---

describe("CapabilityStore", () => {
  it("mints capability tokens with a mcp_ prefix that resolve back to the session", () => {
    const caps = new CapabilityStore();
    const token = caps.mint("web-1");
    assert.match(token, /^mcp_/);
    assert.equal(caps.resolve(token), "web-1");
  });

  it("minting again for the same session invalidates the previous token", () => {
    const caps = new CapabilityStore();
    const first = caps.mint("web-1");
    const second = caps.mint("web-1");
    assert.notEqual(first, second);
    assert.equal(caps.resolve(first), null);
    assert.equal(caps.resolve(second), "web-1");
  });

  it("revokes per session and fails closed for unknown tokens", () => {
    const caps = new CapabilityStore();
    const token = caps.mint("web-1");
    caps.revokeBySession("web-1");
    assert.equal(caps.resolve(token), null);
    assert.equal(caps.resolve("mcp_nope"), null);
    assert.equal(caps.resolve(""), null);
  });

  it("revoking an unknown session is a no-op", () => {
    const caps = new CapabilityStore();
    caps.revokeBySession("never-minted");
    assert.doesNotThrow(() => {
      caps.revokeBySession("never-minted");
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

describe("buildTaskServerEntry", () => {
  it("builds an HTTP ACP server entry with direct tools enabled", () => {
    assert.deepEqual(
      buildTaskServerEntry("mcp_test", "http://127.0.0.1:6800/"),
      {
        type: "http",
        name: "webagent-task",
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

  before(async () => {
    const handler = createMcpEndpoint({
      capabilities: caps,
      isLiveSession: (id) => live.has(id),
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
      isLiveSession: (id) => live.has(id),
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
    caps.revokeBySession("web-1");
    const revoked = await mcpPost("/mcp", {}, auth(token));
    assert.equal(revoked.status, 401);
  });

  it("rejects a valid capability for a session that is not live with 401", async () => {
    const token = caps.mint("web-ghost");
    const res = await mcpPost("/mcp", {}, auth(token));
    assert.equal(res.status, 401);
  });

  it("serves an MCP round trip: initialize, tools/list, echo call", async () => {
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
    assert.equal(initBody.result?.serverInfo?.name, "webagent-task");

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
      result?: { tools?: Array<{ name: string }> };
    };
    const names = (listBody.result?.tools ?? []).map((t) => t.name);
    assert.ok(names.includes("echo"));

    const call = await mcpPost(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hi" } },
      },
      auth(token),
    );
    assert.equal(call.status, 200);
    const callBody = (await call.json()) as {
      result?: { content?: Array<{ type: string; text: string }> };
    };
    const text = (callBody.result?.content ?? []).map((c) => c.text).join("");
    assert.equal(text, "echo: hi (session web-1)");

    live.delete("web-1");
  });
});
