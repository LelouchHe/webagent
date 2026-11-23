import type { HostConfig } from "../../config.ts";
import { HTTP_STATUS } from "../../http-status.ts";
import { hashToken } from "../../auth.ts";
import { resolveHostToken, TokenCommandError } from "./credentials.ts";
import type { HostConnectionState, HostUnreachableReason } from "./state.ts";
import {
  StreamSupervisor,
  type StreamAttempt,
  type StreamFailure,
  STREAM_STALL_TIMEOUT_MS,
} from "../../shared/stream-supervisor.ts";

const REQUEST_TIMEOUT_MS = 8_000;

export interface HostConnectionOptions {
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  retryDelay: (failures: number, failure: StreamFailure) => number;
  resolveToken?: (
    configured: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ) => Promise<string>;
  onState?: (
    state: HostConnectionState,
    reason?: HostUnreachableReason,
  ) => void;
  onConnected?: () => void | Promise<void>;
}

class HostConnectionFailure extends Error {
  readonly reason: HostUnreachableReason;

  constructor(reason: HostUnreachableReason) {
    super(reason);
    this.name = "HostConnectionFailure";
    this.reason = reason;
  }
}

function timeoutSignal(parent: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new HostConnectionFailure("protocol_mismatch");
  }
}

function authorizeHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export class HostConnection {
  private readonly config: HostConfig;
  private readonly options: HostConnectionOptions;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly supervisor: StreamSupervisor;
  private tokenCommand: Promise<string> | null = null;

  constructor(config: HostConfig, options: HostConnectionOptions) {
    this.config = config;
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.supervisor = new StreamSupervisor({
      run: (attempt) => this.runAttempt(attempt),
      retryDelay: options.retryDelay,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? STREAM_STALL_TIMEOUT_MS,
      stallTimeoutMs: options.heartbeatTimeoutMs,
      now: () => performance.now(),
      onFailure: (failure) => {
        const reason =
          failure.kind === "stalled" || failure.kind === "handshake"
            ? "network"
            : HostConnection.failureReason(failure.error);
        this.options.onState?.("unreachable", reason);
      },
    });
  }

  start(): void {
    this.supervisor.start();
  }

  stop(): void {
    this.supervisor.stop();
  }

  private async runAttempt(attempt: StreamAttempt): Promise<void> {
    this.options.onState?.("connecting");
    const token = await this.resolveToken(attempt);
    if (!attempt.isCurrent()) return;
    await this.checkProtocol(attempt.signal);
    const caller = await this.verifyCaller(token, attempt.signal);
    if (caller.hash !== hashToken(token)) {
      throw new HostConnectionFailure("protocol_mismatch");
    }
    if (caller.scope === "read") {
      throw new HostConnectionFailure("insufficient_scope");
    }
    const ticket = await this.ticket(token, attempt.signal);
    await this.openStream(ticket, attempt);
  }

  static failureReason(error: unknown): HostUnreachableReason {
    if (error instanceof TokenCommandError) return "token_command_failed";
    if (error instanceof HostConnectionFailure) return error.reason;
    return "network";
  }

  private async resolveToken(attempt: StreamAttempt): Promise<string> {
    while (this.tokenCommand) {
      const pending = this.tokenCommand;
      try {
        await pending;
      } catch {
        // The old attempt owns that result. This attempt only waits for the
        // command to finish before it starts another one.
      }
      if (!attempt.isCurrent()) throw new Error("stale host attempt");
    }
    if (!attempt.isCurrent()) throw new Error("stale host attempt");
    const command = (this.options.resolveToken ?? resolveHostToken)(
      this.config.token,
      undefined,
      attempt.signal,
    );
    this.tokenCommand = command;
    try {
      return await command;
    } finally {
      if (this.tokenCommand === command) this.tokenCommand = null;
    }
  }

  private async openStream(
    ticket: string,
    attempt: StreamAttempt,
  ): Promise<void> {
    const response = await this.fetchImpl(
      `${endpoint(this.config.url, "/api/v1/events/stream")}?ticket=${encodeURIComponent(ticket)}`,
      { signal: attempt.signal },
    );
    if (!response.ok) {
      throw response.status === HTTP_STATUS.UNAUTHORIZED ||
        response.status === HTTP_STATUS.FORBIDDEN
        ? new HostConnectionFailure("unauthorized")
        : new HostConnectionFailure("network");
    }
    if (!response.body) {
      throw new HostConnectionFailure("protocol_mismatch");
    }
    await this.consume(response.body, attempt);
  }

  private async checkProtocol(stopSignal: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        endpoint(this.config.url, "/api/v1/version"),
        {
          signal: timeoutSignal(stopSignal, this.requestTimeoutMs),
        },
      );
    } catch (error) {
      if (stopSignal.aborted) throw error;
      throw new HostConnectionFailure("network");
    }
    if (!response.ok) throw new HostConnectionFailure("network");
    const body = await responseJson(response);
    const protocol =
      body && typeof body === "object"
        ? (body as { hostProtocol?: unknown }).hostProtocol
        : undefined;
    if (protocol !== 1) {
      throw new HostConnectionFailure("protocol_mismatch");
    }
  }

  private async verifyCaller(
    token: string,
    stopSignal: AbortSignal,
  ): Promise<{ hash: string; scope: "api" | "admin" | "read" }> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        endpoint(this.config.url, "/api/v1/auth/verify"),
        {
          headers: authorizeHeaders(token),
          signal: timeoutSignal(stopSignal, this.requestTimeoutMs),
        },
      );
    } catch (error) {
      if (stopSignal.aborted) throw error;
      throw new HostConnectionFailure("network");
    }
    if (
      response.status === HTTP_STATUS.UNAUTHORIZED ||
      response.status === HTTP_STATUS.FORBIDDEN
    ) {
      throw new HostConnectionFailure("unauthorized");
    }
    if (!response.ok) throw new HostConnectionFailure("network");
    const body = await responseJson(response);
    if (!body || typeof body !== "object") {
      throw new HostConnectionFailure("protocol_mismatch");
    }
    const record = body as { hash?: unknown; scope?: unknown };
    if (
      typeof record.hash !== "string" ||
      (record.scope !== "api" &&
        record.scope !== "admin" &&
        record.scope !== "read")
    ) {
      throw new HostConnectionFailure("protocol_mismatch");
    }
    return { hash: record.hash, scope: record.scope };
  }

  private async ticket(
    token: string,
    stopSignal: AbortSignal,
  ): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        endpoint(this.config.url, "/api/v1/sse-ticket"),
        {
          method: "POST",
          headers: authorizeHeaders(token),
          signal: timeoutSignal(stopSignal, this.requestTimeoutMs),
        },
      );
    } catch (error) {
      if (stopSignal.aborted) throw error;
      throw new HostConnectionFailure("network");
    }
    if (
      response.status === HTTP_STATUS.UNAUTHORIZED ||
      response.status === HTTP_STATUS.FORBIDDEN
    ) {
      throw new HostConnectionFailure("unauthorized");
    }
    if (!response.ok) throw new HostConnectionFailure("network");
    const body = await responseJson(response);
    const ticket =
      body && typeof body === "object"
        ? (body as { ticket?: unknown }).ticket
        : undefined;
    if (typeof ticket !== "string" || ticket.length === 0) {
      throw new HostConnectionFailure("protocol_mismatch");
    }
    return ticket;
  }

  private async consume(
    body: ReadableStream<Uint8Array>,
    attempt: StreamAttempt,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let connected = false;
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
              this.options.onState?.("connected");
              if (attempt.isCurrent()) {
                void this.options.onConnected?.();
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
