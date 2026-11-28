import type { IncomingMessage, ServerResponse } from "node:http";
import type { TokenRecord } from "../auth-store.ts";
import { HTTP_STATUS } from "../http-status.ts";
import { COLLABORATION_MESSAGE_NAMESPACE, opIdentity } from "../op-identity.ts";
import { parseClientOpIdHeader } from "./ops-adapter.ts";
import type { CollaborationDeliveryStatus } from "../shared/delivery-status.ts";
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

interface CollaborationMessageRequestBody {
  targetTaskId: string;
  body: string;
}

function parseCollaborationBody(body: string): CollaborationMessageRequestBody {
  const raw = JSON.parse(body) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid_collaboration_body");
  }
  const value = raw as {
    targetTaskId?: unknown;
    body?: unknown;
  };
  if (
    typeof value.targetTaskId !== "string" ||
    typeof value.body !== "string" ||
    !value.body.trim()
  ) {
    throw new Error("invalid_collaboration_body");
  }
  return {
    targetTaskId: value.targetTaskId,
    body: value.body,
  };
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
  const { req, res, sourceTaskId, store, json } = ctx;
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
      // Persisted collaboration rows publish automatically via outer-commit feed.
      store.updateTaskLastActive(sourceTaskId);
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

  const parsedOpId = parseClientOpIdHeader(req);
  if (parsedOpId.kind === "invalid") {
    json(res, HTTP_STATUS.BAD_REQUEST, {
      error: "Invalid X-Client-Op-Id header",
      code: "invalid_op_id",
    });
    return;
  }
  const opId = parsedOpId.kind === "valid" ? parsedOpId.opId : null;

  let body: CollaborationMessageRequestBody;
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
