import type { AgentCommand } from "./types.ts";

export interface ResolvedAgentCommand {
  command: string;
  agentText: string;
}

export function resolveAgentCommand(
  text: string,
  commands: AgentCommand[],
): ResolvedAgentCommand | null {
  const match = /^\/\/(\S+)([\s\S]*)$/.exec(text);
  if (!match) return null;
  const inputName = match[1];
  const command = commands.find(
    (candidate) => candidate.name.toLowerCase() === inputName.toLowerCase(),
  );
  if (!command) return null;
  return {
    command: `//${inputName}`,
    agentText: `/${command.name}${match[2]}`,
  };
}

export function agentCommandToken(text: string): string {
  return text.match(/^\S+/)?.[0] ?? text;
}
