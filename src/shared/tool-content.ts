/**
 * Runtime shape judgment for ACP tool_call_update content items.
 *
 * Keep this as a judgment, not a renderer: the MCP history projection and
 * frontend display paths must agree on which item families they understand.
 */
import type { AgentImageAttachment } from "../types.ts";

export type ToolContentItemShape =
  | { kind: "terminal"; terminalId: string | undefined }
  | { kind: "content"; text: string }
  | {
      kind: "diff";
      path: string;
      oldText: string | null | undefined;
      newText: string;
    }
  /** An inline image block as it arrived on the wire, still carrying base64. */
  | { kind: "image"; mimeType: string; data: string }
  /** A stored image, referenced by the same descriptor `agent_image` uses. */
  | { kind: "image_attachment"; attachment: AgentImageAttachment }
  | { kind: "unknown" };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The stored image reference inside a payload of unknown shape, or null.
 *
 * Shared by the classifier (server and frontend) and the renderer, so a
 * reference accepted on the way in is exactly the one rendered on the way out.
 */
export function parseImageAttachment(
  raw: unknown,
): AgentImageAttachment | null {
  if (!isObject(raw)) return null;
  if (raw.kind !== "image") return null;
  if (typeof raw.path !== "string" || !raw.path) return null;
  if (typeof raw.mimeType !== "string" || !raw.mimeType) return null;
  return {
    kind: "image",
    attachmentId: typeof raw.attachmentId === "string" ? raw.attachmentId : "",
    displayName:
      typeof raw.displayName === "string" && raw.displayName
        ? raw.displayName
        : "agent image",
    mimeType: raw.mimeType,
    path: raw.path,
    width: typeof raw.width === "number" ? raw.width : null,
    height: typeof raw.height === "number" ? raw.height : null,
  };
}

/**
 * An ACP image block, either still carrying its base64 or already replaced by
 * a stored reference. Accepts both ACP shapes a tool result can use: the bare
 * block and the `{ type: "content", content: <block> }` wrapper.
 */
function imageShape(value: JsonObject): ToolContentItemShape | null {
  if (value.type !== "image") return null;
  const attachment = parseImageAttachment(value.attachment);
  if (attachment) return { kind: "image_attachment", attachment };
  if (typeof value.data === "string" && value.data.length > 0) {
    return {
      kind: "image",
      mimeType: typeof value.mimeType === "string" ? value.mimeType : "",
      data: value.data,
    };
  }
  return null;
}

function diffShape(item: JsonObject): ToolContentItemShape | null {
  if (
    item.type !== "diff" ||
    typeof item.path !== "string" ||
    typeof item.newText !== "string"
  ) {
    return null;
  }
  if (
    item.oldText !== undefined &&
    item.oldText !== null &&
    typeof item.oldText !== "string"
  ) {
    return null;
  }
  return {
    kind: "diff",
    path: item.path,
    oldText: item.oldText,
    newText: item.newText,
  };
}

/** Classify one raw ACP content item without coercing unknown shapes. */
export function classifyToolContentItem(item: unknown): ToolContentItemShape {
  if (!isObject(item)) return { kind: "unknown" };

  const directImage = imageShape(item);
  if (directImage) return directImage;

  if (item.type === "terminal") {
    return {
      kind: "terminal",
      terminalId:
        typeof item.terminalId === "string" ? item.terminalId : undefined,
    };
  }

  const diff = diffShape(item);
  if (diff) return diff;

  if (isObject(item.content)) {
    const wrappedImage = imageShape(item.content);
    if (wrappedImage) return wrappedImage;
    if (typeof item.content.text === "string") {
      return { kind: "content", text: item.content.text };
    }
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

  // A bare text block is a recognized shape: the projection this classifier
  // replaced accepted it, so dropping it here would be a coverage regression.
  if (typeof item.text === "string" && item.text) {
    return { kind: "content", text: item.text };
  }

  return { kind: "unknown" };
}
