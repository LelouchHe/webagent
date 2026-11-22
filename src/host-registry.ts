import { execFile } from "node:child_process";
import { hashToken } from "./auth.ts";
import type { HostConfig } from "./config.ts";
import { log } from "./log.ts";
import {
  HOST_API_VERSION,
  parseHostDescription,
  parseHostEnvelope,
  requestHash,
  type HostDescription,
} from "./host-protocol.ts";
import type { HostEnvelope, Store } from "./store.ts";
import type { TaskManager } from "./task-manager.ts";
import { HTTP_STATUS } from "./http-status.ts";

const slog = log.scope("hosts");
const REQUEST_TIMEOUT_MS = 8_000;
const TOKEN_TIMEOUT_MS = 5_000;
const SSE_STALL_MS = 45_000;
const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

export class SecretResolutionError extends Error {
  constructor() {
    super("token resolution failed");
    this.name = "SecretResolutionError";
  }
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

export async function resolveSecret(
  value: string,
  timeoutMs = TOKEN_TIMEOUT_MS,
): Promise<string> {
  if (!value.startsWith("!")) return value;
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "/bin/sh",
      ["-c", value.slice(1)],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: timeoutMs,
      },
      (error, result) => {
        if (error) {
          reject(new SecretResolutionError());
          return;
        }
        resolve(result);
      },
    );
  });
  const token = stdout.trim();
  if (!token) throw new SecretResolutionError();
  return token;
}

export type HostConnectionState =
  | {
      status: "ok";
      description: HostDescription;
      credentialHash: string;
    }
  | { status: "unreachable"; reason: string };

interface HostRuntime {
  token: string;
  credentialHash: string;
  baseUrl: string;
  streamAbort: AbortController | null;
  dirty: boolean;
  pulling: boolean;
  retryMs: number;
  description: HostDescription | null;
  pullRetryAt: number;
  pullRetryTimer: ReturnType<typeof setTimeout> | null;
}

interface HostRegistryOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  requestTimeoutMs?: number;
  log?: (line: string) => void;
}

type NextHostDispatch = NonNullable<ReturnType<Store["nextHostDispatch"]>>;

export class HostRegistry {
  private readonly hosts: Record<string, HostConfig>;
  private readonly store: Store;
  private readonly tasks: TaskManager;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly runtimes = new Map<string, HostRuntime>();
  private readonly states = new Map<string, HostConnectionState>();
  private readonly edgeSends = new Set<string>();
  private readonly edgeRetries = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly edgeRetryMs = new Map<string, number>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly logLine: (line: string) => void;
  private started = false;
  private stopped = false;

