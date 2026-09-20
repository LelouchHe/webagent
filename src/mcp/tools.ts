import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpTaskHistoryRow } from "./task-history.ts";

export type McpWorkflowStatus = "running" | "idle" | "blocked" | "done";

export interface McpTaskListItem {
  id: string;
  title: string;
  relation: "self" | "parent" | "child" | "sibling";
  /**
   * Lifecycle status of the Task's last turn, matching `task_query`'s
   * `workflowStatus`. `done` is per turn, not a lifecycle terminal.
   */
  workflowStatus: McpWorkflowStatus;
  /**
   * Live execution source from the runtime: `agent` while an ACP turn or
   * delivery is running, `bash` while a user shell command owns the task, and
   * `idle` otherwise. Distinct from `workflowStatus`, which is the last typed
   * report, not execution truth.
   */
  executionState: "idle" | "agent" | "bash";
  /**
   * ISO-8601 time of the Task's latest qualifying agent-runtime event, or
   * null when none has been observed. Unlike `lastEventAt`, it ignores user
   * and system events, so it is a silence signal for a running turn.
   */
  lastAgentActivityAt: string | null;
  /**
   * `created_at` of the Task's most recent persisted event, any type — the
   * Task's own activity clock. Rendered as ISO-8601 UTC with an explicit `Z`,
   * like every other MCP timestamp. `null` when the Task has no persisted
   * events yet. It is a lag signal, not proof of work: a long silent tool call
   * can look stale while the Task is still running.
   */
  lastEventAt: string | null;
}

export type McpTaskHistoryRecord = McpTaskHistoryRow;

export interface McpTaskQueryInput {
  taskId?: string;
  text?: string;
  range?: [number, number];
}

export interface McpTaskQueryResult {
  task_id: string;
  max_seq: number;
  rows: McpTaskHistoryRow[];
}

export interface McpTaskReadInput {
  taskId: string;
  seqs: number[];
}

export interface McpTaskReadRow {
  seq: number;
  type: string;
  at: string;
  from: string;
  data: unknown;
}

export interface McpTaskReadResult {
  task_id: string;
  rows: McpTaskReadRow[];
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
  read(sourceTaskId: string, input: McpTaskReadInput): McpTaskReadResult;
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
        "Use this before choosing a Task to contact, and inspect each item's " +
        "workflowStatus, executionState, lastEventAt, and lastAgentActivityAt. " +
        "workflowStatus is per turn, not a lifecycle terminal: a `done` Task can " +
        "be woken and run again. executionState is the live runtime source " +
        "(`agent`, `bash`, or `idle`). lastEventAt is the created_at of the " +
        "Task's latest persisted event, or null when it has none; it is a lag " +
        "signal, not proof of work — a long silent tool call can look stale " +
        "while the Task is still running. lastAgentActivityAt is the latest " +
        "qualifying agent-runtime event only, so it is a silence signal for a " +
        "running turn. This is a cheap inspection, not a polling loop.",
      inputSchema: {},
    },
    async () => jsonContent({ tasks: host?.list(taskId) ?? unavailable() }),
  );

  server.registerTool(
    "task_query",
    {
      description:
        "List a flat event index for this Task or a visible relative. " +
        "Rows include task-local seq, type, byte size, and bounded projections. " +
        "Use range to page older rows and text for fixed-string search (ASCII case folding only). " +
        "Thinking rows are included; this is for history recovery, diagnosis, or audit, not polling.",
      inputSchema: {
        task_id: TASK_ID.nullable()
          .optional()
          .describe(
            "Visible Task ID; null or omission defaults to the current Task",
          ),
        text: z
          .string()
          .min(1)
          // Zod's own `.max()` counts UTF-16 code units while the documented
          // limit is code points (and JSON Schema's `maxLength` is code
          // points), so validate the unit the contract names and advertise it
          // for clients separately.
          .refine((value) => Array.from(value).length <= 128, {
            message: "Search text must be at most 128 code points",
          })
          .meta({ maxLength: 128 })
          .nullable()
          .optional()
          .describe(
            "Fixed string to find (max 128 code points); ASCII case folding only; null is omitted",
          ),
        range: z
          .tuple([z.number().int(), z.number().int()])
          .nullable()
          .optional()
          .describe("Inclusive seq range; negative values index from max_seq"),
      },
    },
    async ({ task_id, text, range }) =>
      jsonContent(
        host?.query(taskId, {
          taskId: task_id ?? undefined,
          text: text ?? undefined,
          range: range ?? undefined,
        }) ?? unavailable(),
      ),
  );

  server.registerTool(
    "task_read",
    {
      description:
        "Read complete persisted event rows by task-local sequence. " +
        "Use seqs obtained from task_query; duplicate seqs are removed and rows return in ascending order. " +
        "Thinking events are included.",
      inputSchema: {
        task_id: TASK_ID.describe("Visible target Task ID"),
        seqs: z
          .array(z.number().int().min(1))
          .min(1)
          .describe("Task-local event sequences to read"),
      },
    },
    async ({ task_id, seqs }) =>
      jsonContent(
        host?.read(taskId, { taskId: task_id, seqs }) ?? unavailable(),
      ),
  );

  server.registerTool(
    "task_create",
    {
      description:
        "Create a direct child Task for independent work. " +
        "Immediately use task_send to give it the first instruction, then end the dispatch turn without polling.",
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
        "Use it for instructions, questions, findings, progress, decisions, and follow-up. " +
        "This is communication, not a lifecycle handoff; use task_update(done|blocked) for completion or blocking. " +
        "Do not wait for or poll the recipient.",
      inputSchema: {
        target: TASK_ID.describe("Stable target Task ID"),
        body: BODY.describe("Verbatim coordination or handoff message"),
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
        "Send a typed lifecycle account for the current Task: `done` when the assignment is complete, `blocked` when it needs input or a decision. " +
        "There is no correlation parameter: the runtime identifies the directed obligation from the current Task's sole record and closes it when this update comes from an eligible current turn. " +
        "The parent receives the account and decides the next step; an update outside an eligible turn is still recorded and reported without closing the obligation. " +
        "This does not delete or permanently close the Task. Use task_send for normal communication.",
      inputSchema: {
        status: z.enum(["blocked", "done"]),
        body: BODY.describe(
          "Handoff body: explain the blocker or report the completed result",
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
