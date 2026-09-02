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
import type { McpServer, McpServerHttp } from "@agentclientprotocol/sdk";

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
  private mcpServersBySession = new Map<string, McpServer[]>();
  private conn: AgentSideConnection;
  private toolCallCounter = 0;
  private pendingPrompts = new Map<string, PendingPrompt>();
  private retryCancelAttempts = new Map<string, number>();

  constructor(conn: AgentSideConnection) {
    this.conn = conn;
  }

  /** Emit a plan update and park the prompt (assert-from-far e2e fixture). */
  private runSlowPlanPrompt(sessionId: string): Promise<PromptResponse> {
    void this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "Waiting", priority: "medium", status: "pending" },
          { content: "Working", priority: "medium", status: "in_progress" },
          { content: "Finished", priority: "medium", status: "completed" },
        ],
      },
    });
    return new Promise<PromptResponse>((resolve) => {
      this.pendingPrompts.set(sessionId, { resolve });
    });
  }

  /** Park a prompt for later resolution (used by slow/cancel test branches). */
  private runPendingPrompt(
    sessionId: string,
    retryCancelAttempts: number,
  ): Promise<PromptResponse> {
    this.retryCancelAttempts.set(sessionId, retryCancelAttempts);
    return new Promise<PromptResponse>((resolve) => {
      this.pendingPrompts.set(sessionId, { resolve });
    });
  }

  private async runMcpEchoPrompt(
    sessionId: string,
    mcpServers: McpServer[],
    echoArg: string,
  ): Promise<PromptResponse> {
    const result = await this.runMcpEchoRoundTrip(mcpServers, echoArg);
    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: result },
      },
    });
    return { stopReason: "end_turn" };
  }

  /**
   * Perform a real MCP round trip against the MCP server definitions
   * carried in ACP mcpServers: discover the http entry, initialize,
   * list tools, and call the echo tool with its capability header. Returns
   * a human-readable summary or the raw error for e2e assertions.
   */
  private async runMcpEchoRoundTrip(
    mcpServers: McpServer[],
    echoArg: string,
  ): Promise<string> {
    const httpCandidate = mcpServers.find((s) => "url" in s && "headers" in s);
    if (!httpCandidate) return "E2E_MCP_RESULT: no http mcp server provided";
    const entry = httpCandidate as unknown as McpServerHttp;
    const bearer = entry.headers.find((h) => h.name === "Authorization");
    if (!bearer) return "E2E_MCP_RESULT: missing Authorization header";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: bearer.value,
    };
    try {
      const post = (body: unknown): Promise<any> =>
        fetch(entry.url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }).then(async (res) => ({
          status: res.status,
          // 202 (notifications/initialized etc.) and 204 carry no body;
          // only parse JSON when there is content to read.
          body:
            res.status === 204 || res.status === 202 ? null : await res.json(),
        }));

      const init = await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mock-agent", version: "0.1.0" },
        },
      });
      await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const names = (list.body?.result?.tools ?? []).map(
        (t: { name: string }) => t.name,
      );
      const call = await post({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { text: echoArg } },
      });
      const content =
        call.body?.result?.content
          ?.map((c: { text?: string }) => c.text ?? "")
          .join("") ?? JSON.stringify(call.body);
      return `E2E_MCP_RESULT: ${init.status} tools=${names.join(",")} echo=${content}`;
    } catch (error) {
      return `E2E_MCP_RESULT: error ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async advertiseCommands(sessionId: string): Promise<void> {
    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          {
            name: "context",
            description: "Show context usage",
          },
          {
            name: "compact",
            description: "Compact conversation",
            input: { hint: "focus instructions" },
          },
        ],
      },
    });
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
    if (params.mcpServers.length > 0) {
      this.mcpServersBySession.set(sessionId, params.mcpServers);
    }
    const session = {
      cwd: params.cwd,
      configOptions: createConfigOptions(),
    };
    this.sessions.set(sessionId, session);
    await this.advertiseCommands(sessionId);
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
    await this.advertiseCommands(params.sessionId);
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
    session.configOptions = session.configOptions.map((opt) => {
      if (opt.id !== params.configId) return opt;
      if (opt.type === "select") {
        if (typeof params.value !== "string") {
          throw new Error(`Invalid select value for ${params.configId}`);
        }
        return { ...opt, currentValue: params.value };
      }
      if (typeof params.value !== "boolean") {
        throw new Error(`Invalid boolean value for ${params.configId}`);
      }
      return { ...opt, currentValue: params.value };
    });
    return { configOptions: session.configOptions };
  }

  // eslint-disable-next-line complexity -- TODO: refactor E2E dispatch into a route table
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const text = params.prompt
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ")
      .trim();

    if (text.startsWith("E2E_RETRY_CANCEL")) {
      return await this.runPendingPrompt(params.sessionId, 0);
    }

    if (text.startsWith("E2E_SLOW_PLAN")) {
      return await this.runSlowPlanPrompt(params.sessionId);
    }

    if (text.startsWith("E2E_MCP_ECHO")) {
      // Real MCP round trip against the MCP server the WebAgent attached
      // through ACP mcpServers: discover the http entry, call initialize +
      // tools/list + tools/call(echo), and surface the result as a message.
      // This is the P0b transport proof: session capability → capability
      // header → serving endpoint → echo result with the derived session.
      const mcpServers = this.mcpServersBySession.get(params.sessionId) ?? [];
      const echoArg = text.replace(/^E2E_MCP_ECHO\s*/, "").trim() || "hello";
      return await this.runMcpEchoPrompt(params.sessionId, mcpServers, echoArg);
    }

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

    if (text.startsWith("E2E_FINAL_ANSWER_STREAM")) {
      return await this.runFinalAnswerStream(params.sessionId, text);
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

  private async runFinalAnswerStream(
    sessionId: string,
    scenario: string,
  ): Promise<PromptResponse> {
    const toolCallId = `tool-${++this.toolCallCounter}`;
    const toolText =
      "<final_answer>\nCommands run:\n- `npm test`\nResult: passed";
    const continuation = scenario.includes("EXACT")
      ? ""
      : "Parent narration remains visible.";
    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Run validation",
        kind: "other",
      },
    });
    if (scenario.includes("NESTED")) {
      const nestedId = `tool-${++this.toolCallCounter}`;
      await this.conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: nestedId,
          title: "Run nested validation",
          kind: "execute",
        },
      });
      await this.conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: nestedId,
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "nested command output" },
            },
          ],
        },
      });
    }
    const split = 24;
    if (scenario.includes("WRAPPER_FIRST")) {
      await this.sendFinalAnswerCompletion(sessionId, toolCallId, toolText);
    }
    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: toolText.slice(0, split) },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (!scenario.includes("WRAPPER_FIRST")) {
      await this.sendFinalAnswerCompletion(sessionId, toolCallId, toolText);
    }
    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `${toolText.slice(split)}${continuation}`,
        },
      },
    });
    return { stopReason: "end_turn" };
  }

  private async sendFinalAnswerCompletion(
    sessionId: string,
    toolCallId: string,
    text: string,
  ): Promise<void> {
    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text },
          },
        ],
      },
    });
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
    const retryAttempts = this.retryCancelAttempts.get(params.sessionId);
    if (retryAttempts === 0) {
      this.retryCancelAttempts.set(params.sessionId, 1);
      return;
    }
    this.retryCancelAttempts.delete(params.sessionId);
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
