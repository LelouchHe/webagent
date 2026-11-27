import type { IncomingMessage, ServerResponse } from "node:http";
import type { TokenRecord } from "../auth-store.ts";
import { buildCollaborationBroadcast } from "../collaboration-message.ts";
import { HTTP_STATUS } from "../http-status.ts";
import { COLLABORATION_MESSAGE_NAMESPACE, opIdentity } from "../op-identity.ts";
import type { CollaborationDeliveryStatus } from "../shared/delivery-status.ts";
import { taskDisplayLabel } from "../shared/task-title.ts";
import type { SseManager } from "../sse-manager.ts";
import type { Store } from "../store.ts";
import type { TaskManager } from "../task-manager.ts";

export interface CollaborationMessageRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  sourceTaskId: string;
  principal?: TokenRecord;
  store: Store;
  tasks?: TaskManager;
  sseManager: SseManager;
  readBody: (req: IncomingMessage) => Promise<string>;
  json: (
    res: ServerResponse,
    status: number,
    data: unknown,
    req?: IncomingMessage,
  ) => void;
}

interface CollaborationMessageResponseBody {
  messageId: string;
  deliveryId: string;
  status: CollaborationDeliveryStatus;
  clientOpId?: string;
}

function parseCollaborationBody(body: string): {
  targetTaskId: string;
  body: string;
  sourceLabel?: string;
} {
  const raw = JSON.parse(body) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid_collaboration_body");
  }
  const value = raw as {
    targetTaskId?: unknown;
    body?: unknown;
    sourceLabel?: unknown;
  };
  if (
    typeof value.targetTaskId !== "string" ||
    typeof value.body !== "string" ||
    !value.body.trim()
  ) {
    throw new Error("invalid_collaboration_body");
  }
  const sourceLabel =
    typeof value.sourceLabel === "string"
      ? taskDisplayLabel(value.sourceLabel)
      : undefined;
  return {
    targetTaskId: value.targetTaskId,
    body: value.body,
    ...(sourceLabel ? { sourceLabel } : {}),
  };
}

type ParsedOpId = { ok: true; opId: string | null } | { ok: false };

function parseStrictClientOpId(req: IncomingMessage): ParsedOpId {
  const raw = req.headers["x-client-op-id"];
  if (raw === undefined) return { ok: true, opId: null };
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 128) {
    return { ok: false };
  }
  return { ok: true, opId: raw };
}

function buildAcceptedResponse(
  messageId: string,
  deliveryId: string,
  status: CollaborationDeliveryStatus,
  opId: string | null,
): CollaborationMessageResponseBody {
  return {
    messageId,
    deliveryId,
    status,
    ...(opId !== null ? { clientOpId: opId } : {}),
  };
}

function respondCollaborationOutcome(
  ctx: CollaborationMessageRouteContext,
  tasks: TaskManager,
  outcome: ReturnType<Store["createOrReplayCollaborationMessage"]>,
  opId: string | null,
): void {
  const { req, res, sourceTaskId, store, sseManager, json } = ctx;
  switch (outcome.kind) {
    case "source_not_found":
      json(res, HTTP_STATUS.NOT_FOUND, { error: "Source task not found" });
      return;
    case "conflict":
      json(res, HTTP_STATUS.CONFLICT, {
        error: "Client operation ID conflict",
      });
      return;
    case "target_not_found":
      json(res, HTTP_STATUS.NOT_FOUND, { error: "Target task not found" });
      return;
    case "same_task":
      json(res, HTTP_STATUS.BAD_REQUEST, {
        error: "Source and target task must differ",
      });
      return;
    case "replayed":
      json(
        res,
        HTTP_STATUS.ACCEPTED,
        buildAcceptedResponse(
          outcome.message.id,
          outcome.delivery.id,
          outcome.delivery.status,
          opId,
        ),
        req,
      );
      return;
    case "created": {
      // A user-originated collaboration action counts as activity on the
      // Task where the user entered it, not only on the recipient.
      store.updateTaskLastActive(sourceTaskId);
      const sourceLabel =
        outcome.sourceTask.title ?? outcome.sourceTask.id.slice(0, 8);
      const targetLabel =
        outcome.targetTask.title ?? outcome.targetTask.id.slice(0, 8);
      sseManager.broadcast(
        buildCollaborationBroadcast({
          messageId: outcome.message.id,
          sourceTaskId,
          sourceLabel,
          targetTaskId: outcome.targetTask.id,
          targetLabel,
          role: "source",
          taskId: sourceTaskId,
          body: outcome.message.body,
          deliveryStatus: "queued",
        }),
      );
      json(
        res,
        HTTP_STATUS.ACCEPTED,
        buildAcceptedResponse(
          outcome.message.id,
          outcome.delivery.id,
          outcome.delivery.status,
          opId,
        ),
        req,
      );
      // Delivery targets the recipient's own execution, resolved there.
      void tasks.drainCollaborationDeliveries(outcome.targetTask.id);
      return;
    }
  }
}

export async function handleCollaborationMessageRoute(
  ctx: CollaborationMessageRouteContext,
): Promise<void> {
  const { req, res, sourceTaskId, principal, store, tasks, readBody, json } =
    ctx;

  if (principal?.scope === "host") {
    json(res, HTTP_STATUS.FORBIDDEN, { error: "Forbidden" });
    return;
  }
  if (!tasks) {
    json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
      error: "Task manager not available",
    });
    return;
  }

  const parsedOpId = parseStrictClientOpId(req);
  if (!parsedOpId.ok) {
    json(res, HTTP_STATUS.BAD_REQUEST, {
      error: "Invalid X-Client-Op-Id header",
    });
    return;
  }
  const opId = parsedOpId.opId;

  let body: {
    targetTaskId: string;
    body: string;
    sourceLabel?: string;
  };
  try {
    body = parseCollaborationBody(await readBody(req));
  } catch {
    json(res, HTTP_STATUS.BAD_REQUEST, {
      error: "targetTaskId and non-empty body are required",
    });
    return;
  }

  const callerScope = `token:${principal?.name ?? "anonymous"}`;
  const deterministicMessageId =
    opId !== null
      ? opIdentity(COLLABORATION_MESSAGE_NAMESPACE, callerScope, opId)
      : null;

  let outcome: ReturnType<typeof store.createOrReplayCollaborationMessage>;
  try {
    outcome = store.createOrReplayCollaborationMessage({
      deterministicMessageId,
      sourceTaskId,
      directTargetTaskId: body.targetTaskId,
      sourceActor: "user",
      body: body.body,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("Live task not found")) {
      json(res, HTTP_STATUS.NOT_FOUND, { error: msg });
    } else {
      json(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, { error: msg });
    }
    return;
  }

  respondCollaborationOutcome(ctx, tasks, outcome, opId);
}
