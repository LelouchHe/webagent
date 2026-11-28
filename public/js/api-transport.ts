// Shared browser HTTP transport backed by `shared/sync/request`.
// Pins the Bearer token once per logical operation so retries never cross callers.

import { HTTP_STATUS } from "../../src/http-status.ts";
import {
  sendSyncRequest,
  SYNC_REQUEST_DEFAULTS,
  type SyncRequestBackoff,
  type SyncRequestResult,
  type SyncRequestTransport,
  type SyncTimer,
} from "../../src/shared/sync/index.ts";
import { getStoredToken } from "./auth-fetch.ts";

export class ApiError extends Error {
  name = "ApiError";
  status: number;
  agentId: string | null;
  readonly outcome: "rejected" | "unknown";
  constructor(
    status: number,
    message: string,
    agentId: string | null = null,
    outcome: "rejected" | "unknown" = status >= 400 && status < 500
      ? "rejected"
      : "unknown",
  ) {
    super(message);
    this.status = status;
    this.agentId = agentId;
    this.outcome = outcome;
  }
}

export function isRejectedApiError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.outcome === "rejected";
}

export function isUnknownApiError(err: unknown): boolean {
  return !(err instanceof ApiError) || err.outcome === "unknown";
}

export class InvalidRequestError extends Error {
  name = "InvalidRequestError";
}

const BROWSER_TIMER: SyncTimer = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

interface BrowserSyncRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  credentials?: RequestCredentials;
  pinnedToken: string | null;
  expectEmpty?: boolean;
}

async function readResponseBody(
  res: Response,
  status: number,
  allowsEmpty: boolean,
): Promise<{ status: number; body: unknown; bodyMalformed?: boolean }> {
  const isSuccessClass = Math.floor(status / 100) === 2;
  const emptyResult = () => ({
    status,
    body: undefined,
    ...(isSuccessClass && !allowsEmpty ? { bodyMalformed: true } : {}),
  });

  if (typeof res.text === "function") {
    let text: string;
    try {
      text = await res.text();
    } catch {
      return { status, body: null, bodyMalformed: true };
    }
    if (typeof text !== "string" || !text.trim()) {
      if (typeof res.json === "function") {
        try {
          const parsed = (await res.json()) as unknown;
          if (parsed !== undefined) return { status, body: parsed };
        } catch {
          // fall through to empty handling
        }
      }
      return emptyResult();
    }
    try {
      return { status, body: JSON.parse(text) as unknown };
    } catch {
      return { status, body: text, bodyMalformed: true };
    }
  }
  if (typeof res.json === "function") {
    try {
      return { status, body: (await res.json()) as unknown };
    } catch {
      return { status, body: null, bodyMalformed: true };
    }
  }
  return emptyResult();
}

const browserTransport: SyncRequestTransport<BrowserSyncRequest, unknown> = {
  async send(opId, req, signal) {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if (opId !== null) headers["X-Client-Op-Id"] = opId;
    if (req.pinnedToken && !headers.Authorization) {
      headers.Authorization = `Bearer ${req.pinnedToken}`;
    }
    const init: RequestInit = { signal };
    if (req.method !== "GET") init.method = req.method;
    if (Object.keys(headers).length > 0) init.headers = headers;
    if (req.body !== undefined) init.body = req.body;
    if (req.credentials !== undefined) init.credentials = req.credentials;
    const res = await fetch(req.url, init);
    const status =
      typeof res.status === "number"
        ? res.status
        : res.ok
          ? HTTP_STATUS.OK
          : HTTP_STATUS.INTERNAL_SERVER_ERROR;
    const allowsEmpty =
      status === HTTP_STATUS.NO_CONTENT || req.expectEmpty === true;
    return readResponseBody(res, status, allowsEmpty);
  },
};

export function extractErrorInfo(
  body: unknown,
  fallbackStatus?: number,
): { message: string; agentId: string | null } {
  let message =
    fallbackStatus !== undefined ? `HTTP ${fallbackStatus}` : "Network error";
  let agentId: string | null = null;
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    if (rec.error !== undefined) {
      message =
        typeof rec.error === "string" ? rec.error : JSON.stringify(rec.error);
    }
    if (typeof rec.agentId === "string") agentId = rec.agentId;
  } else if (typeof body === "string" && body.trim()) {
    message = body.trim();
  }
  return { message, agentId };
}

export function throwFromSyncResult<T>(result: SyncRequestResult<unknown>): T {
  if (result.kind === "success") {
    return result.body as T;
  }
  if (result.kind === "rejected") {
    const { message, agentId } = extractErrorInfo(result.body, result.status);
    throw new ApiError(result.status, message, agentId, "rejected");
  }
  if (result.kind === "skipped") {
    throw new ApiError(0, "Request skipped", null, "unknown");
  }
  if (result.status !== undefined) {
    const { message, agentId } = extractErrorInfo(result.body, result.status);
    throw new ApiError(result.status, message, agentId, "unknown");
  }
  throw result.error instanceof Error
    ? result.error
    : new Error(String(result.error));
}

export interface SyncApiCallOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  opId?: string | null;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: SyncRequestBackoff;
  signal?: AbortSignal;
  credentials?: RequestCredentials;
  expectEmpty?: boolean;
}

export async function sendApiRaw(
  url: string,
  opts: SyncApiCallOptions = {},
): Promise<SyncRequestResult<unknown>> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let serializedBody: string | undefined;
  if (opts.body !== undefined) {
    if (!headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    serializedBody = JSON.stringify(opts.body);
  }
  const opId = opts.opId ?? null;
  return sendSyncRequest({
    opId,
    request: {
      url,
      method,
      headers,
      body: serializedBody,
      credentials: opts.credentials,
      pinnedToken: getStoredToken(),
      expectEmpty: opts.expectEmpty,
    },
    timeoutMs: opts.timeoutMs ?? SYNC_REQUEST_DEFAULTS.read.timeoutMs,
    retries: opts.retries ?? 0,
    backoffMs: opts.backoffMs,
    signal: opts.signal,
    transport: browserTransport,
    timer: BROWSER_TIMER,
  });
}

export async function request<T = unknown>(
  url: string,
  opts: SyncApiCallOptions = {},
): Promise<T> {
  return throwFromSyncResult<T>(await sendApiRaw(url, opts));
}