  constructor(
    hosts: Record<string, HostConfig>,
    store: Store,
    tasks: TaskManager,
    options: HostRegistryOptions = {},
  ) {
    this.hosts = hosts;
    this.store = store;
    this.tasks = tasks;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds).unref()));
    this.logLine =
      options.log ??
      ((line) => {
        slog.info(line);
      });
  }

  state(name: string): HostConnectionState | undefined {
    return this.states.get(name);
  }

  agentCoordinates(): string[] {
    const result: string[] = [];
    for (const [name, state] of this.states) {
      if (state.status !== "ok") continue;
      for (const agentId of state.description.agent_ids) {
        result.push(`${agentId}@${name}`);
      }
    }
    return result;
  }

  remoteAgentId(agentAndHost: string): {
    agentId: string;
    hostName: string;
    credentialHash: string;
  } | null {
    const split = agentAndHost.lastIndexOf("@");
    if (split <= 0 || split === agentAndHost.length - 1) return null;
    const agentId = agentAndHost.slice(0, split);
    const hostName = agentAndHost.slice(split + 1);
    const state = this.states.get(hostName);
    if (
      state?.status !== "ok" ||
      !state.description.agent_ids.includes(agentId)
    ) {
      return null;
    }
    return { agentId, hostName, credentialHash: state.credentialHash };
  }

  start(): void {
    if (this.started || Object.keys(this.hosts).length === 0) return;
    this.started = true;
    for (const name of Object.keys(this.hosts)) {
      void this.run(name).catch(() => {
        if (!this.isStopped()) this.unreachable(name, "connection loop failed");
      });
    }
  }

  stop(): void {
    this.stopped = true;
    for (const abort of this.aborts.values()) abort.abort();
    for (const runtime of this.runtimes.values()) {
      runtime.streamAbort?.abort();
      if (runtime.pullRetryTimer) clearTimeout(runtime.pullRetryTimer);
    }
    for (const timer of this.edgeRetries.values()) clearTimeout(timer);
    this.edgeRetries.clear();
  }

  private isStopped(): boolean {
    return this.stopped;
  }

  private endpoint(
    runtime: Pick<HostRuntime, "baseUrl">,
    path: string,
  ): string {
    return `${runtime.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private async resolve(name: string): Promise<HostRuntime> {
    const config = this.hosts[name];
    const token = await resolveSecret(config.token);
    return {
      token,
      credentialHash: hashToken(token),
      baseUrl: config.url,
      streamAbort: null,
      dirty: true,
      pulling: false,
      retryMs: MIN_RETRY_MS,
      description: null,
      pullRetryAt: 0,
      pullRetryTimer: null,
    };
  }

  private requestSignal(): AbortSignal {
    return AbortSignal.timeout(this.requestTimeoutMs);
  }

  private async request(
    runtime: HostRuntime,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return this.fetchImpl(this.endpoint(runtime, path), {
      ...init,
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      signal: init.signal ?? this.requestSignal(),
    });
  }

  private unreachable(name: string, reason: string): void {
    this.states.set(name, { status: "unreachable", reason });
    this.logLine(`[hosts] ${name}: unreachable (${reason})`);
  }

  private reachable(name: string, runtime: HostRuntime): void {
    if (!runtime.description) return;
    this.states.set(name, {
      status: "ok",
      description: runtime.description,
      credentialHash: runtime.credentialHash,
    });
  }

  private async run(name: string): Promise<void> {
    let backoff = MIN_RETRY_MS;
    while (!this.stopped) {
      let streamAbort: AbortController | undefined;
      try {
        const runtime = await this.resolve(name);
        const descriptionResponse = await this.request(runtime, "/api/v1/host");
        if (!descriptionResponse.ok) {
          throw new Error(`HTTP ${descriptionResponse.status}`);
        }
        const description = parseHostDescription(
          await descriptionResponse.json(),
        );
        runtime.description = description;
        if (description.host_api_version !== HOST_API_VERSION) {
          throw new Error(
            `host API version ${description.host_api_version} is not ${HOST_API_VERSION}`,
          );
        }
        const ticketResponse = await this.request(
          runtime,
          "/api/v1/sse-ticket",
          {
            method: "POST",
          },
        );
        if (!ticketResponse.ok) {
          throw new Error(`SSE ticket HTTP ${ticketResponse.status}`);
        }
        const ticketBody = (await ticketResponse.json()) as {
          ticket?: unknown;
        };
        if (typeof ticketBody.ticket !== "string") {
          throw new Error("invalid SSE ticket");
        }
        streamAbort = new AbortController();
        runtime.streamAbort = streamAbort;
        this.aborts.set(name, streamAbort);
        const stall = setTimeout(
          () => streamAbort?.abort(),
          this.requestTimeoutMs,
        );
        const streamResponse = await this.fetchImpl(
          `${this.endpoint(runtime, "/api/v1/events/stream")}?ticket=${encodeURIComponent(ticketBody.ticket)}`,
          { signal: streamAbort.signal },
        );
        clearTimeout(stall);
        if (!streamResponse.ok || !streamResponse.body) {
          throw new Error(`SSE HTTP ${streamResponse.status}`);
        }
        this.runtimes.set(name, runtime);
        this.reachable(name, runtime);
        this.logLine(`[hosts] ${name}: connected`);
        backoff = MIN_RETRY_MS;
        await this.readStream(name, runtime, streamResponse.body);
      } catch (error) {
        if (!this.isStopped()) {
          const safeReason =
            error instanceof SecretResolutionError
              ? error.message
              : isTimeoutError(error)
                ? "connection timed out"
                : "connection failed";
          this.unreachable(name, safeReason);
        }
      } finally {
        streamAbort?.abort();
        this.aborts.delete(name);
        this.runtimes.delete(name);
      }
      if (this.isStopped()) return;
      await this.sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_RETRY_MS);
    }
  }

  private async readStream(
    name: string,
    runtime: HostRuntime,
    body: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let connected = false;
    let lastFrame = Date.now();
    const stallTimer = setInterval(() => {
      if (Date.now() - lastFrame >= SSE_STALL_MS) {
        runtime.streamAbort?.abort();
      }
    }, 5_000);
    stallTimer.unref();
    try {
      while (!this.stopped) {
        const result = await reader.read();
        if (result.done) throw new Error("SSE EOF");
        buffer += decoder.decode(result.value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          lastFrame = Date.now();
          const dataLines = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart());
          if (dataLines.length > 0) {
            const data = JSON.parse(dataLines.join("\n")) as {
              type?: unknown;
            };
            if (!connected && data.type === "connected") {
              connected = true;
              runtime.dirty = true;
              this.runPull(name, runtime);
              this.resumeEdges(runtime.credentialHash);
            } else if (data.type === "host_message_pending") {
              this.markDirty(name);
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      clearInterval(stallTimer);
    }
  }

  markDirty(name: string): void {
    const runtime = this.runtimes.get(name);
    if (!runtime) return;
    runtime.dirty = true;
    this.runPull(name, runtime);
  }

  private runPull(name: string, runtime: HostRuntime): void {
    void this.pull(name, runtime).catch(() => {
      if (!this.isStopped()) this.schedulePullRetry(name, runtime);
    });
  }

  private async pull(name: string, runtime: HostRuntime): Promise<void> {
    if (runtime.pulling || !runtime.dirty || this.isStopped()) return;
    if (runtime.pullRetryAt > this.now()) {
      this.schedulePullRetry(name, runtime);
      return;
    }
    runtime.pulling = true;
    if (runtime.pullRetryTimer) {
      clearTimeout(runtime.pullRetryTimer);
      runtime.pullRetryTimer = null;
    }
    runtime.pullRetryAt = 0;
    let stalled = false;
    let reschedule = false;
    try {
      while (runtime.dirty && !this.isStopped()) {
        runtime.dirty = false;
        const outcome = await this.pullPage(name, runtime);
        stalled = outcome === "stalled";
        this.reachable(name, runtime);
        if (outcome === "drained") runtime.dirty = true;
      }
    } catch {
      const retryMs = runtime.retryMs;
      if (!this.isStopped()) reschedule = true;
      runtime.retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      runtime.pullRetryAt = this.now() + retryMs;
      this.unreachable(name, "host request failed");
    } finally {
      runtime.pulling = false;
      runtime.retryMs = Math.min(runtime.retryMs, MAX_RETRY_MS);
      if ((stalled || reschedule) && !this.isStopped()) {
        this.schedulePullRetry(
          name,
          runtime,
          stalled ? MAX_RETRY_MS : undefined,
        );
      }
    }
  }

  private async pullPage(
    name: string,
    runtime: HostRuntime,
  ): Promise<"empty" | "drained" | "stalled"> {
    const response = await this.request(runtime, "/api/v1/host/messages");
    if (!response.ok) throw new Error(`inbox HTTP ${response.status}`);
    const body = (await response.json()) as { messages?: unknown };
    if (!Array.isArray(body.messages)) throw new Error("invalid inbox");
    const messages = body.messages.map(parseHostEnvelope);
    if (messages.length === 0) {
      runtime.retryMs = MIN_RETRY_MS;
      return "empty";
    }
    for (const envelope of messages) {
      await this.acceptAndAck(name, runtime, envelope);
    }
    return this.store.hostReportPageStillQueued(
      name,
      runtime.credentialHash,
      messages.map((message) => message.id),
    )
      ? "stalled"
      : "drained";
  }

  private async acceptAndAck(
    name: string,
    runtime: HostRuntime,
    envelope: HostEnvelope,
  ): Promise<void> {
    if (this.ingest(name, runtime, envelope) === "unmatched") return;
    try {
      const ack = await this.request(
        runtime,
        `/api/v1/host/messages/${encodeURIComponent(envelope.id)}/ack`,
        { method: "POST" },
      );
      if (!ack.ok) throw new Error(`ACK HTTP ${ack.status}`);
    } catch (error) {
      this.store.markHostReportAck(name, runtime.credentialHash, envelope.id);
      throw error;
    }
    const recipient = this.store.markHostReportAck(
      name,
      runtime.credentialHash,
      envelope.id,
    );
    if (recipient) {
      void this.tasks.drainCollaborationDeliveries(recipient);
    }
  }

  private schedulePullRetry(
    name: string,
    runtime: HostRuntime,
    delayOverride?: number,
  ): void {
    if (
      runtime.pullRetryTimer ||
      this.isStopped() ||
      this.runtimes.get(name) !== runtime
    ) {
      return;
    }
    const delay =
      delayOverride ?? Math.max(0, runtime.pullRetryAt - this.now());
    runtime.pullRetryAt = this.now() + delay;
    const timer = setTimeout(() => {
      runtime.pullRetryTimer = null;
      if (this.runtimes.get(name) !== runtime || this.isStopped()) return;
      runtime.dirty = true;
      this.runPull(name, runtime);
    }, delay);
    timer.unref();
    runtime.pullRetryTimer = timer;
  }

  private ingest(
    hostName: string,
    runtime: HostRuntime,
    envelope: HostEnvelope,
  ): "matched" | "unmatched" {
    const result = this.store.ingestHostReport({
      hostName,
      credentialHash: runtime.credentialHash,
      ownerMessageId: envelope.id,
      ownerTaskId: envelope.owner_task_id,
      parentTaskId: envelope.parent_task_id,
      kind: envelope.kind,
      body: envelope.body,
      runtimeKind: envelope.runtime_kind,
      reason: envelope.reason,
    });
    if (result.status === "unmatched") return "unmatched";
    if (result.status === "queued") {
      void this.tasks.drainCollaborationDeliveries(envelope.parent_task_id);
    }
    return "matched";
  }

  async createTask(input: {
    hostName: string;
    credentialHash: string;
    request: {
      createKey: string;
      parentTaskId: string;
      agent: string;
      title: string;
      cwd?: string;
      model?: string;
      thinking?: string;
    };
  }): Promise<{ taskId: string; credentialHash: string }> {
    const runtime = this.runtimes.get(input.hostName);
    if (
      runtime?.credentialHash !== input.credentialHash ||
      this.states.get(input.hostName)?.status !== "ok"
    ) {
      throw new Error("host_unreachable");
    }
    const response = await this.request(runtime, "/api/v1/host/tasks", {
      method: "POST",
      body: JSON.stringify(input.request),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        code?: unknown;
      } | null;
      const suffix =
        typeof body?.code === "string"
          ? `:${body.code}`
          : `:${response.status}`;
      throw new Error(`host_create${suffix}`);
    }
    const body = (await response.json()) as { taskId?: unknown };
    if (typeof body.taskId !== "string")
      throw new Error("invalid create reply");
    return { taskId: body.taskId, credentialHash: runtime.credentialHash };
  }

  kick(edgeId: string): void {
    if (this.edgeRetries.has(edgeId)) return;
    this.runEdgeDrain(edgeId);
  }

  private resumeEdges(credentialHash: string): void {
    for (const edge of this.store.activeHostEdges()) {
      if (edge.credential_hash === credentialHash) this.kick(edge.id);
    }
  }

  private async drainEdge(edgeId: string): Promise<void> {
    if (this.edgeSends.has(edgeId) || this.stopped) return;
    this.edgeSends.add(edgeId);
    try {
      while (!this.isStopped()) {
        const next = this.store.nextHostDispatch(edgeId);
        if (!next) return;
        if (!(await this.sendHostDispatch(next))) return;
      }
    } catch {
      const edge = this.store.getHostEdge(edgeId);
      if (edge) this.unreachable(edge.host_name, "host request failed");
    } finally {
      this.edgeSends.delete(edgeId);
      const pending = this.store.nextHostDispatch(edgeId);
      const runtime = pending
        ? this.runtimes.get(pending.edge.host_name)
        : null;
      if (
        pending &&
        runtime?.credentialHash === pending.edge.credential_hash &&
        !this.isStopped()
      ) {
        this.scheduleEdgeRetry(edgeId);
      }
    }
  }

  private async sendHostDispatch(next: NextHostDispatch): Promise<boolean> {
    const runtime = this.runtimes.get(next.edge.host_name);
    if (runtime?.credentialHash !== next.edge.credential_hash) return false;
    const response = await this.request(runtime, "/api/v1/host/messages", {
      method: "POST",
      body: JSON.stringify({
        to: next.edge.remote_task_id,
        messageId: next.message.id,
        kind: "dispatch",
        body: next.message.body,
      }),
    });
    if (response.status === HTTP_STATUS.ACCEPTED) {
      this.store.markHostDispatchHandedOff(next.delivery.id);
      this.edgeRetryMs.delete(next.edge.id);
      this.reachable(next.edge.host_name, runtime);
      return true;
    }
    if (
      response.status === HTTP_STATUS.BAD_REQUEST ||
      response.status === HTTP_STATUS.CONFLICT
    ) {
      this.store.finishHostDispatch(
        next.delivery.id,
        `http_${response.status}`,
      );
      this.reachable(next.edge.host_name, runtime);
      return true;
    }
    if (response.status === HTTP_STATUS.NOT_FOUND) {
      const body = (await response.json().catch(() => null)) as {
        code?: unknown;
      } | null;
      if (body?.code === "target_not_found") {
        const failed = this.store.failHostEdgeTargetNotFound(next.delivery.id);
        if (failed.noticeRecipientTaskId) {
          void this.tasks.drainCollaborationDeliveries(
            failed.noticeRecipientTaskId,
          );
        }
        this.reachable(next.edge.host_name, runtime);
        return false;
      }
    }
    this.unreachable(
      next.edge.host_name,
      `host request HTTP ${response.status}`,
    );
    return false;
  }

  private runEdgeDrain(edgeId: string): void {
    void this.drainEdge(edgeId).catch(() => {
      if (!this.isStopped()) this.scheduleEdgeRetry(edgeId);
    });
  }

  private scheduleEdgeRetry(edgeId: string): void {
    if (this.edgeRetries.has(edgeId) || this.isStopped()) return;
    const delay = Math.min(
      this.edgeRetryMs.get(edgeId) ?? MIN_RETRY_MS,
      MAX_RETRY_MS,
    );
    this.edgeRetryMs.set(edgeId, Math.min(delay * 2, MAX_RETRY_MS));
    const timer = setTimeout(() => {
      this.edgeRetries.delete(edgeId);
      this.runEdgeDrain(edgeId);
    }, delay);
    timer.unref();
    this.edgeRetries.set(edgeId, timer);
  }
}

export function hostRequestHash(input: {
  parentTaskId: string;
  agent: string;
  title: string;
  cwd?: string;
  model?: string;
  thinking?: string;
}): string {
  return requestHash(input);
}
