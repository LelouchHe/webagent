// REST API client for all server communication.
// Replaces WebSocket message sends with typed fetch calls.

import type { ConfigOption, TaskDetail, TaskSummary } from "../../src/types.ts";
import {
  isCollaborationDeliveryStatus,
  type CollaborationDeliveryStatus,
} from "../../src/shared/delivery-status.ts";

export class ApiError extends Error {
  name = "ApiError";
  status: number;
  /** The agent the server actually tried to start, when the failure names one.
   *  A create/clear target can be inherited, so the caller's submission-time
   *  guess may be wrong; this is the server's own answer. */
  agentId: string | null;
  constructor(status: number, message: string, agentId: string | null = null) {
    super(message);
    this.status = status;
    this.agentId = agentId;
  }
}

/**
 * A request the client refuses to build. It never reaches the server, so it
 * cannot produce an HTTP status; the failure report path treats it as a
 * definite rejection.
 */
export class InvalidRequestError extends Error {
  name = "InvalidRequestError";
}

/**
 * The `agentId` field of a task request.
 *
 * `null`/omitted means "apply the server's inheritance rule". An empty string
 * is neither: the caller named an agent, so silently dropping the field would
 * create or rotate the task on some other agent. It is an upstream bug and is
 * refused here instead of becoming a server-side "Agent  is not configured".
 */
function agentIdField(
  agentId: string | null | undefined,
  operation: string,
): Record<string, string> {
  if (agentId === undefined || agentId === null) return {};
  if (agentId === "") {
    throw new InvalidRequestError(
      `${operation}: agentId is an empty string — that is an upstream bug, not "inherit"; ` +
        `omit the field (or pass null) to inherit, so a named agent is never silently dropped`,
    );
  }
  return { agentId };
}

/**
 * Ceiling for a single request. Without one, a stalled connection (mobile
 * handoff, suspended runtime) leaves the promise pending indefinitely — the
 * browser's own network timeout is not guaranteed and can be minutes. Callers
 * downstream latch state on those promises (the replay gate, the per-task
 * inflight map, the SSE reconnect chain), so a request that never settles is
 * indistinguishable from a hung app.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** For small requests on the recovery path, where waiting out the default
 *  would keep the client disconnected far longer than a retry costs. */
export const FAST_TIMEOUT_MS = 10_000;

/**
 * Run a request under a deadline. The signal is threaded into `fetch` so the
 * timeout covers reading the body too, not just the response headers, and the
 * timer is always cleared — an armed timer keeps the event loop alive and
 * silently inflates test runtime.
 */
export async function withTimeout<T>(
  run: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  if (typeof AbortController !== "function") return run(undefined);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  // A pending deadline must not by itself keep a host process alive; without
  // this, any caller that legitimately abandons a request holds the runtime
  // open for the full timeout. No-op in browsers, where timers have no unref.
  (timer as { unref?: () => void }).unref?.();
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function request<T = unknown>(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return withTimeout(async (signal) => {
    const res = await fetch(url, signal ? { ...init, signal } : init);
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      let agentId: string | null = null;
      try {
        const body = (await res.json()) as Record<string, unknown>;
        if (body.error)
          message =
            typeof body.error === "string"
              ? body.error
              : JSON.stringify(body.error);
        // Only this one field is lifted out of the body: a failed start names
        // its real target, everything else stays a message.
        if (typeof body.agentId === "string") agentId = body.agentId;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, message, agentId);
    }
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }, timeoutMs);
}

