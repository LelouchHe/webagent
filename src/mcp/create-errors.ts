/**
 * Tool-error text for `task_create`.
 *
 * These errors are the fallback discovery channel: a caller that named an agent
 * or a configuration value it could not know has to learn enough to try again.
 * The text therefore carries facts the caller cannot get anywhere else — why
 * the target failed, and which values *that request's* session reported.
 *
 * Every message is bounded: it lands in a transcript and in the model's
 * context. The rules follow from that:
 *
 * - The budget counts the rendered text (real line breaks, real characters),
 *   not the number of parts we happened to build.
 * - A field — an id, a value, a current value, a transport reason — is kept
 *   whole or dropped whole. A shortened id would look like a legal value while
 *   naming nothing.
 * - The failure category and the recovery guidance are never dropped: an error
 *   the caller cannot act on is worth less than a shorter one.
 * - Line breaks exist only between our own lines. A value that arrives with
 *   embedded newlines is flattened before it becomes a line, so an agent's
 *   message cannot forge extra lines or smuggle text past the budget.
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

/**
 * One line slot. `variants` are whole-line alternatives, nicest first; each is
 * added or dropped as a unit. `required` slots fall back to their last variant,
 * which is what keeps the category and the guidance in every message.
 */
export interface ErrorPart {
  variants: readonly string[];
  required?: boolean;
}

/** Collapse embedded line breaks so one external field cannot add lines. */
export function flattenField(value: string): string {
  return value.replace(/\r\n|[\r\n]+/g, " ").trim();
}

function withinLimits(text: string): boolean {
  return (
    text.length <= CREATE_ERROR_MAX_CHARS &&
    text.split("\n").length <= CREATE_ERROR_MAX_LINES
  );
}

/**
 * Render one bounded message.
 *
 * Slots are considered in order. A slot joins only when the whole message —
 * already kept lines, that slot's variant, and every still-pending required
 * slot — stays inside the budget. This is what stops an optional candidate list
 * from crowding out the guidance that follows it.
 */
export function composeError(parts: readonly ErrorPart[]): string {
  const kept: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const pendingRequired = parts
      .slice(index + 1)
      .filter((entry) => entry.required)
      .map((entry) => entry.variants[entry.variants.length - 1]);
    let chosen: string | null = null;
    for (const variant of part.variants) {
      if (withinLimits([...kept, variant, ...pendingRequired].join("\n"))) {
        chosen = variant;
        break;
      }
    }
    if (chosen === null && part.required) {
      // Required text is our own fixed copy (category, guidance), far inside the
      // budget, so this branch is the explicit contract, not a live case.
      chosen = part.variants[part.variants.length - 1];
    }
    if (chosen !== null) kept.push(chosen);
  }
  return kept.join("\n");
}

const OMIT_AGENT_GUIDANCE =
  "Omit `agent` to create the Task on this Task's agent.";

/** `agent` named an id that is not part of the startup configuration. */
export function unconfiguredAgentError(agentId: string): string {
  const id = flattenField(agentId);
  return composeError([
    {
      variants: [
        `Agent "${id}" is not configured, so no Task was created.`,
        "Agent is not configured, so no Task was created.",
      ],
      required: true,
    },
    // Deliberately no id list: it lives in the tool description, and repeating
    // it here is noise in the one place the caller already failed.
    { variants: [OMIT_AGENT_GUIDANCE], required: true },
  ]);
}

/** `agent` is configured but its transport could not be started. */
export function agentStartError(agentId: string, reason: string): string {
  const id = flattenField(agentId);
  const detail = flattenField(reason);
  return composeError([
    {
      variants: [
        `Agent "${id}" is configured but could not start: ${detail}`,
        `Agent "${id}" is configured but could not start.`,
        "A configured agent could not start.",
      ],
      required: true,
    },
    { variants: [OMIT_AGENT_GUIDANCE], required: true },
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
  const { reason, logicalId } = input;
  const id = flattenField(input.agentId);
  const requested = flattenField(input.requestedValue);
  const current =
    input.currentValue === null ? null : flattenField(input.currentValue);
  const supported = input.supportedValues.map(flattenField);

  const head: ErrorPart = {
    variants:
      reason === "unsupported"
        ? [
            `unsupported_config:${logicalId} — agent "${id}" did not report that option for this session, so no Task was created.`,
            `unsupported_config:${logicalId} — the target did not report that option for this session, so no Task was created.`,
          ]
        : [
            `invalid_config_value:${logicalId} — agent "${id}" does not accept "${requested}"; no Task was created.`,
            `invalid_config_value:${logicalId} — agent "${id}" rejected the requested value; no Task was created.`,
            `invalid_config_value:${logicalId} — the target rejected the requested value; no Task was created.`,
          ],
    required: true,
  };
  const guidance: ErrorPart = {
    variants: [
      reason === "unsupported"
        ? `Omit ${logicalId} to use the target's default.`
        : `Omit ${logicalId} to use the target's default, or ask the user which value to use.`,
    ],
    required: true,
  };

  const parts: ErrorPart[] = [head];
  if (reason === "invalid") {
    const list =
      supported.length > 0 && supported.length <= LISTED_CANDIDATE_LIMIT
        ? `Candidates: ${supported.join(", ")}.`
        : null;
    // The count form stands in when the list is too wide (or empty) *or* when
    // the list does not fit: a caller who sees seven candidates learns that the
    // list was wide, not that the target supports nothing.
    parts.push({
      variants: list
        ? [list, `That session reports ${supported.length} candidate values.`]
        : [`That session reports ${supported.length} candidate values.`],
    });
    if (current !== null)
      parts.push({ variants: [`Current value: ${current}.`] });
  }
  parts.push(guidance);
  return composeError(parts);
}
