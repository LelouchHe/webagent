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
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
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

    if (text.startsWith("E2E_PERMISSION")) {
      const toolCallId = `tool-${++this.toolCallCounter}`;
      const title = "Sensitive command";
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title,
          kind: "execute",
          rawInput: { command: "echo sensitive" },
        },
      });
      const permission = await this.conn.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          toolCallId,
          title,
          kind: "execute",
          status: "pending",
          rawInput: { command: "echo sensitive" },
        },
        options: [
          { optionId: "allow", kind: "allow_once", name: "Allow" },
          { optionId: "deny", kind: "reject_once", name: "Deny" },
        ],
      });
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: permission.outcome.outcome === "selected" ? "completed" : "failed",
        },
      });
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

  async cancel(_params: CancelNotification): Promise<void> {}

  async authenticate(): Promise<void> {}
}

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

new AgentSideConnection((conn) => new MockAgent(conn), stream);
