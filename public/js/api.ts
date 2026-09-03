// REST API client for all server communication.
// Replaces WebSocket message sends with typed fetch calls.

import type { SessionDetail, SessionSummary } from "../../src/types.ts";

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
 * downstream latch state on those promises (the replay gate, the per-session
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

// --- Session CRUD ---

export function createSession(
  opts?: {
    cwd?: string;
    inheritFromSessionId?: string | null;
  },
  clientOpId?: string,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (opts?.cwd) body.cwd = opts.cwd;
  if (opts?.inheritFromSessionId)
    body.inheritFromSessionId = opts.inheritFromSessionId;
  return post("/api/v1/sessions", body, clientOpId);
}

export function bootstrapSession(
  clientOpId?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {};
  if (clientOpId) headers["X-Client-Op-Id"] = clientOpId;
  return request("/api/v1/sessions/bootstrap", {
    method: "POST",
    headers,
  });
}

export function deleteSession(id: string): Promise<void> {
  return request("/api/v1/sessions/" + id, { method: "DELETE" });
}

export function listSessions(): Promise<SessionSummary[]> {
  return request("/api/v1/sessions");
}

export function getSession(id: string): Promise<SessionDetail> {
  return request("/api/v1/sessions/" + id);
}

// --- Task plane ---

export interface TaskItem {
  id: string;
  parent_id: string | null;
  name: string;
  brief: string | null;
  workflow_status: string;
  title: string | null;
  cwd: string;
  model: string | null;
  mode: string | null;
  reasoning_effort: string | null;
  liveSessionId?: string | null;
}

export function listTasks(): Promise<TaskItem[]> {
  return request<{ tasks: TaskItem[] }>("/api/v1/tasks").then((r) => r.tasks);
}

export function createTask(input: {
  name?: string;
  brief?: string;
  cwd?: string;
  inheritFromSessionId?: string;
}): Promise<TaskItem> {
  return request<{ task: TaskItem }>("/api/v1/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => r.task);
}

export function getTask(id: string): Promise<TaskItem> {
  return request<{ task: TaskItem }>("/api/v1/tasks/" + id).then((r) => r.task);
}

export function deleteTask(id: string): Promise<void> {
  return request<void>("/api/v1/tasks/" + id, { method: "DELETE" });
}

export function clearTask(id: string): Promise<{ sessionId: string }> {
  return request<{ sessionId: string }>("/api/v1/tasks/" + id + "/clear", {
    method: "POST",
  });
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
  return request("/api/v1/sessions/" + id + "/snapshot");
}

// --- Prompt ---

export interface AttachmentRefForSend {
  kind: "image" | "file";
  attachmentId: string;
  displayName: string;
  mimeType: string;
}

export function sendMessage(
  sessionId: string,
  text: string,
  attachments?: AttachmentRefForSend[],
  clientOpId = newOpId(),
): Promise<unknown> {
  const body: Record<string, unknown> = { text };
  if (attachments?.length) body.attachments = attachments;
  return post("/api/v1/sessions/" + sessionId + "/prompt", body, clientOpId);
}

// --- Cancel ---

export interface CancelResult {
  ok: true;
  status: "cancelling" | "cancelled" | "idle" | "superseded";
}

export function cancelSession(sessionId: string): Promise<CancelResult> {
  return post("/api/v1/sessions/" + sessionId + "/cancel", {}, newOpId());
}

// --- Permissions ---

export function resolvePermission(
  sessionId: string,
  requestId: string,
  optionId: string,
): Promise<void> {
  return post(
    "/api/v1/sessions/" + sessionId + "/permissions/" + requestId,
    { optionId },
    newOpId(),
  );
}

export function denyPermission(
  sessionId: string,
  requestId: string,
): Promise<void> {
  return post(
    "/api/v1/sessions/" + sessionId + "/permissions/" + requestId,
    { denied: true },
    newOpId(),
  );
}

// --- Config ---

export function setConfig(
  sessionId: string,
  configId: string,
  value: string | boolean,
): Promise<void> {
  const urlId = configId.replace(/_/g, "-");
  const path = typeof value === "boolean" ? "config/" + urlId : urlId;
  return request("/api/v1/sessions/" + sessionId + "/" + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

export function setTitle(sessionId: string, title: string): Promise<void> {
  return request("/api/v1/sessions/" + sessionId + "/title", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: title }),
  });
}

// --- Bash ---

export function execBash(sessionId: string, command: string): Promise<unknown> {
  return post("/api/v1/sessions/" + sessionId + "/bash", { command });
}

export function cancelBash(sessionId: string): Promise<void> {
  return post("/api/v1/sessions/" + sessionId + "/bash/cancel", {});
}

// --- Visibility ---

export function postVisibility(
  clientId: string,
  visible: boolean,
  sessionId?: string,
): Promise<void> {
  const body: Record<string, unknown> = { visible };
  if (sessionId) body.sessionId = sessionId;
  return post(
    "/api/beta/clients/" + clientId + "/visibility",
    body,
    undefined,
    FAST_TIMEOUT_MS,
  );
}

// --- Status ---

export function getStatus(sessionId: string): Promise<Record<string, unknown>> {
  return request("/api/v1/sessions/" + sessionId + "/status");
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
  inheritFromSessionId?: string | null,
): Promise<{ sessionId: string; alreadyConsumed: boolean }> {
  return post(`/api/v1/messages/${encodeURIComponent(id)}/consume`, {
    ...(inheritFromSessionId ? { inheritFromSessionId } : {}),
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
