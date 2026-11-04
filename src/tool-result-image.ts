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
// so neither SQLite nor a client ever sees base64. Every position inside an
// item is covered — the item itself, a `content` wrapper, a wrapper's or a
// block's `_meta`, at any depth — because a skipped position would store the
// payload verbatim.
//
// The walk is iterative and never throws out of this file: the event is the
// record, a picture inside it is incidental. A legal deeply nested `_meta` (a
// few thousand single-element arrays is a 4 KB message) must not cost the
// update, and a rewrite that fails degrades that item to a visible placeholder —
// the event survives, the payload does not.
//
// A refusal is never silent: an oversized block, a payload that is not a
// storable image container, or one that cannot be written becomes
// `[image omitted: …]` text in its place, with no file and no row.
//
// This file is the only place that sees base64. The wire shape is recognized
// here and nowhere else: past ingest there is exactly one representation, the
// descriptor `agent_image` also carries. A reader that has to ask "inline or
// stored?" would be a second representation, so no reader gets the choice —
// `src/shared/tool-content.ts` judges stored items only.

import { decodedBase64Bytes, storeImageBytes } from "./agent-image.ts";
import { log } from "./log.ts";
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
 * Only the protocol's content positions are read: the item itself when it is an
 * image block, and `item.content` (the `{ type: "content", content: … }`
 * wrapper). `_meta` is ACP's implementation-specific extension slot — arbitrary
 * JSON, never read by this app — so it is dropped rather than walked: an opaque
 * field is not persisted, and a payload inside it cannot reach a client.
 *
 * Degrading is a placeholder, never a pass-through: a block that cannot be
 * stored becomes visible `[image omitted: …]` text, and an item that cannot be
 * normalized is replaced the same way. The event itself is never lost.
 */
export function storeToolResultImages(
  ctx: ToolResultImageContext,
  content: ToolContentItem[],
): StoredToolResultImages {
  let index = 0;
  /** Attachment rows inserted: the only thing a cached label map cares about. */
  let inserted = 0;

  /**
   * Store one inline payload and return what takes its place.
   *
   * Every failure ends in a placeholder, so this never throws and never hands a
   * payload back to the caller.
   */
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
      // A refused image is still part of the result: the placeholder keeps a
      // reason where the picture was, and the payload never reaches storage.
      return placeholder(result.reason);
    } catch (error) {
      warn("could not store a tool result image", ctx, error);
      return placeholder(UNSTORABLE);
    }
  }

  // The attachment count only names new files; a failure there must not stop the
  // rewrite, because the rewrite is what removes payloads.
  try {
    index = ctx.store.countAttachments(ctx.taskId, "image");
  } catch (error) {
    warn("could not count stored images", ctx, error);
  }

  try {
    const rewritten = content.map((item) => {
      try {
        return normalizeItem(item, store);
      } catch (error) {
        // One item's failure must not cost its siblings, and returning it as
        // received would put its payload into storage and the wire.
        warn("could not normalize a tool result item", ctx, error);
        return placeholder(UNSTORABLE);
      }
    });
    // An item that was rewritten, degraded or stripped is a new object; when
    // none changed, the caller keeps the array it passed in.
    const changed = rewritten.some((item, at) => item !== content[at]);
    return changed ? { content: rewritten, inserted } : { content, inserted };
  } catch (error) {
    // Last resort: no item survives as received, because none of them can be
    // trusted to be payload-free once the rewrite itself failed.
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
 * Normalize one tool result content item.
 *
 * Two protocol positions can hold an image: the item itself, and `item.content`
 * — the `{ type: "content", content: … }` wrapper, which is hoisted to the bare
 * descriptor so a stored row keeps one shape. Nothing else is read or rewritten.
 *
 * `_meta` is dropped from both levels instead: ACP defines it as
 * implementation-specific metadata (arbitrary JSON, never read here), so it is
 * not persisted. Dropping it is also what makes "no inline payload past ingest"
 * true for that slot without walking it. An item with neither an image nor a
 * `_meta` slot is returned as the same object.
 */
function normalizeItem(
  item: ToolContentItem,
  store: (data: string) => ToolContentItem,
): ToolContentItem {
  const own = inlineImageData(item);
  if (own) return store(own);

  const wrapped = inlineImageData(item.content);
  if (wrapped) return store(wrapped);

  if (!isRecord(item)) return item;
  return dropMeta(item);
}

/** A copy of one container without its `_meta` slot. */
function withoutMeta(node: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...node };
  delete copy._meta;
  return copy;
}

/** Drop `_meta` from the item and from its `content` wrapper, if either has it. */
function dropMeta(item: Record<string, unknown>): ToolContentItem {
  const content = item.content;
  const contentIsObject = isRecord(content) && !Array.isArray(content);
  const contentHasMeta = contentIsObject && Object.hasOwn(content, "_meta");
  if (!Object.hasOwn(item, "_meta") && !contentHasMeta) return item;

  const copy = withoutMeta(item);
  if (contentHasMeta) copy.content = withoutMeta(content);
  return copy;
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
