// Shared preview and cwd-resolution helpers for the two task-create entry
// points, `+` and `/new`.
//
// Both menus preview a cwd value and must render it unambiguously, and both
// must send the same resolved path the preview describes, so these rules live
// here rather than in either consumer (task-command.ts imports
// slash-commands.ts, so it cannot be the shared home).

import { state } from "./state.ts";
import { resolveViewPath } from "./file-browser.ts";
import * as api from "./api.ts";
import { loadTaskList } from "./task-topology.ts";
import { HTTP_STATUS } from "../../src/http-status.ts";
import { availableAgentIds, getDefaultAgentId } from "./agent-directory.ts";

/** The only thing coordinate parsing needs from a configured agent. */
export interface ConfiguredAgentRef {
  readonly id: string;
}

export type ParsedCoordinate =
  | { agentId: null; cwd: string }
  | { agentId: string; cwd: string };

export interface CoordinateSuggestion {
  /** First-token text the completion would replace wholesale; "" = nothing
   *  typed yet. null when no agent row applies. */
  agentPrefix: { text: string } | null;
  /** Set once the input is a coordinate; the suffix is byte-preserved. */
  coordinate: { agentId: string; rawSuffix: string } | null;
  /** The only input path completion and submission may consume. */
  pathInput: string;
}

/**
 * Locate the first token of a raw remainder without touching anything after
 * it. The ECMAScript `\s` class (TAB and full-width spaces included) defines
 * the boundary, but it is only ever used to *find* the prefix: the suffix is
 * never normalized.
 */
function firstToken(
  raw: string,
): { start: number; end: number; text: string } | null {
  const start = raw.search(/\S/u);
  if (start === -1) return null;
  const relativeEnd = raw.slice(start).search(/\s/u);
  const end = relativeEnd === -1 ? raw.length : start + relativeEnd;
  return { start, end, text: raw.slice(start, end) };
}

/**
 * Read a raw cwd remainder as `<agent>:<cwd>`.
 *
 * A colon is the only marker: with one the prefix must name a configured agent
 * exactly (lowercase, no folding) and everything after it is the cwd, byte for
 * byte; without one the whole remainder is a path. An unknown prefix is a
 * path, never a "not configured agent" error — paths are unbounded and the
 * disambiguation for a real directory that looks like a coordinate is `./`.
 */
export function parseCoordinate(
  rawRemainder: string,
  agents: readonly ConfiguredAgentRef[],
): ParsedCoordinate {
  const token = firstToken(rawRemainder);
  if (!token) return { agentId: null, cwd: rawRemainder };
  if (token.text.startsWith("./")) return { agentId: null, cwd: rawRemainder };
  const colon = token.text.indexOf(":");
  if (colon === -1) return { agentId: null, cwd: rawRemainder };
  const candidate = token.text.slice(0, colon);
  if (!agents.some((agent) => agent.id === candidate)) {
    return { agentId: null, cwd: rawRemainder };
  }
  return {
    agentId: candidate,
    cwd: rawRemainder.slice(token.start + colon + 1),
  };
}

/**
 * Decide whether the input is still inside an agent-id prefix, and what the
 * settled coordinate (if any) is. Completion consumes this so it can never
 * disagree with `parseCoordinate` about the same text.
 *
 * The two answers are different dimensions, not two states of one machine:
 * `co` both suggests agents and keeps offering path rows, `co ` (first token
 * already ended by whitespace) suggests none, and `copilot:~/a  b` is settled
 * with no agent suggestion. `baselineAgentId` is deliberately not an input to
 * the parse: the current binding only decides which row the menu marks.
 */
export function suggestCoordinatePrefix(
  rawRemainder: string,
  agents: readonly ConfiguredAgentRef[],
  _baselineAgentId: string | null = null,
): CoordinateSuggestion {
  const coordinate = parseCoordinate(rawRemainder, agents);
  if (coordinate.agentId !== null) {
    return {
      agentPrefix: null,
      coordinate: { agentId: coordinate.agentId, rawSuffix: coordinate.cwd },
      pathInput: coordinate.cwd,
    };
  }
  const token = firstToken(rawRemainder);
  if (!token) {
    return {
      agentPrefix: { text: "" },
      coordinate: null,
      pathInput: rawRemainder,
    };
  }
  const endedByWhitespace = token.end < rawRemainder.length;
  const eligible =
    !endedByWhitespace &&
    !token.text.startsWith("./") &&
    !token.text.includes(":") &&
    agents.some((agent) => agent.id.startsWith(token.text));
  return {
    agentPrefix: eligible ? { text: token.text } : null,
    coordinate: null,
    pathInput: rawRemainder,
  };
}

/** A settled coordinate resolved to the wire shape. `cwd: null` means the
 *  field is omitted, so each entry keeps its own documented meaning for that
 *  omission (server default on create, task directory on clear). */
export interface CoordinateTarget {
  agentId: string;
  cwd: string | null;
}

/**
 * Resolve a settled coordinate's suffix for a request.
 *
 * Fidelity boundary: interior bytes are the path and travel verbatim, while
 * leading/trailing whitespace is only the separator the user typed. The empty
 * suffix test runs on the trimmed value, so `copilot: ` and `copilot:` are the
 * same request. The parser itself still reports the raw text; trimming happens
 * here, after parsing and before the request.
 */
export async function resolveCoordinateTarget(coordinate: {
  agentId: string;
  rawSuffix: string;
}): Promise<CoordinateTarget | { error: string }> {
  const suffix = coordinate.rawSuffix.trim();
  if (suffix === "") return { agentId: coordinate.agentId, cwd: null };
  const resolved = await resolveCreateCwd(suffix);
  if ("error" in resolved) return resolved;
  return { agentId: coordinate.agentId, cwd: resolved.cwd };
}

