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
 * Longest line that keeps its example. `.slash-primary` neither wraps nor
 * scrolls by design, so at 390px a longer line would overflow sideways; the
 * short form drops the example instead of the mention list.
 */
const HINT_MAX_CHARS = 38;

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

  // The example is an agent the task is not currently running on: naming the
  // current one would demonstrate nothing. With no known binding, the first
  // configured agent is as good an example as any.
  const example = ids.find((id) => id !== baselineAgentId) ?? ids[0];
  const full = `agents: ${ids.join(", ")} · type "${example}:"`;
  const text =
    full.length <= HINT_MAX_CHARS
      ? full
      : `agents: ${ids.join(", ")} · type "id:"`;
  return {
    spec: { primary: text },
    // A placeholder: not selectable, unchanged on hover, italic and dim.
    prefix: "",
    kind: "placeholder",
  };
}
