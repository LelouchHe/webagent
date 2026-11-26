import type { IncomingMessage, ServerResponse } from "node:http";
import type { TaskOps } from "../api/tasks.ts";
import { HTTP_STATUS } from "../http-status.ts";
import type { Store } from "../store.ts";
import { AgentNotReadyError, type TaskManager } from "../task-manager.ts";

export interface CancelTaskRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  taskId: string;
  store: Store;
  tasks?: TaskManager;
  taskOps?: TaskOps;
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

export async function handleCancelTaskRoute(
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
  const task = store.getTask(taskId);
  if (!task) {
    json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
    return;
  }
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
