import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer as AcpMcpServer } from "@agentclientprotocol/sdk";
import type { CapabilityStore } from "./capability.ts";
import { registerMcpTools } from "./tools.ts";
import { HTTP_STATUS } from "../http-status.ts";

/**
 * WebAgent MCP server endpoint.
 *
 * Serves the MCP control plane for ACP sessions over Streamable HTTP.
 * Each request is authenticated by the capability token minted for its
 * session (carried as `Authorization: Bearer <capability>`); the endpoint
 * fails closed — an unknown, revoked, or out-of-scope capability never
 * reaches the MCP protocol layer.
 *
 * The endpoint lives outside `/api/**`, so the shared Bearer auth gate does
 * not apply to it (mirroring the share viewer's `/s/*` pattern): identity is
 * the per-task capability, distinct from operator UI tokens.
 */

/** Uniquely-named WebAgent MCP server appended to an ACP session's mcpServers. */
export const MCP_SERVER_NAME = "webagent";

const DEFAULT_PATH = "/mcp";

/**
 * Build the ACP `McpServer` definition for one session: an HTTP entry whose
 * Authorization header carries the session's freshly minted capability.
 * `authBaseUrl` is the WebAgent's own origin (e.g. `http://127.0.0.1:6800`);
 * the endpoint path is appended here so callers pass the base only.
 */
export function buildMcpServerEntry(
  capability: string,
  authBaseUrl: string,
): AcpMcpServer {
  const base = authBaseUrl.replace(/\/$/, "");
  return {
    type: "http",
    name: MCP_SERVER_NAME,
    url: `${base}${DEFAULT_PATH}`,
    headers: [{ name: "Authorization", value: `Bearer ${capability}` }],
    // ACP reserves _meta for extension metadata. pi-acp translates this
    // generic direct-tools hint into the adapter's internal setting; agents
    // that do not understand it can safely ignore the metadata.
    _meta: { directTools: true },
  };
}

export interface McpEndpointOptions {
  /** Per-task capability store (keyed by task id). */
  capabilities: CapabilityStore;
  /**
   * Confirms a resolved task's execution is active. Creating/restoring tasks are
   * included because the ACP agent may auto-connect before the bridge call
   * returns and TaskManager promotes the task to live.
   */
  isTaskActive: (taskId: string) => boolean;
  /** Mount path; the response `true` claims that path. */
  path?: string;
}

function capabilityFromRequest(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(raw.trim());
  return match ? match[1] : null;
}

/**
 * Create an MCP request handler. Returns a function that handles requests
 * for the endpoint path and returns `false` for everything else so the main
 * router can continue dispatching.
 */
export function createMcpEndpoint(
  options: McpEndpointOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const path = options.path ?? DEFAULT_PATH;
  const { capabilities, isTaskActive } = options;

  return async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0] ?? url;
    if (pathname !== path) return false;

    const method = req.method ?? "GET";
    if (method !== "POST") {
      // Stateless mode has no SSE stream and no session reuse, so the MCP
      // client drives request/response over POST only — mirrors the SDK's
      // stateless example, which rejects other methods with 405.
      res.writeHead(HTTP_STATUS.METHOD_NOT_ALLOWED, {
        Allow: "POST",
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        }),
      );
      return true;
    }

    // --- Capability gate (fail closed) ---
    const capability = capabilityFromRequest(req);
    const taskId = capability ? capabilities.resolve(capability) : null;
    if (!taskId || !isTaskActive(taskId)) {
      res.writeHead(HTTP_STATUS.UNAUTHORIZED, {
        "Content-Type": "application/json",
        "WWW-Authenticate": "Bearer",
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Unauthorized" },
          id: null,
        }),
      );
      return true;
    }

    // --- MCP protocol (stateless, one server+transport per request) ---
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: "0.1.0" },
      {},
    );
    registerMcpTools(server, taskId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // JSON responses for POST round trips (no SSE streaming needed for the
      // agent-driven request/response shape; the SDK default SSE response is
      // harder for clients without an event-stream consumer).
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
      // Transport already owns response handling for protocol errors; a
      // thrown error here means the response was not (or only partially)
      // written. Emit a JSON-RPC internal error instead of leaking details.
    } catch {
      try {
        if (!res.headersSent) {
          res.writeHead(HTTP_STATUS.INTERNAL_SERVER_ERROR, {
            "Content-Type": "application/json",
          });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: null,
            }),
          );
        } else {
          res.end();
        }
      } catch {
        // Nothing more we can do; the connection is gone.
      }
    } finally {
      res.once("close", () => {
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });
    }
    return true;
  };
}
