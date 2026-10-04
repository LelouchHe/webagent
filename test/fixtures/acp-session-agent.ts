import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const [profile, callsPath] = process.argv.slice(2);
function groupedConfigOptions(
  sessionId: string,
  includeThird = false,
): acp.SessionConfigOption[] {
  const provider = sessionId.endsWith("2") ? "vendor-b" : "vendor-a";
  const firstValue = JSON.stringify([provider, "model-one"]);
  const secondValue = JSON.stringify([provider, "model-two"]);
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: firstValue,
      options: [
        {
          group: provider,
          name: provider === "vendor-a" ? "Vendor A" : "Vendor B",
          options: [
            { value: firstValue, name: "Model One" },
            { value: secondValue, name: "Model Two" },
            ...(includeThird
              ? [
                  {
                    value: JSON.stringify([provider, "model-three"]),
                    name: "Model Three",
                  },
                ]
              : []),
          ],
        },
      ],
    },
  ];
}

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
let nextSession = 0;
const sessionOptions = new Map<string, acp.SessionConfigOption[]>();

function optionsForSession(sessionId: string): acp.SessionConfigOption[] {
  return profile === "grouped-model"
    ? (sessionOptions.get(sessionId) ?? groupedConfigOptions(sessionId))
    : configOptions;
}

const agent: acp.Agent = {
  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "session-fixture", version: "1" },
      agentCapabilities: {
        loadSession:
          profile === "grouped-model" ||
          profile === "load-only" ||
          profile === "both",
        sessionCapabilities: {
          ...(profile === "grouped-model" ||
          profile === "resume-only" ||
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
    if (profile === "grouped-model") {
      const sessionId = `grouped-${++nextSession}`;
      const options = groupedConfigOptions(sessionId);
      sessionOptions.set(sessionId, groupedConfigOptions(sessionId, true));
      await connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: groupedConfigOptions(sessionId, true),
        },
      });
      return { sessionId, configOptions: options };
    }
    return { sessionId: "unexpected-new", configOptions };
  },
  async loadSession(params) {
    record("load", params);
    return { configOptions: optionsForSession(params.sessionId) };
  },
  async resumeSession(params) {
    record("resume", params);
    if (profile === "resume-missing") {
      throw acp.RequestError.resourceNotFound(params.sessionId);
    }
    return { configOptions: optionsForSession(params.sessionId) };
  },
  async setSessionConfigOption(params) {
    record("config", params);
    const options = optionsForSession(params.sessionId);
    const updated = options.map((option) => {
      if (option.id !== params.configId) return option;
      if (option.type === "select") {
        const choices = option.options.flatMap((choice) =>
          "options" in choice ? choice.options : [choice],
        );
        if (!choices.some((choice) => choice.value === params.value)) {
          throw new Error(`Unknown model option: ${String(params.value)}`);
        }
        return { ...option, currentValue: params.value as string };
      }
      return option;
    });
    if (profile === "grouped-model") {
      sessionOptions.set(params.sessionId, updated);
    }
    return { configOptions: updated };
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
