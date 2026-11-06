// TEMPORARY WORKAROUND for one upstream defect. Not a feature.
//
// Upstream defect: Copilot's `image_generation` tool does not return an ACP
// image block. It returns text that names the file it wrote, so the picture
// never crosses ACP and the web client would have nothing to render.
//
// Measured evidence (2026-11, one real turn):
//   text:  "Image generated successfully.\n"
//          "image_id: sha256:<64 hex>\n"
//          "saved_to: /Users/<user>/.copilot/images/image-<id>.png"
//   file:  a real 2.49 MB PNG at that path (magic bytes PNG)
//   ACP:   no image content block on any `tool_call_update` for that call
//
// Retirement condition: when Copilot's image tool emits a real ACP image
// block, delete this file and its call site. Deleting it means exactly:
//   1. delete `src/agent-compatibility/copilot-image-path.ts`
//   2. delete the import of `recoverCopilotImagePath` **and** `toolResultText`
//      in `src/event-handler.ts` (they share one import line)
//   3. delete the one call to `recoverCopilotImagePath` in that file's
//      `tool_call_update` branch; `toolResultText` exists only to feed it
// Nothing else refers to either, and no barrel exists to update.
//
// Rules for anything that lands in `src/agent-compatibility/` (one directory
// for upstream-defect shims; no `index.ts` barrel until a second shim exists):
//   1. A shim is a plain function: ACP event data + context in, an optional
//      attachment out. The agent's name appears in its own file and nowhere
//      else in `src/`.
//   2. One shim, one call site.
//   3. The file header states the upstream defect, the evidence, and the
//      retirement condition.
//   4. No privilege growth: no config key, no path allowlist.
//   5. No protocol semantics rewritten: a shim may only recover what the agent
//      failed to send, never reinterpret a field the protocol defines.
//
// Trigger — all three must hold, otherwise the text is left exactly as received:
//   1. the tool result text contains `image_id: sha256:<64 hex>`
//   2. the same text contains `saved_to: <absolute path>`
//   3. the tool call's title is `image_generation`
//
// Capture rules — any failure is "do nothing" plus a log line; the tool call
// itself is never affected:
//   - the file's sha256 must equal the marker's hash (a mismatch is refused);
//   - its bytes must be a storable image container (PNG/JPEG/GIF/WebP);
//   - it must be at most `limits.image_upload` bytes;
//   - it is COPIED, never moved or deleted: the tool's own file stays;
//   - within one task, identical bytes are stored once (dedupe by content hash).

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { attachmentDescriptor, storeImageBytes } from "../agent-image.ts";
import { readImageInfo } from "../image-info.ts";
import { log } from "../log.ts";
import { classifyToolContentItem } from "../shared/tool-content.ts";
import type { Store } from "../store.ts";
import type { AgentImageAttachment, ToolContentItem } from "../types.ts";

const plog = log.scope("agent-compatibility");

/** The tool this shim exists for. */
const TOOL_TITLE = "image_generation";

const IMAGE_ID_MARKER = /image_id:\s*sha256:([0-9a-f]{64})/i;
const SAVED_TO_MARKER = /saved_to:\s*(\S+)/;

/**
 * The text a tool result carries, one line per item, empty items dropped.
 *
 * Only the shim's eligibility test reads it: whether the result text names a
 * file. It lives here, not in the normal image path, so deleting the shim also
 * removes its last caller and leaves no unused import behind.
 */
