import type { McpTaskHistoryRecord } from "./tools.ts";

const MAX_RECORD_TEXT = 800;
const MAX_TOOL_DETAIL = 400;

type JsonObject = Record<string, unknown>;

type CompactText = {
  text: string;
  truncated: boolean;
};

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function textValue(value: unknown): string {
  // Preserve message/code indentation; joinText only removes whitespace around
  // the final record envelope, never from the text itself.
  return stringValue(value) ?? "";
}

function clip(text: string, limit: number): CompactText {
  if (text.length <= limit) return { text, truncated: false };
  // Keep the ellipsis inside the stated limit, including its separating newline.
  return { text: `${text.slice(0, limit - 2)}\n…`, truncated: true };
}

function joinText(parts: Array<string | CompactText | undefined>): CompactText {
  const truncated = parts.some(
    (part): part is CompactText => isObject(part) && part.truncated === true,
  );
  const text = parts
    .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
    .filter(Boolean)
    .join("\n")
    .trim();
  const clipped = clip(text, MAX_RECORD_TEXT);
  return { text: clipped.text, truncated: truncated || clipped.truncated };
}

function prefixed(label: string, value: CompactText): CompactText {
  return { text: `${label}${value.text}`, truncated: value.truncated };
}

function toolContentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (!isObject(item)) return "";
      if (isObject(item.content)) return textValue(item.content.text);
      if (Array.isArray(item.content)) {
        return item.content
          .map((nested) => (isObject(nested) ? textValue(nested.text) : ""))
          .filter(Boolean)
          .join("");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolInputDetail(value: unknown): CompactText | undefined {
  if (!isObject(value)) return undefined;
  const command = textValue(value.command);
  if (command) return prefixed("$ ", clip(command, MAX_TOOL_DETAIL));
  const path = textValue(value.path);
  if (path) return prefixed("Path: ", clip(path, MAX_TOOL_DETAIL));
  return undefined;
}

function optionLabel(value: unknown): string {
  if (!isObject(value)) return "Unknown option";
  return (
    textValue(value.label) ||
    textValue(value.name) ||
    textValue(value.optionId) ||
    "Unknown option"
  );
}

function planText(entries: unknown): string | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  return entries
    .map((entry) => {
      if (!isObject(entry)) return "- Unknown plan item";
      const status = textValue(entry.status) || "pending";
      const content = textValue(entry.content) || "Untitled plan item";
      return `- [${status}] ${content}`;
    })
    .join("\n");
}

function malformedRecord(
  seq: number,
  type: string,
  createdAt: string,
  rawSize: number,
): McpTaskHistoryRecord {
  return {
    seq,
    type,
    createdAt,
    text: `Unreadable ${type} event; raw payload omitted.`,
    rawSize,
  };
}

/**
 * Produce a small deterministic, human-readable task-history record. Raw event
 * payloads stay in SQLite and are deliberately never embedded in the MCP
 * response: tool inputs and outputs commonly contain complete source files.
 */
// eslint-disable-next-line complexity -- maps the complete persisted event schema.
export function compactTaskHistoryRecord(record: {
  seq: number;
  type: string;
  data: string;
  createdAt: string;
}): McpTaskHistoryRecord | null {
  const rawSize = Buffer.byteLength(record.data, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(record.data) as unknown;
  } catch {
    return malformedRecord(record.seq, record.type, record.createdAt, rawSize);
  }
  if (!isObject(data)) {
    return malformedRecord(record.seq, record.type, record.createdAt, rawSize);
  }

  let result: CompactText | null;
  switch (record.type) {
    case "assistant_message":
      result = joinText([
        "Assistant:",
        textValue(data.text) || "(empty message)",
      ]);
      break;
    case "user_message": {
      const attachments = Array.isArray(data.attachments)
        ? `Attachments: ${data.attachments.length}`
        : undefined;
      result = joinText([
        "User:",
        textValue(data.text) || "(empty message)",
        attachments,
      ]);
      break;
    }
    case "tool_call": {
      const title = textValue(data.title) || "Unnamed tool";
      const kind = textValue(data.kind);
      result = joinText([
        `Tool started: ${title}${kind ? ` (${kind})` : ""}`,
        toolInputDetail(data.rawInput),
      ]);
      break;
    }
    case "tool_call_update": {
      const title =
        textValue(data.title) || textValue(data.kind) || "Unnamed tool";
      const status = textValue(data.status) || "updated";
      const content = toolContentText(data.content);
      result = joinText([
        `Tool ${status}: ${title}`,
        content
          ? prefixed("Result:\n", clip(content, MAX_TOOL_DETAIL))
          : undefined,
        toolInputDetail(data.rawInput),
      ]);
      break;
    }
    case "plan":
      result = joinText(["Plan:", planText(data.entries) ?? "(empty plan)"]);
      break;
    case "permission_request": {
      const options = Array.isArray(data.options)
        ? `Options: ${data.options.map(optionLabel).join(", ")}`
        : undefined;
      result = joinText([
        `Permission requested: ${textValue(data.title) || "Unnamed request"}`,
        options,
      ]);
      break;
    }
    case "permission_response":
      result = joinText([
        `Permission ${data.denied === true ? "denied" : "allowed"}: ${textValue(data.optionName) || "Unnamed option"}`,
      ]);
      break;
    case "prompt_done": {
      const stopReason = textValue(data.stopReason) || "unknown";
      // Normal completions add no collaboration information: workflowStatus
      // already communicates that the task is idle.
      if (stopReason === "end_turn") return null;
      result = joinText([`Turn finished: ${stopReason}`]);
      break;
    }
    case "error":
      result = joinText(["Error:", textValue(data.message) || "Unknown error"]);
      break;
    case "system_message": {
      const source =
        textValue(data.sourceLabel) || textValue(data.sourceTaskId);
      const target =
        textValue(data.targetLabel) || textValue(data.targetTaskId);
      const route = source && target ? ` (${source} → ${target})` : "";
      result = joinText([
        `Collaboration message${route}:`,
        textValue(data.body) || "(empty message)",
      ]);
      break;
    }
    case "task_update":
      result = joinText([
        `Task ${textValue(data.status) || "updated"}:`,
        textValue(data.body) || "(no details)",
      ]);
      break;
    case "message":
      result = joinText([
        `Message from ${textValue(data.from_label) || textValue(data.from_ref) || "unknown sender"}: ${textValue(data.title) || "Untitled"}`,
        textValue(data.body) || "(empty message)",
      ]);
      break;
    case "bash_command":
      result = joinText([
        "Shell command:",
        `$ ${textValue(data.command) || "(empty command)"}`,
      ]);
      break;
    case "bash_result": {
      const code =
        typeof data.code === "number" || typeof data.code === "string"
          ? String(data.code)
          : "unknown";
      const signal = textValue(data.signal);
      const output = textValue(data.output);
      result = joinText([
        `Shell finished: exit ${code}${signal ? `, signal ${signal}` : ""}`,
        output
          ? prefixed("Output:\n", clip(output, MAX_TOOL_DETAIL))
          : undefined,
      ]);
      break;
    }
    default:
      // New event types are not treated as noise: make their occurrence
      // visible without risking an arbitrary raw payload in agent context.
      return {
        seq: record.seq,
        type: record.type,
        createdAt: record.createdAt,
        text: `Unrecognized ${record.type} event; raw payload omitted.`,
        rawSize,
      };
  }

  return {
    seq: record.seq,
    type: record.type,
    createdAt: record.createdAt,
    text: result.text,
    ...(result.truncated ? { truncated: true, rawSize } : {}),
  };
}
