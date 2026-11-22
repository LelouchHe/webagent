import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpTaskHistoryRow } from "./task-history.ts";
import { buildTaskCreateDescription } from "./task-create-description.ts";

export type McpWorkflowStatus =
  "running" | "idle" | "waiting" | "blocked" | "done";

export interface McpTaskListItem {
  id: string;
  title: string;
  relation: "self" | "parent" | "child";
  /**
   * Lifecycle status of the Task's last turn, matching `task_query`'s
   * `workflowStatus`. `done` is per turn, not a lifecycle terminal.
   */
  workflowStatus?: McpWorkflowStatus;
  /**
   * Live execution source from the runtime: `agent` while an ACP turn or
   * delivery is running, `bash` while a user shell command owns the task, and
   * `idle` otherwise. Distinct from `workflowStatus`, which is the last typed
   * report, not execution truth.
   */
  executionState?: "idle" | "agent" | "bash";
  /**
   * ISO-8601 time of the Task's latest qualifying agent-runtime event, or
   * null when none has been observed. Unlike `lastEventAt`, it ignores user
   * and system events, so it is a silence signal for a running turn.
   */
  lastAgentActivityAt?: string | null;
  /**
   * `created_at` of the Task's most recent persisted event, any type — the
   * Task's own activity clock. Rendered as ISO-8601 UTC with an explicit `Z`,
   * like every other MCP timestamp. `null` when the Task has no persisted
   * events yet. It is a lag signal, not proof of work: a long silent tool call
   * can look stale while the Task is still running.
   */
  lastEventAt?: string | null;
  /** True when the endpoint is represented by a persisted host binding. */
  external?: boolean;
  hostLabel?: string;
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
  taskId?: string;
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
  /**
   * The execution agent the child is created for, as configured at startup.
   * Omitted means "this Task's agent", which is the only value the caller can
   * always derive without knowing the deployment.
   */
  agent?: string;
}

export interface McpTaskCreateResult {
  taskId: string;
}

/**
 * The caller identity of one MCP request, captured once at the endpoint and
 * never mutated.
 *
 * `taskId` is the agent's own task, `agentId` the agent that capability was
 * minted for, and `generation` the execution generation the *token* was
 * promoted for. That generation is the authorization: a request that outlives
 * a rotation must not write even though its token authenticated, and an old
 * token must not inherit the task's newer generation. `initializing` marks the
 * pending window of a session creation, where only the protocol handshake is
 * allowed.
 */
export interface McpCallerPrincipal {
  readonly taskId: string;
  readonly agentId: string;
  readonly generation: number | null;
  readonly initializing: boolean;
}

/**
 * Operations supplied by the WebAgent runtime behind the MCP tool surface.
 *
 * Every operation takes the request's immutable caller principal: the write
 * operations re-check it at their own submission boundary (immediately before
 * the first side effect), so a rotation that lands while a request is in
 * flight cannot be written through.
 */
export interface McpTaskToolHost {
  list(principal: McpCallerPrincipal): McpTaskListItem[];
  query(
    principal: McpCallerPrincipal,
    input: McpTaskQueryInput,
  ): McpTaskQueryResult;
  read(
    principal: McpCallerPrincipal,
    input: McpTaskReadInput,
  ): McpTaskReadResult;
  cancel(
    principal: McpCallerPrincipal,
    targetTaskId: string,
    reason: string,
  ): Promise<McpTaskCancelResult>;
  create(
    principal: McpCallerPrincipal,
    input: McpTaskCreateInput,
  ): Promise<McpTaskCreateResult>;
  send(
    principal: McpCallerPrincipal,
    targetTaskId: string,
    body: string,
  ): Promise<void>;
  update(
    principal: McpCallerPrincipal,
    status: "waiting" | "blocked" | "done",
    body: string,
  ): Promise<{ note?: string }>;
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

/** Registration inputs that come from the running deployment, not the request. */
export interface McpToolRegistrationOptions {
  /**
   * Configured agent ids from the startup snapshot. The MCP server is built per
   * request, so `task_create`'s description can be computed against the
   * deployment that is actually running instead of a static schema.
   */
  configuredAgentIds?: readonly string[];
}

/** Register the Agent-facing Task control-plane tools. */
export function registerMcpTools(
  server: McpServer,
  principal: McpCallerPrincipal,
  host?: McpTaskToolHost,
  options: McpToolRegistrationOptions = {},
): void {
  /**
   * Business tools never run in the pending window, and every call re-checks
   * the caller's authority. The error text is explicit so an agent can tell
   * "not yet" from "not allowed".
   */
  const guard = (): void => {
    if (!host) unavailable();
    if (principal.initializing) throw new Error("initializing");
  };

  server.registerTool(
    "task_list",
    {
      description:
        "List the current Task, its parent, and its direct children. " +
        "workflowStatus is the last typed update or the runtime turn status " +
        "(`running`, `idle`); it is not a lifecycle terminal. executionState is " +
        "the live runtime (`agent`, `bash`, or `idle`). lastEventAt is the " +
        "created_at of the latest persisted event of any type, or null. " +
        "lastAgentActivityAt is the latest agent-runtime event (output, " +
        "thinking, tool call, plan, or permission request), or null.",
      inputSchema: {},
    },
    async () => {
      guard();
      return jsonContent({ tasks: host!.list(principal) });
    },
  );

  server.registerTool(
    "task_query",
    {
      description:
        "List a flat event index for a visible Task. " +
        "Rows include task-local seq, type, byte size, and bounded projections; thinking rows are included. " +
        "Reads never start an execution.",
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
        // Not z.tuple(): that advertises array-form `items` (draft-07) or
        // `prefixItems` (2020-12), which sit outside the OpenAI
        // function-calling subset and make OpenAI-compatible providers
        // (Xiaomi MiMo, Moonshot) reject the whole request with a 400. A
        // 2-element array carries the identical constraint, and the transform
        // keeps the tuple type the host contract expects. The MCP SDK converts
        // input schemas with io: "input", so it sees the array, not the
        // transform.
        range: z
          .array(z.number().int())
          .length(2)
          .transform((value): [number, number] => [value[0], value[1]])
          .nullable()
          .optional()
          .describe("Inclusive seq range; negative values index from max_seq"),
      },
    },
    async ({ task_id, text, range }) => {
      guard();
      return jsonContent(
        host!.query(principal, {
          taskId: task_id ?? undefined,
          text: text ?? undefined,
          range: range ?? undefined,
        }),
      );
    },
  );

