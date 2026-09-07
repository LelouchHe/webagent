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
        "Discover Tasks available for coordination. " +
        "Use this before choosing a Task to contact.",
      inputSchema: {},
    },
    async () => jsonContent({ tasks: host?.list(taskId) ?? unavailable() }),
  );

  server.registerTool(
    "task_query",
    {
      description:
        "Inspect Task history when earlier context or a prior result needs recovery. " +
        "Do not use this tool to wait for work or poll for completion.",
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
        "Inspect one full history record when the available history summary is insufficient. " +
        "Use a sequence obtained from task_query.",
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
        "Create a child Task for independent work. " +
        "Send its first instruction with task_send, then end the dispatch turn.",
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
        "Stop a child Task's current work when it should no longer continue. " +
        "The Task and its history remain available.",
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
        "Send a durable coordination message to another Task. " +
        "Use it for instructions, questions, findings, routine progress, decisions, " +
        "and follow-up work, including continuing or resuming a Task marked blocked or done. " +
        "When reporting that the current Task is blocked or its assignment is complete, " +
        "use task_update instead. Send messages without waiting for or polling the recipient.",
      inputSchema: {
        target: TASK_ID.describe("Stable target Task ID"),
        body: BODY.describe(
          "Verbatim coordination message; use task_update for blocked/done status",
        ),
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
        "Send a typed lifecycle handoff for the current Task. " +
        "Use blocked when the current work cannot continue without input, and done when the current assignment is complete. " +
        "This does not delete or permanently close the Task: its history remains available and a later task_send may continue it. " +
        "Use task_send for routine progress and follow-up coordination.",
      inputSchema: {
        status: z.enum(["blocked", "done"]),
        body: BODY.describe(
          "Actionable blocker explanation or evidence-backed completion result",
        ),
      },
    },
    async ({ status, body }) => {
      if (!host) return unavailable();
      await host.update(taskId, status, body);
      return accepted();
    },
  );
}
