/**
 * The `task_create` description is the only always-visible discovery channel
 * for configured agents: it is rebuilt per MCP request from the startup
 * configuration snapshot, so adding or removing `[agents.<id>]` never needs a
 * second source of truth (no schema enum, no discovery tool).
 *
 * The budget covers the **whole** description, not just the list. Providers cap
 * function-calling descriptions (1024 characters is the documented ceiling), so
 * a legal large deployment must still produce a description the provider
 * accepts — otherwise the request fails before the tool can run at all.
 *
 * A listed id is always a complete id. A truncated id would look legal while
 * naming nothing, so an id that does not fit is dropped, never shortened; the
 * list then ends with an ellipsis and the omitted count.
 */

/** Whole-description ceiling, including the fixed copy and the list suffix. */
export const TASK_CREATE_DESCRIPTION_BUDGET = 1024;

const BASE =
  "Create a direct child Task for independent work. " +
  "Immediately use task_send to give it the first instruction, then end the dispatch turn without polling.";

const OMIT_NOTE = "Omit `agent` to inherit this Task's agent.";

const LIST_INTRO = "Pass `agent` to choose the execution agent; configured: ";

function compose(
  base: string,
  listed: readonly string[],
  omitted: number,
  omitNote: string,
): string {
  const names = listed.join(", ");
  const more = omitted > 0 ? `… ${omitted} more` : "";
  return `${base} ${LIST_INTRO}${names}${more}. ${omitNote}`;
}

/**
 * Build the description for one request from the configured agent ids.
 *
 * A single-agent deployment keeps the plain description: there is no
 * cross-agent choice to advertise, and the `agent` field's own description
 * already explains omission.
 */
export function buildTaskCreateDescription(
  agentIds: readonly string[],
): string {
  const ids = [...new Set(agentIds.filter((id) => id.length > 0))];
  if (ids.length <= 1) return BASE;

  for (let shown = ids.length; shown >= 1; shown--) {
    const text = compose(
      BASE,
      ids.slice(0, shown),
      ids.length - shown,
      OMIT_NOTE,
    );
    if (text.length <= TASK_CREATE_DESCRIPTION_BUDGET) return text;
  }

  // Not even one complete id fits. Say how many exist rather than inventing a
  // shortened, plausible-looking id.
  return `${BASE} ${ids.length} execution agents are configured; their ids are too long to list here. ${OMIT_NOTE}`;
}
