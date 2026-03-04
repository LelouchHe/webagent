import { spawn, ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { EventEmitter } from "node:events";
import * as acp from "@agentclientprotocol/sdk";

// Events emitted to WebSocket layer
export type AgentEvent =
  | { type: "connected"; agent: { name: string; version: string }; models: acp.ModelInfo[] }
  | { type: "session_created"; sessionId: string; cwd?: string; models?: acp.ModelsInfo }
  | { type: "message_chunk"; sessionId: string; text: string }
  | { type: "thought_chunk"; sessionId: string; text: string }
  | { type: "tool_call"; sessionId: string; id: string; title: string; kind: string; rawInput?: unknown }
  | { type: "tool_call_update"; sessionId: string; id: string; status: string; content?: unknown[] }
  | { type: "plan"; sessionId: string; entries: unknown[] }
  | { type: "permission_request"; requestId: string; sessionId: string; title: string; toolCallId?: string | null; options: acp.PermissionOption[] }
  | { type: "prompt_done"; sessionId: string; stopReason: string }
  | { type: "session_expired"; sessionId: string }
  | { type: "error"; message: string };

export class CopilotBridge extends EventEmitter {
  private proc: ChildProcess | null = null;
  private conn: acp.ClientSideConnection | null = null;
  private permissionResolvers = new Map<string, (resp: acp.RequestPermissionResponse) => void>();
  private permissionCounter = 0;

  async start(): Promise<void> {
    this.proc = spawn("copilot", ["--acp"], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    if (!this.proc.stdin || !this.proc.stdout) {
      throw new Error("Failed to start copilot --acp");
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
      models: [],
    } satisfies AgentEvent);
  }

  async newSession(cwd: string): Promise<string> {
    if (!this.conn) throw new Error("Not connected");
    const session = await this.conn.newSession({ cwd, mcpServers: [] });
    this.emit("event", {
      type: "session_created",
      sessionId: session.sessionId,
      cwd,
      models: session.models,
    } satisfies AgentEvent);
    return session.sessionId;
  }

  async loadSession(sessionId: string, cwd: string): Promise<string> {
    if (!this.conn) throw new Error("Not connected");
    const session = await this.conn.loadSession({ sessionId, cwd, mcpServers: [] });
    this.emit("event", {
      type: "session_created",
      sessionId: session.sessionId,
      cwd,
      models: session.models,
    } satisfies AgentEvent);
    return session.sessionId;
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    if (!this.conn) throw new Error("Not connected");
    await this.conn.unstable_setSessionModel({ sessionId, modelId });
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
      const message = err instanceof Error ? err.message : String(err);
      this.emit("event", { type: "error", message } satisfies AgentEvent);
    }
  }

  async cancel(): Promise<void> {
    await this.conn?.cancel();
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
    const requestId = `perm_${++this.permissionCounter}`;
    const title = params.toolCall?.title ?? "Permission requested";
    const toolCallId = params.toolCall?.toolCallId ?? null;
    console.log(`[bridge] permission: toolCallId=${toolCallId}, title=${title}`);

    this.emit("event", {
      type: "permission_request",
      requestId,
      sessionId: params.sessionId,
      title,
      toolCallId,
      options: params.options,
    } satisfies AgentEvent);

    return new Promise((resolve) => {
      this.permissionResolvers.set(requestId, resolve);
    });
  }

  private handleSessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    const sessionId = params.sessionId;

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
        console.log(`[bridge] tool_call:`, JSON.stringify(update).slice(0, 500));
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
        console.log(`[bridge] tool_call_update:`, JSON.stringify(update).slice(0, 500));
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
