// REST API client for all server communication.
// Replaces WebSocket message sends with typed fetch calls.

import type { ConfigOption, TaskDetail, TaskSummary } from "../../src/types.ts";
import type { CollaborationDeliveryStatus } from "../../src/shared/delivery-status.ts";
import { SYNC_REQUEST_DEFAULTS } from "../../src/shared/sync/index.ts";
import {
  ApiError,
  InvalidRequestError,
  isRejectedApiError,
  isUnknownApiError,
  extractErrorInfo,
  sendApiRaw,
  request,
} from "./api-transport.ts";

export { ApiError, InvalidRequestError, isRejectedApiError, isUnknownApiError };

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

function postWrite<T = unknown>(
  url: string,
  body: Record<string, unknown>,
  clientOpId?: string,
  preset: {
    timeoutMs: number;
    retries: number;
    backoffMs?: readonly number[];
  } = SYNC_REQUEST_DEFAULTS.write,
  expectEmpty?: boolean,
): Promise<T> {
  return request<T>(url, {
    method: "POST",
    body,
    opId: clientOpId ?? newOpId(),
    timeoutMs: preset.timeoutMs,
    retries: preset.retries,
    backoffMs: preset.backoffMs,
    expectEmpty,
  });
}

function putWrite<T = unknown>(
  url: string,
  body: Record<string, unknown>,
  clientOpId?: string,
  expectEmpty?: boolean,
): Promise<T> {
  return request<T>(url, {
    method: "PUT",
    body,
    opId: clientOpId ?? newOpId(),
    ...SYNC_REQUEST_DEFAULTS.write,
    expectEmpty,
  });
}

function deleteWrite<T = unknown>(
  url: string,
  body?: Record<string, unknown>,
  clientOpId?: string,
  expectEmpty?: boolean,
): Promise<T> {
  return request<T>(url, {
    method: "DELETE",
    ...(body !== undefined ? { body } : {}),
    opId: clientOpId ?? newOpId(),
    ...SYNC_REQUEST_DEFAULTS.write,
    expectEmpty,
  });
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
  // Create stays single-shot (retries: 0) until hard-deleted tasks retain replay identity.
  return postWrite(
    "/api/v1/tasks",
    body,
    clientOpId,
    SYNC_REQUEST_DEFAULTS.create,
  );
}

