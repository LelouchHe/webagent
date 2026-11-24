import { hashToken } from "../../auth.ts";
import { isScope } from "../../auth-store.ts";
import { z } from "zod";
import { HTTP_STATUS } from "../../http-status.ts";
import {
  StreamSupervisor,
  STREAM_STALL_TIMEOUT_MS,
  type StreamAttempt,
  type StreamFailure,
} from "../../shared/stream-supervisor.ts";
import type { HostConfig } from "../../config.ts";
import { errorMessage } from "../../types.ts";
import { resolveHostToken, TokenCommandError } from "./credentials.ts";
import {
  HOST_PROTOCOL_VERSION,
  type HostConnectionState,
  type HostUnreachableReason,
} from "./state.ts";
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
  agentId: z.string().nullable(),
  title: z.string().nullable(),
  model: z.string().nullable().optional(),
  thinking: z.string().nullable().optional(),
  workflowStatus: z.enum(["running", "idle", "waiting", "blocked", "done"]),
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

export interface RemoteTaskDetail {
  id: string;
  title: string | null;
  workflowStatus: "running" | "idle" | "waiting" | "blocked" | "done";
}

export interface OwnerTaskHistoryEvent extends CanonicalTaskHistoryEvent {
  parsedData: Record<string, unknown>;
}

