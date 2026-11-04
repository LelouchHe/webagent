/**
 * Shape judgment for a stored ACP tool_call_update content item.
 *
 * Keep this as a judgment, not a renderer: the MCP history projection and
 * frontend display paths must agree on which item families they understand.
 *
 * Stored representation only: the wire shape is recognized at ingest
 * (`src/tool-result-image.ts`) and never survives into a stored row.
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
 *
 * This app writes the descriptor; only `width`/`height` are optional.
 */
export function parseImageAttachment(
  raw: unknown,
): AgentImageAttachment | null {
  if (!isObject(raw)) return null;
  if (raw.kind !== "image") return null;
  if (typeof raw.attachmentId !== "string" || !raw.attachmentId) return null;
  if (typeof raw.path !== "string" || !raw.path) return null;
  if (typeof raw.mimeType !== "string" || !raw.mimeType) return null;
  return {
    kind: "image",
    attachmentId: raw.attachmentId,
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
 * The stored reference an image block carries: the bare block or the
 * `{ type: "content", content: <block> }` wrapper.
 */
function storedImageShape(value: JsonObject): ToolContentItemShape | null {
  if (value.type !== "image") return null;
  const attachment = parseImageAttachment(value.attachment);
  return attachment ? { kind: "image_attachment", attachment } : null;
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

  const directImage = storedImageShape(item);
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
    const wrappedImage = storedImageShape(item.content);
    if (wrappedImage) return wrappedImage;
    if (typeof item.content.text === "string") {
      return { kind: "content", text: item.content.text };
    }
  }

  // Text is a single block in `content.text`; anything else is unrecognized.
  return { kind: "unknown" };
}
