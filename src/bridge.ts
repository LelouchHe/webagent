import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { EventEmitter } from "node:events";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentEvent, ConfigOption, RawInput } from "./types.ts";
import type { SessionManager } from "./session-manager.ts";
import type { TitleService } from "./title-service.ts";
import { interruptBashProc } from "./session-manager.ts";

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
  readonly agentCmd: string;
  reloading = false;

  constructor(agentCmd: string) {
    super();
    this.agentCmd = agentCmd;
  }

  async start(): Promise<void> {
    const [cmd, ...args] = this.agentCmd.split(/\s+/);
    this.proc = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "inherit"],
    });

    if (!this.proc.stdin || !this.proc.stdout) {
      throw new Error(`Failed to start: ${this.agentCmd}`);
    }

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
      readTextFile: async (params: acp.ReadTextFileRequest) =>
        this.handleReadFile(params),
      writeTextFile: async (params: acp.WriteTextFileRequest) =>
        this.handleWriteFile(params),
    };

    this.conn = new acp.ClientSideConnection((_agent) => client, stream);

    const init = (await this.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
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

  async newSession(cwd: string, opts?: { silent?: boolean }): Promise<string> {
    if (!this.conn) throw new Error("Not connected");
    const session = (await this.conn.newSession({
      cwd,
      mcpServers: [],
    })) as acp.NewSessionResponse;
    if (!opts?.silent) {
      this.emit("event", {
        type: "session_created",
        sessionId: session.sessionId,
        cwd,
        configOptions: (session.configOptions ??
          []) as unknown as ConfigOption[],
      } satisfies AgentEvent);
    }
    return session.sessionId;
  }

  async loadSession(
    sessionId: string,
    cwd: string,
  ): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    if (!this.conn) throw new Error("Not connected");
    const session = (await this.conn.loadSession({
      sessionId,
      cwd,
      mcpServers: [],
    })) as acp.LoadSessionResponse;
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
    value: string,
  ): Promise<ConfigOption[]> {
    if (!this.conn) throw new Error("Not connected");
    const result = (await this.conn.setSessionConfigOption({
      sessionId,
      configId,
      value,
    })) as acp.SetSessionConfigOptionResponse;
    return result.configOptions as unknown as ConfigOption[];
  }

  async prompt(
    sessionId: string,
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ): Promise<void> {
    if (!this.conn) throw new Error("Not connected");
    try {
      const promptParts: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [];
      if (images) {
        for (const img of images) {
          promptParts.push({
            type: "image",
            data: img.data,
            mimeType: img.mimeType,
          });
        }
      }
      promptParts.push({ type: "text", text });
      const result = (await this.conn.prompt({
        sessionId,
        prompt: promptParts,
      })) as { stopReason?: string };
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

  /** Send a prompt and collect the full text response without emitting events. */
  async promptForText(sessionId: string, text: string): Promise<string> {
    if (!this.conn) throw new Error("Not connected");
    this.silentSessions.add(sessionId);
    this.silentBuffers.set(sessionId, "");
    try {
      await this.conn.prompt({ sessionId, prompt: [{ type: "text", text }] });
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
    console.info("[bridge] reloading agent...");

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
          console.error(`[bridge] start attempt ${i + 1} failed:`, err);
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

      console.info("[bridge] agent reloaded successfully");
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
          content: update.content ?? undefined,
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

      default:
        return null;
    }
  }

  private async handleReadFile(
    params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(params.path, "utf-8");
    return { content };
  }

  private async handleWriteFile(
    params: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse> {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(params.path), { recursive: true });
    await writeFile(params.path, params.content);
    return {};
  }
}
