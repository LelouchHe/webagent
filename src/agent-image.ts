// Store an image an agent returned inline as an ordinary attachment.
//
// An agent's picture is not special: it lands in the same
// `<data_dir>/tasks/<taskId>/attachments/<uuid>.<ext>` layout, gets the same
// `attachments` row, the same unsigned base path in the transcript, the same
// egress re-sign, and the same cleanup (the row by the task FK, the file with
// the task directory). Only the trigger differs — it arrives with the agent's
// stream instead of an upload request.
//
// Everything here is synchronous, and that is a requirement rather than an
// accident: the event pipeline has no per-task queue, so awaiting between
// receiving the block and writing the row would let a later text chunk flush
// ahead of the image and reorder the transcript.

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  classifyKind,
  mimeToExt,
  normalizeDisplayName,
  sniffImageMime,
} from "./attachments.ts";
import { readImageDimensions } from "./image-dimensions.ts";
import { log } from "./log.ts";
import type { AttachmentRow, Store } from "./store.ts";
import type { AgentImageAttachment } from "./types.ts";

const ilog = log.scope("agent-image");

/** Bytes claimed by a base64 payload, or null when it is not valid base64. */
export function decodedBase64Bytes(data: string): Buffer | null {
  const compact = data.replace(/\s+/g, "");
  if (compact.length === 0 || compact.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  return Buffer.from(compact, "base64");
}

/** Human megabyte label; `10 MB`, `12.3 MB`. */
function megabytes(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} MB`;
}

export interface StoreAgentImageInput {
  store: Store;
  dataDir: string;
  taskId: string;
  /** The ACP block's base64, exactly as received. */
  data: string;
  /** 1-based index within the task, for the default display name. */
  index: number;
  /** `limits.image_upload`: the same ceiling a user upload gets. */
  limitBytes: number;
}

/**
 * The byte-source entry to the same storage pipeline. An inline ACP block is
 * decoded to bytes first; a tool-result image producer may already hold bytes
 * (an image block's payload, or a file it read). Both then share one size
 * check, one content sniff, one write, one row, and one descriptor.
 */
export interface StoreImageBytesInput {
  store: Store;
  dataDir: string;
  taskId: string;
  bytes: Buffer;
  /** 1-based index within the task, for the default display name. */
  index: number;
  /** `limits.image_upload`: the same ceiling a user upload gets. */
  limitBytes: number;
  /** Defaults to `agent-image-<index>`. */
  displayName?: string;
}

export type StoreAgentImageResult =
  | { stored: AgentImageAttachment }
  /** Visible replacement text; the bytes are not stored and no row exists. */
  | { omitted: string; reason: string };

/**
 * The transcript reference for a stored image row: the shape `agent_image`
 * already uses, with the unsigned base path the egress re-signer recognizes.
 */
export function attachmentDescriptor(
  taskId: string,
  row: AttachmentRow,
): AgentImageAttachment {
  return {
    kind: "image",
    attachmentId: row.id,
    displayName: row.name,
    mimeType: row.mime,
    // Unsigned base path: the egress re-sign turns it into a usable URL.
    path: `/api/v1/tasks/${taskId}/attachments/${basename(row.realpath)}`,
    ...(row.width !== null && row.height !== null
      ? { width: row.width, height: row.height }
      : {}),
  };
}

/**
 * Store one inline agent image, or explain why it was not stored.
 *
 * A refusal is never silent: the caller writes the returned text into the
 * transcript, so a gap always has a reason next to it.
 */
export function storeAgentImage(
  input: StoreAgentImageInput,
): StoreAgentImageResult {
  const bytes = decodedBase64Bytes(input.data);
  if (!bytes || bytes.length === 0) {
    return omitted("empty payload");
  }
  return storeImageBytes({ ...input, bytes });
}

/**
 * Store image bytes as an ordinary attachment, or explain why not.
 *
 * Synchronous on purpose: the event pipeline has no per-task queue, so an
 * `await` between receiving the block and writing the row would let a later
 * text chunk flush ahead of the image and reorder the transcript.
 */
export function storeImageBytes(
  input: StoreImageBytesInput,
): StoreAgentImageResult {
  const { store, dataDir, taskId, index, limitBytes } = input;
  // Buffer is a Uint8Array subtype; accept any byte source the caller holds.
  const bytes = Buffer.isBuffer(input.bytes)
    ? input.bytes
    : Buffer.from(input.bytes);
  if (bytes.length === 0) {
    return omitted("empty payload");
  }
  if (bytes.length > limitBytes) {
    return omitted(
      `${megabytes(bytes.length)} > ${megabytes(limitBytes)} limit`,
    );
  }
  // Never trust the wire's mime: the container decides, and only containers we
  // can store and serve inline are accepted.
  const mime = sniffImageMime(bytes.subarray(0, 4096));
  if (!mime) {
    return omitted("unrecognized image format");
  }
  if (classifyKind(mime) !== "image") {
    return omitted("not an image");
  }

  const id = randomUUID();
  const ext = mimeToExt(mime);
  const dir = join(dataDir, "tasks", taskId, "attachments");
  const finalPath = join(dir, `${id}.${ext}`);
  const tmpPath = `${finalPath}.tmp`;
  let realpath: string;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmpPath, bytes);
    renameSync(tmpPath, finalPath);
    realpath = realpathSync(finalPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Nothing to clean up.
    }
    ilog.warn("could not store an agent image", {
      taskId: taskId.slice(0, 8),
      mime,
      bytes: bytes.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return omitted("could not be stored");
  }

  const dimensions = readImageDimensions(bytes);
  const displayName =
    normalizeDisplayName(input.displayName ?? `agent-image-${index}`) ??
    "image";
  try {
    store.insertAttachment({
      id,
      taskId,
      kind: "image",
      name: displayName,
      mime,
      size: bytes.length,
      realpath,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    });
  } catch (err) {
    ilog.warn("could not record a stored agent image", {
      taskId: taskId.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      unlinkSync(finalPath);
    } catch {
      // Nothing to clean up.
    }
    return omitted("could not be stored");
  }

  return {
    stored: {
      kind: "image",
      attachmentId: id,
      displayName,
      mimeType: mime,
      // Unsigned base path: the egress re-sign turns it into a usable URL.
      path: `/api/v1/tasks/${taskId}/attachments/${basename(finalPath)}`,
      ...(dimensions
        ? { width: dimensions.width, height: dimensions.height }
        : {}),
    },
  };
}

function omitted(reason: string): StoreAgentImageResult {
  return { omitted: `[image omitted: ${reason}]`, reason };
}
