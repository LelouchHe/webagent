import { createHash } from "node:crypto";

export const ROOT_ID_PREFIX = "root-";

export function agentKeyFromCommand(agentCmd: string): string {
  const key = agentCmd.trim().split(/\s+/, 1)[0];
  if (!key) throw new Error("ACP agent command is empty");
  return key;
}

export function rootTaskIdFor(agentKey: string): string {
  return `${ROOT_ID_PREFIX}${createHash("sha256").update(agentKey).digest("hex").slice(0, 32)}`;
}

export function isReservedRootTaskId(taskId: string): boolean {
  return taskId.startsWith(ROOT_ID_PREFIX);
}