  server.registerTool(
    "task_read",
    {
      description:
        "Read complete persisted event rows of a visible Task by task-local sequence. " +
        "Duplicate seqs are removed and rows return in ascending order; thinking events are included. " +
        "Reads never start an execution.",
      inputSchema: {
        task_id: TASK_ID.nullable()
          .optional()
          .describe(
            "Visible Task ID; null or omission defaults to the current Task",
          ),
        seqs: z
          .array(z.number().int().min(1))
          .min(1)
          .describe("Task-local event sequences to read"),
      },
    },
    async ({ task_id, seqs }) => {
      guard();
      return jsonContent(
        host!.read(principal, { taskId: task_id ?? undefined, seqs }),
      );
    },
  );

  server.registerTool(
    "task_create",
    {
      description: buildTaskCreateDescription(options.configuredAgentIds ?? []),
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
            "Working directory; local creation inherits the current Task, while agent@host omission uses the owner host default",
          ),
        agent: z
          .string()
          .trim()
          .min(1)
          .nullable()
          .optional()
          .describe(
            "Execution agent; null or omission inherits the current Task's agent",
          ),
        model: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .nullable()
          .optional()
          .describe(
            "Model override; omitted local same-agent children inherit, while remote children use owner defaults",
          ),
        thinking: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .nullable()
          .optional()
          .describe(
            "Thinking override; omitted local same-agent children inherit, while remote children use owner defaults",
          ),
      },
    },
    async ({ title, cwd, agent, model, thinking }) => {
      guard();
      return jsonContent(
        await host!.create(principal, {
          title,
          cwd: cwd ?? undefined,
          agent: agent ?? undefined,
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
        "Stop a child Task's current work. The Task and its history remain available.",
      inputSchema: {
        target: TASK_ID.describe("Stable child Task ID"),
        reason: BODY.describe("Reason recorded with the cancellation"),
      },
    },
    async ({ target, reason }) => {
      guard();
      return jsonContent(await host!.cancel(principal, target, reason));
    },
  );

  server.registerTool(
    "task_send",
    {
      description:
        "Queue a durable message to a visible Task. " +
        "It is delivered at the recipient's next turn boundary and wakes it. " +
        "An agent's message to its direct child opens or keeps open the account for that edge once it is delivered.",
      inputSchema: {
        target: TASK_ID.describe("Stable target Task ID"),
        body: BODY.describe("Message body, delivered verbatim"),
      },
    },
    async ({ target, body }) => {
      guard();
      await host!.send(principal, target, body);
      return accepted();
    },
  );

  server.registerTool(
    "task_update",
    {
      description:
        "Record a typed update for the current Task and set its workflowStatus. " +
        "`done` and `blocked` are delivered to the requester (the source of the open account, or the current parent when none is open), wake it, and settle the account, even when late. " +
        "`waiting` is only recorded: it is not delivered, wakes no one, and leaves the account open; the result says when the runtime cannot see what will wake this Task. " +
        "Any update satisfies the current turn's account check. The Task is not deleted or closed.",
      inputSchema: {
        status: z
          .enum(["waiting", "blocked", "done"])
          .describe(
            "`done`: the work is complete. `blocked`: progress needs the requester, a human, an external event, missing information, or permission. `waiting`: work continues without the requester, and a Task this one dispatched or its own background work will wake it.",
          ),
        body: BODY.describe(
          "Update body, delivered verbatim with done or blocked",
        ),
      },
    },
    async ({ status, body }) => {
      guard();
      const { note } = await host!.update(principal, status, body);
      return jsonContent({ accepted: true, ...(note ? { note } : {}) });
    },
  );
}
