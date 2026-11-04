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
import type { Store } from "./store.ts";
import type { ToolContentItem } from "./types.ts";

export interface ToolResultImageContext {
  store: Store;
  /** Where task data lives; an image lands under `<dataDir>/tasks/<taskId>/`. */
  dataDir: string;
  taskId: string;
  /** `limits.image_upload`: the ceiling an image must stay under. */
  limitBytes: number;
}

/**
 * Store every ACP image block in one tool result's content, in place.
 *
 * Returns the rewritten content: the same array when there was no image, and a
 * new one otherwise. Callers persist and broadcast the result, so no inline
 * payload can survive past this function.
 */
export function storeToolResultImages(
  ctx: ToolResultImageContext,
  content: ToolContentItem[],
): ToolContentItem[] {
  let index = ctx.store.countAttachments(ctx.taskId, "image");
  let images = 0;

  /** Store one inline payload and return what takes its place. */
  function store(data: string): ToolContentItem {
    images++;
    const result = storeImageBytes({
      store: ctx.store,
      dataDir: ctx.dataDir,
      taskId: ctx.taskId,
      bytes: decodedBase64Bytes(data) ?? Buffer.alloc(0),
      index: ++index,
      limitBytes: ctx.limitBytes,
    });
    if ("stored" in result) {
      return { type: "image", attachment: result.stored };
    }
    // A refused image is still part of the result: the placeholder keeps a
    // reason where the picture was, and the payload never reaches storage.
    return {
      type: "content",
      content: { type: "text", text: result.omitted },
    };
  }

  const rewritten = content.map((item) => rewriteItem(item, store));
  return images > 0 ? rewritten : content;
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
 * An item with the extension-metadata slot ACP allows on a content block. The
 * slot is not part of `ToolContentItem` because nothing else reads it: only
 * ingest has to, so a nested payload cannot survive into storage.
 */
type ContentItemWithMeta = ToolContentItem & { _meta?: unknown };

/**
 * Replace every inline image block in one content item with its stored
 * descriptor.
 *
 * The positions an image block can occupy inside an item: the item itself, the
 * `{ type: "content", content: … }` wrapper, and — because a block may carry
 * extension metadata holding another block — anywhere inside `_meta`. An item
 * with no image stores nothing, so `storeToolResultImages` returns the original
 * array and "nothing to store" stays observable to the caller.
 */
function rewriteItem(
  item: ToolContentItem,
  store: (data: string) => ToolContentItem,
): ToolContentItem {
  const own = inlineImageData(item);
  if (own) return store(own);

  const wrapped = inlineImageData(item.content);
  if (wrapped) return store(wrapped);

  const meta = (item as ContentItemWithMeta)._meta;
  if (meta === undefined) return item;
  return {
    ...item,
    _meta: rewriteMetaImages(meta, store),
  } as ContentItemWithMeta;
}

/**
 * Rewrite image blocks anywhere in a `_meta` subtree.
 *
 * Containers are copied, never mutated: `_meta` is agent-supplied and may be
 * shared with the caller's object.
 */
function rewriteMetaImages(
  node: unknown,
  store: (data: string) => ToolContentItem,
): unknown {
  const own = inlineImageData(node);
  if (own) return store(own);
  if (Array.isArray(node)) {
    return node.map((child) => rewriteMetaImages(child, store));
  }
  if (!isRecord(node)) return node;
  // `Object.create(null)`: a JSON key named `__proto__` must stay an ordinary
  // own property instead of running the prototype setter.
  const next = copyContainer(node);
  for (const [key, child] of Object.entries(node)) {
    next[key] = rewriteMetaImages(child, store);
  }
  return next;
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
