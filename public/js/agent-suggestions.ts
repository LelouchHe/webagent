// Completion surface for the `<agent>:<cwd>` coordinate field.
//
// `+`, `/new`, and `/clear` all read the same field and must offer the same
// agent rows: `create-command.ts` owns the grammar (`suggestCoordinatePrefix`),
// this module turns its answer into menu rows, and each entry supplies only how
// a chosen row is filled (its command head differs). Nothing here re-reads the
// raw text as a coordinate, so a menu cannot disagree with submission about
// what the same bytes mean.
//
// Two independent questions live here, exactly as the frozen suggestion shape
// splits them: whether the first token is still an open agent-id prefix (rows),
// and whether a coordinate is already settled (path input and prefix).

import {
  suggestCoordinatePrefix,
  type CoordinateSuggestion,
} from "./create-command.ts";
import type { AgentDirectoryEntry } from "./agent-directory.ts";
import type { Candidate } from "./slash-tree.ts";

/**
 * Agent rows appear only when the configuration actually offers a choice. With
 * one configured agent the menu must be byte-for-byte what it was before
 * coordinates existed, so a single-agent deployment gets no agent segment.
 */
const AGENT_ROWS_MIN = 2;

export interface CoordinateField {
  /** The only text path completion may filter and complete on: the suffix of a
   *  settled coordinate, otherwise the field as typed. */
  pathInput: string;
  /** `<agent>:` while the input is already a coordinate, else "". */
  coordinatePrefix: string;
  /** The settled coordinate, when the first token already names an agent. */
  coordinate: CoordinateSuggestion["coordinate"];
  /** Agent rows for the front of the data segment, already prefix-filtered. */
  rows: Candidate[];
}

/**
 * Read a raw argument field once for both of its consumers.
 *
 * `fillFor` builds the value a row inserts, because the three entries differ
 * only there (`+<title> <id>:` versus the command head the walker already
 * supplies). The caller keeps ownership of the rows' position: they belong at
 * the front of the data segment, never ahead of the submit row.
 */
export function coordinateField(
  rawRemainder: string,
  agents: readonly AgentDirectoryEntry[],
  baselineAgentId: string | null,
  fillFor: (agentId: string) => string,
): CoordinateField {
  const suggestion = suggestCoordinatePrefix(
    rawRemainder,
    agents,
    baselineAgentId,
  );
  const coordinate = suggestion.coordinate;
  return {
    pathInput: suggestion.pathInput,
    coordinatePrefix: coordinate === null ? "" : `${coordinate.agentId}:`,
    coordinate,
    rows: agentRows(suggestion, agents, baselineAgentId, fillFor),
  };
}

/**
 * Rows for the agents the first token can still become. `agentPrefix` is null
 * for a settled coordinate, a first token already ended by whitespace, and a
 * `./` escape, so those menus keep offering path rows only.
 */
function agentRows(
  suggestion: CoordinateSuggestion,
  agents: readonly AgentDirectoryEntry[],
  baselineAgentId: string | null,
  fillFor: (agentId: string) => string,
): Candidate[] {
  const prefix = suggestion.agentPrefix;
  if (prefix === null || agents.length < AGENT_ROWS_MIN) return [];
  return (
    agents
      .filter((agent) => agent.id.startsWith(prefix.text))
      // Available first, configuration order inside each group: the rows the
      // user can act on now are reachable with the fewest keystrokes.
      .sort((a, b) => Number(b.available) - Number(a.available))
      .map((agent): Candidate => {
        const current = agent.id === baselineAgentId;
        return {
          spec: {
            // The colon is part of the label: the row completes a coordinate,
            // not an id, and `<id>:` is the same syntax the status bar uses.
            primary: `${agent.id}:`,
            // Availability is carried by text, never by color alone.
            secondary: agent.available ? "agent" : "unavailable",
            current,
            fill: fillFor(agent.id),
            // The coordinate is not settled by this row alone: the menu stays
            // open for the suffix's path completion.
            continueOnFill: true,
          },
          // `current` only switches the color class; the star is its own input.
          prefix: current ? "*" : "",
          kind: "data",
        };
      })
  );
}
