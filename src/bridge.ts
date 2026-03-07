import { spawn, ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { EventEmitter } from "node:events";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentEvent, ConfigOption } from "./types.ts";

export class AgentBridge extends EventEmitter {
  private proc: ChildProcess | null = null;
  private conn: acp.ClientSideConnection | null = null;
  private permissionResolvers = new Map<string, (resp: acp.RequestPermissionResponse) => void>();
  private silentSessions = new Set<string>(); // Sessions that don't emit events
  private silentBuffers = new Map<string, string>(); // Text buffers for silent sessions
  readonly agentCmd: string;

  constructor(agentCmd?: string) {
    super();
    this.agentCmd = agentCmd ?? process.env.AGENT_CMD ?? "copilot --acp";
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
    const output = Readable.toWeb(this.proc.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const client: acp.Client = {
      requestPermission: async (params) => this.handlePermission(params),
      sessionUpdate: async (params) => this.handleSessionUpdate(params),
      readTextFile: async (params) => this.handleReadFile(params),
      writeTextFile: async (params) => this.handleWriteFile(params),
    };

    this.conn = new acp.ClientSideConnection((_agent) => client, stream);

    const init = await this.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

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
    const session = await this.conn.newSession({ cwd, mcpServers: [] });
    if (!opts?.silent) {
      this.emit("event", {
        type: "session_created",
        sessionId: session.sessionId,
        cwd,
        configOptions: (session as any).configOptions ?? [],
      } satisfies AgentEvent);
    }
    return session.sessionId;
  }

  async loadSession(sessionId: string, cwd: string): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    if (!this.conn) throw new Error("Not connected");
    const session = await this.conn.loadSession({ sessionId, cwd, mcpServers: [] });
    this.emit("event", {
      type: "session_created",
      sessionId: session.sessionId,
      cwd,
      configOptions: (session as any).configOptions ?? [],
    } satisfies AgentEvent);
    return { sessionId: session.sessionId, configOptions: (session as any).configOptions ?? [] };
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    if (!this.conn) throw new Error("Not connected");
    await this.conn.setSessionConfigOption({ sessionId, configId, value });
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
          promptParts.push({ type: "image", data: img.data, mimeType: img.mimeType });
        }
      }
      promptParts.push({ type: "text", text });
      const result = await this.conn.prompt({
        sessionId,
        prompt: promptParts,
      });
      this.emit("event", {
        type: "prompt_done",
        sessionId,
        stopReason: result.stopReason ?? "end_turn",
      } satisfies AgentEvent);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : (typeof err === "string" ? err : JSON.stringify(err));
      if (/cancel/i.test(message)) return; // Expected on cancel, not an error
      this.emit("event", { type: "error", message } satisfies AgentEvent);
    }
  }

  async cancel(sessionId: string): Promise<void> {
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
    }
  }

  denyPermission(requestId: string): void {
    const resolve = this.permissionResolvers.get(requestId);
    if (resolve) {
      resolve({ outcome: { outcome: "cancelled" } });
      this.permissionResolvers.delete(requestId);
    }
  }

  async shutdown(): Promise<void> {
    // Reject all pending permissions
    for (const [id, resolve] of this.permissionResolvers) {
      resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissionResolvers.clear();

    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.proc?.kill("SIGKILL");
          resolve();
        }, 5000);
        this.proc?.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.proc = null;
    this.conn = null;
  }

  // --- ACP Client callbacks ---

  private handlePermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const requestId = crypto.randomUUID();
    const title = params.toolCall?.title ?? "Permission requested";
    const toolCallId = params.toolCall?.toolCallId ?? null;

    return new Promise((resolve) => {
      // Register resolver BEFORE emitting, so synchronous auto-approve can find it
      this.permissionResolvers.set(requestId, resolve);
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

    // Silent sessions: only buffer text, don't emit events
    if (this.silentSessions.has(sessionId)) {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        const buf = (this.silentBuffers.get(sessionId) ?? "") + update.content.text;
        this.silentBuffers.set(sessionId, buf);
      }
      return Promise.resolve();
    }

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          this.emit("event", {
            type: "message_chunk",
            sessionId,
            text: update.content.text,
          } satisfies AgentEvent);
        }
        break;

      case "agent_thought_chunk":
        if (update.content.type === "text") {
          this.emit("event", {
            type: "thought_chunk",
            sessionId,
            text: update.content.text,
          } satisfies AgentEvent);
        }
        break;

      case "tool_call":
        this.emit("event", {
          type: "tool_call",
          sessionId,
          id: update.toolCallId ?? "",
          title: update.title ?? "",
          kind: update.kind ?? "unknown",
          rawInput: update.rawInput,
        } satisfies AgentEvent);
        break;

      case "tool_call_update":
        this.emit("event", {
          type: "tool_call_update",
          sessionId,
          id: update.toolCallId ?? "",
          status: update.status ?? "",
          content: update.content,
        } satisfies AgentEvent);
        break;

      case "plan":
        this.emit("event", {
          type: "plan",
          sessionId,
          entries: update.entries ?? [],
        } satisfies AgentEvent);
        break;

      case "config_option_update":
        this.emit("event", {
          type: "config_option_update",
          sessionId,
          configOptions: (update as any).configOptions ?? [],
        } satisfies AgentEvent);
        break;
    }

    return Promise.resolve();
  }

  private async handleReadFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(params.path, "utf-8");
    return { content };
  }

  private async handleWriteFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(params.path), { recursive: true });
    await writeFile(params.path, params.content);
    return {};
  }
}
