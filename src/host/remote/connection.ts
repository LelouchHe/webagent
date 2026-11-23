import type { HostConfig } from "../../config.ts";
import { HTTP_STATUS } from "../../http-status.ts";
import {
  hostCredentialFingerprint,
  resolveHostToken,
  TokenCommandError,
} from "./credentials.ts";
import { parseHostDescription, type HostDescription } from "./protocol.ts";
import type { HostConnectionState, HostUnreachableReason } from "./state.ts";
import {
  StreamSupervisor,
  type StreamAttempt,
  type StreamFailure,
} from "../../shared/stream-supervisor.ts";

const REQUEST_TIMEOUT_MS = 8_000;

export interface HostConnectionOptions {
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  retryDelay: (failures: number, failure: StreamFailure) => number;
  onState?: (
    state: HostConnectionState,
    reason?: HostUnreachableReason,
  ) => void;
  onConnected?: (description: HostDescription) => void | Promise<void>;
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

  constructor(config: HostConfig, options: HostConnectionOptions) {
    this.config = config;
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.supervisor = new StreamSupervisor({
      run: (attempt) => this.runAttempt(attempt),
      retryDelay: options.retryDelay,
      stallTimeoutMs: options.heartbeatTimeoutMs,
      onFailure: (failure) => {
        const reason =
          failure.kind === "stalled"
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
    const token = await resolveHostToken(
      this.config.token,
      undefined,
      attempt.signal,
    );
    const fingerprint = hostCredentialFingerprint(token);
    const description = await this.describe(token, attempt.signal);
    if (description.caller.fingerprint !== fingerprint) {
      throw new HostConnectionFailure("protocol_mismatch");
    }
    const ticket = await this.ticket(token, attempt.signal);
    await this.openStream(ticket, description, attempt);
  }

  static failureReason(error: unknown): HostUnreachableReason {
    if (error instanceof TokenCommandError) return "token_command_failed";
    if (error instanceof HostConnectionFailure) return error.reason;
    return "network";
  }

  private async openStream(
    ticket: string,
    description: HostDescription,
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
    await this.consume(response.body, description, attempt);
  }

  private async describe(
    token: string,
    stopSignal: AbortSignal,
  ): Promise<HostDescription> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        endpoint(this.config.url, "/api/v1/host"),
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
    try {
      return parseHostDescription(await responseJson(response));
    } catch {
      throw new HostConnectionFailure("protocol_mismatch");
    }
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
    description: HostDescription,
    attempt: StreamAttempt,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let connected = false;
    try {
      while (attempt.isCurrent()) {
        const result = await reader.read();
        if (result.done) throw new HostConnectionFailure("network");
        buffer += decoder.decode(result.value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.supervisor.noteActivity(attempt);
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
              connected = true;
              this.supervisor.connected(attempt);
              this.options.onState?.("connected");
              void this.options.onConnected?.(description);
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
