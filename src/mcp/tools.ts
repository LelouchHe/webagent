import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  TaskAgentNotConfiguredError,
  TaskAgentStartError,
  TaskCreateConfigError,
  type TaskCaller,
  type TaskOps,
} from "../host/task-ops.ts";
import { buildTaskCreateDescription } from "./task-create-description.ts";
import {
  agentStartError,
  configOverrideError,
  unconfiguredAgentError,
} from "./create-errors.ts";

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
  principal: TaskCaller,
  host?: TaskOps,
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
            "Working directory; null or omission inherits the current Task",
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
    async ({ title, cwd, agent, model, thinking }) => {
      guard();
      try {
        return jsonContent({
          taskId: (
            await host!.create(
              { kind: "agent", principal },
              {
                title,
                cwd: cwd ?? undefined,
                agentId: agent ?? undefined,
                model: model ?? undefined,
                thinking: thinking ?? undefined,
                parentId: principal.taskId,
                inheritFromTaskId: principal.taskId,
                source: "agent",
              },
            )
          ).taskId,
        });
      } catch (error) {
        if (error instanceof TaskAgentNotConfiguredError) {
          throw new Error(unconfiguredAgentError(error.agentId), {
            cause: error,
          });
        }
        if (error instanceof TaskAgentStartError) {
          throw new Error(agentStartError(error.agentId, error.reason), {
            cause: error,
          });
        }
        if (error instanceof TaskCreateConfigError) {
          throw new Error(configOverrideError(error), { cause: error });
        }
        throw error;
      }
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
