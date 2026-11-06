/**
 * Tool-error text for `task_create`.
 *
 * These errors are the fallback discovery channel: a caller that named an agent
 * or a configuration value it could not know has to learn enough to try again.
 * The text therefore carries facts the caller cannot get anywhere else — why
 * the target failed, and which values *that request's* session reported.
 *
 * Every message is bounded: it lands in a transcript and in the model's
 * context. Bounding drops whole lines and whole ids, never part of an id — a
 * shortened id would look like a legal value while naming nothing.
 */

/** Whole error ceiling. */
export const CREATE_ERROR_MAX_CHARS = 400;
/** Whole error ceiling, so one message cannot crowd out the conversation. */
export const CREATE_ERROR_MAX_LINES = 6;

/**
 * Above this many candidates a list stops being useful. `thinking` normally
 * reports a handful; `model` can report dozens, most of them unusable, and
 * listing them invites "pick one at random" instead of a decision.
 */
export const LISTED_CANDIDATE_LIMIT = 5;

/** Keep the leading lines that fit; the first line is always kept. */
export function boundErrorText(lines: readonly string[]): string {
  const kept: string[] = [];
  for (const line of lines) {
    if (kept.length >= CREATE_ERROR_MAX_LINES) break;
    const candidate = [...kept, line].join("\n");
    if (candidate.length <= CREATE_ERROR_MAX_CHARS) {
      kept.push(line);
      continue;
    }
    if (kept.length === 0) {
      // Only reachable with a pathologically long id or transport reason, all
      // of which are free text rather than a candidate list.
      kept.push(`${line.slice(0, CREATE_ERROR_MAX_CHARS - 1)}…`);
    }
    break;
  }
  return kept.join("\n");
}

function fits(lines: readonly string[], addition: string): boolean {
  if (lines.length >= CREATE_ERROR_MAX_LINES) return false;
  return [...lines, addition].join("\n").length <= CREATE_ERROR_MAX_CHARS;
}

function candidateLine(
  supportedValues: readonly string[],
  currentValue: string | null,
): string {
  const current =
    currentValue === null ? "" : ` Current value: ${currentValue}.`;
  return `Candidates: ${supportedValues.join(", ")}.${current}`;
}

function countLine(
  supportedValues: readonly string[],
  currentValue: string | null,
): string {
  const current =
    currentValue === null ? "" : ` Current value: ${currentValue}.`;
  return `That session reports ${supportedValues.length} candidate values.${current}`;
}

/** `agent` named an id that is not part of the startup configuration. */
export function unconfiguredAgentError(agentId: string): string {
  // Deliberately no id list: it lives in the tool description, and repeating it
  // here is noise in the one place the caller already failed.
  return boundErrorText([
    `Agent "${agentId}" is not configured, so no Task was created.`,
    "Omit `agent` to create the Task on this Task's agent.",
  ]);
}

/** `agent` is configured but its transport could not be started. */
export function agentStartError(agentId: string, reason: string): string {
  return boundErrorText([
    `Agent "${agentId}" is configured but could not start: ${reason}`,
    "Omit `agent` to create the Task on this Task's agent.",
  ]);
}

/**
 * The target's own session rejected (or never reported) a requested
 * `model` / `thinking` value. The candidates come from that session's report —
 * never from the agent-level cache, which can be a stale list from an earlier
 * session that reported more than this one did.
 */
export function configOverrideError(input: {
  reason: "unsupported" | "invalid";
  logicalId: "model" | "thinking";
  agentId: string;
  requestedValue: string;
  supportedValues: readonly string[];
  currentValue: string | null;
}): string {
  const { reason, logicalId, agentId, requestedValue } = input;
  const head =
    reason === "unsupported"
      ? `unsupported_config:${logicalId} — agent "${agentId}" did not report that option for this session, so no Task was created.`
      : `invalid_config_value:${logicalId} — agent "${agentId}" does not accept "${requestedValue}"; no Task was created.`;
  const guidance =
    reason === "unsupported"
      ? `Omit ${logicalId} to use the target's default.`
      : `Omit ${logicalId} to use the target's default, or ask the user which value to use.`;

  const lines = [head];
  if (reason === "invalid") {
    const list =
      input.supportedValues.length > 0 &&
      input.supportedValues.length <= LISTED_CANDIDATE_LIMIT
        ? candidateLine(input.supportedValues, input.currentValue)
        : null;
    // The list is all-or-nothing: it is added only when the guidance still
    // fits beside it. Otherwise the bounded count form says the same thing.
    if (list && fits([...lines, guidance], list)) lines.push(list);
    else lines.push(countLine(input.supportedValues, input.currentValue));
  }
  lines.push(guidance);
  return boundErrorText(lines);
}