export function bootstrapTask(
  clientOpId?: string,
): Promise<Record<string, unknown>> {
  return request("/api/v1/tasks/bootstrap", {
    method: "POST",
    opId: clientOpId ?? newOpId(),
    ...SYNC_REQUEST_DEFAULTS.slowWrite,
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
  return postWrite("/api/v1/tasks/" + id + "/clear", body);
}

export function compactTask(
  id: string,
  prompt?: string,
): Promise<Record<string, unknown>> {
  return postWrite("/api/v1/tasks/" + id + "/compact", {
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
  const result = await deleteWrite<DeleteTaskResult | undefined>(
    "/api/v1/tasks/" + id,
    undefined,
    clientOpId,
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
  return postWrite(`/api/v1/tasks/${encodeURIComponent(id)}/archive`, {});
}

export interface UnarchiveTaskResult {
  status: "unarchived";
  taskId: string;
  parentId: string;
  parentPath: string;
}

export function unarchiveTask(id: string): Promise<UnarchiveTaskResult> {
  return postWrite(`/api/v1/tasks/${encodeURIComponent(id)}/unarchive`, {});
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

export async function sendCollaborationMessage(
  sourceTaskId: string,
  targetTaskId: string,
  body: string,
  clientOpId: string | null,
): Promise<CollaborationMessageSendResult> {
  const url = `/api/v1/tasks/${encodeURIComponent(sourceTaskId)}/messages`;
  const result = await sendApiRaw(url, {
    method: "POST",
    body: { targetTaskId, body },
    opId: clientOpId,
    ...SYNC_REQUEST_DEFAULTS.write,
  });
  if (result.kind === "success") {
    return {
      kind: "accepted",
      response: result.body as CollaborationMessageAccepted,
    };
  }
  if (result.kind === "rejected") {
    const { message } = extractErrorInfo(result.body, result.status);
    return { kind: "rejected", status: result.status, message };
  }
  const message =
    result.kind === "unknown"
      ? result.status !== undefined
        ? extractErrorInfo(result.body, result.status).message
        : result.error instanceof Error
          ? result.error.message
          : String(result.error)
      : "Request skipped";
  return { kind: "unknown", message };
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
export function getSnapshot(
  id: string,
  opts?: { warm?: boolean; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const warm = opts?.warm !== false ? "?warm=1" : "";
  return request("/api/v1/tasks/" + id + "/snapshot" + warm, {
    signal: opts?.signal,
    timeoutMs: FAST_TIMEOUT_MS,
  });
}

export interface StoredEventRow {
  id: number;
  task_id: string;
  seq: number;
  type: string;
  data: string;
  from_ref: string;
  created_at: string;
}

export interface TaskEventFeedEntry {
  feed: string;
  pos: number;
  prev: number;
  data: StoredEventRow;
}

export interface TaskEventsResponse {
  events: TaskEventFeedEntry[];
  hasMore?: boolean;
  total?: number;
  imageReferences?: unknown;
}

export function getTaskEvents(
  taskId: string,
  opts: {
    after?: number;
    before?: number;
    upTo?: number;
    limit?: number;
    thinking?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<TaskEventsResponse> {
  const params = new URLSearchParams();
  if (opts.thinking === false) params.set("thinking", "0");
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.after !== undefined) params.set("after", String(opts.after));
  if (opts.before !== undefined) params.set("before", String(opts.before));
  if (opts.upTo !== undefined) params.set("upTo", String(opts.upTo));
  const qs = params.toString();
  return request<TaskEventsResponse>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/events${qs ? `?${qs}` : ""}`,
    {
      signal: opts.signal,
      timeoutMs: FAST_TIMEOUT_MS,
    },
  );
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
  return postWrite("/api/v1/tasks/" + taskId + "/prompt", body, clientOpId);
}

// --- Cancel ---

export interface CancelResult {
  ok: true;
  status: "cancelling" | "cancelled" | "idle" | "superseded";
}

export function cancelTask(taskId: string): Promise<CancelResult> {
  return postWrite("/api/v1/tasks/" + taskId + "/cancel", {}, newOpId());
}

// --- Permissions ---

export function resolvePermission(
  taskId: string,
  requestId: string,
  optionId: string,
): Promise<void> {
  return postWrite(
    "/api/v1/tasks/" + taskId + "/permissions/" + requestId,
    { optionId },
    newOpId(),
    SYNC_REQUEST_DEFAULTS.write,
    true,
  );
}

export function denyPermission(
  taskId: string,
  requestId: string,
): Promise<void> {
  return postWrite(
    "/api/v1/tasks/" + taskId + "/permissions/" + requestId,
    { denied: true },
    newOpId(),
    SYNC_REQUEST_DEFAULTS.write,
    true,
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
  return putWrite(
    "/api/v1/tasks/" + taskId + "/" + path,
    { value },
    undefined,
    true,
  );
}

export function setTitle(taskId: string, title: string): Promise<void> {
  return putWrite(
    "/api/v1/tasks/" + taskId + "/title",
    { value: title },
    undefined,
    true,
  );
}

// --- Bash ---

export function execBash(taskId: string, command: string): Promise<unknown> {
  return postWrite("/api/v1/tasks/" + taskId + "/bash", { command });
}

export function cancelBash(taskId: string): Promise<void> {
  return postWrite(
    "/api/v1/tasks/" + taskId + "/bash/cancel",
    {},
    undefined,
    SYNC_REQUEST_DEFAULTS.write,
    true,
  );
}

// --- Visibility ---

export function postVisibility(
  clientId: string,
  taskIds: readonly string[],
  rev = 1,
): Promise<void> {
  return request(
    "/api/beta/clients/" + encodeURIComponent(clientId) + "/visibility",
    {
      method: "POST",
      body: { taskIds: [...taskIds] },
      headers: { "X-Visibility-Rev": String(rev) },
      opId: null,
      timeoutMs: FAST_TIMEOUT_MS,
      expectEmpty: true,
    },
  );
}

// --- Status & Version ---

export function getStatus(taskId: string): Promise<Record<string, unknown>> {
  return request("/api/v1/tasks/" + taskId + "/status");
}

export function getVersion(): Promise<Record<string, unknown>> {
  return request("/api/v1/version");
}

export function getRecentPaths(
  limit?: number,
): Promise<Array<{ cwd: string; cwdDisplay?: string; last_used_at: string }>> {
  const url =
    limit && limit > 0
      ? `/api/v1/recent-paths?limit=${limit}`
      : "/api/v1/recent-paths";
  return request(url);
}

// --- Bridge ---

export function reloadAgent(taskId?: string): Promise<void> {
  return postWrite(
    "/api/v1/bridge/reload",
    taskId === undefined ? {} : { taskId },
    undefined,
    SYNC_REQUEST_DEFAULTS.slowWrite,
    true,
  );
}

// --- SSE ticket ---

export function mintSseTicket(signal?: AbortSignal): Promise<{
  ticket: string;
  expiresIn: number;
}> {
  return request("/api/v1/sse-ticket", {
    method: "POST",
    body: {},
    opId: null,
    timeoutMs: FAST_TIMEOUT_MS,
    signal,
  });
}

// --- Push ---

export function getPushVapidKey(): Promise<{ publicKey: string }> {
  return request("/api/beta/push/vapid-key");
}

export function subscribePushEndpoint(payload: {
  endpoint?: string;
  keys?: Record<string, string>;
  clientId: string | null;
}): Promise<void> {
  return postWrite(
    "/api/beta/push/subscribe",
    payload as Record<string, unknown>,
    undefined,
    SYNC_REQUEST_DEFAULTS.write,
    true,
  );
}

export function unsubscribePushEndpoint(endpoint: string): Promise<void> {
  return postWrite(
    "/api/beta/push/unsubscribe",
    { endpoint },
    undefined,
    SYNC_REQUEST_DEFAULTS.write,
    true,
  );
}

export function registerPushClient(
  clientId: string,
  endpoint: string,
): Promise<void> {
  return request("/api/beta/push/register-client", {
    method: "POST",
    body: { clientId, endpoint },
    opId: null,
    timeoutMs: FAST_TIMEOUT_MS,
    expectEmpty: true,
  });
}

// --- Shares ---

export function createSharePreview<T = unknown>(taskId: string): Promise<T> {
  return postWrite<T>(`/api/v1/tasks/${encodeURIComponent(taskId)}/share`, {});
}

export function publishSharePreview<T = unknown>(
  taskId: string,
  token: string,
): Promise<T> {
  return postWrite<T>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/share/publish`,
    { token },
  );
}

export function listShares<T = unknown>(): Promise<{ shares: T[] }> {
  return request<{ shares: T[] }>("/api/v1/shares", {
    credentials: "same-origin",
  });
}

export function revokeTaskShare(
  taskId: string,
  token: string,
): Promise<{ revoked: boolean }> {
  return deleteWrite<{ revoked: boolean }>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/share`,
    { token },
  );
}

export function getShareDisplayName(): Promise<{ value: string | null }> {
  return request<{ value: string | null }>("/api/v1/share/by", {
    credentials: "same-origin",
  });
}

export function setShareDisplayName(
  value: string | null,
): Promise<{ value: string | null }> {
  return putWrite<{ value: string | null }>("/api/v1/share/by", { value });
}

export function patchSharePreview(
  taskId: string,
  token: string,
  displayName: string,
): Promise<void> {
  return request(`/api/v1/tasks/${encodeURIComponent(taskId)}/share`, {
    method: "PATCH",
    body: { token, display_name: displayName },
    opId: newOpId(),
    ...SYNC_REQUEST_DEFAULTS.write,
    expectEmpty: true,
  });
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
  return postWrite(`/api/v1/messages/${encodeURIComponent(id)}/consume`, {
    ...(inheritFromTaskId ? { inheritFromTaskId } : {}),
  });
}

export function ackMessage(id: string): Promise<void> {
  return deleteWrite(
    `/api/v1/messages/${encodeURIComponent(id)}`,
    undefined,
    undefined,
    true,
  );
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
  return request("/api/v1/tokens", {
    method: "POST",
    body: { name },
    opId: null,
    timeoutMs: FAST_TIMEOUT_MS,
  });
}

export function revokeToken(name: string): Promise<void> {
  return deleteWrite(
    "/api/v1/tokens/" + encodeURIComponent(name),
    undefined,
    undefined,
    true,
  );
}
