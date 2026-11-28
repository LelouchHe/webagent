import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  MAX_HOST_CANCEL_SOURCE_LABEL_LENGTH,
  TaskRemoteCancelError,
  type TaskCancelCommand,
  type TaskCancelOutcome,
  type TaskOps,
} from "../api/tasks.ts";
import type { TokenRecord } from "../auth-store.ts";
import { HTTP_STATUS } from "../http-status.ts";
import { AgentUnavailableError } from "../agent-registry.ts";
import type { Store, TaskRow } from "../store.ts";
import {
  TaskDeleteStateChangedError,
  TaskRemoteDeleteError,
} from "../task-delete.ts";
import {
  AgentNotReadyError,
  TaskBusyError,
  TaskNotFoundError,
  type TaskManager,
} from "../task-manager.ts";
import type { SseManager } from "../sse-manager.ts";

export function cancelHttpStatus(status: TaskCancelOutcome["status"]): number {
  return status === "cancelling" || status === "superseded"
    ? HTTP_STATUS.ACCEPTED
    : HTTP_STATUS.OK;
}

const HostCancelBodySchema = z.union([
  z.object({ kind: z.literal("user") }).strict(),
  z
    .object({
      kind: z.literal("agent"),
      reason: z.string().max(65_536),
      sourceLabel: z.string().min(1).max(MAX_HOST_CANCEL_SOURCE_LABEL_LENGTH),
    })
    .strict(),
]);

type ParsedHostCancelBody = z.infer<typeof HostCancelBodySchema>;

function parseHostCancelBody(raw: string): ParsedHostCancelBody | null {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "user" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Object.keys(parsed).length === 0
  ) {
    return { kind: "user" };
  }
  const result = HostCancelBodySchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export interface CancelTaskRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  taskId: string;
  principal?: TokenRecord;
  store: Store;
  tasks?: TaskManager;
  taskOps?: TaskOps;
  hostRegistry?: { list(): unknown[] };
  readBody: (req: IncomingMessage) => Promise<string>;
  json: (
    res: ServerResponse,
    status: number,
    data: unknown,
    req?: IncomingMessage,
  ) => void;
}

function resolveCancelEntry(
  ctx: CancelTaskRouteContext,
  hostRawBody: string | undefined,
): TaskCancelCommand | null {
  const { res, taskId, principal, store, tasks, taskOps, hostRegistry, json } =
    ctx;

  if (principal?.scope === "host") {
    const body = parseHostCancelBody(hostRawBody ?? "");
    if (!body) {
      json(res, HTTP_STATUS.BAD_REQUEST, {
        error: "Invalid cancel request body",
      });
      return null;
    }
    const task = store.getTask(taskId);
    const externalParent = store.getExternalParentLink(taskId);
    if (!task || externalParent?.remote_host !== principal.name) {
      json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
      return null;
    }
    if (!tasks) {
      json(res, HTTP_STATUS.OK, { ok: true, status: "idle" });
      return null;
    }
    return {
      kind: "host",
      taskId,
      actor:
        body.kind === "agent"
          ? {
              kind: "agent",
              sourceTaskId: externalParent.remote_task_id,
              sourceLabel: body.sourceLabel,
              reason: body.reason,
            }
          : { kind: "user" },
    };
  }

  if (store.getTask(taskId)) {
    if (!tasks) {
      json(res, HTTP_STATUS.OK, { ok: true, status: "idle" });
      return null;
    }
    return { kind: "user", taskId };
  }

  if (!tasks || !taskOps || !hostRegistry || hostRegistry.list().length === 0) {
    json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
    return null;
  }
  return { kind: "user", taskId };
}

export async function handleCancelTaskRoute(
  ctx: CancelTaskRouteContext,
): Promise<void> {
  const hostRawBody =
    ctx.principal?.scope === "host" ? await ctx.readBody(ctx.req) : undefined;
  const command = resolveCancelEntry(ctx, hostRawBody);
  if (!command) return;
  const { res, taskOps, json } = ctx;
  if (!taskOps) {
    throw new Error("Task operations are not configured");
  }
  const pending = taskOps.cancel(command);
  let result;
  try {
    result = await pending;
  } catch (error) {
    if (error instanceof AgentNotReadyError) {
      json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
        error: "Agent not ready yet",
      });
      return;
    }
    if (error instanceof TaskNotFoundError) {
      json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
      return;
    }
    if (error instanceof TaskRemoteCancelError) {
      if (error.detail.kind === "rejected") {
        if (error.detail.status === HTTP_STATUS.NOT_FOUND) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
          return;
        }
        json(res, error.detail.status, {
          error: error.detail.reason,
          host: error.host,
          remoteStatus: error.detail.status,
          outcome: "rejected",
        });
        return;
      }
      json(res, HTTP_STATUS.BAD_GATEWAY, {
        error: "Remote task cancel result is unknown",
        reason: error.detail.reason,
        host: error.host,
        outcome: "unknown",
      });
      return;
    }
    throw error;
  }
  const status = cancelHttpStatus(result.status);
  json(res, status, { ok: true, status: result.status });
}

export interface DeleteTaskRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  taskId: string;
  principal?: TokenRecord;
  clientOpId: string | null;
  store: Store;
  tasks?: TaskManager;
  sseManager: SseManager;
  activationFields: (
    task: TaskRow,
    opts: { taskId: string },
  ) => Record<string, unknown>;
  json: (
    res: ServerResponse,
    status: number,
    data: unknown,
    req?: IncomingMessage,
  ) => void;
}

