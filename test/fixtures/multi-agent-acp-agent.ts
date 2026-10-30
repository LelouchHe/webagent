import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

/**
 * Minimal ACP agent for the multi-agent runtime tests.
 *
 * Usage: multi-agent-acp-agent.ts <session-id> <calls-path>
 *
 * The session id is supplied by the caller so two agents can deliberately hand
 * out the *same* id — the case that must stay two executions. Every call is
 * recorded so a test can prove which process received it.
 *
 * Prompts are answered immediately, so a test never waits on a real model.
 */
const [sessionIdPrefix, callsPath, initDelayMs, initializeMode] =
  process.argv.slice(2);
let sessionCount = 0;

// Recorded so a test can prove the child is really gone after a failed start.
appendFileSync(`${callsPath}.pid`, `${process.pid}\n`);

function record(method: string, params: unknown): void {
  appendFileSync(callsPath, `${JSON.stringify({ method, params })}\n`);
}

const agent: acp.Agent = {
  async initialize() {
    record("initialize", {});
    if (initDelayMs) {
      await new Promise((done) => setTimeout(done, Number(initDelayMs)));
    }
    if (initializeMode === "fail") {
      // A live process that refuses the handshake. It must be cleaned up by
      // the start path, not left running with a half-open connection.
      throw new Error("initialize refused by the fixture");
    }
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "multi-agent-fixture", version: "1" },
      // Advertised so the third Root state (a real binding restores its
      // session) is reachable.
      agentCapabilities: { loadSession: true },
    };
  },
  async newSession(params) {
    record("new", params);
    // Per-process counter: two agents with the same prefix hand out the same
    // ids (a shared CLI session store), while one agent never reuses an id.
    sessionCount++;
    return {
      sessionId: `${sessionIdPrefix}-${sessionCount}`,
      configOptions: [],
    };
  },
  async authenticate() {
    record("authenticate", {});
  },
  async loadSession(params) {
    record("load", params);
    return { configOptions: [] };
  },
  async setSessionConfigOption(params) {
    record("config", params);
    return { configOptions: [] };
  },
  async prompt(params) {
    record("prompt", params);
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "done" },
      },
    });
    return { stopReason: "end_turn" };
  },
  async cancel(params) {
    record("cancel", params);
  },
};

const connection = new acp.AgentSideConnection(
  () => agent,
  acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
