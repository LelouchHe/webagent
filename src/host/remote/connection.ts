import { z } from "zod";
import { WORKFLOW_STATUSES } from "../../shared/workflow-status.ts";
import { HTTP_STATUS } from "../../http-status.ts";
import {
  sendSyncRequest,
  type SyncFeedEntry,
  type SyncFeedTransport,
  type SyncRequestTransport,
  type SyncTimer,
} from "../../shared/sync/index.ts";
import type { HostConfig } from "../../config.ts";
import { errorMessage } from "../../types.ts";
import { resolveHostToken, TokenCommandError } from "./credentials.ts";
import type { HostUnreachableReason } from "./state.ts";
import type {
  RemoteTaskCreateInput,
  TaskReadInput,
  TaskReadResult,
  TaskCreateResult,
} from "../../api/tasks.ts";
import type { CanonicalTaskHistoryEvent } from "../../task-history.ts";
import {
  buildTaskHistoryRead,
  uniqueTaskHistorySeqs,
} from "../../task-history.ts";

const REQUEST_TIMEOUT_MS = 8_000;
export const REMOTE_STATUS_TIMEOUT_MS = 2_000;

const ConfigOptionSchema = z.union([
  z.object({
    type: z.literal("select").optional(),
    id: z.string(),
    name: z.string(),
    category: z.string().nullable().optional(),
    currentValue: z.string(),
    options: z.array(
      z.object({ value: z.string(), name: z.string() }).passthrough(),
    ),
  }),
  z.object({
    type: z.literal("boolean"),
    id: z.string(),
    name: z.string(),
    category: z.string().nullable().optional(),
    currentValue: z.boolean(),
  }),
]);

const TaskCreateResponseSchema = z.object({
  id: z.string().min(1),
  cwd: z.string(),
  cwdDisplay: z.string(),
  parentId: z.string().nullable(),
  parentAgentId: z.string().nullable(),
  agentId: z.string().min(1),
  title: z.string().nullable(),
  model: z.string().nullable(),
  thinking: z.string().nullable(),
  workflowStatus: z.enum(WORKFLOW_STATUSES),
  source: z.string(),
  configOptions: z.array(ConfigOptionSchema),
  agentCommands: z.object({
    epoch: z.string(),
    revision: z.number().int().nonnegative(),
    commands: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        input: z.object({ hint: z.string() }).optional(),
      }),
    ),
  }),
});

const TaskEventSchema = z
  .object({
    task_id: z.string().min(1),
    seq: z.number().int().positive(),
    type: z.string(),
    created_at: z.string(),
    from_ref: z.string(),
    data: z.string(),
  })
  .passthrough();

const RemoteTaskStatusSchema = z.object({
  title: z.string().nullable(),
  workflowStatus: z.enum(WORKFLOW_STATUSES),
  executionState: z.enum(["agent", "bash", "idle"]),
  lastEventAt: z.string().nullable(),
  lastAgentActivityAt: z.string().nullable(),
});

export type RemoteTaskStatus = z.infer<typeof RemoteTaskStatusSchema>;

const FeedEntrySchema = z.object({
  pos: z.number().int().positive(),
  prev: z.number().int().nonnegative(),
  data: z.unknown(),
});

export interface OwnerTaskHistoryEvent extends CanonicalTaskHistoryEvent {
  parsedData: Record<string, unknown>;
}

export function decodeOwnerTaskEvents(
  raw: unknown,
  taskId: string,
): OwnerTaskHistoryEvent[] {
  const parsed = z.object({ events: z.array(z.unknown()) }).safeParse(raw);
  if (!parsed.success) {
    throw new HostConnectionFailure("invalid_response");
  }
  return parsed.data.events.map((event) => {
    const row = TaskEventSchema.safeParse(event);
    if (!row.success || row.data.task_id !== taskId) {
      throw new HostConnectionFailure("invalid_response");
    }
    let parsedData: unknown;
    try {
      parsedData = JSON.parse(row.data.data) as unknown;
    } catch {
      throw new HostConnectionFailure("invalid_response");
    }
    if (
      !parsedData ||
      typeof parsedData !== "object" ||
      Array.isArray(parsedData)
    ) {
      throw new HostConnectionFailure("invalid_response");
    }
    return {
      ...row.data,
      parsedData: parsedData as Record<string, unknown>,
    };
  });
}