async function handleExitRootDelete(
  ctx: DeleteTaskRouteContext,
): Promise<void> {
  const {
    res,
    taskId,
    clientOpId,
    store,
    tasks,
    sseManager,
    activationFields,
    json,
  } = ctx;
  if (!tasks) {
    json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
      error: "Task manager not available",
    });
    return;
  }
  const result = await tasks.exitRoot();
  const replacedBy = result.rootTaskId;
  for (const entry of result.affected) {
    sseManager.broadcast({
      type: "task_deleted",
      taskId: entry.id,
      agentId: entry.agentId,
      ...(entry.id === taskId ? { parentId: null, replacedBy } : {}),
      ...(entry.id === taskId && clientOpId ? { clientOpId } : {}),
    });
  }
  const root = store.getTask(replacedBy);
  if (root) {
    sseManager.broadcast({
      type: "task_created",
      taskId: root.id,
      ...activationFields(root, { taskId: root.id }),
      title: root.title,
      configOptions: tasks.applyStoredConfig(
        tasks.configOptionsForTask(root.id),
        root,
      ),
      agentCommands: tasks.getAgentCommands(root.id),
    });
  }
  json(res, HTTP_STATUS.OK, {
    taskId,
    parentId: null,
    replacedBy,
    ...(clientOpId ? { clientOpId } : {}),
  });
}

function sendDeleteError(
  ctx: DeleteTaskRouteContext,
  err: unknown,
  isHostScope: boolean,
): void {
  const { res, taskId, store, json } = ctx;
  const message =
    err instanceof TaskBusyError
      ? `Cancel active work in ${store.getTaskPath(err.taskId) ?? err.taskId} before deleting this task`
      : err instanceof Error
        ? err.message
        : String(err);
  if (isHostScope) {
    if (err instanceof TaskNotFoundError) {
      json(res, HTTP_STATUS.NOT_FOUND, {
        error: "Task not found",
        code: "not_found",
        failedTaskId: taskId,
      });
      return;
    }
    if (err instanceof TaskBusyError) {
      json(res, HTTP_STATUS.CONFLICT, {
        error: message,
        code: "task_busy",
        failedTaskId: err.taskId,
      });
      return;
    }
    if (
      err instanceof TaskRemoteDeleteError ||
      err instanceof TaskDeleteStateChangedError
    ) {
      json(res, HTTP_STATUS.CONFLICT, {
        error: message,
        code: err.code,
        failedTaskId: err.failedTaskId,
      });
      return;
    }
    throw err;
  }

  if (err instanceof TaskRemoteDeleteError) {
    const status =
      err.outcome === "unknown"
        ? HTTP_STATUS.BAD_GATEWAY
        : HTTP_STATUS.CONFLICT;
    json(res, status, {
      error: message,
      code: err.code,
      host: err.host,
      failedTaskId: err.failedTaskId,
      ...(err.remoteStatus !== undefined
        ? { remoteStatus: err.remoteStatus }
        : {}),
      outcome: err.outcome,
      deletedRemoteTasks: err.deletedRemoteTasks,
    });
    return;
  }
  if (err instanceof TaskDeleteStateChangedError) {
    json(res, HTTP_STATUS.CONFLICT, {
      error: message,
      code: err.code,
      failedTaskId: err.failedTaskId,
      deletedRemoteTasks: err.deletedRemoteTasks,
    });
    return;
  }
  const status =
    err instanceof TaskNotFoundError
      ? HTTP_STATUS.NOT_FOUND
      : err instanceof TaskBusyError
        ? HTTP_STATUS.CONFLICT
        : err instanceof AgentUnavailableError
          ? HTTP_STATUS.SERVICE_UNAVAILABLE
          : HTTP_STATUS.BAD_REQUEST;
  json(res, status, { error: message });
}

export async function handleDeleteTaskRoute(
  ctx: DeleteTaskRouteContext,
): Promise<void> {
  const { res, taskId, principal, clientOpId, store, tasks, sseManager, json } =
    ctx;
  const isHostScope = principal?.scope === "host";
  const task = store.getTask(taskId);
  if (isHostScope) {
    const externalParent = store.getExternalParentLink(taskId);
    if (!task || externalParent?.remote_host !== principal.name) {
      json(res, HTTP_STATUS.NOT_FOUND, {
        error: "Task not found",
        code: "not_found",
        failedTaskId: taskId,
      });
      return;
    }
  } else if (!task) {
    json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
    return;
  }
  if (!isHostScope && taskId === store.rootTaskId) {
    try {
      await handleExitRootDelete(ctx);
    } catch (err) {
      sendDeleteError(ctx, err, false);
    }
    return;
  }
  let affectedStore: { affected: ReturnType<Store["deleteTask"]>["affected"] };
  try {
    affectedStore = tasks
      ? await tasks.deleteTask(undefined, taskId, {
          ...(isHostScope
            ? { requiredExternalParentHost: principal.name }
            : {}),
        })
      : store.deleteTask(taskId);
  } catch (err) {
    sendDeleteError(ctx, err, isHostScope);
    return;
  }
  for (const entry of affectedStore.affected) {
    sseManager.broadcast({
      type: "task_deleted",
      taskId: entry.id,
      agentId: entry.agentId,
      ...(entry.id === taskId ? { parentId: task.parent_id } : {}),
      ...(entry.id === taskId && clientOpId ? { clientOpId } : {}),
    });
  }
  json(res, HTTP_STATUS.OK, {
    taskId,
    parentId: task.parent_id,
    ...(clientOpId ? { clientOpId } : {}),
  });
}
