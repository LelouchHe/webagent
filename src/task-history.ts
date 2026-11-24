import { classifyToolContentItem } from "./shared/tool-content.ts";
import type { TaskHistoryRow } from "./api/tasks.ts";

const MAX_TEXT_CHARS = 200;
const MATCH_WINDOW_RADIUS = 100;

export type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asciiFold(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    result += String.fromCodePoint(
      code >= 0x41 && code <= 0x5a ? code + 0x20 : code,
    );
  }
  return result;
}

function truncate(text: string, limit = MAX_TEXT_CHARS): string {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  return `${chars.slice(0, limit - 1).join("")}…`;
}

function windowAround(text: string, query: string): string {
  const chars = Array.from(text);
  const folded = chars.map((char) => asciiFold(char));
  const needle = Array.from(asciiFold(query));
  let match = -1;
  outer: for (let i = 0; i <= folded.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (folded[i + j] !== needle[j]) continue outer;
    }
    match = i;
    break;
  }
  if (match < 0) return truncate(text);
  if (chars.length <= MAX_TEXT_CHARS) return text;

  // Reserve the complete match before allocating the remaining budget to
  // context. The query schema caps the needle at 128 code points, so this
  // always has room for the match and both possible ellipses.
  const prefixNeeded = match > 0 ? 1 : 0;
  const suffixNeeded = match + needle.length < chars.length ? 1 : 0;
  const contextBudget =
    MAX_TEXT_CHARS - prefixNeeded - suffixNeeded - needle.length;
  let left = Math.min(MATCH_WINDOW_RADIUS, match);
  let right = Math.min(
    MATCH_WINDOW_RADIUS,
    chars.length - match - needle.length,
  );
  left = Math.min(left, Math.floor(contextBudget / 2));
  right = Math.min(right, contextBudget - left);
  // If one side is near a boundary, use its unused share on the other side.
  const spare = contextBudget - left - right;
  left = Math.min(MATCH_WINDOW_RADIUS, match, left + spare);
  right = Math.min(
    MATCH_WINDOW_RADIUS,
    chars.length - match - needle.length,
    right + (contextBudget - left - right),
  );

  const start = match - left;
  const end = match + needle.length + right;
  const prefix = start > 0 ? "…" : "";
  const suffix = end < chars.length ? "…" : "";
  return `${prefix}${chars.slice(start, end).join("")}${suffix}`;
}

function pathForKey(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function visitStringLeaves(
  value: unknown,
  path: string,
  visit: (text: string, path: string) => boolean,
): boolean {
  if (typeof value === "string") return visit(value, path);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (visitStringLeaves(value[i], `${path}[${i}]`, visit)) return true;
    }
    return false;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (visitStringLeaves(child, pathForKey(path, key), visit)) return true;
    }
  }
  return false;
}

function findMatch(
  data: unknown,
  query: string,
): { text: string; field: string } | undefined {
  let result: { text: string; field: string } | undefined;
  visitStringLeaves(data, "", (text, field) => {
    const foldedText = asciiFold(text);
    if (foldedText.includes(asciiFold(query))) {
      result = { text: windowAround(text, query), field };
      return true;
    }
    return false;
  });
  return result;
}

type ToolContentProjection =
  | { kind: "none" }
  | { kind: "content"; text: string; field: string; unrecognized: boolean }
  | { kind: "diff"; path: string; field: string; unrecognized: boolean }
  | { kind: "unknown" };

function projectToolContent(value: unknown): ToolContentProjection {
  if (!Array.isArray(value)) return { kind: "none" };
  if (value.length === 0) return { kind: "none" };

  const shapes = value.map(classifyToolContentItem);
  const hasRecognized = shapes.some((shape) => shape.kind !== "unknown");
  if (!hasRecognized) return { kind: "unknown" };

  // An unrecognized item is reported, never swallowed — but it must not cost a
  // recognized sibling its text, so the shape is marked rather than the row
  // erased.
  const unrecognized = shapes.some((shape) => shape.kind === "unknown");

  const diffs = shapes.flatMap((shape, index) =>
    shape.kind === "diff" ? [{ index, path: shape.path }] : [],
  );
  if (diffs.length > 0) {
    return {
      kind: "diff",
      path: diffs.map((diff) => diff.path).join("\n"),
      field: `content[${diffs[0].index}].path`,
      unrecognized,
    };
  }

  return {
    kind: "content",
    // Empty contributions are dropped rather than joined: an unrecognized
    // sibling must not leave a stray separator behind.
    text: shapes
      .map((shape) => {
        if (shape.kind === "terminal")
          return `[terminal ${shape.terminalId ?? "undefined"}]`;
        // A stored image is a reference, not text: name it so the projection is
        // not silently empty, and never echo a path or payload. An inline block
        // that never became an attachment is not a picture to a reader: it is
        // `unknown` below, which marks the row without echoing its payload.
        if (shape.kind === "image_attachment") {
          return "[image]";
        }
        return shape.kind === "content" ? shape.text : "";
      })
      .filter(Boolean)
      .join("\n"),
    field: shapes.every((shape) => shape.kind === "terminal")
      ? "content[0].terminalId"
      : "content[]",
    unrecognized,
  };
}