function post<T = unknown>(
  url: string,
  body: Record<string, unknown>,
  clientOpId?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (clientOpId) headers["X-Client-Op-Id"] = clientOpId;
  return request<T>(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
}

export function newOpId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return (
    "op-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

// --- Task CRUD ---

export function createTask(
  opts?: {
    cwd?: string;
    inheritFromTaskId?: string | null;
    parentId?: string | null;
    title?: string;
    /**
     * Explicit execution environment. `null`/omitted = the server's inheritance
     * rule; an empty string is refused rather than silently treated as
     * "inherit".
     */
    agentId?: string | null;
    host?: string | null;
  },
  clientOpId?: string,
): Promise<Record<string, unknown>> {
  // An empty `agentId` throws before the request is built.
  let agent = opts?.agentId;
  let host = opts?.host;
  if (agent?.includes("@")) {
    const coordinate = agent.split("@");
    if (coordinate.length !== 2 || !coordinate[0] || !coordinate[1]) {
      throw new InvalidRequestError("createTask: invalid agent@host");
    }
    [agent, host] = coordinate;
  }
  const body: Record<string, unknown> = {
    ...agentIdField(agent, "createTask"),
  };
  if (host) body.host = host;
  if (opts?.cwd) body.cwd = opts.cwd;
  if (opts?.inheritFromTaskId) body.inheritFromTaskId = opts.inheritFromTaskId;
  if (opts?.parentId) body.parentId = opts.parentId;
  if (opts?.title !== undefined) body.title = opts.title;
  return post("/api/v1/tasks", body, clientOpId);
}

export function bootstrapTask(
  clientOpId?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {};
  if (clientOpId) headers["X-Client-Op-Id"] = clientOpId;
  return request("/api/v1/tasks/bootstrap", {
    method: "POST",
    headers,
  });
}

export function clearTask(
  id: string,
  opts?: {
    cwd?: string;
    /** `null`/omitted = keep the task's own agent; empty is refused. */
    agentId?: string | null;
  },
): Promise<Record<string, unknown>> {
  // An empty `agentId` throws before the request is built; removing a stale
  // `cwd` silently would rotate onto another agent's directory.
  const body: Record<string, unknown> = {
    ...agentIdField(opts?.agentId, "clearTask"),
  };
  if (opts?.cwd) body.cwd = opts.cwd;
  return post("/api/v1/tasks/" + id + "/clear", body);
}

export function compactTask(
  id: string,
  prompt?: string,
): Promise<Record<string, unknown>> {
  return post("/api/v1/tasks/" + id + "/compact", {
    ...(prompt !== undefined ? { prompt } : {}),
  });
}

export interface DeleteTaskResult {
  taskId: string;
  parentId?: string | null;
  /** The Root that replaced this one, when the deleted task was the Root. */
  replacedBy?: string;
  clientOpId?: string;
}

export async function deleteTask(
  id: string,
): Promise<DeleteTaskResult | undefined> {
  const clientOpId = newOpId();
  const result = await request<DeleteTaskResult | undefined>(
    "/api/v1/tasks/" + id,
    {
      method: "DELETE",
      headers: { "X-Client-Op-Id": clientOpId },
    },
  );
  return result
    ? { ...result, clientOpId: result.clientOpId ?? clientOpId }
    : result;
}

export interface ArchiveTaskResult {
  status: "archived" | "already_archived";
  taskId: string;
  parentId: string | null;
  parentPath: string | null;
  /** True when the task still owed its former parent an account.
   *  Archiving cuts that edge; the debt is recorded but never delivered. */
  pendingAccount: boolean;
}

export function archiveTask(id: string): Promise<ArchiveTaskResult> {
  return post(`/api/v1/tasks/${encodeURIComponent(id)}/archive`, {});
}

export interface UnarchiveTaskResult {
  status: "unarchived";
  taskId: string;
  parentId: string;
  parentPath: string;
}

export function unarchiveTask(id: string): Promise<UnarchiveTaskResult> {
  return post(`/api/v1/tasks/${encodeURIComponent(id)}/unarchive`, {});
}

/** Only the tops of archived trees: a live parentless non-Root task is what
 *  the server calls an archived tree. */
export async function listArchivedTaskTops(): Promise<TaskSummary[]> {
  const tasks = await listTasks(true);
  return tasks.filter((task) => task.parent_id === null && !task.isRoot);
}

export interface CollaborationMessageAccepted {
  messageId: string;
  deliveryId: string;
  status: CollaborationDeliveryStatus;
  clientOpId?: string;
}

export type CollaborationMessageSendResult =
  | { kind: "accepted"; response: CollaborationMessageAccepted }
  | { kind: "rejected"; status: number; message: string }
  | { kind: "unknown"; message: string };

const COLLABORATION_MESSAGE_RETRIES = 2;

function extractErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const err = (body as Record<string, unknown>).error;
    if (typeof err === "string" && err.length > 0) return err;
    if (err !== undefined && err !== null) return JSON.stringify(err);
  }
  return `HTTP ${status}`;
}

