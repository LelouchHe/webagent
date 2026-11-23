import type { IncomingMessage, ServerResponse } from "node:http";
import { HTTP_STATUS } from "../http-status.ts";
import {
  InvalidTaskDirectoryError,
  TaskNotFoundError,
  TaskTreeBusyError,
} from "../task-manager.ts";
import {
  TaskAgentIdTypeError,
  TaskAgentNotConfiguredError,
  TaskAgentStartError,
  type TaskOps,
} from "../host/task-ops.ts";
import { validateTaskTitle } from "../shared/task-title.ts";

export interface TaskCreateEndpointOptions {
  taskOps: TaskOps;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString());
    });
    req.on("error", reject);
  });
}

function getClientOpId(req: IncomingMessage): string | null {
  const value = req.headers["x-client-op-id"];
  if (typeof value === "string" && value.length > 0 && value.length <= 128) {
    return value;
  }
  return null;
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function respondCreateError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TaskAgentIdTypeError) {
    json(res, HTTP_STATUS.BAD_REQUEST, {
      error: "agentId must be a string",
    });
  } else if (error instanceof TaskAgentNotConfiguredError) {
    json(res, HTTP_STATUS.BAD_REQUEST, {
      error: `Agent ${error.agentId} is not configured`,
    });
  } else if (error instanceof TaskAgentStartError) {
    json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
      error: error.unavailable
        ? `Agent ${error.agentId} is not available: ${error.reason}`
        : error.reason,
      agentId: error.agentId,
    });
  } else if (message === "parent_not_found") {
    json(res, HTTP_STATUS.BAD_REQUEST, {
      error: "Parent task not found",
    });
  } else if (
    error instanceof InvalidTaskDirectoryError ||
    error instanceof TaskNotFoundError
  ) {
    json(res, HTTP_STATUS.BAD_REQUEST, { error: message });
  } else if (error instanceof TaskTreeBusyError) {
    json(res, HTTP_STATUS.CONFLICT, { error: message });
  } else if (
    message.includes("UNIQUE constraint failed: tasks.parent_id, tasks.title")
  ) {
    json(res, HTTP_STATUS.BAD_REQUEST, {
      error: "A sibling task already has that title",
    });
  } else {
    json(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, { error: message });
  }
}

/**
 * HTTP adapter for the general task-create command. Everything on the other
 * side of `TaskOps.create` is shared with the MCP task-create tool.
 */
export function createTaskCreateEndpoint(
  options: TaskCreateEndpointOptions,
): (
  req: IncomingMessage,
  res: ServerResponse,
  onRequestBodyReadStart?: (url: string) => void,
) => Promise<boolean> {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    onRequestBodyReadStart?: (url: string) => void,
  ): Promise<boolean> => {
    if (req.url !== "/api/v1/tasks" || req.method !== "POST") return false;

    const clientOpId = getClientOpId(req);
    onRequestBodyReadStart?.(req.url);
    let body: {
      cwd?: string;
      inheritFromTaskId?: string;
      source?: string;
      parentId?: string;
      title?: string;
      agentId?: unknown;
    };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
      return true;
    }

    const source = body.source ?? "auto";
    const title =
      body.title !== undefined ? validateTaskTitle(body.title) : undefined;
    if (title !== undefined && (title === null || !body.parentId)) {
      json(res, HTTP_STATUS.BAD_REQUEST, {
        error: "a named child needs a non-empty title and a parent",
      });
      return true;
    }

    try {
      const created = await options.taskOps.create(
        { kind: "user" },
        {
          cwd: body.cwd,
          inheritFromTaskId: body.inheritFromTaskId,
          source,
          parentId: body.parentId,
          title: title ?? undefined,
          workflowStatus: title ? "idle" : undefined,
          agentId: body.agentId,
          clientOpId: clientOpId ?? undefined,
        },
      );
      const activation = created.activation;
      if (!activation) throw new Error("missing_create_activation");
      json(res, HTTP_STATUS.CREATED, {
        id: created.taskId,
        cwd: activation.cwd,
        cwdDisplay: activation.cwdDisplay,
        parentId: activation.parentId,
        parentAgentId: activation.parentAgentId,
        agentId: activation.agentId,
        title: activation.title,
        workflowStatus: activation.workflowStatus,
        source: activation.source,
        configOptions: activation.configOptions,
        agentCommands: activation.agentCommands,
        clientOpId: clientOpId ?? undefined,
      });
    } catch (error) {
      respondCreateError(res, error);
    }
    return true;
  };
}