/**
 * Display form of a create cwd field. A settled coordinate keeps `<agent>:`
 * glued to its cwd (no space that could be read as a different pair); an
 * unsettled field is the plain path preview.
 */
export function previewCreateCwd(
  rawRemainder: string,
  agents: readonly ConfiguredAgentRef[],
): string {
  const coordinate = parseCoordinate(rawRemainder, agents);
  if (coordinate.agentId === null) return previewCwdDisplay(rawRemainder);
  const display =
    coordinate.cwd === "" ? "" : previewCwdDisplay(coordinate.cwd);
  return `${coordinate.agentId}:${display}`;
}

/**
 * The one-line rescue for an agent that is configured but would not start:
 * name an agent other than the one that just failed, preferring one whose
 * command exists at startup and falling back to the configured default. The
 * cwd is the raw task path, and the whole line is plain copyable text.
 */
export function agentRescueCommand(
  failedAgentId: string | null,
  cwd: string,
): string | null {
  const available = availableAgentIds().filter((id) => id !== failedAgentId);
  const fallback = getDefaultAgentId();
  const live =
    available.length > 0
      ? available[0]
      : fallback !== null && fallback !== failedAgentId
        ? fallback
        : null;
  if (live === null) return null;
  return `/clear ${live}:${cwd}`;
}

/**
 * Report a create/clear failure. Only a start failure of a configured agent
 * carries a rescue line: an unknown agent has nothing to rescue to, and a
 * directory error is fixed by the path, not by another agent.
 */
export function taskAgentFailureLines(
  action: "create" | "clear",
  err: unknown,
  failedAgentId: string | null,
  /** Raw task cwd for the rescue line. Passed explicitly because a create
   *  failure is reported after the view was reset. */
  cwd: string | null,
): string[] {
  const detail = err instanceof Error ? err.message : String(err);
  const prefix =
    action === "create" ? "err: create failed" : "err: Failed to clear task";
  const lines = [`${prefix} — ${detail}`];
  if (
    err instanceof api.ApiError &&
    err.status === HTTP_STATUS.SERVICE_UNAVAILABLE
  ) {
    const rescue = agentRescueCommand(failedAgentId, cwd ?? "");
    if (rescue !== null) lines.push(rescue);
  }
  return lines;
}

/**
 * Collapse the `.` segments and duplicate separators a relative cwd picks up
 * from the join, without canonicalizing symlinks: `/tmp/my dir` stays literal
 * while `./rel` stops leaking a `/./`.
 */
export function tidyResolvedPath(path: string): string {
  return path
    .replace(/\/\.\//g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/\.$/, "");
}

/**
 * Render one preview field so a value can never be misread as a different
 * (title, cwd) pair. A value without a quote character keeps the plain
 * single-quote form byte for byte; a value containing `'` or `"` switches to a
 * JSON string (double quotes with `\"`/`\\` escapes) so the delimiters stay
 * unambiguous. Titles and cwds share this rendering.
 */
export function previewValue(value: string): string {
  if (!/['"]/.test(value)) return `'${value}'`;
  return JSON.stringify(value);
}

/**
 * Display form of a cwd preview field. Resolved against the abbreviated cwd
 * base so it stays `~/…`-styled; never touches the filesystem.
 */
export function previewCwdDisplay(rawCwd: string): string {
  const base = state.taskCwd ?? "";
  const displayBase = state.taskCwdDisplay ?? base;
  if (rawCwd === "") return displayBase;
  try {
    return tidyResolvedPath(resolveViewPath(rawCwd, displayBase || null));
  } catch {
    return rawCwd;
  }
}

/**
 * Resolve a create cwd — the `+` cwd remainder or the `/new` argument — to the
 * path that must actually be sent. A relative path resolves against the current
 * Task cwd, `~` passes through for the server to expand, and the directory must
 * already exist. Shared so `+` and both `/new` entry points cannot diverge.
 */
export async function resolveCreateCwd(
  rawCwd: string,
): Promise<{ cwd: string } | { error: string }> {
  const base = state.taskCwd ?? "";
  let resolved: string;
  try {
    resolved = rawCwd === "" ? base : resolveViewPath(rawCwd, base || null);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (resolved === "") return { error: "No active task cwd" };
  resolved = tidyResolvedPath(resolved);
  try {
    const info = await api.getFileInfo(resolved);
    if (info.kind !== "dir") {
      return { error: `not a directory: '${rawCwd}'` };
    }
  } catch (err) {
    // Only a definite 404 is "missing". A permission denial, a 5xx, a network
    // failure, or the request timeout must not be reported as a missing
    // directory: surface the real reason so the user can act on it.
    if (err instanceof api.ApiError) {
      if (err.status === HTTP_STATUS.NOT_FOUND) {
        return { error: `directory not found: '${rawCwd}'` };
      }
      return { error: err.message };
    }
    const detail = err instanceof Error ? err.message : String(err);
    return { error: `could not check directory '${rawCwd}': ${detail}` };
  }
  return { cwd: resolved };
}

/**
 * Whether the Task a create command was submitted in no longer exists. Called
 * after the cwd probe so a source Task deleted while the probe was pending
 * cannot trigger the destructive create reset. Only a definite absence counts:
 * any other failure returns false, so a transient list error never blocks a
 * valid create.
 */
export async function isSourceTaskMissing(
  sourceTaskId: string | null,
): Promise<boolean> {
  if (!sourceTaskId) return false;
  try {
    const tasks = await loadTaskList();
    return !tasks.some((task) => task.id === sourceTaskId);
  } catch {
    return false;
  }
}