function parseCollaborationAccepted(
  raw: unknown,
  expectedOpId: string | null,
): CollaborationMessageAccepted | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.messageId !== "string" ||
    value.messageId.length === 0 ||
    typeof value.deliveryId !== "string" ||
    value.deliveryId.length === 0 ||
    !isCollaborationDeliveryStatus(value.status)
  ) {
    return null;
  }
  if (expectedOpId !== null) {
    if (value.clientOpId !== expectedOpId) return null;
  } else if (value.clientOpId !== undefined) {
    return null;
  }
  return {
    messageId: value.messageId,
    deliveryId: value.deliveryId,
    status: value.status,
    ...(typeof value.clientOpId === "string"
      ? { clientOpId: value.clientOpId }
      : {}),
  };
}

function readTextWithinSignal(
  res: Response,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  if (!signal) {
    return res.text().catch(() => null);
  }
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    const onAbort = () => {
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    res.text().then(
      (text) => {
        signal.removeEventListener("abort", onAbort);
        resolve(text);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(null);
      },
    );
  });
}

async function sendCollaborationMessageOnce(
  url: string,
  payload: { targetTaskId: string; body: string },
  clientOpId: string | null,
): Promise<CollaborationMessageSendResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (clientOpId !== null) headers["X-Client-Op-Id"] = clientOpId;
  try {
    return await withTimeout(async (signal) => {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      });
      // Classify definite 4xx refusal as soon as headers arrive: if reading
      // the error body fails or stalls, keep the refusal and fall back to status.
      if (res.status >= 400 && res.status < 500) {
        const text = await readTextWithinSignal(res, signal);
        let parsed: unknown = null;
        if (text) {
          try {
            parsed = JSON.parse(text) as unknown;
          } catch {
            parsed = null;
          }
        }
        return {
          kind: "rejected",
          status: res.status,
          message: extractErrorMessage(parsed, res.status),
        };
      }
      if (res.status !== 202) {
        return { kind: "unknown", message: `HTTP ${res.status}` };
      }
      const text = await readTextWithinSignal(res, signal);
      if (!text) {
        return {
          kind: "unknown",
          message: "Invalid collaboration acceptance response",
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return {
          kind: "unknown",
          message: "Invalid collaboration acceptance response",
        };
      }
      const accepted = parseCollaborationAccepted(parsed, clientOpId);
      if (!accepted) {
        return {
          kind: "unknown",
          message: "Invalid collaboration acceptance response",
        };
      }
      return { kind: "accepted", response: accepted };
    }, DEFAULT_TIMEOUT_MS);
  } catch (err) {
    return {
      kind: "unknown",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function sendCollaborationMessage(
  sourceTaskId: string,
  targetTaskId: string,
  body: string,
  clientOpId: string | null,
): Promise<CollaborationMessageSendResult> {
  const url = `/api/v1/tasks/${encodeURIComponent(sourceTaskId)}/messages`;
  const payload = { targetTaskId, body };
  const maxRetries = clientOpId === null ? 0 : COLLABORATION_MESSAGE_RETRIES;
  let result = await sendCollaborationMessageOnce(url, payload, clientOpId);
  let lastUnknown: { kind: "unknown"; message: string } | null =
    result.kind === "unknown" ? result : null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    if (result.kind !== "unknown") return result;
    result = await sendCollaborationMessageOnce(url, payload, clientOpId);
    if (result.kind === "unknown") {
      lastUnknown = result;
    } else if (result.kind === "rejected" && lastUnknown !== null) {
      // Once an earlier attempt had an unknown outcome, a later 4xx cannot
      // prove the original request did not commit.
      return lastUnknown;
    }
  }
  return result;
}

/** A remote child in a list read; it follows its local parent. */
export interface RemoteTaskSummary {
  id: string;
  host: string | null;
  parent_id: string | null;
  title: string | null;
  workflow_status?: string;
  unreachable?: true;
}

/** Local tasks plus the remote children of the listed parents. */
export async function listTaskTree(archived = false): Promise<{
  tasks: TaskSummary[];
  remote: RemoteTaskSummary[];
}> {
  const entries = await request<Array<TaskSummary | RemoteTaskSummary>>(
    archived ? "/api/v1/tasks?archived=true" : "/api/v1/tasks",
  );
  const tasks: TaskSummary[] = [];
  const remote: RemoteTaskSummary[] = [];
  for (const entry of entries) {
    if ("host" in entry) remote.push(entry);
    else tasks.push(entry);
  }
  return { tasks, remote };
}

/**
 * Active tree by default; `archived` selects archived trees only. Local tasks
 * only: the browser cannot open a remote child yet.
 */
export async function listTasks(archived = false): Promise<TaskSummary[]> {
  return (await listTaskTree(archived)).tasks;
}

export function getConfig(): Promise<{
  configOptions: ConfigOption[];
  /** Configured agents, in configuration order. Ids only: the directory is a
   *  configuration fact and carries no liveness (see `agent-directory.ts`). */
  agents?: Array<{ id: string }>;
  defaultAgentId?: string | null;
}> {
  return request("/api/v1/config");
}

export function getTask(
  id: string,
  opts: { warm?: boolean } = {},
): Promise<TaskDetail> {
  return request("/api/v1/tasks/" + id + (opts.warm ? "?warm=1" : ""));
}

// --- File viewer ---

export interface FileInfo {
  path: string;
  /** Home-abbreviated display form (e.g. `~/project/a.ts`). */
  pathDisplay?: string;
  name: string;
  kind: "file" | "dir";
  size: number;
  mtime: number;
  mime?: string;
  maxBytes?: number;
  contentUrl?: string;
}

export interface FileListEntry {
  name: string;
  kind: "file" | "dir";
  size: number | null;
  mtime: number;
}

export interface FileListResponse {
  path: string;
  pathDisplay?: string;
  parent: string;
  parentDisplay?: string;
  truncated: boolean;
  entries: FileListEntry[];
}

export function getFileInfo(path: string): Promise<FileInfo> {
  return request(`/api/v1/files/info?path=${encodeURIComponent(path)}`);
}

export function listFiles(
  path: string,
  opts?: { includeHidden?: boolean },
): Promise<FileListResponse> {
  const hidden = opts?.includeHidden ? "&hidden=1" : "";
  return request(
    `/api/v1/files/list?path=${encodeURIComponent(path)}${hidden}`,
  );
}

/** client-server-split M1: fetch the current runtime snapshot. */
export function getSnapshot(id: string): Promise<Record<string, unknown>> {
  return request("/api/v1/tasks/" + id + "/snapshot?warm=1");
}

// --- Prompt ---

export interface AttachmentRefForSend {
  kind: "image" | "file";
  attachmentId: string;
  displayName: string;
  mimeType: string;
}

export function sendMessage(
  taskId: string,
  text: string,
  attachments?: AttachmentRefForSend[],
  clientOpId = newOpId(),
): Promise<unknown> {
  const body: Record<string, unknown> = { text };
  if (attachments?.length) body.attachments = attachments;
  return post("/api/v1/tasks/" + taskId + "/prompt", body, clientOpId);
}

// --- Cancel ---

export interface CancelResult {
  ok: true;
  status: "cancelling" | "cancelled" | "idle" | "superseded";
}

export function cancelTask(taskId: string): Promise<CancelResult> {
  return post("/api/v1/tasks/" + taskId + "/cancel", {}, newOpId());
}

// --- Permissions ---

export function resolvePermission(
  taskId: string,
  requestId: string,
  optionId: string,
): Promise<void> {
  return post(
    "/api/v1/tasks/" + taskId + "/permissions/" + requestId,
    { optionId },
    newOpId(),
  );
}

export function denyPermission(
  taskId: string,
  requestId: string,
): Promise<void> {
  return post(
    "/api/v1/tasks/" + taskId + "/permissions/" + requestId,
    { denied: true },
    newOpId(),
  );
}

// --- Config ---

export function setConfig(
  taskId: string,
  configId: string,
  value: string | boolean,
): Promise<void> {
  const urlId = configId.replace(/_/g, "-");
  const path = typeof value === "boolean" ? "config/" + urlId : urlId;
  return request("/api/v1/tasks/" + taskId + "/" + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

export function setTitle(taskId: string, title: string): Promise<void> {
  return request("/api/v1/tasks/" + taskId + "/title", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: title }),
  });
}

