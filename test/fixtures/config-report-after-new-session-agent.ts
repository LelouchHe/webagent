import { createInterface } from "node:readline";

/**
 * An ACP agent whose `session/new` result and a **newer** config report for the
 * same session are emitted in a controlled order.
 *
 * Both orders are ordinary agent behavior, and the difference is the hardest
 * ordering the runtime has to keep:
 *
 * - `after` (default): the response describes the session's initial state, the
 *   notification describes a change that already happened. A client that treats
 *   the response as authoritative after the notification has been applied
 *   silently rolls the value back.
 * - `before`: the notification is already in the transport's queue while the
 *   response is still being produced. The transport replays it when the binding
 *   commits, which can land before a rotation's own tail.
 * - `none`: only the response is sent, so a rotation that clears a stored value
 *   has nothing newer to adopt.
 *
 * Written as a raw JSON-RPC loop rather than through the SDK so the lines leave
 * the process in one write: no timer decides the order.
 *
 * Usage: config-report-after-new-session-agent.ts [after|before|none]
 */

type Mode = "after" | "before" | "none";

const MODE: Mode = (() => {
  const arg = process.argv[2];
  return arg === "before" || arg === "none" ? arg : "after";
})();

const SESSION_ID = "after-response-session";

function schema(currentValue: "high" | "medium"): unknown[] {
  return [
    {
      type: "select",
      id: "reasoning_effort",
      category: "thought_level",
      name: "Thinking",
      currentValue,
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ];
}

function reply(id: unknown, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
}

function notification(): string {
  return `${JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: schema("medium"),
      },
    },
  })}\n`;
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line) as {
    id?: unknown;
    method?: string;
    params?: { protocolVersion?: string };
  };
  // A notification from the client needs no answer.
  if (message.id === undefined) return;

  if (message.method === "initialize") {
    process.stdout.write(
      reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        agentInfo: { name: "after-response-agent", version: "1" },
        agentCapabilities: { loadSession: true },
      }),
    );
    return;
  }

  if (message.method === "session/new") {
    const response = reply(message.id, {
      sessionId: SESSION_ID,
      configOptions: schema("high"),
    });
    const update = MODE === "none" ? "" : notification();
    process.stdout.write(
      MODE === "before" ? `${update}${response}` : `${response}${update}`,
    );
    return;
  }

  // Anything else (retirement, config writes) is accepted and ignored.
  process.stdout.write(reply(message.id, {}));
});
