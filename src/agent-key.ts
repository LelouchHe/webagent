export function agentKeyFromCommand(agentCmd: string): string {
  const key = agentCmd.trim().split(/\s+/, 1)[0];
  if (!key) throw new Error("ACP agent command is empty");
  return key;
}