// --- Bash ---

export function execBash(taskId: string, command: string): Promise<unknown> {
  return post("/api/v1/tasks/" + taskId + "/bash", { command });
}

export function cancelBash(taskId: string): Promise<void> {
  return post("/api/v1/tasks/" + taskId + "/bash/cancel", {});
}

// --- Visibility ---

export function postVisibility(
  clientId: string,
  visible: boolean,
  taskId?: string,
): Promise<void> {
  const body: Record<string, unknown> = { visible };
  if (taskId) body.taskId = taskId;
  return post(
    "/api/beta/clients/" + clientId + "/visibility",
    body,
    undefined,
    FAST_TIMEOUT_MS,
  );
}

// --- Status ---

export function getStatus(taskId: string): Promise<Record<string, unknown>> {
  return request("/api/v1/tasks/" + taskId + "/status");
}

// --- Bridge ---

export function reloadAgent(taskId?: string): Promise<void> {
  return post("/api/v1/bridge/reload", taskId === undefined ? {} : { taskId });
}

// --- SSE ticket ---

export function mintSseTicket(): Promise<{
  ticket: string;
  expiresIn: number;
}> {
  // The reconnect chain blocks on this: a stalled mint used to leave the
  // client permanently in "connecting" because the retry only runs on reject.
  return post("/api/v1/sse-ticket", {}, undefined, FAST_TIMEOUT_MS);
}

