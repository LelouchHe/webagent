// REST API client for all server communication.
// Replaces WebSocket message sends with typed fetch calls.

import type { TaskDetail, TaskSummary } from "../../src/types.ts";

export class ApiError extends Error {
  name = "ApiError";
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
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
      try {
        const body = (await res.json()) as Record<string, unknown>;
        if (body.error)
          message =
            typeof body.error === "string"
              ? body.error
              : JSON.stringify(body.error);
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, message);
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
    brief?: string;
  },
  clientOpId?: string,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (opts?.cwd) body.cwd = opts.cwd;
  if (opts?.inheritFromTaskId) body.inheritFromTaskId = opts.inheritFromTaskId;
  if (opts?.parentId) body.parentId = opts.parentId;
  if (opts?.title !== undefined) body.title = opts.title;
  if (opts?.brief !== undefined) body.brief = opts.brief;
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
  opts?: { cwd?: string },
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (opts?.cwd) body.cwd = opts.cwd;
  return post("/api/v1/tasks/" + id + "/clear", body);
}

export function compactTask(id: string): Promise<Record<string, unknown>> {
  return post("/api/v1/tasks/" + id + "/compact", {});
}

export interface DeleteTaskResult {
  taskId: string;
  parentId?: string | null;
  reset?: boolean;
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

export function sendCollaborationMessage(
  sourceTaskId: string,
  targetTaskId: string,
  body: string,
  clientOpId?: string,
): Promise<{
  messageId: string;
  deliveryId: string;
  status: "queued" | "delivered";
}> {
  return post(
    `/api/v1/tasks/${encodeURIComponent(sourceTaskId)}/messages`,
    { targetTaskId, body },
    clientOpId,
  );
}

export function listTasks(): Promise<TaskSummary[]> {
  return request("/api/v1/tasks");
}

export function getTask(id: string): Promise<TaskDetail> {
  return request("/api/v1/tasks/" + id);
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

export function listFiles(path: string): Promise<FileListResponse> {
  return request(`/api/v1/files/list?path=${encodeURIComponent(path)}`);
}

/** client-server-split M1: fetch the current runtime snapshot. */
export function getSnapshot(id: string): Promise<Record<string, unknown>> {
  return request("/api/v1/tasks/" + id + "/snapshot");
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

export function reloadAgent(): Promise<void> {
  return post("/api/v1/bridge/reload", {});
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
  created_at: number;
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
  createdAt: number;
  lastUsedAt: number | null;
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