export type HostTaskCreateAttempt =
  | { kind: "success"; result: TaskCreateResult }
  | { kind: "rejected"; status: number; reason: string }
  | { kind: "unknown"; reason: string }
  | { kind: "not_sent"; reason: string };

export interface HostHttpRequest {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
  redirect?: RequestRedirect;
}

export interface HostConnectionOptions {
  fetch?: typeof globalThis.fetch;
  requestTransport?: SyncRequestTransport<HostHttpRequest, unknown>;
  timer?: SyncTimer;
  createRetries?: number;
}

const DEFAULT_TIMER: SyncTimer = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class HostConnectionFailure extends Error {
  readonly reason: HostUnreachableReason;

  constructor(reason: HostUnreachableReason, options?: ErrorOptions) {
    super(reason, options);
    this.name = "HostConnectionFailure";
    this.reason = reason;
  }
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function responseError(body: unknown, status: number): string {
  return body &&
    typeof body === "object" &&
    typeof (body as { error?: unknown }).error === "string"
    ? (body as { error: string }).error
    : `HTTP ${status}`;
}

interface HostFetchOptions {
  signal?: AbortSignal;
  token?: string;
  method?: string;
  body?: unknown;
  headers?: HeadersInit;
  redirect?: RequestRedirect;
  timeoutMs?: number | null;
}

export class HostConnection {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly config: HostConfig;
  private readonly requestTransport: SyncRequestTransport<
    HostHttpRequest,
    unknown
  >;
  private readonly timer: SyncTimer;
  private readonly createRetries: number;
  private tokenCommand: Promise<string> | null = null;

  constructor(config: HostConfig, options: HostConnectionOptions = {}) {
    this.config = config;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timer = options.timer ?? DEFAULT_TIMER;
    this.createRetries = Math.max(0, options.createRetries ?? 2);
    this.requestTransport = options.requestTransport ?? {
      send: async (opId, request, signal) => {
        const token = request.token ?? (await this.resolveToken(signal));
        const headers =
          opId !== null
            ? { ...(request.headers ?? {}), "X-Client-Op-Id": opId }
            : request.headers;
        const response = await this.fetchResponse(request.path, {
          token,
          method: request.method,
          body: request.body,
          headers,
          redirect: request.redirect,
          signal,
          timeoutMs: null,
        });
        return {
          status: response.status,
          body: await responseBody(response),
        };
      },
    };
  }

  async createTask(
    input: RemoteTaskCreateInput,
  ): Promise<HostTaskCreateAttempt> {
    let token: string;
    try {
      token = await this.resolveToken();
    } catch {
      return { kind: "not_sent", reason: "Host credential is unavailable" };
    }

    const { opId, ...payload } = input;
    const outcome = await sendSyncRequest({
      opId,
      request: {
        method: "POST",
        path: "/api/v1/tasks",
        body: payload,
        token,
        redirect: "error",
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
      transport: this.requestTransport,
      timer: this.timer,
      retries: this.createRetries,
    });
    if (outcome.kind === "unknown") {
      return { kind: "unknown", reason: errorMessage(outcome.error) };
    }
    if (outcome.kind === "rejected") {
      return {
        kind: "rejected",
        status: outcome.status,
        reason: responseError(outcome.body, outcome.status),
      };
    }
    if (outcome.status !== HTTP_STATUS.CREATED) {
      return {
        kind: "unknown",
        reason: `Unexpected HTTP ${outcome.status}`,
      };
    }
    const parsed = TaskCreateResponseSchema.safeParse(outcome.body);
    if (!parsed.success) {
      return {
        kind: "unknown",
        reason: "Remote returned an incomplete task-create response",
      };
    }
    const activation = parsed.data;
    return {
      kind: "success",
      result: {
        task: {
          id: activation.id,
          title: activation.title,
          agentId: activation.agentId,
          cwd: activation.cwd,
          model: activation.model,
          thinking: activation.thinking,
          parentId: activation.parentId,
          workflowStatus: activation.workflowStatus,
          source: activation.source,
        },
        session: {
          cwdDisplay: activation.cwdDisplay,
          parentAgentId: activation.parentAgentId,
          configOptions: activation.configOptions,
          agentCommands: activation.agentCommands,
        },
      },
    };
  }

  async getJson(path: string): Promise<unknown> {
    const outcome = await sendSyncRequest({
      opId: null,
      request: { method: "GET", path, redirect: "error" },
      timeoutMs: REQUEST_TIMEOUT_MS,
      transport: this.requestTransport,
      timer: this.timer,
    });
    if (outcome.kind === "rejected") {
      throw new HostRequestError(path, outcome.status);
    }
    if (outcome.kind === "unknown") {
      throw new HostConnectionFailure("network", { cause: outcome.error });
    }
    if (outcome.body === null) {
      throw new HostConnectionFailure("invalid_response");
    }
    return outcome.body;
  }

  async readTaskStatus(
    taskId: string,
    timeoutMs = REMOTE_STATUS_TIMEOUT_MS,
  ): Promise<RemoteTaskStatus> {
    const path = `/api/v1/tasks/${encodeURIComponent(taskId)}/status`;
    const outcome = await sendSyncRequest({
      opId: null,
      request: { method: "GET", path, redirect: "error" },
      timeoutMs,
      transport: this.requestTransport,
      timer: this.timer,
    });
    if (outcome.kind === "rejected") {
      throw new HostRequestError(path, outcome.status);
    }
    if (outcome.kind === "unknown") {
      throw new HostConnectionFailure("network", { cause: outcome.error });
    }
    const parsed = RemoteTaskStatusSchema.safeParse(outcome.body);
    if (!parsed.success) {
      throw new HostConnectionFailure("invalid_response");
    }
    return parsed.data;
  }

  async readTaskEvents(taskId: string): Promise<OwnerTaskHistoryEvent[]> {
    const raw = await this.getJson(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/events`,
    );
    return decodeOwnerTaskEvents(raw, taskId);
  }

  async readTaskHistory(
    taskId: string,
    input: TaskReadInput,
  ): Promise<TaskReadResult> {
    uniqueTaskHistorySeqs(input.seqs);
    return buildTaskHistoryRead({
      taskId,
      events: await this.readTaskEvents(taskId),
      seqs: input.seqs,
    });
  }

  feedTransport(): SyncFeedTransport<unknown> {
    return {
      read: (after, signal) => this.readLinkOutbox(after, signal),
      watch: (input) => this.watchLinkOutbox(input),
    };
  }

  pushTransport(): SyncRequestTransport<unknown, unknown> {
    return {
      send: async (opId, request, signal) => {
        const token = await this.resolveToken(signal);
        const response = await this.fetchResponse("/api/v1/link/entries", {
          token,
          method: "POST",
          body: request,
          headers: opId !== null ? { "X-Client-Op-Id": opId } : undefined,
          signal,
          timeoutMs: null,
          redirect: "error",
        });
        return {
          status: response.status,
          body: await responseBody(response),
        };
      },
    };
  }

  static failureReason(error: unknown): HostUnreachableReason {
    if (error instanceof TokenCommandError) return "token_command_failed";
    if (error instanceof HostConnectionFailure) return error.reason;
    return "network";
  }

  private async readLinkOutbox(
    after: number,
    signal: AbortSignal,
  ): Promise<SyncFeedEntry<unknown>[]> {
    const token = await this.resolveToken(signal);
    const response = await this.fetchResponse(
      `/api/v1/link/outbox?after=${encodeURIComponent(String(after))}&limit=100`,
      { token, signal, redirect: "error" },
    );
    if (!response.ok) throw this.httpFailure(response.status);
    let raw: unknown;
    try {
      raw = (await response.json()) as unknown;
    } catch {
      throw new HostConnectionFailure("invalid_response");
    }
    const parsed = z
      .object({ entries: z.array(FeedEntrySchema) })
      .safeParse(raw);
    if (!parsed.success) {
      throw new HostConnectionFailure("invalid_response");
    }
    return parsed.data.entries;
  }

  private async watchLinkOutbox(input: {
    after: number;
    signal: AbortSignal;
    connected(): void;
    activity(): void;
    entry(entry: SyncFeedEntry<unknown>): void | Promise<void>;
  }): Promise<void> {
    const token = await this.resolveToken(input.signal);
    if (input.signal.aborted) return;
    let response: Response;
    try {
      response = await this.fetchResponse(
        `/api/v1/link/watch?after=${encodeURIComponent(String(input.after))}`,
        { token, signal: input.signal, timeoutMs: null, redirect: "error" },
      );
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- signal can abort across await
      if (input.signal.aborted) throw error;
      throw new HostConnectionFailure("network", { cause: error });
    }
    if (!response.ok) throw this.httpFailure(response.status);
    if (!response.body) throw new HostConnectionFailure("invalid_response");
    await this.consumeWatch(response.body, input);
  }

  private async resolveToken(signal?: AbortSignal): Promise<string> {
    while (this.tokenCommand) {
      try {
        await this.tokenCommand;
      } catch {
        // The prior attempt reports its own outcome.
      }
      if (signal?.aborted) {
        throw new Error("stale host attempt");
      }
    }
    if (signal?.aborted) {
      throw new Error("stale host attempt");
    }
    const command = resolveHostToken(this.config.token, undefined, signal);
    this.tokenCommand = command;
    try {
      return await command;
    } finally {
      if (this.tokenCommand === command) this.tokenCommand = null;
    }
  }

  private fetchResponse(
    path: string,
    options: HostFetchOptions = {},
  ): Promise<Response> {
    const headers = new Headers(options.headers);
    if (options.token) {
      headers.set("Authorization", `Bearer ${options.token}`);
    }
    const body =
      options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const timeoutSignal =
      options.timeoutMs === null
        ? null
        : AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const signal =
      options.signal && timeoutSignal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : (options.signal ?? timeoutSignal ?? undefined);
    return this.fetchImpl(endpoint(this.config.url, path), {
      method: options.method ?? "GET",
      headers,
      body,
      ...(options.redirect ? { redirect: options.redirect } : {}),
      signal,
    });
  }

  private httpFailure(status: number): HostConnectionFailure {
    return new HostConnectionFailure(
      status === HTTP_STATUS.UNAUTHORIZED || status === HTTP_STATUS.FORBIDDEN
        ? "unauthorized"
        : "network",
    );
  }

  private async consumeWatch(
    body: ReadableStream<Uint8Array>,
    input: {
      signal: AbortSignal;
      connected(): void;
      activity(): void;
      entry(entry: SyncFeedEntry<unknown>): void | Promise<void>;
    },
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let connected = false;
    try {
      while (!input.signal.aborted) {
        const result = await reader.read();
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- signal can abort across await
        if (input.signal.aborted) return;
        if (result.done) throw new HostConnectionFailure("network");
        buffer += decoder.decode(result.value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = frame.split(/\r?\n/);
          const event = lines
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim();
          const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (event === "connected") {
            connected = true;
            input.connected();
          } else if (connected && event === "heartbeat") {
            input.activity();
          } else if (connected && event === "entry" && data) {
            let parsedJson: unknown;
            try {
              parsedJson = JSON.parse(data) as unknown;
            } catch {
              throw new HostConnectionFailure("invalid_response");
            }
            const parsed = FeedEntrySchema.safeParse(parsedJson);
            if (!parsed.success) {
              throw new HostConnectionFailure("invalid_response");
            }
            await input.entry(parsed.data);
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export class HostRequestError extends Error {
  readonly path: string;
  readonly status: number;

  constructor(path: string, status: number) {
    super(`Remote request failed with HTTP ${status}`);
    this.name = "HostRequestError";
    this.path = path;
    this.status = status;
  }
}
