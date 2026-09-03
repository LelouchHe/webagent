import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Tool definitions for the WebAgent MCP server.
 *
 * P0b spike exposes a single `echo` tool to prove the transport path
 * (ACP `mcpServers` → pi-acp → pi-mcp-adapter → agent tool surface) before
 * the five Task tools (`task_list` / `task_query` / `task_send` /
 * `task_propose` / `task_update`) from the design are implemented. Keep
 * each tool's schema + handler in this file so S2 only adds entries here.
 */

/**
 * Register the spike tool set on an MCP server.
 *
 * `taskId` is the identity derived from the request's capability token.
 * The echo result includes it so the spike test can prove capability
 * derivation works end to end.
 */
export function registerMcpTools(server: McpServer, taskId: string): void {
  server.registerTool(
    "echo",
    {
      description:
        "Echo the provided text back together with the invoking task id. " +
        "Temporary spike tool used to validate the WebAgent MCP transport.",
      inputSchema: {
        text: z.string().describe("Text to echo back"),
      },
    },
    async ({ text }) => {
      return {
        content: [
          {
            type: "text" as const,
            text: `echo: ${text} (task ${taskId})`,
          },
        ],
      };
    },
  );
}
