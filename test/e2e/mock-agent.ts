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
      options: [{ value: "mock-model", name: "Mock Model" }],
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
      sessionId: params.sessionId,
      configOptions: session.configOptions,
    };
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }
    session.configOptions = session.configOptions.map((opt) =>
      opt.id === params.configId ? { ...opt, currentValue: params.value } : opt
    );
    return { configOptions: session.configOptions };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const text = params.prompt
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ")
      .trim();

    if (text.startsWith("E2E_SLOW")) {
      return await new Promise<PromptResponse>((resolve) => {
        this.pendingPrompts.set(params.sessionId, { resolve });
      });
    }

    if (text.startsWith("E2E_PERMISSION")) {
      if (text.startsWith("E2E_PERMISSION_TWICE")) {
        const first = await this.runPermissionStep(params.sessionId, "Sensitive command 1", "echo sensitive-1");
        const second = await this.runPermissionStep(params.sessionId, "Sensitive command 2", "echo sensitive-2");
        const granted = first.outcome.outcome === "selected" && second.outcome.outcome === "selected";
        await this.conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: granted ? "Both permissions granted" : "A permission was denied",
            },
          },
        });
        return { stopReason: granted ? "end_turn" : "cancelled" };
      }

      const permission = await this.runPermissionStep(params.sessionId, "Sensitive command", "echo sensitive");
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: permission.outcome.outcome === "selected"
              ? "Permission granted"
              : "Permission denied",
          },
        },
      });
      return {
        stopReason: permission.outcome.outcome === "selected" ? "end_turn" : "cancelled",
      };
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

  private async runPermissionStep(sessionId: string, title: string, command: string) {
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
          status: permission.outcome.outcome === "selected" ? "completed" : "failed",
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
