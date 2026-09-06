import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface McpTaskListItem {
  id: string;
  title: string;
  brief: string | null;
  relation: "self" | "parent" | "child" | "sibling";
}

/** A bounded, human-readable projection of one persisted task event. */
export interface McpTaskHistoryRecord {
  /** Stable event sequence within the task; reserved for future raw lookup. */
  seq: number;
  type: string;
  createdAt: string;
  /** Deterministic text extracted from the event's known schema. */
  text: string;
  /** Text was shortened; rawSize is the UTF-8 size of the omitted payload. */
  truncated?: boolean;
  rawSize?: number;
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

export interface McpTaskGetRecordInput {
  taskId?: string;
  seq: number;
}

/** Complete WebAgent-persisted event row, not necessarily the original ACP notification. */
export interface McpTaskStoredRecord {
  id: number;
  taskId: string;
  seq: number;
  type: string;
  data: string;
  fromRef: string;
  createdAt: string;
}

export interface McpTaskGetRecordResult {
  taskId: string;
  record: McpTaskStoredRecord;
}

export interface McpTaskCancelResult {
  accepted: true;
  taskId: string;
  status: "idle" | "cancelling" | "cancelled" | "superseded";
}

export interface McpTaskCreateInput {
  title: string;
  cwd?: string;
  model?: string;
  thinking?: string;
}

export interface McpTaskCreateResult {
  taskId: string;
}

/** Operations supplied by the WebAgent runtime behind the MCP tool surface. */
export interface McpTaskToolHost {
  list(sourceTaskId: string): McpTaskListItem[];
  query(sourceTaskId: string, input: McpTaskQueryInput): McpTaskQueryResult;
  getRecord(
    sourceTaskId: string,
    input: McpTaskGetRecordInput,
  ): McpTaskGetRecordResult;
  cancel(
    sourceTaskId: string,
    targetTaskId: string,
    reason: string,
  ): Promise<McpTaskCancelResult>;
  create(
    sourceTaskId: string,
    input: McpTaskCreateInput,
  ): Promise<McpTaskCreateResult>;
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

/** Register the Agent-facing Task control-plane tools. */
export function registerMcpTools(
  server: McpServer,
  taskId: string,
  host?: McpTaskToolHost,
): void {
  server.registerTool(
    "task_list",
    {
      description:
        "List the Tasks available for coordination with the current Task. " +
        "Returns stable identity and short description data only; it does not return workflow status or history. " +
        "Use this to discover which Task to inspect or contact.",
      inputSchema: {},
    },
    async () => jsonContent({ tasks: host?.list(taskId) ?? unavailable() }),
  );

  server.registerTool(
    "task_query",
    {
      description:
        "Read a bounded page of compact history records from the current Task or another available Task. " +
        "With no arguments, returns the latest page; use the returned cursor to read older pages. " +
        "The text filter is a literal substring search, not semantic search. " +
        "Results include seq values that can be passed to task_get_record when a compact summary is not enough. " +
        "Raw event payloads are not returned by this tool.",
      inputSchema: {
        task_id: TASK_ID.nullable()
          .optional()
          .describe(
            "Visible Task ID; null or omission defaults to the current Task",
          ),
        text: z
          .string()
          .min(1)
          .max(256)
          .nullable()
          .optional()
          .describe("Literal text to find; null is treated as omitted"),
        cursor: z
          .string()
          .min(1)
          .max(512)
          .nullable()
          .optional()
          .describe("Opaque cursor from a previous result; null is omitted"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .nullable()
          .optional()
          .describe("Maximum records to return; null uses the default"),
      },
    },
    async ({ task_id, text, cursor, limit }) =>
      jsonContent(
        host?.query(taskId, {
          taskId: task_id ?? undefined,
          text: text ?? undefined,
          cursor: cursor ?? undefined,
          limit: limit ?? undefined,
        }) ?? unavailable(),
      ),
  );

  server.registerTool(
    "task_get_record",
    {
      description:
        "Fetch one complete history record by its task-local seq. " +
        "Use a seq returned by task_query when its compact summary is not sufficient. " +
        "The result includes the full event payload rather than a compact summary.",
      inputSchema: {
        task_id: TASK_ID.nullable()
          .optional()
          .describe(
            "Visible target task ID; null or omission defaults to the current task",
          ),
        seq: z
          .number()
          .int()
          .min(1)
          .describe("Stable event sequence within the target task"),
      },
    },
    async ({ task_id, seq }) =>
      jsonContent(
        host?.getRecord(taskId, {
          taskId: task_id ?? undefined,
          seq,
        }) ?? unavailable(),
      ),
  );

  server.registerTool(
    "task_create",
    {
      description:
        "Create a direct child Task for independent work. " +
        "The new Task starts with the supplied title; cwd, model, and thinking are optional overrides. " +
        "Use task_send to deliver its first work instruction after creation. " +
        "The server returns the new Task ID or an error.",
      inputSchema: {
        title: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .refine((value) => !value.includes("/"), "Title must not contain '/'")
          .describe("Task title"),
        cwd: z
          .string()
          .trim()
          .min(1)
          .max(4096)
          .nullable()
          .optional()
          .describe(
            "Working directory; null or omission inherits the current Task",
          ),
        model: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .nullable()
          .optional()
          .describe(
            "Model override; null or omission inherits the current Task",
          ),
        thinking: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .nullable()
          .optional()
          .describe(
            "Thinking level override; null or omission inherits the current Task",
          ),
      },
    },
    async ({ title, cwd, model, thinking }) => {
      if (!host) return unavailable();
      return jsonContent(
        await host.create(taskId, {
          title,
          cwd: cwd ?? undefined,
          model: model ?? undefined,
          thinking: thinking ?? undefined,
        }),
      );
    },
  );

  server.registerTool(
    "task_cancel",
    {
      description:
        "Cancel the current execution of a child Task. " +
        "Use this when the child should stop its current work; the Task and its history are preserved. " +
        "The reason is recorded for coordination history. " +
        "This does not delete or retire the Task.",
      inputSchema: {
        target: TASK_ID.describe("Stable child Task ID"),
        reason: BODY.describe("Why the child Task should stop"),
      },
    },
    async ({ target, reason }) => {
      if (!host) return unavailable();
      return jsonContent(await host.cancel(taskId, target, reason));
    },
  );

  server.registerTool(
    "task_send",
    {
      description:
        "Send one durable message to another Task. " +
        "Use this for ordinary coordination, questions, requests for help, context sharing, or routine progress updates. " +
        "It does not change the sender's workflow status. " +
        "The message is queued or delivered by the system; do not check whether the recipient is busy before sending.",
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
        "Commit a material workflow state change for the current Task. " +
        "Use this only when the Task is blocked and cannot proceed, or when it has completed its assigned work. " +
        "The body must contain the actionable reason or the completed result and evidence. " +
        "The system records the update and forwards it to the relevant coordinating Task when applicable. " +
        "Do not use this for ordinary coordination or routine progress updates; use task_send instead.",
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
