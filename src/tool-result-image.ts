// Images inside an ACP tool result.
//
// ACP defines an image content block, and `tool_call_update.content` can carry
// one, so this is the normal path: a compliant agent that returns a picture
// from a tool sends it this way. Plain code, not an extension point.
//
// The block is stored through the same attachment pipeline an `agent_image`
// uses: the same `<dataDir>/tasks/<taskId>/attachments/<uuid>.<ext>` layout, the
// same `attachments` row, the same `limits.image_upload` ceiling, the same
// content sniff, the same unsigned base path + egress re-sign, and the same
// cleanup (the row by the task FK, the file with the task directory). In
// `content` the block is replaced by the descriptor an `agent_image` carries,
// so neither SQLite nor a client ever sees base64.
//
// Only the items a reader can render are persisted, rebuilt from exactly the
// fields it reads: an image block, a text block, a diff, a terminal. Any field
// we do not render cannot reach storage or a client.
//
// This file is the only place that sees base64.

import { decodedBase64Bytes, storeImageBytes } from "./agent-image.ts";
import { log } from "./log.ts";
import { classifyToolContentItem } from "./shared/tool-content.ts";
import type { Store } from "./store.ts";
import type { ToolContentItem } from "./types.ts";

const ilog = log.scope("tool-result-image");

export interface ToolResultImageContext {
  store: Store;
  /** Where task data lives; an image lands under `<dataDir>/tasks/<taskId>/`. */
  dataDir: string;
  taskId: string;
  /** `limits.image_upload`: the ceiling an image must stay under. */
  limitBytes: number;
}

export interface StoredToolResultImages {
  /** The content to persist and broadcast. */
  content: ToolContentItem[];
  /**
   * Attachment rows this call inserted — the only thing a cached
   * attachment-label map cares about. A refusal placeholder rewrites the block
   * but writes no row, so it reports 0.
   */
  inserted: number;
}

/**
 * Store every ACP image block in one tool result's content, in place.
 *
 * A block that cannot be stored becomes `[image omitted: …]` text: no path hands
 * a payload back, and the event is never lost. An update whose items were all
 * dropped keeps `content: []`.
 */
export function storeToolResultImages(
  ctx: ToolResultImageContext,
  content: ToolContentItem[],
): StoredToolResultImages {
  let index = 0;
  /** Attachment rows inserted: the only thing a cached label map cares about. */
  let inserted = 0;

  /** Store one inline payload and return what takes its place. */
  function store(data: string): ToolContentItem {
    try {
      const result = storeImageBytes({
        store: ctx.store,
        dataDir: ctx.dataDir,
        taskId: ctx.taskId,
        bytes: decodedBase64Bytes(data) ?? Buffer.alloc(0),
        index: ++index,
        limitBytes: ctx.limitBytes,
      });
      if ("stored" in result) {
        inserted++;
        return { type: "image", attachment: result.stored };
      }
      // A refused image becomes a placeholder; the payload is not stored.
      return placeholder(result.reason);
    } catch (error) {
      warn("could not store a tool result image", ctx, error);
      return placeholder(UNSTORABLE);
    }
  }

  // The count only names new files; its failure must not stop the rewrite.
  try {
    index = ctx.store.countAttachments(ctx.taskId, "image");
  } catch (error) {
    warn("could not count stored images", ctx, error);
  }

  try {
    const normalized = content.flatMap((item) => {
      try {
        const next = normalizeItem(item, store);
        return next === null ? [] : [next];
      } catch (error) {
        // One item's failure must not cost its siblings: it becomes a
        // placeholder.
        warn("could not normalize a tool result item", ctx, error);
        return [placeholder(UNSTORABLE)];
      }
    });
    return { content: normalized, inserted };
  } catch (error) {
    // Last resort: nothing survives as received.
    warn("could not rewrite tool result content", ctx, error);
    return {
      content: content.map(() => placeholder(UNSTORABLE)),
      inserted,
    };
  }
}

/** Why a block or an item could not be normalized; logged, never surfaced raw. */
const UNSTORABLE = "could not be stored";

