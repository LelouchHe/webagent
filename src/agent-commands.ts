import type { AgentCommand } from "./types.ts";

export interface ResolvedAgentCommand {
  command: string;
  agentText: string;
}

function splitFirstToken(text: string): {
  token: string;
  remainder: string;
} {
  const boundary = text.search(/\s/);
  if (boundary < 0) return { token: text, remainder: "" };
  return {
    token: text.slice(0, boundary),
    remainder: text.slice(boundary),
  };
}

export function resolveAgentCommand(
  text: string,
  commands: AgentCommand[],
): ResolvedAgentCommand | null {
  if (!text.startsWith("//")) return null;
  const { token, remainder } = splitFirstToken(text);
  const inputName = token.slice(2);
  if (!inputName) return null;
  const command = commands.find(
    (candidate) => candidate.name.toLowerCase() === inputName.toLowerCase(),
  );
  if (!command) return null;
  return {
    command: token,
    agentText: `/${command.name}${remainder}`,
  };
}

export function agentCommandToken(text: string): string {
  return splitFirstToken(text).token || text;
}