export function decodeOwnerTaskEvents(
  raw: unknown,
  taskId: string,
): OwnerTaskHistoryEvent[] {
  const parsed = z.object({ events: z.array(z.unknown()) }).safeParse(raw);
  if (!parsed.success) {
    throw new HostConnectionFailure("protocol_mismatch");
  }
  return parsed.data.events.map((event) => {
    const row = TaskEventSchema.safeParse(event);
    if (!row.success || row.data.task_id !== taskId) {
      throw new HostConnectionFailure("protocol_mismatch");
    }
    let parsedData: unknown;
    try {
      parsedData = JSON.parse(row.data.data) as unknown;
    } catch {
      throw new HostConnectionFailure("protocol_mismatch");
    }
    if (
      !parsedData ||
      typeof parsedData !== "object" ||
      Array.isArray(parsedData)
    ) {
      throw new HostConnectionFailure("protocol_mismatch");
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

export type HostTaskSendAttempt =
  | { kind: "accepted"; messageId: string }
  | { kind: "rejected"; status: number; reason: string }
  | { kind: "unknown"; reason: string };

export interface HostConnectionOptions {
  fetch?: typeof globalThis.fetch;
  handshakeTimeoutMs?: number;
  retryDelay: (failures: number, failure: StreamFailure) => number;
  onState?: (
    state: HostConnectionState,
    reason?: HostUnreachableReason,
  ) => void;
  onConnected?: (isCurrent: () => boolean) => Promise<void> | void;
  onEvent?: (event: HostStreamEvent) => void | Promise<void>;
  subscriptionParentIds?: () => string[];
}

export interface HostStreamEvent {
  seq?: number;
  data: Record<string, unknown>;
}

class HostConnectionFailure extends Error {
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
  private readonly options: HostConnectionOptions;
  private readonly supervisor: StreamSupervisor;
  private tokenCommand: Promise<string> | null = null;
  private connectionId: string | null = null;

  constructor(config: HostConfig, options: HostConnectionOptions) {
    this.config = config;
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.supervisor = new StreamSupervisor({
      run: (attempt) => this.runAttempt(attempt),
      retryDelay: options.retryDelay,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? STREAM_STALL_TIMEOUT_MS,
      clock: { now: () => performance.now() },
      onFailure: ({ kind, error }) => {
        this.options.onState?.(
          "unreachable",
          kind === "stalled" ? "network" : HostConnection.failureReason(error),
        );
      },
    });
  }

  start(): void {
    this.supervisor.start();
  }

  stop(): void {
    this.supervisor.stop();
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

    let response: Response;
    try {
      response = await this.fetchResponse("/api/v1/tasks", {
        token,
        method: "POST",
        body: input,
        headers: this.connectionId
          ? { "X-Host-Connection-Id": this.connectionId }
          : undefined,
        redirect: "error",
      });
    } catch (error) {
      return {
        kind: "unknown",
        reason: errorMessage(error),
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const reason =
        body &&
        typeof body === "object" &&
        typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `HTTP ${response.status}`;
      return response.status >= HTTP_STATUS.BAD_REQUEST &&
        response.status < HTTP_STATUS.INTERNAL_SERVER_ERROR
        ? { kind: "rejected", status: response.status, reason }
        : { kind: "unknown", reason };
    }
    if (response.status !== HTTP_STATUS.CREATED) {
      return {
        kind: "unknown",
        reason: `Unexpected HTTP ${response.status}`,
      };
    }
    const parsed = TaskCreateResponseSchema.safeParse(body);
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
        taskId: activation.id,
        facts: {
          title: activation.title,
          agentId: activation.agentId,
          cwd: activation.cwd,
          model: activation.model ?? null,
          thinking: activation.thinking ?? null,
        },
        activation,
      },
    };
  }

  async getJson(path: string): Promise<unknown> {
    const token = await this.resolveToken();
    const response = await this.fetchResponse(path, {
      token,
      redirect: "error",
    });
    if (!response.ok) {
      throw new HostRequestError(path, response.status);
    }
    try {
      return (await response.json()) as unknown;
    } catch (error) {
      throw new HostConnectionFailure("protocol_mismatch", { cause: error });
    }
  }

  async readTaskDetail(taskId: string): Promise<RemoteTaskDetail> {
    const raw = await this.getJson(
      `/api/v1/tasks/${encodeURIComponent(taskId)}`,
    );
    const parsed = z
      .object({
        id: z.literal(taskId),
        title: z.string().nullable(),
        workflowStatus: z.enum([
          "running",
          "idle",
          "waiting",
          "blocked",
          "done",
        ]),
      })
      .passthrough()
      .safeParse(raw);
    if (!parsed.success) {
      throw new HostConnectionFailure("protocol_mismatch");
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

  async sendTaskMessage(input: {
    sourceTaskId: string;
    targetTaskId: string;
    body: string;
    clientOpId: string;
    sourceLabel: string;
  }): Promise<HostTaskSendAttempt> {
    let token: string;
    try {
      token = await this.resolveToken();
    } catch (error) {
      return { kind: "unknown", reason: errorMessage(error) };
    }
    let response: Response;
    try {
      response = await this.fetchResponse(
        `/api/v1/tasks/${encodeURIComponent(input.sourceTaskId)}/messages`,
        {
          token,
          method: "POST",
          body: {
            targetTaskId: input.targetTaskId,
            body: input.body,
            sourceLabel: input.sourceLabel,
          },
          headers: { "X-Client-Op-Id": input.clientOpId },
          redirect: "error",
        },
      );
    } catch (error) {
      return { kind: "unknown", reason: errorMessage(error) };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (response.status === HTTP_STATUS.ACCEPTED) {
      if (
        body &&
        typeof body === "object" &&
        typeof (body as { messageId?: unknown }).messageId === "string"
      ) {
        return {
          kind: "accepted",
          messageId: (body as { messageId: string }).messageId,
        };
      }
      return { kind: "unknown", reason: "Owner returned no message id" };
    }
    const reason =
      body &&
      typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `HTTP ${response.status}`;
    return response.status >= HTTP_STATUS.BAD_REQUEST &&
      response.status < HTTP_STATUS.INTERNAL_SERVER_ERROR
      ? { kind: "rejected", status: response.status, reason }
      : { kind: "unknown", reason };
  }

  private async runAttempt(attempt: StreamAttempt): Promise<void> {
    this.options.onState?.("connecting");
    const token = await this.resolveToken(attempt);
    if (!attempt.isCurrent()) return;
    this.supervisor.beginHandshake(attempt);
    const version = await this.request(attempt.signal, "/api/v1/version");
    if (
      !version ||
      typeof version !== "object" ||
      (version as { hostProtocol?: unknown }).hostProtocol !==
        HOST_PROTOCOL_VERSION
    ) {
      throw new HostConnectionFailure("protocol_mismatch");
    }
    const caller = await this.request(
      attempt.signal,
      "/api/v1/auth/verify",
      token,
    );
    if (!caller || typeof caller !== "object") {
      throw new HostConnectionFailure("protocol_mismatch");
    }
    const identity = caller as { hash?: unknown; scope?: unknown };
    if (identity.hash !== hashToken(token) || !isScope(identity.scope)) {
      throw new HostConnectionFailure("protocol_mismatch");
    }
    const ticketResponse = await this.fetchResponse("/api/v1/sse-ticket", {
      signal: attempt.signal,
      token,
      method: "POST",
      body: { parentIds: this.options.subscriptionParentIds?.() ?? [] },
    });
    if (!ticketResponse.ok) throw this.httpFailure(ticketResponse.status);
    let ticketBody: unknown;
    try {
      ticketBody = await ticketResponse.json();
    } catch {
      throw new HostConnectionFailure("protocol_mismatch");
    }
    const ticket =
      ticketBody && typeof ticketBody === "object"
        ? (ticketBody as { ticket?: unknown }).ticket
        : undefined;
    if (typeof ticket !== "string" || !ticket) {
      throw new HostConnectionFailure("protocol_mismatch");
    }
    const response = await this.fetchResponse(
      `/api/v1/events/stream?ticket=${encodeURIComponent(ticket)}`,
      { signal: attempt.signal, timeoutMs: null },
    );
    if (!response.ok) throw this.httpFailure(response.status);
    if (!response.body) throw new HostConnectionFailure("protocol_mismatch");
    this.connectionId = response.headers.get("X-Host-Connection-Id");
    try {
      await this.consume(response.body, attempt);
    } finally {
      this.connectionId = null;
    }
  }

  static failureReason(error: unknown): HostUnreachableReason {
    if (error instanceof TokenCommandError) return "token_command_failed";
    if (error instanceof HostConnectionFailure) return error.reason;
    return "network";
  }

  private async resolveToken(attempt?: StreamAttempt): Promise<string> {
    while (this.tokenCommand) {
      try {
        await this.tokenCommand;
      } catch {
        // The prior attempt reports its own outcome.
      }
      if (attempt && !attempt.isCurrent()) {
        throw new Error("stale host attempt");
      }
    }
    if (attempt && !attempt.isCurrent()) {
      throw new Error("stale host attempt");
    }
    const command = resolveHostToken(
      this.config.token,
      undefined,
      attempt?.signal,
    );
    this.tokenCommand = command;
    try {
      return await command;
    } finally {
      if (this.tokenCommand === command) this.tokenCommand = null;
    }
  }

  private async request(
    signal: AbortSignal,
    path: string,
    token?: string,
    method = "GET",
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchResponse(path, {
        signal,
        token,
        method,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new HostConnectionFailure("network");
    }
    if (!response.ok) throw this.httpFailure(response.status);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new HostConnectionFailure("protocol_mismatch");
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

  // eslint-disable-next-line complexity -- one framed-stream parser owns handshake, heartbeat, and event delivery.
  private async consume(
    body: ReadableStream<Uint8Array>,
    attempt: StreamAttempt,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let connected = false;
    let refreshPromise: Promise<void> | null = null;
    let bufferedEvents: HostStreamEvent[] = [];
    try {
      while (attempt.isCurrent()) {
        const result = await reader.read();
        if (!attempt.isCurrent()) return;
        if (result.done) throw new HostConnectionFailure("network");
        buffer += decoder.decode(result.value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = frame
            .split(/\r?\n/)
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim();
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!connected && data) {
            let parsed: { type?: unknown };
            try {
              parsed = JSON.parse(data) as { type?: unknown };
            } catch {
              throw new HostConnectionFailure("protocol_mismatch");
            }
            if (parsed.type === "connected") {
              if (!attempt.isCurrent()) return;
              connected = true;
              this.supervisor.connected(attempt);
              if (!attempt.isCurrent()) return;
              refreshPromise = Promise.resolve(
                this.options.onConnected?.(() => attempt.isCurrent()),
              );
              const ownedRefresh = refreshPromise;
              void ownedRefresh.then(
                async () => {
                  if (!attempt.isCurrent() || refreshPromise !== ownedRefresh)
                    return;
                  try {
                    while (bufferedEvents.length > 0) {
                      const pending = bufferedEvents;
                      bufferedEvents = [];
                      for (const pendingEvent of pending) {
                        if (!attempt.isCurrent()) return;
                        await this.options.onEvent?.(pendingEvent);
                      }
                    }
                    if (
                      attempt.isCurrent() &&
                      refreshPromise === ownedRefresh
                    ) {
                      refreshPromise = null;
                      this.options.onState?.("connected");
                    }
                  } catch {
                    if (attempt.isCurrent()) this.supervisor.reconnect(attempt);
                  }
                },
                () => {
                  if (attempt.isCurrent() && refreshPromise === ownedRefresh) {
                    this.supervisor.reconnect(attempt);
                  }
                },
              );
              boundary = buffer.indexOf("\n\n");
              continue;
            }
          }
          if (connected && event !== "heartbeat" && data) {
            let payload: unknown;
            try {
              payload = JSON.parse(data) as unknown;
            } catch {
              throw new HostConnectionFailure("protocol_mismatch");
            }
            if (
              payload &&
              typeof payload === "object" &&
              !Array.isArray(payload)
            ) {
              const id = frame
                .split(/\r?\n/)
                .find((line) => line.startsWith("id:"))
                ?.slice(3)
                .trim();
              const seq = id === undefined ? NaN : Number(id);
              const streamEvent: HostStreamEvent = {
                ...(Number.isInteger(seq) ? { seq } : {}),
                data: payload as Record<string, unknown>,
              };
              if (refreshPromise) {
                bufferedEvents.push(streamEvent);
              } else {
                await this.options.onEvent?.(streamEvent);
              }
            }
          }
          if (connected && event === "heartbeat") {
            this.supervisor.noteActivity(attempt);
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