function stringArrayText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return parts.length > 0 ? parts.join("\n") : undefined;
}

// eslint-disable-next-line complexity -- maps the documented event projection table.
function projected(
  data: unknown,
  type: string,
): {
  title?: string;
  text?: string;
  field?: string;
  content_shape?: "unknown";
} {
  if (!isObject(data)) return {};
  const title = [
    "tool_call",
    "permission_request",
    "system_message",
    "message",
  ].includes(type)
    ? stringField(data.title)
    : undefined;
  switch (type) {
    case "user_message":
    case "assistant_message":
    case "thinking":
    case "collaboration_prompt":
      return { title, text: stringField(data.text), field: "text" };
    case "tool_call": {
      const raw = isObject(data.rawInput) ? data.rawInput : undefined;
      if (!raw) return { title };
      for (const key of [
        "command",
        "path",
        "content",
        "queries",
        "url",
        "urls",
        "findText",
      ]) {
        const value = raw[key];
        const text =
          typeof value === "string"
            ? stringValue(value)
            : stringArrayText(value);
        if (text)
          return {
            title,
            text,
            field: `rawInput.${key}${Array.isArray(value) ? "[]" : ""}`,
          };
      }
      return { title };
    }
    case "tool_call_update": {
      const content = projectToolContent(data.content);
      const mark =
        (content.kind === "content" || content.kind === "diff") &&
        content.unrecognized
          ? { content_shape: "unknown" as const }
          : {};
      if (content.kind === "content" && content.text) {
        return { title, text: content.text, field: content.field, ...mark };
      }
      if (content.kind === "diff") {
        return { title, text: content.path, field: content.field, ...mark };
      }
      if (content.kind === "unknown") {
        return { title, content_shape: "unknown" };
      }
      return { title, text: stringField(data.status), field: "status" };
    }
    case "agent_image":
      // The stored row carries a descriptor, never a payload. A visible marker
      // keeps the image from projecting as an empty row.
      return { title, text: "[image]", field: "attachment" };
    case "system_message":
    case "message":
      return { title, text: stringField(data.body), field: "body" };
    case "error":
      return { title, text: stringField(data.message), field: "message" };
    case "task_update":
      return { title, text: stringField(data.body), field: "body" };
    case "bash_command":
      return { title, text: stringField(data.command), field: "command" };
    case "prompt_done":
      return { title, text: stringField(data.stopReason), field: "stopReason" };
    default:
      return { title };
  }
}

export function projectTaskHistoryRow(
  record: { seq: number; type: string; data: string },
  query?: string,
): TaskHistoryRow {
  const bytes = Buffer.byteLength(record.data, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(record.data) as unknown;
  } catch {
    return { seq: record.seq, type: record.type, bytes };
  }
  const row: TaskHistoryRow = { seq: record.seq, type: record.type, bytes };
  if (isObject(data)) {
    if (record.type === "tool_call" || record.type === "tool_call_update") {
      if (typeof data.id === "string") row.group = data.id;
    } else if (
      record.type === "permission_request" &&
      typeof data.toolCallId === "string"
    ) {
      row.group = data.toolCallId;
    }
  }
  const projection = projected(data, record.type);
  if (projection.title !== undefined) row.title = truncate(projection.title);
  if (projection.content_shape !== undefined)
    row.content_shape = projection.content_shape;
  if (query !== undefined) {
    const match = findMatch(data, query);
    if (!match) return row;
    row.field = match.field;
    row.text = match.text;
    if (projection.text === undefined) row.unprojected = true;
    return row;
  }
  if (projection.text !== undefined && projection.field !== undefined) {
    row.field = projection.field;
    row.text = truncate(projection.text);
  }
  return row;
}

export function parseTaskHistoryData(data: string): unknown {
  return JSON.parse(data) as unknown;
}

