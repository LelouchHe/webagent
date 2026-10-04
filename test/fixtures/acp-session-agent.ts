import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const [profile, callsPath] = process.argv.slice(2);
const configOptions = [
  {
    type: "select",
    id: "mode",
    name: "Mode",
    currentValue: "agent",
    options: [
      { value: "agent", name: "Agent" },
      { value: "#plan", name: "Plan" },
    ],
  },
] satisfies acp.SessionConfigOption[];

function record(method: string, params: unknown): void {
  appendFileSync(callsPath, JSON.stringify({ method, params }) + "\n");
}

// Implement even unadvertised methods: forbidden calls must be reachable so
// the tests prove capability selection rather than rely on method-not-found.
const agent: acp.Agent = {
  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "session-fixture", version: "1" },
      agentCapabilities: {
        loadSession: profile === "load-only" || profile === "both",
        sessionCapabilities: {
          ...(profile === "resume-only" ||
          profile === "both" ||
          profile === "resume-missing"
            ? { resume: {} }
            : {}),
          ...(profile === "close" || profile === "delete" ? { close: {} } : {}),
          ...(profile === "delete" ? { delete: {} } : {}),
        },
      },
    };
  },
  async newSession(params) {
    record("new", params);
    return { sessionId: "unexpected-new", configOptions };
  },
  async loadSession(params) {
    record("load", params);
    return { configOptions };
  },
  async resumeSession(params) {
    record("resume", params);
    if (profile === "resume-missing") {
      throw acp.RequestError.resourceNotFound(params.sessionId);
    }
    return { configOptions };
  },
  async setSessionConfigOption(params) {
    record("config", params);
    return {
      configOptions: configOptions.map((option) => ({
        ...option,
        currentValue: params.value as string,
      })),
    };
  },
  async closeSession(params) {
    record("close", params);
    return {};
  },
  async deleteSession(params) {
    record("delete", params);
    return {};
  },
  async authenticate() {},
  async prompt(params) {
    if (profile === "large-update") {
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "large-result",
          rawOutput: "x".repeat(32 * 1024 * 1024),
        },
      });
    }
    return { stopReason: "end_turn" };
  },
  async cancel() {},
};

const connection = new acp.AgentSideConnection(
  () => agent,
  acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