/** The visible replacement for an image that will not be stored. */
function placeholder(reason: string): ToolContentItem {
  return {
    type: "content",
    content: { type: "text", text: `[image omitted: ${reason}]` },
  };
}

function warn(
  message: string,
  ctx: ToolResultImageContext,
  error: unknown,
): void {
  ilog.warn(message, {
    taskId: ctx.taskId.slice(0, 8),
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * The base64 an ACP image block still carries, or null when the value is not
 * one.
 *
 * This is the wire shape, and it is recognized in exactly two places, both in
 * this file: the ingest rewrite (store the bytes) and the `rawOutput` strip
 * (empty the bytes). Nothing past ingest sees a block this predicate accepts.
 */
function inlineImageData(value: unknown): string | null {
  if (!isRecord(value) || Array.isArray(value)) return null;
  if (value.type !== "image") return null;
  if (typeof value.data !== "string" || value.data.length === 0) return null;
  return value.data;
}

/**
 * Rebuild one tool result content item from the fields the renderer reads, or
 * drop it.
 *
 * Built, not trimmed: a field this function does not name cannot reach storage,
 * so no extension slot (`_meta`, `annotations`, anything a provider adds later)
 * has to be enumerated. An image block is the item itself or `item.content` (the
 * wrapper, hoisted to the bare descriptor so a stored row keeps one shape).
 */
function normalizeItem(
  item: ToolContentItem,
  store: (data: string) => ToolContentItem,
): ToolContentItem | null {
  const own = inlineImageData(item);
  if (own) return store(own);

  const wrapped = inlineImageData(item.content);
  if (wrapped) return store(wrapped);

  const shape = classifyToolContentItem(item);
  switch (shape.kind) {
    case "content":
      return { type: "content", content: { type: "text", text: shape.text } };
    case "diff":
      return {
        type: "diff",
        path: shape.path,
        oldText: shape.oldText,
        newText: shape.newText,
      };
    case "terminal":
      return { type: "terminal", terminalId: shape.terminalId };
    case "image_attachment":
      return { type: "image", attachment: shape.attachment };
    case "unknown":
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Drop every inline image payload from a tool update's `rawOutput`.
 *
 * `rawOutput` is forwarded as the agent sent it, so an agent that repeats the
 * tool's result there would put the same base64 into the live SSE frame —
 * `saveEvent` already omits the field, so the frame is its only egress. Only an
 * image block's own `data` is emptied; the block shape and every other field
 * stay exactly as received, and an image block's other fields (`_meta`
 * included) are still traversed, because an image can nest another one. The
 * walk is iterative: a deeply nested payload must not turn this into a stack
 * overflow.
 *
 * Object nodes are copied with a null prototype. A plain `{}` target would
 * interpret a JSON key named `__proto__` as a prototype setter and silently
 * drop the field; a null-prototype object keeps it as an ordinary own
 * property, so `JSON.stringify` still sees it.
 */
export function stripRawOutputImageData(rawOutput: unknown): unknown {
  if (!isRecord(rawOutput)) return rawOutput;

  const root = copyContainer(rawOutput);
  const stack: Array<{
    source: Record<string, unknown>;
    target: Record<string, unknown>;
    /** This node is an image block, so its own `data` is the payload. */
    image: boolean;
  }> = [
    {
      source: rawOutput,
      target: root,
      image: inlineImageData(rawOutput) !== null,
    },
  ];
  while (stack.length > 0) {
    const { source, target, image } = stack.pop()!;
    for (const [key, child] of Object.entries(source)) {
      if (image && key === "data") {
        target[key] = "";
      } else if (isRecord(child)) {
        const copy = copyContainer(child);
        target[key] = copy;
        stack.push({
          source: child,
          target: copy,
          image: inlineImageData(child) !== null,
        });
      } else {
        target[key] = child;
      }
    }
  }
  return root;
}

function copyContainer(
  value: Record<string, unknown>,
): Record<string, unknown> {
  // Arrays cannot carry a `__proto__` own key from JSON; objects must not
  // inherit the setter that would swallow it.
  return Array.isArray(value)
    ? ([] as unknown as Record<string, unknown>)
    : (Object.create(null) as Record<string, unknown>);
}
