const MAX_TEXT_CHARS = 200;
const MATCH_WINDOW_RADIUS = 100;

export type JsonObject = Record<string, unknown>;

export interface McpTaskHistoryRow {
  seq: number;
  type: string;
  bytes: number;
  group?: string;
  title?: string;
  field?: string;
  text?: string;
  unprojected?: true;
}

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

  let start = Math.max(0, match - MATCH_WINDOW_RADIUS);
  let end = Math.min(chars.length, match + needle.length + MATCH_WINDOW_RADIUS);
  // Keep the match and as much context as possible inside the same 200-code
  // point envelope used by ordinary projections.
  if (end - start > MAX_TEXT_CHARS) {
    const desiredStart = Math.max(0, match - MATCH_WINDOW_RADIUS);
    start = desiredStart;
    end = Math.min(chars.length, start + MAX_TEXT_CHARS);
    if (end - start < MAX_TEXT_CHARS) {
      start = Math.max(0, end - MAX_TEXT_CHARS);
    }
  }
  const prefix = start > 0 ? "…" : "";
  const suffix = end < chars.length ? "…" : "";
  const available = MAX_TEXT_CHARS - Array.from(prefix + suffix).length;
  let body = chars.slice(start, end).join("");
  if (Array.from(body).length > available) {
    body = Array.from(body).slice(0, available).join("");
  }
  return `${prefix}${body}${suffix}`;
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

function contentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    if (isObject(item.content)) {
      const text = stringValue(item.content.text);
      if (text) parts.push(text);
    } else if (typeof item.text === "string" && item.text) {
      parts.push(item.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
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
): { title?: string; text?: string; field?: string } {
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
      const text = contentText(data.content);
      return text
        ? { title, text, field: "content[]" }
        : { title, text: stringField(data.status), field: "status" };
    }
    case "system_message":
    case "message":
      return { title, text: stringField(data.body), field: "body" };
    case "error":
      return { title, text: stringField(data.message), field: "message" };
    case "task_update":
      return { title, text: stringField(data.body), field: "body" };
    case "task_cancel":
      return { title, text: stringField(data.reason), field: "reason" };
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
): McpTaskHistoryRow {
  const bytes = Buffer.byteLength(record.data, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(record.data) as unknown;
  } catch {
    return { seq: record.seq, type: record.type, bytes };
  }
  const row: McpTaskHistoryRow = { seq: record.seq, type: record.type, bytes };
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
  queryBytes: 256 * 1024,
  readBytes: 4 * 1024 * 1024,
  readSeqs: 100,
} as const;
