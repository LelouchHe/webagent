/**
 * Runtime shape judgment for ACP tool_call_update content items.
 *
 * Keep this as a judgment, not a renderer: the MCP history projection and
 * frontend display paths must agree on which item families they understand.
 */
export type ToolContentItemShape =
  | { kind: "terminal"; terminalId: string | undefined }
  | { kind: "content"; text: string }
  | {
      kind: "diff";
      path: string;
      oldText: string | null | undefined;
      newText: string;
    }
  | { kind: "unknown" };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Classify one raw ACP content item without coercing unknown shapes. */
export function classifyToolContentItem(item: unknown): ToolContentItemShape {
  if (!isObject(item)) return { kind: "unknown" };

  if (item.type === "terminal") {
    return {
      kind: "terminal",
      terminalId:
        typeof item.terminalId === "string" ? item.terminalId : undefined,
    };
  }

  if (
    item.type === "diff" &&
    typeof item.path === "string" &&
    typeof item.newText === "string" &&
    (item.oldText === undefined ||
      item.oldText === null ||
      typeof item.oldText === "string")
  ) {
    return {
      kind: "diff",
      path: item.path,
      oldText: item.oldText,
      newText: item.newText,
    };
  }

  if (isObject(item.content) && typeof item.content.text === "string") {
    return { kind: "content", text: item.content.text };
  }

  if (Array.isArray(item.content)) {
    const text: string[] = [];
    for (const part of item.content) {
      if (!isObject(part)) return { kind: "unknown" };
      if (part.text === undefined || part.text === null) continue;
      if (typeof part.text !== "string") return { kind: "unknown" };
      text.push(part.text);
    }
    return { kind: "content", text: text.join("") };
  }

  return { kind: "unknown" };
}
