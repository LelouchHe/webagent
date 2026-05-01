import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type CancelNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

type SessionState = {
  cwd: string;
  configOptions: SessionConfigOption[];
};

type PendingPrompt = {
  resolve: (resp: PromptResponse) => void;
};

function createConfigOptions(): SessionConfigOption[] {
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "mock-model",
      options: [
        { value: "mock-model", name: "Mock Model" },
        { value: "mock-model-2", name: "Mock Model 2" },
      ],
    },
    {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "agent",
      options: [
        { value: "agent", name: "Agent" },
        { value: "chat#plan", name: "Plan" },
        { value: "chat#autopilot", name: "Autopilot" },
      ],
    },
    {
      type: "select",
      id: "reasoning_effort",
      name: "Reasoning",
      category: "thought_level",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ];
}

class MockAgent implements Agent {
  private sessions = new Map<string, SessionState>();
  private conn: AgentSideConnection;
  private toolCallCounter = 0;
  private pendingPrompts = new Map<string, PendingPrompt>();

  constructor(conn: AgentSideConnection) {
    this.conn = conn;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: "mock-agent", version: "0.1.0" },
      agentCapabilities: { loadSession: true },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = randomUUID();
    const session = {
      cwd: params.cwd,
      configOptions: createConfigOptions(),
    };
    this.sessions.set(sessionId, session);
    return { sessionId, configOptions: session.configOptions };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    let session = this.sessions.get(params.sessionId);
    if (!session) {
      session = {
        cwd: params.cwd,
        configOptions: createConfigOptions(),
      };
      this.sessions.set(params.sessionId, session);
    }
    return {
      configOptions: session.configOptions,
    };
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }
    session.configOptions = session.configOptions.map((opt) =>
      opt.id === params.configId ? { ...opt, currentValue: params.value } : opt,
    );
    return { configOptions: session.configOptions };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const text = params.prompt
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ")
      .trim();

    if (text.startsWith("E2E_SLOW_TOOL")) {
      const toolCallId = `tool-${++this.toolCallCounter}`;
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Long-running tool",
          kind: "execute",
          rawInput: { command: "sleep 30" },
        },
      });
      return await new Promise<PromptResponse>((resolve) => {
        this.pendingPrompts.set(params.sessionId, { resolve });
      });
    }

    if (text.startsWith("E2E_SLOW")) {
      return await new Promise<PromptResponse>((resolve) => {
        this.pendingPrompts.set(params.sessionId, { resolve });
      });
    }

    // Reads each attachment in the prompt and emits a tool_call whose
    // title + rawInput.path reference the absolute uuid path. Used by
    // the attachment-label-egress E2E spec to verify the server
    // rewrites the path to `<name> [#<id4>]` at egress.
    if (text.startsWith("E2E_READ_ATTACHMENT")) {
      const fileUris = params.prompt
        .filter((p) => p.type === "resource_link")
        .map((p) => (p as { type: "resource_link"; uri: string }).uri)
        .filter((u): u is string => typeof u === "string");
      for (const uri of fileUris) {
        const path = uri.startsWith("file://")
          ? decodeURIComponent(uri.slice(7))
          : uri;
        const toolCallId = `tool-${++this.toolCallCounter}`;
        await this.conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: `Read ${path}`,
            kind: "read",
            rawInput: { path },
          },
        });
        await this.conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
          },
        });
      }
      return { stopReason: "end_turn" };
    }

    if (text.startsWith("E2E_PERMISSION")) {
      if (text.startsWith("E2E_PERMISSION_TWICE")) {
        const first = await this.runPermissionStep(
          params.sessionId,
          "Sensitive command 1",
          "echo sensitive-1",
        );
        const second = await this.runPermissionStep(
          params.sessionId,
          "Sensitive command 2",
          "echo sensitive-2",
        );
        const granted =
          first.outcome.outcome === "selected" &&
          second.outcome.outcome === "selected";
        await this.conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: granted
                ? "Both permissions granted"
                : "A permission was denied",
            },
          },
        });
        return { stopReason: granted ? "end_turn" : "cancelled" };
      }

      const permission = await this.runPermissionStep(
        params.sessionId,
        "Sensitive command",
        "echo sensitive",
      );
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text:
              permission.outcome.outcome === "selected"
                ? "Permission granted"
                : "Permission denied",
          },
        },
      });
      return {
        stopReason:
          permission.outcome.outcome === "selected" ? "end_turn" : "cancelled",
      };
    }

    if (text.startsWith("E2E_TOOL_EDIT")) {
      const toolCallId = `tool-${++this.toolCallCounter}`;
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Edit File",
          kind: "edit",
          rawInput: {
            path: "src/server.ts",
            old_str: 'const PORT = 3000;\nconst HOST = "localhost";',
            new_str:
              'const PORT = parseInt(process.env.PORT || "8080");\nconst HOST = "0.0.0.0";',
          },
        },
      });
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
        },
      });
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Updated the server config to use environment variables.",
          },
        },
      });
      return { stopReason: "end_turn" };
    }

    if (text.startsWith("E2E_TOOL_CREATE")) {
      const toolCallId = `tool-${++this.toolCallCounter}`;
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Create File",
          kind: "edit",
          rawInput: {
            path: "src/config.ts",
            file_text:
              'export interface Config {\n  port: number;\n  host: string;\n  dataDir: string;\n}\n\nexport const defaults: Config = {\n  port: 8080,\n  host: "0.0.0.0",\n  dataDir: "./data",\n};\n',
          },
        },
      });
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
        },
      });
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Created the config module with default values.",
          },
        },
      });
      return { stopReason: "end_turn" };
    }

    await this.conn.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Echo: ${text}` },
      },
    });
    return { stopReason: "end_turn" };
  }

  private async runPermissionStep(
    sessionId: string,
    title: string,
    command: string,
  ) {
    const toolCallId = `tool-${++this.toolCallCounter}`;
    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title,
        kind: "execute",
        rawInput: { command },
      },
    });
    const permission = await this.conn.requestPermission({
      sessionId,
      toolCall: {
        toolCallId,
        title,
        kind: "execute",
        status: "pending",
        rawInput: { command },
      },
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow" },
        { optionId: "deny", kind: "reject_once", name: "Deny" },
      ],
    });
    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status:
          permission.outcome.outcome === "selected" ? "completed" : "failed",
      },
    });
    return permission;
  }

  async cancel(params: CancelNotification): Promise<void> {
    const pending = this.pendingPrompts.get(params.sessionId);
    if (!pending) return;
    this.pendingPrompts.delete(params.sessionId);
    pending.resolve({ stopReason: "cancelled" });
  }

  async authenticate(): Promise<void> {}
}

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

new AgentSideConnection((conn) => new MockAgent(conn), stream);
