// The configured agent directory, as the server reports it on the metadata
// read face (`GET /config`, `POST /tasks/bootstrap`).
//
// It answers exactly one question: which agents may a create target, and which
// one is the configured default. It carries no liveness — whether an agent can
// really start is decided when one is started (503 with the real reason), and
// nothing probes PATH at startup.
//
// The other agent set in this client is different and must not be merged: the
// agents of visible tasks (`task-topology.ts`) carry the parent binding a
// task's own coordinate is compared against, and the list-row baseline.

export interface AgentDirectory {
  /** Configured agent ids, in configuration order. */
  ids: string[];
  defaultAgentId: string | null;
}

const EMPTY: AgentDirectory = { ids: [], defaultAgentId: null };

let directory: AgentDirectory = EMPTY;

function isEntry(value: unknown): value is { id: string } {
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
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of agents) {
    if (!isEntry(raw)) continue;
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    ids.push(raw.id);
  }
  directory = {
    ids,
    defaultAgentId:
      typeof defaultAgent === "string" && defaultAgent.length > 0
        ? defaultAgent
        : null,
  };
}

export function getAgentDirectory(): AgentDirectory {
  return directory;
}

/** Configured ids in configuration order (the shape a parse takes). */
export function configuredAgentIds(): string[] {
  return directory.ids;
}

export function isConfiguredAgent(id: string): boolean {
  return directory.ids.includes(id);
}

export function getDefaultAgentId(): string | null {
  return directory.defaultAgentId;
}

export function resetAgentDirectoryForTest(): void {
  directory = EMPTY;
}
