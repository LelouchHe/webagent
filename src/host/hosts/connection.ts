import type { HostConfig } from "../../config.ts";
import { HTTP_STATUS } from "../../http-status.ts";
import {
  hostCredentialFingerprint,
  resolveHostToken,
  TokenCommandError,
} from "./credentials.ts";
import { parseHostDescription, type HostDescription } from "./protocol.ts";
import type { HostConnectionState, HostUnreachableReason } from "./state.ts";

const REQUEST_TIMEOUT_MS = 8_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 3;
const HEARTBEAT_POLL_MS = 5_000;

export interface HostConnectionOptions {
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
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

function bindAbort(source: AbortSignal, target: AbortController): () => void {
  const abortTarget = () => {
    target.abort();
  };
  source.addEventListener("abort", abortTarget, { once: true });
  if (source.aborted) target.abort();
  return () => {
    source.removeEventListener("abort", abortTarget);
  };
}

export class HostConnection {
  private readonly config: HostConfig;
  private readonly stopSignal: AbortSignal;
  private readonly options: HostConnectionOptions;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;

  constructor(
    config: HostConfig,
    stopSignal: AbortSignal,
    options: HostConnectionOptions = {},
  ) {
    this.config = config;
    this.stopSignal = stopSignal;
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.heartbeatTimeoutMs =
      options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  }

  async connect(): Promise<void> {
    this.options.onState?.("connecting");
    const token = await resolveHostToken(
      this.config.token,
      undefined,
      this.stopSignal,
    );
    const fingerprint = hostCredentialFingerprint(token);
    const description = await this.describe(token);
    if (description.caller.fingerprint !== fingerprint) {
      throw new HostConnectionFailure("protocol_mismatch");
    }
    const ticket = await this.ticket(token);
    if (this.stopSignal.aborted) {
      throw this.stopSignal.reason;
    }
    const streamAbort = new AbortController();
    const unbindStop = bindAbort(this.stopSignal, streamAbort);
    let rejectHandshake: (reason: unknown) => void = () => {};
    const handshakeTimer = setTimeout(() => {
      streamAbort.abort();
      rejectHandshake(new HostConnectionFailure("network"));
    }, this.requestTimeoutMs);
    handshakeTimer.unref();
    const handshakeDeadline = new Promise<never>((_resolve, reject) => {
      rejectHandshake = reject;
    });
    try {
      await Promise.race([
        this.openStream(ticket, description, streamAbort, () => {
          clearTimeout(handshakeTimer);
        }),
        handshakeDeadline,
      ]);
    } finally {
      clearTimeout(handshakeTimer);
      unbindStop();
      streamAbort.abort();
    }
  }

  static failureReason(error: unknown): HostUnreachableReason {
    if (error instanceof TokenCommandError) return "token_command_failed";
    if (error instanceof HostConnectionFailure) return error.reason;
    return "network";
  }

  private async openStream(
    ticket: string,
    description: HostDescription,
    abort: AbortController,
    onConnected: () => void,
  ): Promise<void> {
    const response = await this.fetchImpl(
      `${endpoint(this.config.url, "/api/v1/events/stream")}?ticket=${encodeURIComponent(ticket)}`,
      { signal: abort.signal },
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
    await this.consume(response.body, description, abort, onConnected);
  }

  private async describe(token: string): Promise<HostDescription> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        endpoint(this.config.url, "/api/v1/host"),
        {
          headers: authorizeHeaders(token),
          signal: timeoutSignal(this.stopSignal, this.requestTimeoutMs),
        },
      );
    } catch (error) {
      if (this.stopSignal.aborted) throw error;
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

  private async ticket(token: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        endpoint(this.config.url, "/api/v1/sse-ticket"),
        {
          method: "POST",
          headers: authorizeHeaders(token),
          signal: timeoutSignal(this.stopSignal, this.requestTimeoutMs),
        },
      );
    } catch (error) {
      if (this.stopSignal.aborted) throw error;
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
    abort: AbortController,
    onConnected: () => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let connected = false;
    let lastHeartbeatAt = 0;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    try {
      while (!this.stopSignal.aborted) {
        const result = await reader.read();
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
          if (event === "heartbeat") {
            lastHeartbeatAt = performance.now();
          }
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
              onConnected();
              lastHeartbeatAt = performance.now();
              heartbeatTimer = setInterval(
                () => {
                  if (
                    performance.now() - lastHeartbeatAt >=
                    this.heartbeatTimeoutMs
                  ) {
                    abort.abort();
                  }
                },
                Math.min(HEARTBEAT_POLL_MS, this.heartbeatTimeoutMs),
              );
              heartbeatTimer.unref();
              this.options.onState?.("connected");
              void this.options.onConnected?.(description);
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      reader.releaseLock();
    }
  }
}
