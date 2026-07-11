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
import type { SessionManager } from "./session-manager.ts";
import type { TitleService } from "./title-service.ts";
import { interruptBashProc } from "./session-manager.ts";
import type {
  AttachmentDispatcher,
  AttachmentRef,
  PromptBlock,
} from "./attachment-dispatch.ts";
import { log } from "./log.ts";

const blog = log.scope("bridge");

export class AgentBridge extends EventEmitter {
  private proc: ChildProcess | null = null;
  private conn: acp.ClientSideConnection | null = null;
  private readonly permissionResolvers = new Map<
    string,
    (resp: acp.RequestPermissionResponse) => void
  >();
  private readonly permissionRequestSessions = new Map<string, string>();
  private readonly silentSessions = new Set<string>(); // Sessions that don't emit events
  private readonly silentBuffers = new Map<string, string>(); // Text buffers for silent sessions
  private readonly pendingAborts = new Map<string, (e: Error) => void>();
  private deadReason: string | null = null;
  private stderrTail = "";
  readonly agentCmd: string;
  reloading = false;
  private attachmentDispatcher: AttachmentDispatcher | null = null;

  constructor(agentCmd: string) {
    super();
    this.agentCmd = agentCmd;
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
    proc.on("error", (err: Error) => {
      if (this.reloading) return;
      if (proc !== this.proc) return;
      this.markAgentDead(`Agent process error: ${err.message}`);
    });

    const input = Writable.toWeb(this.proc.stdin);
    const output = Readable.toWeb(
      this.proc.stdout,
    ) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const client: acp.Client = {
      requestPermission: async (params: acp.RequestPermissionRequest) =>
        this.handlePermission(params),
      sessionUpdate: async (params: acp.SessionNotification) =>
        this.handleSessionUpdate(params),
    };

    this.conn = new acp.ClientSideConnection((_agent) => client, stream);

    const init = (await this.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: true,
      },
    })) as { agentInfo?: { name?: string; version?: string } };

    const agentInfo = init.agentInfo;
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
    opts?: { silent?: boolean },
  ): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    if (!this.conn) throw new Error("Not connected");
    const session = await this.conn.newSession({
      cwd,
      mcpServers: [],
    });
    const configOptions = (session.configOptions ??
      []) as unknown as ConfigOption[];
    if (!opts?.silent) {
      this.emit("event", {
        type: "session_created",
        sessionId: session.sessionId,
        cwd,
        configOptions,
      } satisfies AgentEvent);
    }
    return { sessionId: session.sessionId, configOptions };
  }

  async loadSession(
    sessionId: string,
    cwd: string,
  ): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    if (!this.conn) throw new Error("Not connected");
    let session: acp.LoadSessionResponse;
    try {
      session = await this.conn.loadSession({
        sessionId,
        cwd,
        mcpServers: [],
      });
    } catch (err: unknown) {
      // -32002 = Resource not found. Some agents (e.g. claude-agent-acp) don't
      // persist sessions across process restarts, so a session in our DB may
      // be unknown to the live agent. Translate the JSON-RPC error into a
      // user-actionable message; routes returns it as 500 / SSE 'error' event.
      const code = (err as { code?: number }).code;
      if (code === -32002) {
        throw new Error(
          `The agent no longer remembers session ${sessionId.slice(0, 8)}… ` +
            `(it may not persist sessions across restarts). Use /new to start a fresh one.`,
          { cause: err },
        );
      }
      throw err;
    }
    const configOptions = (session.configOptions ??
      []) as unknown as ConfigOption[];
    this.emit("event", {
      type: "session_created",
      sessionId,
      cwd,
      configOptions,
    } satisfies AgentEvent);
    return { sessionId, configOptions };
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: ConfigValue,
  ): Promise<ConfigOption[]> {
    if (!this.conn) throw new Error("Not connected");
    const result = await this.conn.setSessionConfigOption({
      sessionId,
      configId,
      ...(typeof value === "boolean"
        ? { type: "boolean" as const, value }
        : { value }),
    });
    return result.configOptions as unknown as ConfigOption[];
  }

  async prompt(
    sessionId: string,
    text: string,
    attachments?: AttachmentRef[],
  ): Promise<void> {
    if (this.deadReason) {
      this.emit("event", {
        type: "error",
        sessionId,
        message: this.deadReason,
      } satisfies AgentEvent);
      return;
    }
    if (!this.conn) throw new Error("Not connected");
    let abortReject: (e: Error) => void = () => {};
    const abortPromise = new Promise<never>((_, rej) => {
      abortReject = rej;
    });
    this.pendingAborts.set(sessionId, abortReject);
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
          const block = await this.attachmentDispatcher.dispatch(
            sessionId,
            ref,
          );
          promptParts.push(block);
        }
      }
      promptParts.push({ type: "text", text });
      const result = (await Promise.race([
        this.conn.prompt({
          sessionId,
          prompt: promptParts,
        }),
        abortPromise,
      ])) as { stopReason?: string };
      this.emit("event", {
        type: "prompt_done",
        sessionId,
        stopReason: result.stopReason ?? "end_turn",
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
          sessionId,
          stopReason: "cancelled",
        } satisfies AgentEvent);
        return;
      }
      this.emit("event", {
        type: "error",
        sessionId,
        message,
      } satisfies AgentEvent);
    } finally {
      this.pendingAborts.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    for (const [requestId, requestSessionId] of this
      .permissionRequestSessions) {
      if (requestSessionId === sessionId) {
        this.denyPermission(requestId);
      }
    }
    await this.conn?.cancel({ sessionId });
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
    blog.error("agent subprocess dead", { reason });
    const aborts = [...this.pendingAborts.entries()];
    this.pendingAborts.clear();
    for (const [sessionId, abort] of aborts) {
      this.emit("event", {
        type: "error",
        sessionId,
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
      this.permissionRequestSessions.delete(requestId);
    }
  }

  denyPermission(requestId: string): void {
    const resolve = this.permissionResolvers.get(requestId);
    if (resolve) {
      resolve({ outcome: { outcome: "cancelled" } });
      this.permissionResolvers.delete(requestId);
      this.permissionRequestSessions.delete(requestId);
    }
  }

  /**
   * Restart the agent subprocess. Cancels all active work, cleans up state,
   * shuts down the old process, and starts a new one. Sessions are restored
   * lazily via ensureResumed() on next user interaction.
   */
  async restart(
    sessions: SessionManager,
    titleService: TitleService,
  ): Promise<void> {
    if (this.reloading) throw new Error("Already reloading");
    this.reloading = true;
    this.emit("event", { type: "agent_reloading" } satisfies AgentEvent);
    blog.info("reloading agent...");

    try {
      // 1. Cancel all active prompts + kill bash procs
      for (const sessionId of [...sessions.activePrompts]) {
        const proc = sessions.runningBashProcs.get(sessionId);
        if (proc) {
          interruptBashProc(proc);
          sessions.runningBashProcs.delete(sessionId);
        }
        try {
          await this.cancel(sessionId);
        } catch {
          /* best-effort */
        }
      }

      // 2. Flush buffers to persist partial content
      for (const sessionId of sessions.liveSessions) {
        sessions.flushBuffers(sessionId);
      }

      // 3. Clean up SessionManager state
      sessions.pendingPermissions.clear();
      for (const id of sessions.activePrompts) {
        sessions.state.patch(id, { runtime: { busy: null } });
      }
      sessions.activePrompts.clear();

      // 4. Clean up bridge-side silent session state
      this.silentSessions.clear();
      this.silentBuffers.clear();

      // 5. Invalidate title service session
      titleService.invalidate();

      // 5. Clear liveSessions so ensureResumed() will re-register on next access
      sessions.liveSessions.clear();
      // Also clear the global configOptions cache — a restarted agent may
      // speak a different schema (e.g. agent upgrade removed a model). The
      // next resumeSession will warm it from the user's stored config.
      sessions.cachedConfigOptions = [];

      // 6. Shutdown old process
      await this.shutdown();

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
    this.permissionRequestSessions.clear();

    if (this.proc?.exitCode === null) {
      const proc = this.proc;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill(process.platform === "win32" ? undefined : "SIGKILL");
          resolve();
        }, 5000);
        proc.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
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
      this.permissionRequestSessions.set(requestId, params.sessionId);
      this.emit("event", {
        type: "permission_request",
        requestId,
        sessionId: params.sessionId,
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
    const sessionId = params.sessionId;

    if (this.silentSessions.has(sessionId)) {
      this.captureSilentText(sessionId, update);
      return Promise.resolve();
    }

    const event = this.sessionUpdateToEvent(sessionId, update);
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
    sessionId: string,
    update: acp.SessionNotification["update"],
  ): AgentEvent | null {
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only handles events with UI effects
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return update.content.type === "text"
          ? { type: "message_chunk", sessionId, text: update.content.text }
          : null;

      case "agent_thought_chunk":
        return update.content.type === "text"
          ? { type: "thought_chunk", sessionId, text: update.content.text }
          : null;

      case "tool_call":
        return {
          type: "tool_call",
          sessionId,
          id: update.toolCallId,
          title: update.title,
          kind: update.kind ?? "unknown",
          rawInput: update.rawInput as RawInput | undefined,
        };

      case "tool_call_update":
        return {
          type: "tool_call_update",
          sessionId,
          id: update.toolCallId,
          status: update.status ?? "",
          content: (update.content ?? undefined) as
            | ToolContentItem[]
            | undefined,
        };

      case "plan":
        return { type: "plan", sessionId, entries: update.entries };

      case "config_option_update":
        return {
          type: "config_option_update",
          sessionId,
          configOptions:
            (update as unknown as { configOptions?: ConfigOption[] })
              .configOptions ?? [],
        };

      case "available_commands_update":
        return {
          type: "available_commands_update",
          sessionId,
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
