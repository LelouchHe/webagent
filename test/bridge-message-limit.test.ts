import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentBridge, MAX_ACP_MESSAGE_BYTES } from "../src/bridge.ts";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentEvent } from "../src/types.ts";

const LARGE_RAW_OUTPUT_BYTES = 32 * 1024 * 1024;

describe("ACP stdio message limit", { timeout: 30_000 }, () => {
  it("accepts a tool result just over the SDK's default 32 MiB line bound", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-acp-message-limit-"));
    const callsPath = join(dir, "calls.jsonl");
    writeFileSync(callsPath, "");
    const fixture = fileURLToPath(
      new URL("./fixtures/acp-session-agent.ts", import.meta.url),
    );
    const bridge = new AgentBridge(
      `${process.execPath} --experimental-strip-types ${fixture} large-update ${callsPath}`,
      {
        getAgentSessionId: (taskId) =>
          taskId === "web-1" ? "agent-1" : undefined,
        getTaskId: (agentSessionId) =>
          agentSessionId === "agent-1" ? "web-1" : undefined,
      },
    );
    const events: AgentEvent[] = [];
    bridge.on("event", (event: AgentEvent) => events.push(event));
    t.after(async () => {
      bridge.reloading = true;
      await bridge.shutdown();
      rmSync(dir, { recursive: true, force: true });
    });

    await bridge.start();
    await bridge.prompt("web-1", "return a large tool result");

    const result = events.find((event) => event.type === "tool_call_update");
    assert.ok(
      result,
      `large ACP tool result reaches the bridge; events=${JSON.stringify(events)}`,
    );
    assert.equal(typeof result.rawOutput, "string");
    assert.equal((result.rawOutput as string).length, LARGE_RAW_OUTPUT_BYTES);
  });

  // An over-limit inbound line aborts the whole connection and the SDK caches
  // that error for every later request, so the bridge must retire the agent:
  // otherwise the session looks alive and repeats the same raw error until the
  // process is restarted.
  const sessionIds = {
    getAgentSessionId: () => "agent-1",
    getTaskId: () => "web-1",
  };

  it("marks the agent disconnected when an inbound message exceeds the limit", () => {
    const bridge = new AgentBridge("unused", sessionIds);
    const events: AgentEvent[] = [];
    bridge.on("event", (event: AgentEvent) => events.push(event));
    (bridge as any).conn = {
      // Rejects after hand-off: the prompt resolves, the agent must still die.
      prompt: async () => {
        throw new acp.MessageTooLargeError(MAX_ACP_MESSAGE_BYTES);
      },
    };

    return bridge.prompt("web-1", "oversized tool result").then(async () => {
      assert.ok(events.some((event) => event.type === "agent_disconnected"));
      assert.match(
        String((bridge as any).deadReason),
        /exceeded the \d+-byte limit/,
      );
      assert.equal((bridge as any).conn, null);
      await assert.rejects(
        () => bridge.prompt("web-1", "again"),
        /exceeded the \d+-byte limit/,
      );
    });
  });

  it("reports the un-delivered turn when the limit trips before hand-off", async () => {
    const bridge = new AgentBridge("unused", sessionIds);
    (bridge as any).conn = {
      // Throws synchronously: the agent never received the prompt.
      prompt: () => {
        throw new acp.MessageTooLargeError(MAX_ACP_MESSAGE_BYTES);
      },
    };

    await assert.rejects(
      () => bridge.prompt("web-1", "oversized tool result"),
      /exceeded the \d+-byte limit/,
    );
  });
});