export const TASK_HISTORY_LIMITS = {
  maxTextChars: MAX_TEXT_CHARS,
  matchWindowRadius: MATCH_WINDOW_RADIUS,
  /**
   * One index page is a decision aid, not a corpus. At ~250-300 bytes per row
   * this is ~85 rows: more than the recommended 50-row window, still a screen
   * rather than a transcript (~6k ASCII / ~8k CJK tokens).
   */
  queryBytes: 24 * 1024,
  /**
   * A batch pull of raw rows the caller already sized from the index. Bounded
   * so `seqs` filled with many large rows is refused instead of absorbed.
   */
  readBytes: 128 * 1024,
  /**
   * Single-row exemption (batch size is not exempt from this): keeps one
   * legitimate event readable instead of permanently blocked, with ~4x margin
   * over the largest payload observed in the dogfood database (258 KB).
   */
  readSingleBytes: 1024 * 1024,
  readSeqs: 100,
} as const;

export interface CanonicalTaskHistoryEvent {
  task_id: string;
  seq: number;
  type: string;
  created_at: string;
  from_ref: string;
  data: string;
}

export function normalizeTaskHistoryRange(
  range: [number, number] | undefined,
  maxSeq: number,
): [number, number] {
  if (maxSeq < 1) return [1, 0];
  const resolveIndex = (value: number) =>
    value < 0 ? maxSeq + value + 1 : value;
  const clamp = (value: number) => Math.min(maxSeq, Math.max(1, value));
  const a = clamp(resolveIndex(range?.[0] ?? 1));
  const b = clamp(resolveIndex(range?.[1] ?? maxSeq));
  return a <= b ? [a, b] : [b, a];
}

function taskHistoryTooLarge(
  value: unknown,
  limitBytes: number,
  extra: Record<string, unknown>,
): never {
  throw new Error(
    JSON.stringify({
      error: "response_too_large",
      required_bytes: Buffer.byteLength(JSON.stringify(value), "utf8"),
      limit_bytes: limitBytes,
      ...extra,
    }),
  );
}

export function buildTaskHistoryQuery(input: {
  taskId: string;
  events: readonly CanonicalTaskHistoryEvent[];
  maxSeq: number;
  range?: [number, number];
  text?: string;
}): import("./api/tasks.ts").TaskQueryResult {
  const [start, end] = normalizeTaskHistoryRange(input.range, input.maxSeq);
  const result = {
    task_id: input.taskId,
    max_seq: input.maxSeq,
    rows: input.events
      .filter((event) => event.seq >= start && event.seq <= end)
      .map((event) => projectTaskHistoryRow(event, input.text))
      .filter((row) => input.text === undefined || row.field !== undefined),
  };
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") >
    TASK_HISTORY_LIMITS.queryBytes
  ) {
    taskHistoryTooLarge(result, TASK_HISTORY_LIMITS.queryBytes, {
      max_seq: input.maxSeq,
      hint: { range: [-Math.min(50, input.maxSeq), -1] },
    });
  }
  return result;
}

export function uniqueTaskHistorySeqs(seqs: readonly number[]): number[] {
  const uniqueSeqs = [...new Set(seqs)].sort((a, b) => a - b);
  if (
    uniqueSeqs.length > TASK_HISTORY_LIMITS.readSeqs &&
    uniqueSeqs.length !== 1
  ) {
    throw new Error(
      `too_many_seqs: maximum is ${TASK_HISTORY_LIMITS.readSeqs}`,
    );
  }
  return uniqueSeqs;
}

export function buildTaskHistoryRead(input: {
  taskId: string;
  events: readonly CanonicalTaskHistoryEvent[];
  seqs: readonly number[];
}): import("./api/tasks.ts").TaskReadResult {
  const uniqueSeqs = uniqueTaskHistorySeqs(input.seqs);
  const bySeq = new Map(input.events.map((event) => [event.seq, event]));
  const missing = uniqueSeqs.filter((seq) => !bySeq.has(seq));
  if (missing.length > 0) {
    throw new Error(JSON.stringify({ error: "unknown_seq", missing }));
  }
  const result = {
    task_id: input.taskId,
    rows: uniqueSeqs.map((seq) => {
      const event = bySeq.get(seq)!;
      return {
        seq: event.seq,
        type: event.type,
        at: event.created_at,
        from: event.from_ref,
        data: parseTaskHistoryData(event.data),
      };
    }),
  };
  const limit =
    uniqueSeqs.length === 1
      ? TASK_HISTORY_LIMITS.readSingleBytes
      : TASK_HISTORY_LIMITS.readBytes;
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > limit) {
    taskHistoryTooLarge(result, limit, { seqs: uniqueSeqs });
  }
  return result;
}
