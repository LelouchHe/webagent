import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Tool definitions for the WebAgent Task Server.
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
 * `webSessionId` is the identity derived from the request's capability token.
 * The echo result includes it so the spike test can prove capability
 * derivation works end to end.
 */
export function registerTaskTools(
  server: McpServer,
  webSessionId: string,
): void {
  server.registerTool(
    "echo",
    {
      description:
        "Echo the provided text back together with the invoking session id. " +
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
            text: `echo: ${text} (session ${webSessionId})`,
          },
        ],
      };
    },
  );
}