// --- Inbox messages ---

export interface InboxMessage {
  id: string;
  from_ref: string;
  from_label: string | null;
  to_ref: string;
  deliver: string;
  dedup_key: string | null;
  title: string;
  body: string;
  cwd: string | null;
  /** ISO-8601 UTC with an explicit `Z`. */
  created_at: string;
}

export function listMessages(): Promise<{ messages: InboxMessage[] }> {
  return request("/api/v1/messages");
}

export function consumeMessage(
  id: string,
  inheritFromTaskId?: string | null,
): Promise<{ taskId: string; alreadyConsumed: boolean }> {
  return post(`/api/v1/messages/${encodeURIComponent(id)}/consume`, {
    ...(inheritFromTaskId ? { inheritFromTaskId } : {}),
  });
}

export function ackMessage(id: string): Promise<void> {
  return request(`/api/v1/messages/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// --- Tokens (admin scope only) ---

export interface TokenSummary {
  name: string;
  scope: "admin" | "api";
  /** ISO-8601 UTC with an explicit `Z`. */
  createdAt: string;
  /** ISO-8601 UTC with an explicit `Z`, or `null` when never used. */
  lastUsedAt: string | null;
  isSelf: boolean;
}

export function listTokens(): Promise<TokenSummary[]> {
  return request("/api/v1/tokens");
}

export function createApiToken(
  name: string,
): Promise<{ token: string; name: string; scope: "api" }> {
  return post("/api/v1/tokens", { name });
}

export function revokeToken(name: string): Promise<void> {
  return request("/api/v1/tokens/" + encodeURIComponent(name), {
    method: "DELETE",
  });
}
