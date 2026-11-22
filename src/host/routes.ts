import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import type { TokenRecord } from "../auth-store.ts";
import { canonicalCwd } from "../cwd-path.ts";
import { expandHomePath } from "../home-path.ts";
import { HTTP_STATUS } from "../http-status.ts";
import {
  HOST_API_VERSION,
  HostCreateSchema,
  HostDispatchSchema,
  requestHash,
  targetNotFoundBody,
} from "./protocol.ts";
import type { HostStore } from "./store.ts";

export interface HostRouteDeps {
  store: HostStore;
  agentIds: readonly string[];
  defaultCwd: string;
  principal: TokenRecord;
  onBodyRead?: () => void;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HostRouteDeps,
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readBody(req));
  } catch {
    json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
    return;
  }
  const parsed = HostCreateSchema.safeParse(raw);
  if (!parsed.success) {
    json(res, HTTP_STATUS.BAD_REQUEST, {
      error: "Invalid host create request",
      code: "invalid_request",
    });
    return;
  }
  const requestHashValue = requestHash(parsed.data);
  const replay = deps.store.getHostCreateResult(
    deps.principal.hash,
    parsed.data.createKey,
    requestHashValue,
  );
  if (replay) {
    json(
      res,
      replay.status === "reused" ? HTTP_STATUS.OK : HTTP_STATUS.CONFLICT,
      replay.status === "reused"
        ? { taskId: replay.taskId }
        : {
            error: "createKey already used for a different request",
            code: "create_conflict",
          },
    );
    return;
  }
  if (!deps.agentIds.includes(parsed.data.agent)) {
    json(res, HTTP_STATUS.BAD_REQUEST, {
      error: "Agent is not configured on this host",
      code: "unknown_agent",
    });
    return;
  }
  const cwd = canonicalCwd(expandHomePath(parsed.data.cwd ?? deps.defaultCwd));
  if (!isAbsolute(cwd)) {
    json(res, HTTP_STATUS.BAD_REQUEST, {
      error: "cwd must be absolute or start with ~",
      code: "invalid_cwd",
    });
    return;
  }
  try {
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) throw new Error("not directory");
  } catch {
    json(res, HTTP_STATUS.BAD_REQUEST, {
      error: "cwd is not an accessible directory",
      code: "invalid_cwd",
    });
    return;
  }
  const created = deps.store.createHostTask({
    credentialHash: deps.principal.hash,
    parentTaskId: parsed.data.parentTaskId,
    createKey: parsed.data.createKey,
    requestHash: requestHashValue,
    agentId: parsed.data.agent,
    cwd,
    title: parsed.data.title,
    model: parsed.data.model,
    thinking: parsed.data.thinking,
  });
  if (created.status === "conflict") {
    json(res, HTTP_STATUS.CONFLICT, {
      error: "createKey already used for a different request",
      code: "create_conflict",
    });
    return;
  }
  json(
    res,
    created.status === "created" ? HTTP_STATUS.CREATED : HTTP_STATUS.OK,
    { taskId: created.taskId },
  );
}

async function handleDispatch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HostRouteDeps,
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readBody(req));
  } catch {
    json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
    return;
  }
  const parsed = HostDispatchSchema.safeParse(raw);
  if (!parsed.success) {
    json(res, HTTP_STATUS.BAD_REQUEST, {
      error: "Invalid host dispatch request",
      code: "invalid_request",
    });
    return;
  }
  const received = deps.store.receiveHostDispatch({
    credentialHash: deps.principal.hash,
    remoteMessageId: parsed.data.messageId,
    requestHash: requestHash(parsed.data),
    targetTaskId: parsed.data.to,
    body: parsed.data.body,
  });
  if (received.status === "conflict") {
    json(res, HTTP_STATUS.CONFLICT, {
      error: "messageId already used for a different request",
      code: "message_conflict",
    });
    return;
  }
  if (received.status === "target_not_found") {
    json(res, HTTP_STATUS.NOT_FOUND, targetNotFoundBody());
    return;
  }
  if (received.status === "forbidden") {
    json(res, HTTP_STATUS.FORBIDDEN, {
      error: "Task is not owned by this credential",
      code: "target_not_allowed",
    });
    return;
  }
  json(res, HTTP_STATUS.ACCEPTED, {
    accepted: true,
    messageId: received.localMessageId,
  });
}

export async function handleHostRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HostRouteDeps,
): Promise<boolean> {
  const url = req.url ?? "/";
  const prefix = "/api/v1/host";
  if (url !== prefix && !url.startsWith(`${prefix}/`)) return false;
  deps.onBodyRead?.();

  if (url === prefix && req.method === "GET") {
    json(res, HTTP_STATUS.OK, {
      host_api_version: HOST_API_VERSION,
      agent_ids: [...deps.agentIds],
    });
    return true;
  }

  if (url === `${prefix}/tasks` && req.method === "POST") {
    await handleCreate(req, res, deps);
    return true;
  }

  if (url === `${prefix}/messages` && req.method === "POST") {
    await handleDispatch(req, res, deps);
    return true;
  }

  if (url === `${prefix}/messages` && req.method === "GET") {
    json(res, HTTP_STATUS.OK, {
      messages: deps.store.listHostOutbox(deps.principal.hash),
    });
    return true;
  }

  const ack = url.match(/^\/api\/v1\/host\/messages\/([^/]+)\/ack$/);
  if (ack && req.method === "POST") {
    const result = deps.store.ackHostMessage(
      deps.principal.hash,
      decodeURIComponent(ack[1]),
    );
    if (result.status === "acked") {
      json(res, HTTP_STATUS.OK, { acknowledged: true });
    } else if (result.status === "forbidden") {
      json(res, HTTP_STATUS.FORBIDDEN, { error: "Forbidden" });
    } else {
      json(res, HTTP_STATUS.NOT_FOUND, { error: "Message not found" });
    }
    return true;
  }

  return false;
}
