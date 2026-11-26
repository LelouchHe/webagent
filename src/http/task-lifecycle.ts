import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  cancelHttpStatus,
  MAX_HOST_CANCEL_SOURCE_LABEL_LENGTH,
  TaskRemoteCancelError,
  type TaskCancelCommand,
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

interface ResolvedCancelEntry {
  command: TaskCancelCommand;
  opId: string | null;
}

function resolveCancelEntry(
  ctx: CancelTaskRouteContext,
  hostRawBody: string | undefined,
): ResolvedCancelEntry | null {
  const {
    req,
    res,
    taskId,
    principal,
    store,
    tasks,
    taskOps,
    hostRegistry,
    json,
    tryReplayClientOp,
    saveClientOpResult,
  } = ctx;

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
      opId: null,
      command: {
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
      },
    };
  }

  if (store.getTask(taskId)) {
    const { opId, replayed } = tryReplayClientOp(req, res, store, taskId);
    if (replayed) return null;
    if (!tasks) {
      const idleBody = { ok: true, status: "idle" };
      saveClientOpResult(store, opId, taskId, HTTP_STATUS.OK, idleBody);
      json(res, HTTP_STATUS.OK, idleBody);
      return null;
    }
    return { opId, command: { kind: "user", taskId } };
  }

  if (!tasks || !taskOps || !hostRegistry || hostRegistry.list().length === 0) {
    json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
    return null;
  }
  return { opId: null, command: { kind: "user", taskId } };
}

export async function handleCancelTaskRoute(
  ctx: CancelTaskRouteContext,
): Promise<void> {
  const hostRawBody =
    ctx.principal?.scope === "host" ? await ctx.readBody(ctx.req) : undefined;
  const entry = resolveCancelEntry(ctx, hostRawBody);
  if (!entry) return;
  const { res, taskId, store, taskOps, json, saveClientOpResult } = ctx;
  if (!taskOps) {
    throw new Error("Task operations are not configured");
  }
  const pending = taskOps.cancel(entry.command);
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
  const okBody = { ok: true, status: result.status };
  saveClientOpResult(store, entry.opId, taskId, status, okBody);
  json(res, status, okBody);
}
