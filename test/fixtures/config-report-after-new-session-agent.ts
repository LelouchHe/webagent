import { createInterface } from "node:readline";

/**
 * An ACP agent whose `session/new` result is immediately followed, in the same
 * output chunk, by a **newer** config report for the same session.
 *
 * That is ordinary agent behavior, and it is the hardest ordering the runtime
 * has to keep: the response describes the session's initial state, the
 * notification describes a change that already happened. A client that treats
 * the response as authoritative *after* the notification has been applied
 * silently rolls the value back.
 *
 * Written as a raw JSON-RPC loop rather than through the SDK so the two lines
 * leave the process in one write: the response first, the notification second,
 * and neither delayed by a timer.
 */

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
    process.stdout.write(
      reply(message.id, {
        sessionId: SESSION_ID,
        configOptions: schema("high"),
      }) +
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: "config_option_update",
              configOptions: schema("medium"),
            },
          },
        })}\n`,
    );
    return;
  }

  // Anything else (retirement, config writes) is accepted and ignored.
  process.stdout.write(reply(message.id, {}));
});
