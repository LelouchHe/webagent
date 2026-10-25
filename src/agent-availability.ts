// Agent CLI availability is a runtime condition, not a startup gate.
//
// A missing binary (or an agent removed from config) means that agent has no
// usable bridge right now: its tasks stay readable/deletable but cannot
// execute. The service must still start so those paths are reachable, so this
// module only reports availability for warnings.

import { spawnSync } from "node:child_process";

export interface AgentAvailability {
  id: string;
  cmd: string;
  bin: string;
  available: boolean;
}

/** First token of a command string, matching the bridge's launch split. */
export function agentCommandBinary(cmd: string): string {
  return cmd.trim().split(/\s+/, 1)[0] ?? "";
}

function inPath(bin: string): boolean {
  if (!bin) return false;
  const which = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(which, [bin], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function checkAgentAvailability(
  agents: Record<string, { cmd: string }>,
): AgentAvailability[] {
  return Object.entries(agents).map(([id, agent]) => ({
    id,
    cmd: agent.cmd,
    bin: agentCommandBinary(agent.cmd),
    available: inPath(agentCommandBinary(agent.cmd)),
  }));
}

/** Multi-line, operator-facing warning block (empty when all agents exist). */
export function formatAvailabilityWarnings(
  availability: AgentAvailability[],
  defaultAgent: string,
): string[] {
  const missing = availability.filter((entry) => !entry.available);
  if (missing.length === 0) return [];
  const lines = [
    "[agent] WARNING: some configured agents are not available; the service " +
      "still starts and their tasks remain read-only/deletable.",
  ];
  for (const entry of missing) {
    const label = entry.id === defaultAgent ? "default agent" : "agent";
    lines.push(
      `[agent] WARNING: ${label} "${entry.id}" is unavailable: ` +
        `'${entry.bin}' was not found in PATH (cmd: ${entry.cmd}).`,
    );
  }
  lines.push(
    "[agent] WARNING: tasks for an unavailable agent are read-only; no " +
      "execution is available until its binary is found again.",
  );
  return lines;
}
