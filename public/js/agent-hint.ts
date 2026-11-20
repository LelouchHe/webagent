// The menu's one-line agent hint.
//
// Agents are a small closed set with short, typeable ids; paths are an open set
// that must be completed. So the menus never offer agent rows — they end with
// one non-selectable line that names the configured agents and shows the
// coordinate syntax once. It only explains how to type; it never ranks or
// annotates availability (whether an agent starts is decided when it is used).

import { parseCoordinate } from "./create-command.ts";
import type { Candidate } from "./slash-tree.ts";

/**
 * The hint row for a raw argument field, or null when there is nothing to
 * explain: fewer than two configured agents (a single-agent menu stays
 * byte-for-byte as it was), or a field that already is a coordinate (`id:` has
 * been typed, so the syntax is in use).
 */
export function agentHintRow(
  rawRemainder: string,
  ids: readonly string[],
  baselineAgentId: string | null,
): Candidate | null {
  if (ids.length < 2) return null;
  if (parseCoordinate(rawRemainder, ids).agentId !== null) return null;

  // The current agent goes last, so the first one, the example, is always an
  // agent the task is not running on: naming the current one would
  // demonstrate nothing. With no known binding the configured order stands.
  const ordered = [
    ...ids.filter((id) => id !== baselineAgentId),
    ...ids.filter((id) => id === baselineAgentId),
  ];
  return {
    spec: {
      primary: `agents: ${ordered.join(", ")} · type "${ordered[0]}:"`,
    },
    // A placeholder: not selectable, unchanged on hover, italic and dim.
    prefix: "",
    kind: "placeholder",
  };
}
