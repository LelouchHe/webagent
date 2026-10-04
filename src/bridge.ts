import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { EventEmitter } from "node:events";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentEvent,
  ConfigOption,
  ConfigValue,
  RawInput,
  ToolContentItem,
} from "./types.ts";
import type { TaskManager } from "./task-manager.ts";
import { interruptBashProc } from "./task-manager.ts";
import type {
  AttachmentDispatcher,
  AttachmentRef,
  PromptBlock,
} from "./attachment-dispatch.ts";
import { abbreviateHomePath } from "./home-path.ts";
import { flattenConfigOptions } from "./config-options.ts";
import {
  canonicalModelIdentity,
  normalizeModelConfigOptions,
} from "./model-identity.ts";
import { log } from "./log.ts";

const blog = log.scope("bridge");

// A default 50 MiB file attachment can produce a larger agent tool-result
// message. Keep an explicit finite bound while allowing JSON-escaped text and
// its ACP envelope through.
export const MAX_ACP_MESSAGE_BYTES = 128 * 1024 * 1024;

export interface AgentSessionIds {
  getAgentSessionId(taskId: string): string | undefined;
  getTaskId(agentSessionId: string): string | undefined;
}

/**
 * Thrown by `AgentBridge.prompt` when the prompt was never handed to the agent
 * session (dead bridge, missing connection, or an attachment-dispatch
 * misconfiguration before the request was sent). The bridge still emits an
 * `error` event first; this type is the machine-readable signal that the
 * failure was request-level, so callers must not account for it as a delivered
 * turn or count it as a delivered reminder.
 */
export class PromptNotDeliveredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptNotDeliveredError";
  }
}

export class AgentBridge extends EventEmitter {
  private proc: ChildProcess | null = null;
  private conn: acp.ClientSideConnection | null = null;
  private readonly permissionResolvers = new Map<
    string,
    (resp: acp.RequestPermissionResponse) => void
  >();
  private readonly permissionRequestTasks = new Map<string, string>();
  private readonly silentSessions = new Set<string>(); // Sessions that don't emit events
  private readonly silentBuffers = new Map<string, string>(); // Text buffers for silent tasks
  private pendingNewSessions = 0;
  private readonly unboundNewSessionIds = new Set<string>();
  private readonly pendingSessionUpdates = new Map<
    string,
    acp.SessionNotification["update"][]
  >();
  private readonly pendingAborts = new Map<string, (e: Error) => void>();
  private readonly modelOptionIdsBySession = new Map<string, Set<string>>();
  private readonly modelValuesBySession = new Map<
    string,
    Map<string, Map<string, string>>
  >();
  private readonly knownModelOptionIdsBySession = new Map<
    string,
    Set<string>
  >();
  private readonly currentModelOptionIdsBySession = new Map<
    string,
    Set<string>
  >();
  private readonly currentConfigOptionIdsBySession = new Map<
    string,
    Set<string>
  >();
  private readonly invalidatedSessionCodecs = new Set<string>();
  private readonly codecEpochBySession = new Map<string, number>();
  private codecProcessEpoch = 0;
  private deadReason: string | null = null;
  /** Capabilities advertised by the agent at initialize; gates restore/retire calls. */
  private sessionCapabilities: acp.SessionCapabilities | null = null;
  private loadSessionSupported = false;
  private stderrTail = "";
  private readonly closedProcesses = new WeakSet<ChildProcess>();
  readonly agentCmd: string;
  private readonly sessionIds: AgentSessionIds;
  reloading = false;
  private attachmentDispatcher: AttachmentDispatcher | null = null;

  constructor(agentCmd: string, sessionIds: AgentSessionIds) {
    super();
    this.agentCmd = agentCmd;
    this.sessionIds = sessionIds;
  }

  private agentSessionId(taskId: string): string {
    const id = this.sessionIds.getAgentSessionId(taskId);
    if (!id)
      throw new Error(`Task is not available for the current agent: ${taskId}`);
    return id;
  }

  /**
   * Inject the dispatcher used to translate client attachment refs into
   * ACP prompt blocks. Set once at server boot; staying optional so unit
   * tests that don't exercise attachments can construct a bare bridge.
   */
  setAttachmentDispatcher(dispatcher: AttachmentDispatcher): void {
    this.attachmentDispatcher = dispatcher;
  }

