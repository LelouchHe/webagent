import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface McpTaskListItem {
  id: string;
  title: string;
  brief: string | null;
  relation: "self" | "parent" | "child" | "sibling";
}

export interface McpTaskHistoryRecord {
  seq: number;
  type: string;
  data: string;
  createdAt: string;
}

export interface McpTaskQueryInput {
  taskId?: string;
  text?: string;
  cursor?: string;
  limit?: number;
}

export interface McpTaskQueryResult {
  workflowStatus: "running" | "idle" | "blocked" | "done";
  records: McpTaskHistoryRecord[];
  nextCursor?: string;
  hasMore: boolean;
}

/** Operations supplied by the WebAgent runtime behind the MCP tool surface. */
export interface McpTaskToolHost {
  list(sourceTaskId: string): McpTaskListItem[];
  query(sourceTaskId: string, input: McpTaskQueryInput): McpTaskQueryResult;
  send(sourceTaskId: string, targetTaskId: string, body: string): Promise<void>;
  update(
    sourceTaskId: string,
    status: "blocked" | "done",
    body: string,
  ): Promise<void>;
}

const TASK_ID = z.string().trim().min(1).max(256);
const BODY = z
  .string()
  .max(64 * 1024)
  .refine((value) => value.trim().length > 0, "Body must not be empty");

function jsonContent(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function accepted(): {
  content: Array<{ type: "text"; text: string }>;
} {
  return jsonContent({ accepted: true });
}

function unavailable(): never {
  throw new Error("Task MCP tools are not configured");
}

/** Register the four Agent-facing Task control-plane tools. */
export function registerMcpTools(
  server: McpServer,
  taskId: string,
  host?: McpTaskToolHost,
): void {
  server.registerTool(
    "task_list",
    {
      description:
        "List the current Task and its locally reachable parent, children, and siblings. " +
        "Returns stable identity data only; it does not return status or history.",
      inputSchema: {},
    },
    async () => jsonContent({ tasks: host?.list(taskId) ?? unavailable() }),
  );

  server.registerTool(
    "task_query",
    {
      description:
        "Read a bounded page of one visible Task's persisted history. " +
        "Omit arguments for the current Task's latest page; use the returned cursor for more. " +
        "Use text only to locate a known term; results are exact records, not summaries.",
      inputSchema: {
        task_id: TASK_ID.optional().describe(
          "Visible Task ID; defaults to the current Task",
        ),
        text: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe("Literal text to find"),
        cursor: z
          .string()
          .min(1)
          .max(512)
          .optional()
          .describe("Opaque cursor from a previous result"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum records to return"),
      },
    },
    async ({ task_id, text, cursor, limit }) =>
      jsonContent(
        host?.query(taskId, {
          taskId: task_id,
          text,
          cursor,
          limit,
        }) ?? unavailable(),
      ),
  );

  server.registerTool(
    "task_send",
    {
      description:
        "Send one durable graceful message to a visible parent, child, or sibling Task. " +
        "The server queues or delivers it; do not inspect busy state first.",
      inputSchema: {
        target: TASK_ID.describe("Stable target Task ID"),
        body: BODY.describe("Verbatim collaboration message"),
      },
    },
    async ({ target, body }) => {
      if (!host) return unavailable();
      await host.send(taskId, target, body);
      return accepted();
    },
  );

  server.registerTool(
    "task_update",
    {
      description:
        "Report the current Task as blocked or done. The body is the required reason or result. " +
        "The server records the update and informs the direct parent when one exists.",
      inputSchema: {
        status: z.enum(["blocked", "done"]),
        body: BODY.describe("Reason for blocking or result of completion"),
      },
    },
    async ({ status, body }) => {
      if (!host) return unavailable();
      await host.update(taskId, status, body);
      return accepted();
    },
  );
}
