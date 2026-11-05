// The configured agent directory, as the server reports it on the metadata
// read face (`GET /config`, `POST /tasks/bootstrap`).
//
// Two different sets exist in this client and must not be merged:
//
// - this directory: what the configuration offers. It answers "which agents
//   can a create target?" and therefore drives coordinate parsing and (later)
//   the completion menu.
// - the agents of visible tasks (`task-topology.ts`): what is actually being
//   carried right now. That one supplies the parent binding a task's coordinate
//   is compared against, and the list-row baseline.
//
// `available` only means the launch command was found in PATH at startup. It
// says nothing about a process starting, handshaking, or being authenticated,
// so nothing may treat it as runtime health.

export interface AgentDirectoryEntry {
  id: string;
  available: boolean;
}

let directory: AgentDirectoryEntry[] = [];
let defaultAgentId: string | null = null;

function isEntry(value: unknown): value is { id: string; available?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

/**
 * Install the directory from a metadata response. Unknown shapes are ignored
 * rather than half-installed: a client without a directory simply never reads
 * a colon as a coordinate, which is the safe degradation.
 */
export function installAgentDirectory(
  agents: unknown,
  defaultAgent: unknown,
): void {
  if (!Array.isArray(agents)) return;
  const next: AgentDirectoryEntry[] = [];
  const seen = new Set<string>();
  for (const raw of agents) {
    if (!isEntry(raw)) continue;
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    next.push({ id: raw.id, available: raw.available === true });
  }
  directory = next;
  defaultAgentId =
    typeof defaultAgent === "string" && defaultAgent.length > 0
      ? defaultAgent
      : null;
}

export function getAgentDirectory(): readonly AgentDirectoryEntry[] {
  return directory;
}

export function configuredAgentIds(): string[] {
  return directory.map((entry) => entry.id);
}

export function isConfiguredAgent(id: string): boolean {
  return directory.some((entry) => entry.id === id);
}

export function getDefaultAgentId(): string | null {
  return defaultAgentId;
}

/** Ids whose launch command existed at startup, in configuration order. */
export function availableAgentIds(): string[] {
  return directory.filter((entry) => entry.available).map((entry) => entry.id);
}

export function resetAgentDirectoryForTest(): void {
  directory = [];
  defaultAgentId = null;
}