  async start(): Promise<void> {
    this.clearSessionConfigCodecs();
    // Capability state belongs to the process this call is about to start.
    // Clearing it first means a start that fails before initialize cannot
    // leave the previous process's flags behind for a later restore to act on.
    this.sessionCapabilities = null;
    this.loadSessionSupported = false;

    const [cmd, ...args] = this.agentCmd.split(/\s+/);
    this.proc = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!this.proc.stdin || !this.proc.stdout || !this.proc.stderr) {
      throw new Error(`Failed to start: ${this.agentCmd}`);
    }

    // Reset dead state for fresh start, and capture stderr for diagnostics.
    this.deadReason = null;
    this.stderrTail = "";
    this.proc.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4096);
    });

    // Detect unexpected agent death. restart() and shutdown() set
    // `reloading=true` so they own the lifecycle and we skip auto-marking.
    const proc = this.proc;
    proc.on("exit", (code, signal) => {
      if (this.reloading) return;
      if (proc !== this.proc) return; // already replaced
      const tail = this.stderrTail.trim().split("\n").slice(-3).join("\n");
      const why = signal ? `signal=${signal}` : `code=${code}`;
      const reason =
        `Agent process exited unexpectedly (${why}).` +
        (tail ? `\nLast stderr:\n${tail}` : "") +
        `\nCheck '${this.agentCmd}' is properly configured (e.g. authenticated).`;
      this.markAgentDead(reason);
    });
    proc.once("close", () => {
      this.closedProcesses.add(proc);
    });
    proc.on("error", (err: Error) => {
      if (this.reloading) return;
      if (proc !== this.proc) return;
      this.markAgentDead(`Agent process error: ${err.message}`);
    });

    const input = Writable.toWeb(this.proc.stdin);
    const output = Readable.toWeb(
      this.proc.stdout,
    ) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output, {
      maxMessageBytes: MAX_ACP_MESSAGE_BYTES,
    });

    const client: acp.Client = {
      requestPermission: async (params: acp.RequestPermissionRequest) =>
        this.handlePermission(params),
      sessionUpdate: async (params: acp.SessionNotification) =>
        this.handleSessionUpdate(params),
    };

    this.conn = new acp.ClientSideConnection((_agent) => client, stream);

    const init = await this.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: true,
      },
    });

    const agentInfo = init.agentInfo;
    this.sessionCapabilities =
      init.agentCapabilities?.sessionCapabilities ?? null;
    this.loadSessionSupported = init.agentCapabilities?.loadSession ?? false;
    this.emit("event", {
      type: "connected",
      agent: {
        name: agentInfo?.name ?? "unknown",
        version: agentInfo?.version ?? "?",
      },
      configOptions: [],
    } satisfies AgentEvent);
  }

  async newSession(
    cwd: string,
    opts?: { silent?: boolean; mcpServers?: acp.McpServer[] },
  ): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    if (!this.conn) throw new Error("Not connected");
    this.pendingNewSessions++;
    try {
      const session = await this.conn.newSession({
        cwd,
        mcpServers: opts?.mcpServers ?? [],
      });
      this.activateSessionConfigCodec(session.sessionId);
      const bufferedUpdates = opts?.silent
        ? (this.pendingSessionUpdates.get(session.sessionId) ?? [])
        : [];
      if (opts?.silent) {
        this.pendingSessionUpdates.delete(session.sessionId);
        this.silentSessions.add(session.sessionId);
      } else {
        this.unboundNewSessionIds.add(session.sessionId);
      }
      const configOptions = Array.isArray(session.configOptions)
        ? this.normalizeSessionConfigOptions(
            session.sessionId,
            session.configOptions as unknown as ConfigOption[],
          )
        : [];
      for (const update of bufferedUpdates) {
        this.normalizeSilentConfigUpdate(session.sessionId, update);
      }
      return { sessionId: session.sessionId, configOptions };
    } finally {
      this.pendingNewSessions--;
      if (this.pendingNewSessions === 0) {
        for (const sessionId of this.pendingSessionUpdates.keys()) {
          if (!this.unboundNewSessionIds.has(sessionId)) {
            this.pendingSessionUpdates.delete(sessionId);
            blog.warn("discarded update for unrelated unmapped ACP session", {
              sessionId,
            });
          }
        }
      }
    }
  }

  sessionMapped(agentSessionId: string): void {
    this.unboundNewSessionIds.delete(agentSessionId);
    const updates = this.pendingSessionUpdates.get(agentSessionId) ?? [];
    this.pendingSessionUpdates.delete(agentSessionId);
    for (const update of updates) {
      void this.handleSessionUpdate({ sessionId: agentSessionId, update });
    }
  }

  discardUnboundSession(agentSessionId: string): void {
    this.unboundNewSessionIds.delete(agentSessionId);
    this.pendingSessionUpdates.delete(agentSessionId);
    this.clearSessionConfigCodec(agentSessionId);
  }

  /**
   * Explicitly retire an ACP execution whose WebAgent binding has been
   * rotated away or deleted. Best-effort: prefers `session/delete` when the
   * agent advertises it, falls back to `session/close`, and skips silently
   * when the agent supports neither. Failures are logged but never thrown,
   * so retirement can never roll back an already-successful rotation.
   */
  async retireExecution(agentSessionId: string): Promise<void> {
    this.clearSessionConfigCodec(agentSessionId);
    if (!this.conn) return;
    const params = { sessionId: agentSessionId } as const;
    try {
      if (this.sessionCapabilities?.delete) {
        await this.conn.deleteSession(params);
      } else if (this.sessionCapabilities?.close) {
        await this.conn.closeSession(params);
      }
    } catch (err) {
      blog.warn("failed to retire retired ACP session", {
        agentSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Restore without history replay when possible; load is the advertised fallback. */
  async loadSession(
    taskId: string,
    cwd: string,
    mcpServers?: acp.McpServer[],
  ): Promise<{ taskId: string; configOptions: ConfigOption[] }> {
    if (!this.conn) throw new Error("Not connected");
    const agentSessionId = this.agentSessionId(taskId);
    let session: acp.LoadSessionResponse | acp.ResumeSessionResponse;
    try {
      const params = {
        sessionId: agentSessionId,
        cwd,
        mcpServers: mcpServers ?? [],
      };
      if (this.sessionCapabilities?.resume) {
        session = await this.conn.resumeSession(params);
      } else if (this.loadSessionSupported) {
        session = await this.conn.loadSession(params);
      } else {
        throw new Error(
          "The agent does not support restoring sessions. Use /new to start a fresh one.",
        );
      }
    } catch (err: unknown) {
      // -32002 = Resource not found. Some agents (e.g. claude-agent-acp) don't
      // persist tasks across process restarts, so a session in our DB may
      // be unknown to the live agent. Translate the JSON-RPC error into a
      // user-actionable message; routes returns it as 500 / SSE 'error' event.
      const code = (err as { code?: number }).code;
      if (code === -32002) {
        throw new Error(
          `The agent no longer remembers task ${taskId.slice(0, 8)}… ` +
            `(it may not persist sessions across restarts). Use /new to start a fresh one.`,
          { cause: err },
        );
      }
      throw err;
    }
    const configOptions = Array.isArray(session.configOptions)
      ? this.normalizeSessionConfigOptions(
          agentSessionId,
          session.configOptions as unknown as ConfigOption[],
        )
      : [];
    this.emit("event", {
      type: "task_created",
      taskId,
      cwd,
      cwdDisplay: abbreviateHomePath(cwd),
      configOptions,
    } satisfies AgentEvent);
    return { taskId, configOptions };
  }

  async setConfigOption(
    taskId: string,
    configId: string,
    value: ConfigValue,
  ): Promise<ConfigOption[]> {
    if (!this.conn) throw new Error("Not connected");
    const agentSessionId = this.agentSessionId(taskId);
    const wireValue = this.resolveWireConfigValue(
      agentSessionId,
      configId,
      value,
    );
    const codecEpoch = this.sessionCodecEpoch(agentSessionId);
    const result = await this.conn.setSessionConfigOption({
      sessionId: agentSessionId,
      configId,
      ...(typeof wireValue === "boolean"
        ? { type: "boolean" as const, value: wireValue }
        : { value: wireValue }),
    });
    return this.acceptConfigOptionResponse(
      agentSessionId,
      result.configOptions,
      codecEpoch,
    );
  }

  async setAgentConfigOption(
    agentSessionId: string,
    configId: string,
    value: ConfigValue,
  ): Promise<ConfigOption[]> {
    if (!this.conn) throw new Error("Not connected");
    const wireValue = this.resolveWireConfigValue(
      agentSessionId,
      configId,
      value,
    );
    const codecEpoch = this.sessionCodecEpoch(agentSessionId);
    const result = await this.conn.setSessionConfigOption({
      sessionId: agentSessionId,
      configId,
      ...(typeof wireValue === "boolean"
        ? { type: "boolean" as const, value: wireValue }
        : { value: wireValue }),
    });
    return this.acceptConfigOptionResponse(
      agentSessionId,
      result.configOptions,
      codecEpoch,
    );
  }

  private normalizeSessionConfigOptions(
    agentSessionId: string,
    configOptions: ConfigOption[],
  ): ConfigOption[] {
    const flattened = flattenConfigOptions(configOptions);
    const normalized = normalizeModelConfigOptions(flattened);
    this.currentConfigOptionIdsBySession.set(
      agentSessionId,
      new Set(flattened.map((option) => option.id)),
    );
    this.currentModelOptionIdsBySession.set(
      agentSessionId,
      normalized.modelOptionIds,
    );
    const knownModelOptionIds =
      this.knownModelOptionIdsBySession.get(agentSessionId) ??
      new Set<string>();
    for (const id of normalized.modelOptionIds) knownModelOptionIds.add(id);
    this.knownModelOptionIdsBySession.set(agentSessionId, knownModelOptionIds);
    this.modelOptionIdsBySession.set(agentSessionId, knownModelOptionIds);
    this.modelValuesBySession.set(
      agentSessionId,
      normalized.modelValueToWireValue,
    );
    this.sessionCodecEpoch(agentSessionId);
    return normalized.configOptions;
  }

  private resolveWireConfigValue(
    agentSessionId: string,
    configId: string,
    value: ConfigValue,
  ): ConfigValue {
    if (typeof value !== "string") return value;
    const currentModelOption =
      this.currentModelOptionIdsBySession.get(agentSessionId)?.has(configId) ??
      false;
    if (
      configId !== "model" &&
      !currentModelOption &&
      this.currentConfigOptionIdsBySession.get(agentSessionId)?.has(configId)
    ) {
      return value;
    }
    const previouslyModelOption =
      this.modelOptionIdsBySession.get(agentSessionId)?.has(configId) ?? false;
    if (configId !== "model" && !currentModelOption && !previouslyModelOption) {
      return value;
    }
    const canonicalValue = canonicalModelIdentity(value);
    const wireValue = this.modelValuesBySession
      .get(agentSessionId)
      ?.get(configId)
      ?.get(canonicalValue);
    if (wireValue === undefined) {
      throw new Error(
        `cannot resolve model option for this session: ${configId}=${value}`,
      );
    }
    return wireValue;
  }

  private sessionCodecEpoch(agentSessionId: string): string {
    if (!this.codecEpochBySession.has(agentSessionId)) {
      this.codecEpochBySession.set(agentSessionId, 0);
    }
    return `${this.codecProcessEpoch}:${this.codecEpochBySession.get(agentSessionId)}`;
  }

  private acceptConfigOptionResponse(
    agentSessionId: string,
    configOptions: unknown,
    codecEpoch: string,
  ): ConfigOption[] {
    if (this.sessionCodecEpoch(agentSessionId) !== codecEpoch) {
      throw new Error("ACP execution changed while setting a config option");
    }
    return Array.isArray(configOptions)
      ? this.normalizeSessionConfigOptions(
          agentSessionId,
          configOptions as ConfigOption[],
        )
      : [];
  }

  private configOptionsFromUpdate(
    update: acp.SessionNotification["update"],
  ): ConfigOption[] | undefined {
    if (update.sessionUpdate !== "config_option_update") return undefined;
    const configOptions = (update as unknown as { configOptions?: unknown })
      .configOptions;
    return Array.isArray(configOptions)
      ? (configOptions as ConfigOption[])
      : undefined;
  }

  private normalizeSilentConfigUpdate(
    agentSessionId: string,
    update: acp.SessionNotification["update"],
  ): void {
    if (this.invalidatedSessionCodecs.has(agentSessionId)) return;
    const configOptions = this.configOptionsFromUpdate(update);
    if (configOptions) {
      this.normalizeSessionConfigOptions(agentSessionId, configOptions);
    }
  }

  private activateSessionConfigCodec(agentSessionId: string): void {
    this.clearSessionConfigCodec(agentSessionId);
    this.invalidatedSessionCodecs.delete(agentSessionId);
  }

  private clearSessionConfigCodec(agentSessionId: string): void {
    this.invalidatedSessionCodecs.add(agentSessionId);
    this.codecEpochBySession.set(
      agentSessionId,
      (this.codecEpochBySession.get(agentSessionId) ?? 0) + 1,
    );
    this.modelOptionIdsBySession.delete(agentSessionId);
    this.knownModelOptionIdsBySession.delete(agentSessionId);
    this.currentModelOptionIdsBySession.delete(agentSessionId);
    this.currentConfigOptionIdsBySession.delete(agentSessionId);
    this.modelValuesBySession.delete(agentSessionId);
  }

  private clearSessionConfigCodecs(): void {
    this.codecProcessEpoch++;
    this.codecEpochBySession.clear();
    this.modelOptionIdsBySession.clear();
    this.knownModelOptionIdsBySession.clear();
    this.currentModelOptionIdsBySession.clear();
    this.currentConfigOptionIdsBySession.clear();
    this.modelValuesBySession.clear();
  }

  async prompt(
    taskId: string,
    text: string,
    attachments?: AttachmentRef[],
    /** Turn identity echoed back on this prompt's terminal event, so a
     *  completion that outlives its turn can be told apart from the live one. */
    promptId?: string,
  ): Promise<void> {
    if (this.deadReason) {
      this.emit("event", {
        type: "error",
        taskId,
        message: this.deadReason,
      } satisfies AgentEvent);
      throw new PromptNotDeliveredError(this.deadReason);
    }
    if (!this.conn) throw new PromptNotDeliveredError("Not connected");
    let abortReject: (e: Error) => void = () => {};
    const abortPromise = new Promise<never>((_, rej) => {
      abortReject = rej;
    });
    this.pendingAborts.set(taskId, abortReject);
    let handedOver = false;
    try {
      const promptParts: PromptBlock[] = [];
      if (attachments && attachments.length > 0) {
        if (!this.attachmentDispatcher) {
          // Misconfiguration: routes accepted attachments but bridge has no
          // dispatcher wired. Fail loud so tests / dev catch it; production
          // server.ts always calls setAttachmentDispatcher().
          throw new Error("attachment dispatcher not configured");
        }
        for (const ref of attachments) {
          const blocks = await this.attachmentDispatcher.dispatch(taskId, ref);
          promptParts.push(...blocks);
        }
      }
      promptParts.push({ type: "text", text });
      // Evaluate the request call before flipping the flag: a synchronous
      // throw here means the agent never received the prompt.
      const request = this.conn.prompt({
        sessionId: this.agentSessionId(taskId),
        prompt: promptParts,
      });
      handedOver = true;
      const result = (await Promise.race([request, abortPromise])) as {
        stopReason?: string;
      };
      this.emit("event", {
        type: "prompt_done",
        taskId,
        stopReason: result.stopReason ?? "end_turn",
        ...(promptId ? { promptId } : {}),
      } satisfies AgentEvent);
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : JSON.stringify(err);
      if (/cancel/i.test(message)) {
        this.emit("event", {
          type: "prompt_done",
          taskId,
          stopReason: "cancelled",
          ...(promptId ? { promptId } : {}),
        } satisfies AgentEvent);
        return;
      }
      if (err instanceof acp.MessageTooLargeError) {
        // The SDK aborts the whole connection when one inbound line exceeds the
        // configured bound, and caches that error for every later request. Left
        // unmarked, the session would look alive and repeat the raw error until
        // a process restart, so retire the agent instead of wedging it.
        const reason =
          `An inbound ACP message exceeded the ${MAX_ACP_MESSAGE_BYTES}-byte limit, ` +
          `so the agent connection was closed. Restart the agent to continue.`;
        // Retire this turn before retiring the agent: a request that never
        // reached the wire has no consumer for the abort rejection, and
        // markAgentDead would raise it as an unhandled rejection.
        this.pendingAborts.delete(taskId);
        abortPromise.catch(() => {});
        this.emit("event", {
          type: "error",
          taskId,
          message: reason,
          ...(promptId ? { promptId } : {}),
        } satisfies AgentEvent);
        this.markAgentDead(reason);
        if (!handedOver) throw new PromptNotDeliveredError(reason);
        return;
      }
      this.emit("event", {
        type: "error",
        taskId,
        message,
        ...(promptId ? { promptId } : {}),
      } satisfies AgentEvent);
      // A failure before the request was handed over is request-level and must
      // reject so callers do not account for it as a delivered turn. A failure
      // after hand-off is an in-turn agent error and resolves.
      if (!handedOver) throw new PromptNotDeliveredError(message);
    } finally {
      this.pendingAborts.delete(taskId);
    }
  }

  async cancel(taskId: string): Promise<void> {
    for (const [requestId, requestTaskId] of this.permissionRequestTasks) {
      if (requestTaskId === taskId) {
        this.denyPermission(requestId);
      }
    }
    await this.conn?.cancel({ sessionId: this.agentSessionId(taskId) });
  }

  async cancelAgentSession(agentSessionId: string): Promise<void> {
    await this.conn?.cancel({ sessionId: agentSessionId });
  }

  /**
   * Mark the agent subprocess as dead. Rejects in-flight prompts and emits
   * an `error` event for each so the frontend can exit the busy state and
   * show a useful message instead of hanging forever.
   *
   * Called from `start()`'s `proc.on("exit"|"error")` handlers when the
   * subprocess dies outside of `restart()` / `shutdown()` (which set
   * `reloading=true` to claim the lifecycle). Does NOT auto-restart — for
   * config errors like missing auth, restart would loop into the same
   * failure. User fixes the config and runs `/reload`.
   */
  private markAgentDead(reason: string): void {
    if (this.deadReason) return;
    this.deadReason = reason;
    this.clearSessionConfigCodecs();
    blog.error("agent subprocess dead", { reason });
    const aborts = [...this.pendingAborts.entries()];
    this.pendingAborts.clear();
    for (const [taskId, abort] of aborts) {
      this.emit("event", {
        type: "error",
        taskId,
        message: reason,
      } satisfies AgentEvent);
      abort(new Error(reason));
    }
    this.emit("event", { type: "agent_disconnected" } satisfies AgentEvent);
    this.conn = null;
  }

  /** Send a prompt and collect the full text response without emitting events. */
  async promptForText(sessionId: string, text: string): Promise<string> {
    if (this.deadReason) throw new Error(this.deadReason);
    if (!this.conn) throw new Error("Not connected");
    this.silentSessions.add(sessionId);
    this.silentBuffers.set(sessionId, "");
    let abortReject: (e: Error) => void = () => {};
    const abortPromise = new Promise<never>((_, rej) => {
      abortReject = rej;
    });
    this.pendingAborts.set(sessionId, abortReject);
    try {
      await Promise.race([
        this.conn.prompt({ sessionId, prompt: [{ type: "text", text }] }),
        abortPromise,
      ]);
      return this.silentBuffers.get(sessionId) ?? "";
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : JSON.stringify(err);
      if (/cancel/i.test(message)) {
        return "";
      }
      throw err;
    } finally {
      this.silentSessions.delete(sessionId);
      this.silentBuffers.delete(sessionId);
      this.pendingAborts.delete(sessionId);
    }
  }

  resolvePermission(requestId: string, optionId: string): void {
    const resolve = this.permissionResolvers.get(requestId);
    if (resolve) {
      resolve({ outcome: { outcome: "selected", optionId } });
      this.permissionResolvers.delete(requestId);
      this.permissionRequestTasks.delete(requestId);
    }
  }

  denyPermission(requestId: string): void {
    const resolve = this.permissionResolvers.get(requestId);
    if (resolve) {
      resolve({ outcome: { outcome: "cancelled" } });
      this.permissionResolvers.delete(requestId);
      this.permissionRequestTasks.delete(requestId);
    }
  }

  /**
   * Restart the agent subprocess. Cancels all active work, cleans up state,
   * shuts down the old process, and starts a new one. Tasks are restored
   * lazily via ensureResumed() on next user interaction.
   */
  async restart(tasks: TaskManager): Promise<void> {
    if (this.reloading) throw new Error("Already reloading");
    this.reloading = true;
    const liveTaskIds = [...tasks.liveTasks];
    this.emit("event", { type: "agent_reloading" } satisfies AgentEvent);
    blog.info("reloading agent...");

    try {
      // 1. Cancel all active prompts + kill bash procs
      for (const taskId of [...tasks.activePrompts]) {
        const proc = tasks.runningBashProcs.get(taskId);
        if (proc) {
          interruptBashProc(proc);
          tasks.runningBashProcs.delete(taskId);
        }
        try {
          await this.cancel(taskId);
        } catch {
          /* best-effort */
        }
      }

      // 2. Flush buffers to persist partial content
      for (const taskId of liveTaskIds) {
        tasks.flushBuffers(taskId);
      }

      // 3. Clean up TaskManager state
      tasks.pendingPermissions.clear();
      tasks.state.clearPlans();
      const busyTaskIds = new Set([
        ...tasks.activePrompts,
        ...tasks.pendingPromptSubmissions.keys(),
        // A drain that has started a turn but not yet issued its prompt keeps
        // the target busy; abort its watchdog too or a stale no_activity can
        // fire after the restart.
        ...tasks.drainingCollaborationTasks,
      ]);
      for (const id of busyTaskIds) {
        tasks.abortObligationTurn(id);
        tasks.state.patch(id, { runtime: { busy: null } });
      }
      for (const submissionId of tasks.pendingPromptSubmissions.values()) {
        tasks.cancelledPromptSubmissions.add(submissionId);
      }
      tasks.activePrompts.clear();
      tasks.pendingPromptSubmissions.clear();

      // 4. Clean up bridge-side silent session state
      this.silentSessions.clear();
      this.silentBuffers.clear();
      this.unboundNewSessionIds.clear();
      this.pendingSessionUpdates.clear();
      this.clearSessionConfigCodecs();

      // 5. Clear liveTasks so ensureResumed() will re-register on next access
      tasks.liveTasks.clear();
      // Also clear the global configOptions cache — a restarted agent may
      // speak a different schema (e.g. agent upgrade removed a model). The
      // next resumeTask will warm it from the user's stored config.
      tasks.cachedConfigOptions = [];

      // 6. Shutdown old process
      await this.shutdown();
      // Cancellation is asynchronous: the old agent may emit final chunks
      // before shutdown completes. Persist that tail and make the terminal
      // stream state authoritative before starting the replacement process.
      for (const taskId of liveTaskIds) {
        tasks.flushBuffers(taskId);
      }
      tasks.state.clearStreaming();

      // 7. Start new process with retry (exponential backoff, max 3 attempts)
      let lastError: unknown;
      for (let i = 0; i < 3; i++) {
        try {
          await this.start();
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          blog.error("start attempt failed", { attempt: i + 1, error: err });
          if (i < 2) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
        }
      }

      if (lastError || !this.conn) {
        const msg =
          lastError instanceof Error ? lastError.message : String(lastError);
        this.emit("event", {
          type: "agent_reloading_failed",
          error: msg,
        } satisfies AgentEvent);
        throw lastError;
      }

      blog.info("agent reloaded successfully");
    } finally {
      this.reloading = false;
    }
  }

  async shutdown(): Promise<void> {
    // Reject all pending permissions
    for (const [_id, resolve] of this.permissionResolvers) {
      resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissionResolvers.clear();
    this.permissionRequestTasks.clear();
    this.clearSessionConfigCodecs();

    const proc = this.proc;
    if (proc && !this.closedProcesses.has(proc)) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          this.closedProcesses.add(proc);
          clearTimeout(killTimer);
          clearTimeout(drainTimer);
          proc.off("close", finish);
          resolve();
        };
        const killTimer = setTimeout(() => {
          proc.kill(process.platform === "win32" ? undefined : "SIGKILL");
        }, 5000);
        // `close` follows `exit` after stdio has drained. Keep a bounded
        // fallback for pathological child-process implementations that never
        // deliver close even after SIGKILL.
        const drainTimer = setTimeout(finish, 6000);
        proc.once("close", finish);
        proc.kill();
      });
    }
    this.proc = null;
    this.conn = null;
  }

  // --- ACP Client callbacks ---

  private handlePermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const taskId = this.sessionIds.getTaskId(params.sessionId);
    if (!taskId) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    const requestId = crypto.randomUUID();
    const toolCall = params.toolCall;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- toolCall may be undefined in practice
    const title = toolCall?.title ?? "Permission requested";
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- toolCall may be undefined in practice
    const toolCallId = toolCall?.toolCallId;
    const tc = toolCall as
      | (typeof toolCall & {
          kind?: string;
          name?: string;
          locations?: { path: string; line?: number | null }[];
          rawInput?: Record<string, unknown>;
        })
      | undefined;

    return new Promise((resolve) => {
      // Register resolver BEFORE emitting, so synchronous auto-approve can find it
      this.permissionResolvers.set(requestId, resolve);
      this.permissionRequestTasks.set(requestId, taskId);
      this.emit("event", {
        type: "permission_request",
        requestId,
        taskId: taskId,
        title,
        toolCallId,
        options: params.options,
        toolKind: tc?.kind,
        toolName: tc?.name,
        locations: tc?.locations,
        rawInput: tc?.rawInput,
      } satisfies AgentEvent);
    });
  }

  private handleSessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    const agentSessionId = params.sessionId;
    if (this.deadReason || this.invalidatedSessionCodecs.has(agentSessionId)) {
      return Promise.resolve();
    }

    if (this.silentSessions.has(agentSessionId)) {
      this.captureSilentText(agentSessionId, update);
      this.normalizeSilentConfigUpdate(agentSessionId, update);
      return Promise.resolve();
    }

    const taskId = this.sessionIds.getTaskId(agentSessionId);
    if (!taskId) {
      if (
        this.pendingNewSessions > 0 ||
        this.unboundNewSessionIds.has(agentSessionId)
      ) {
        const updates = this.pendingSessionUpdates.get(agentSessionId) ?? [];
        updates.push(update);
        this.pendingSessionUpdates.set(agentSessionId, updates);
        return Promise.resolve();
      }
      blog.warn("ignored event for unmapped ACP session", {
        sessionId: agentSessionId,
      });
      return Promise.resolve();
    }
    const event = this.sessionUpdateToEvent(taskId, agentSessionId, update);
    if (event) this.emit("event", event);
    return Promise.resolve();
  }

  private captureSilentText(
    sessionId: string,
    update: acp.SessionNotification["update"],
  ): void {
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
    ) {
      const buf =
        (this.silentBuffers.get(sessionId) ?? "") + update.content.text;
      this.silentBuffers.set(sessionId, buf);
    }
  }

  private sessionUpdateToEvent(
    taskId: string,
    agentSessionId: string,
    update: acp.SessionNotification["update"],
  ): AgentEvent | null {
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only handles events with UI effects
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return update.content.type === "text"
          ? { type: "message_chunk", taskId, text: update.content.text }
          : null;

      case "agent_thought_chunk":
        return update.content.type === "text"
          ? { type: "thought_chunk", taskId, text: update.content.text }
          : null;

      case "tool_call":
        return {
          type: "tool_call",
          taskId,
          id: update.toolCallId,
          title: update.title,
          kind: update.kind ?? "unknown",
          rawInput: update.rawInput as RawInput | undefined,
        };

      case "tool_call_update":
        return {
          type: "tool_call_update",
          taskId,
          id: update.toolCallId,
          status: update.status ?? "",
          content: (update.content ?? undefined) as
            | ToolContentItem[]
            | undefined,
          ...(typeof update.title === "string" ? { title: update.title } : {}),
          ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
          ...(update.rawInput ? { rawInput: update.rawInput as RawInput } : {}),
          ...(Object.hasOwn(update, "rawOutput")
            ? { rawOutput: update.rawOutput }
            : {}),
          ...(Array.isArray(update.locations)
            ? { locations: update.locations }
            : {}),
        };

      case "plan":
        return { type: "plan", taskId, entries: update.entries };

      case "usage_update":
        return {
          type: "usage_update",
          taskId,
          used: update.used,
          size: update.size,
          cost: update.cost,
        };

      case "config_option_update": {
        const configOptions = this.configOptionsFromUpdate(update);
        return {
          type: "config_option_update",
          taskId,
          configOptions: configOptions
            ? this.normalizeSessionConfigOptions(agentSessionId, configOptions)
            : [],
        };
      }

      case "available_commands_update":
        return {
          type: "available_commands_update",
          taskId,
          commands: update.availableCommands.map((command) => ({
            name: command.name,
            description: command.description,
            ...(command.input ? { input: { hint: command.input.hint } } : {}),
          })),
        };

      default:
        return null;
    }
  }
}
