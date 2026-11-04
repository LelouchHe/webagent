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
 * The whole item tree is walked, so no inline payload can survive past this
 * function into SQLite, `GET /events` or a live frame.
 *
 * Degrading is a placeholder, never a pass-through: a block that cannot be
 * stored becomes visible `[image omitted: …]` text, and a walk that fails
 * replaces the item it failed on the same way. The event itself is never lost —
 * the record matters more than the picture — but the bytes never ride along with
 * it.
 */
export function storeToolResultImages(
  ctx: ToolResultImageContext,
  content: ToolContentItem[],
): StoredToolResultImages {
  let index = 0;
  /** Image blocks seen: stored *or* degraded (a degradation writes a placeholder). */
  let processed = 0;
  /** Attachment rows inserted: the only thing a cached label map cares about. */
  let inserted = 0;

  /**
   * Store one inline payload and return what takes its place.
   *
   * Every failure ends in a placeholder, so this never throws and never hands a
   * payload back to the caller.
   */
  function store(data: string): ToolContentItem {
    processed++;
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
  // walk, because the walk is what removes payloads.
  try {
    index = ctx.store.countAttachments(ctx.taskId, "image");
  } catch (error) {
    warn("could not count stored images", ctx, error);
  }

  try {
    const rewritten = content.map((item) => {
      try {
        // Most items are text or a diff: nothing to rewrite, and copying their
        // containers buys nothing.
        return mayContainImageBlock(item) ? rewriteItem(item, store) : item;
      } catch (error) {
        // One item's rewrite must not cost its siblings: that item becomes a
        // placeholder and the rest are still normalized. Returning it as
        // received would put its payload into storage and the wire.
        warn("could not rewrite a tool result image", ctx, error);
        return placeholder(UNSTORABLE);
      }
    });
    return processed > 0
      ? { content: rewritten, inserted }
      : { content, inserted };
  } catch (error) {
    // Last resort: no item survives as received, because none of them can be
    // trusted to be payload-free once the walk itself failed.
    warn("could not walk tool result content", ctx, error);
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
 * Whether this item's tree can hold an image block at all.
 *
 * A cheap scan before the rewriting walk. Ordinary updates are text, diff or
 * terminal items, and copying every container of every item to find nothing was
 * measurable (100 text items: ~4µs → ~23µs per update). The scan visits
 * containers only — a block is itself a container, and only containers nest — so
 * it cannot miss one; it just does not copy.
 */
function mayContainImageBlock(item: unknown): boolean {
  if (!isRecord(item)) return false;
  const stack: Record<string, unknown>[] = [item];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (Array.isArray(node)) {
      for (const child of node) {
        if (isRecord(child)) stack.push(child);
      }
      continue;
    }
    if (node.type === "image") return true;
    for (const child of Object.values(node)) {
      if (isRecord(child)) stack.push(child);
    }
  }
  return false;
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
 * Replace every inline image block anywhere in one content item with its stored
 * descriptor.
 *
 * Every position is covered, because ACP allows an image block in more than one:
 * the item itself, a `{ type: "content", content: … }` wrapper, a wrapper's own
 * `_meta`, and a block's `_meta` — any key, any depth, arrays included. A
 * position the walk skipped would store a payload verbatim, which is the defect
 * this replaces.
 *
 * The walk is iterative: a legal deeply nested `_meta` (a few thousand
 * single-element arrays is a 4 KB message) must not overflow the host stack.
 * Containers are copied, never mutated, because the event data is agent-supplied
 * and may be shared with the caller's object; an item with no image stores
 * nothing, so `storeToolResultImages` returns the original array.
 */
function rewriteItem(
  item: ToolContentItem,
  store: (data: string) => ToolContentItem,
): ToolContentItem {
  const own = inlineImageData(item);
  if (own) return store(own);

  // A `content` wrapper is hoisted to the item: the stored representation is
  // the bare descriptor, so a stored row has one shape and not two. Any other
  // field on the wrapper is dropped with it, so nothing it held can leak.
  const wrapped = inlineImageData(item.content);
  if (wrapped) return store(wrapped);

  if (!isRecord(item)) return item;

  const root = copyContainer(item);
  const stack: Array<{
    source: Record<string, unknown>;
    target: Record<string, unknown>;
  }> = [{ source: item, target: root }];
  while (stack.length > 0) {
    const { source, target } = stack.pop()!;
    for (const [key, child] of Object.entries(source)) {
      const payload = inlineImageData(child);
      if (payload) {
        target[key] = store(payload);
      } else if (isRecord(child)) {
        const copy = copyContainer(child);
        target[key] = copy;
        stack.push({ source: child, target: copy });
      } else {
        target[key] = child;
      }
    }
  }
  return root;
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
