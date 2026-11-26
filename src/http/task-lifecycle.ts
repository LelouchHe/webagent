import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  TaskRemoteCancelRejectedError,
  TaskRemoteCancelUnknownError,
  type TaskOps,
} from "../api/tasks.ts";
import type { TokenRecord } from "../auth-store.ts";
import { HTTP_STATUS } from "../http-status.ts";
import type { Store } from "../store.ts";
import {
  AgentNotReadyError,
  TaskNotFoundError,
  type TaskManager,
} from "../task-manager.ts";

const HostCancelBodySchema = z.union([
  z.object({ kind: z.literal("user") }).strict(),
  z
    .object({
      kind: z.literal("agent"),
      reason: z.string().max(65_536),
      sourceLabel: z.string().min(1).max(256),
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
  tryReplayClientOp: (
    req: IncomingMessage,
    res: ServerResponse,
    store: Store,
    taskId: string,
  ) => { opId: string | null; replayed: boolean };
  saveClientOpResult: (
    store: Store,
    opId: string | null,
    taskId: string,
    status: number,
    body: unknown,
  ) => void;
}

async function handleHostCancelRoute(
  ctx: CancelTaskRouteContext,
  hostName: string,
): Promise<void> {
  const { req, res, taskId, store, tasks, taskOps, readBody, json } = ctx;
  const raw = await readBody(req);
  const body = parseHostCancelBody(raw);
  if (!body) {
    json(res, HTTP_STATUS.BAD_REQUEST, {
      error: "Invalid cancel request body",
    });
    return;
  }
  const task = store.getTask(taskId);
  const externalParent = store.getExternalParentLink(taskId);
  if (!task || externalParent?.remote_host !== hostName) {
    json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
    return;
  }
  if (!tasks) {
    json(res, HTTP_STATUS.OK, { ok: true, status: "idle" });
    return;
  }
  if (!taskOps) {
    throw new Error("Task operations are not configured");
  }
  let result;
  try {
    result = await taskOps.cancel({
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
    });
  } catch (error) {
    if (error instanceof AgentNotReadyError) {
      json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
        error: "Agent not ready yet",
      });
      return;
    }
    throw error;
  }
  const status =
    result.status === "cancelling" || result.status === "superseded"
      ? HTTP_STATUS.ACCEPTED
      : HTTP_STATUS.OK;
  json(res, status, { ok: true, status: result.status });
}

async function handleLocalUserCancelRoute(
  ctx: CancelTaskRouteContext,
): Promise<void> {
  const {
    req,
    res,
    taskId,
    store,
    tasks,
    taskOps,
    json,
    tryReplayClientOp,
    saveClientOpResult,
  } = ctx;
  const { opId, replayed } = tryReplayClientOp(req, res, store, taskId);
  if (replayed) return;

  if (!tasks) {
    const idleBody = { ok: true, status: "idle" };
    saveClientOpResult(store, opId, taskId, HTTP_STATUS.OK, idleBody);
    json(res, HTTP_STATUS.OK, idleBody);
    return;
  }
  if (!taskOps) {
    throw new Error("Task operations are not configured");
  }
  let result;
  try {
    result = await taskOps.cancel({ kind: "user", taskId });
  } catch (error) {
    if (error instanceof AgentNotReadyError) {
      json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
        error: "Agent not ready yet",
      });
      return;
    }
    throw error;
  }
  const status =
    result.status === "cancelling" || result.status === "superseded"
      ? HTTP_STATUS.ACCEPTED
      : HTTP_STATUS.OK;
  const okBody = { ok: true, status: result.status };
  saveClientOpResult(store, opId, taskId, status, okBody);
  json(res, status, okBody);
}

async function handleRemoteUserCancelRoute(
  ctx: CancelTaskRouteContext,
): Promise<void> {
  const { res, taskId, tasks, taskOps, hostRegistry, json } = ctx;
  if (!tasks || !taskOps || !hostRegistry || hostRegistry.list().length === 0) {
    json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
    return;
  }
  let result;
  try {
    result = await taskOps.cancel({ kind: "user", taskId });
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
      return;
    }
    if (error instanceof TaskRemoteCancelRejectedError) {
      if (error.status === HTTP_STATUS.NOT_FOUND) {
        json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
        return;
      }
      json(res, error.status, {
        error: error.reason,
        host: error.host,
        remoteStatus: error.status,
        outcome: "rejected",
      });
      return;
    }
    if (error instanceof TaskRemoteCancelUnknownError) {
      json(res, HTTP_STATUS.BAD_GATEWAY, {
        error: "Remote task cancel result is unknown",
        reason: error.reason,
        host: error.host,
        outcome: "unknown",
      });
      return;
    }
    if (error instanceof AgentNotReadyError) {
      json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
        error: "Agent not ready yet",
      });
      return;
    }
    throw error;
  }
  const status =
    result.status === "cancelling" || result.status === "superseded"
      ? HTTP_STATUS.ACCEPTED
      : HTTP_STATUS.OK;
  json(res, status, { ok: true, status: result.status });
}

export async function handleCancelTaskRoute(
  ctx: CancelTaskRouteContext,
): Promise<void> {
  if (ctx.principal?.scope === "host") {
    await handleHostCancelRoute(ctx, ctx.principal.name);
    return;
  }
  if (ctx.store.getTask(ctx.taskId)) {
    await handleLocalUserCancelRoute(ctx);
    return;
  }
  await handleRemoteUserCancelRoute(ctx);
}
