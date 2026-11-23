import { hashToken } from "../../auth.ts";
import { HTTP_STATUS } from "../../http-status.ts";
import {
  StreamSupervisor,
  STREAM_STALL_TIMEOUT_MS,
  type StreamAttempt,
  type StreamFailure,
} from "../../shared/stream-supervisor.ts";
import type { HostConfig } from "../../config.ts";
import { resolveHostToken, TokenCommandError } from "./credentials.ts";
import {
  HOST_PROTOCOL_VERSION,
  type HostConnectionState,
  type HostUnreachableReason,
} from "./state.ts";

const REQUEST_TIMEOUT_MS = 8_000;

export interface HostConnectionOptions {
  fetch?: typeof globalThis.fetch;
  handshakeTimeoutMs?: number;
  retryDelay: (failures: number, failure: StreamFailure) => number;
  onState?: (
    state: HostConnectionState,
    reason?: HostUnreachableReason,
  ) => void;
  onConnected?: () => void;
}

class HostConnectionFailure extends Error {
  readonly reason: HostUnreachableReason;

  constructor(reason: HostUnreachableReason) {
    super(reason);
    this.name = "HostConnectionFailure";
    this.reason = reason;
  }
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export class HostConnection {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly config: HostConfig;
  private readonly options: HostConnectionOptions;
  private readonly supervisor: StreamSupervisor;
  private tokenCommand: Promise<string> | null = null;

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
    if (
      identity.hash !== hashToken(token) ||
      (identity.scope !== "read" &&
        identity.scope !== "api" &&
        identity.scope !== "admin")
    ) {
      throw new HostConnectionFailure("protocol_mismatch");
    }
    if (identity.scope === "read") {
      throw new HostConnectionFailure("insufficient_scope");
    }
    const ticketBody = await this.request(
      attempt.signal,
      "/api/v1/sse-ticket",
      token,
      "POST",
    );
    const ticket =
      ticketBody && typeof ticketBody === "object"
        ? (ticketBody as { ticket?: unknown }).ticket
        : undefined;
    if (typeof ticket !== "string" || !ticket) {
      throw new HostConnectionFailure("protocol_mismatch");
    }
    const response = await this.fetchImpl(
      `${endpoint(this.config.url, "/api/v1/events/stream")}?ticket=${encodeURIComponent(ticket)}`,
      { signal: attempt.signal },
    );
    if (!response.ok) throw this.httpFailure(response.status);
    if (!response.body) throw new HostConnectionFailure("protocol_mismatch");
    await this.consume(response.body, attempt);
  }

  static failureReason(error: unknown): HostUnreachableReason {
    if (error instanceof TokenCommandError) return "token_command_failed";
    if (error instanceof HostConnectionFailure) return error.reason;
    return "network";
  }

  private async resolveToken(attempt: StreamAttempt): Promise<string> {
    while (this.tokenCommand) {
      try {
        await this.tokenCommand;
      } catch {
        // The prior attempt reports its own outcome.
      }
      if (!attempt.isCurrent()) throw new Error("stale host attempt");
    }
    if (!attempt.isCurrent()) throw new Error("stale host attempt");
    const command = resolveHostToken(
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

  private async request(
    signal: AbortSignal,
    path: string,
    token?: string,
    method = "GET",
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint(this.config.url, path), {
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
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

  private httpFailure(status: number): HostConnectionFailure {
    return new HostConnectionFailure(
      status === HTTP_STATUS.UNAUTHORIZED || status === HTTP_STATUS.FORBIDDEN
        ? "unauthorized"
        : "network",
    );
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
              if (attempt.isCurrent()) void this.options.onConnected?.();
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