export function toolResultText(content: ToolContentItem[]): string {
  return content
    .map((item) => {
      const shape = classifyToolContentItem(item);
      return shape.kind === "content" ? shape.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export interface CopilotImagePathContext {
  store: Store;
  dataDir: string;
  taskId: string;
  /** The tool call whose result this is; its title decides eligibility. */
  toolCall: { id: string; title: string };
  /** The tool result's visible text. */
  text: string;
  /** `limits.image_upload`: the same ceiling every other image obeys. */
  limitBytes: number;
}

interface ImagePathMarker {
  sha256: string;
  path: string;
}

/** The two text markers, or null when either is missing or not absolute. */
function readMarker(text: string): ImagePathMarker | null {
  const idMatch = IMAGE_ID_MARKER.exec(text);
  const pathMatch = SAVED_TO_MARKER.exec(text);
  if (!idMatch || !pathMatch) return null;

  const path = pathMatch[1];
  if (!isAbsolute(path)) return null;
  return { sha256: idMatch[1].toLowerCase(), path };
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Why a marker did not become an image; logged, never surfaced. */
function ignore(reason: string, fields: Record<string, unknown>): null {
  plog.warn(reason, fields);
  return null;
}

export interface RecoveredImage {
  attachment: AgentImageAttachment;
  /** True only when this call inserted the attachment row. */
  inserted: boolean;
}

/**
 * Recover the image a Copilot `image_generation` result only names by path.
 *
 * Returns the descriptor together with whether this call inserted a new row,
 * or null when the three markers do not all hold or the file does not match
 * them. The caller appends the descriptor to the tool result's content and
 * invalidates the label cache only for a new row; this function never mutates
 * the ACP event.
 */
export function recoverCopilotImagePath(
  ctx: CopilotImagePathContext,
): RecoveredImage | null {
  const marker = readMarker(ctx.text);
  if (!marker) return null;

  const ownTitle = ctx.toolCall.title.trim();
  const title =
    ownTitle.length > 0
      ? ownTitle
      : (ctx.store.findToolCallTitle(ctx.taskId, ctx.toolCall.id)?.trim() ??
        "");
  if (title !== TOOL_TITLE) return null;

  const logFields = {
    taskId: ctx.taskId.slice(0, 8),
    path: marker.path,
    sha256: marker.sha256.slice(0, 12),
  };

  let size: number;
  try {
    const stats = statSync(marker.path);
    if (!stats.isFile()) return ignore("saved_to is not a file", logFields);
    size = stats.size;
  } catch (err) {
    return ignore("saved_to is unreadable", {
      ...logFields,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (size === 0) return ignore("saved_to is empty", logFields);
  if (size > ctx.limitBytes) {
    return ignore("saved_to is above the image limit", {
      ...logFields,
      bytes: size,
      limitBytes: ctx.limitBytes,
    });
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(marker.path);
  } catch (err) {
    return ignore("saved_to could not be read", {
      ...logFields,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (sha256Of(bytes) !== marker.sha256) {
    return ignore("saved_to does not match the marker's sha256", logFields);
  }
  // Never trust the extension or the marker: the container decides. The whole
  // file is read: a JPEG's frame header can sit past the first 4 KB behind a
  // large EXIF/ICC segment, and this parse has to agree with the one storage
  // does to the same bytes.
  if (!readImageInfo(bytes)) {
    return ignore("saved_to is not a storable image", logFields);
  }

  const duplicate = findStoredCopy(ctx, marker.sha256, bytes.length);
  if (duplicate) return { attachment: duplicate, inserted: false };

  const index = ctx.store.countAttachments(ctx.taskId, "image") + 1;
  const result = storeImageBytes({
    store: ctx.store,
    dataDir: ctx.dataDir,
    taskId: ctx.taskId,
    bytes,
    index,
    limitBytes: ctx.limitBytes,
    displayName: `generated-image-${index}`,
  });
  if ("omitted" in result) {
    return ignore("saved_to could not be stored", {
      ...logFields,
      reason: result.reason,
    });
  }
  return { attachment: result.stored, inserted: true };
}

/**
 * An attachment of this task whose bytes are identical, if one exists.
 *
 * Durable across restarts without a schema change: the candidate's sha256 is
 * already known, and only an equal-size attachment can be the same file, so a
 * size-filtered scan reads a handful of files instead of all of them.
 */
function findStoredCopy(
  ctx: CopilotImagePathContext,
  sha256: string,
  size: number,
): AgentImageAttachment | null {
  for (const row of ctx.store.listAttachmentsBySize(
    ctx.taskId,
    "image",
    size,
  )) {
    try {
      if (sha256Of(readFileSync(row.realpath)) === sha256) {
        return attachmentDescriptor(ctx.taskId, row);
      }
    } catch {
      // A vanished row is not a duplicate; keep looking.
    }
  }
  return null;
}
