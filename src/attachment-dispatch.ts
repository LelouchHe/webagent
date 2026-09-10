import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isUpstreamImageMime } from "./attachments.ts";
import { isInsideTaskAttachments } from "./tasks-anchor.ts";
import type { Store } from "./store.ts";

/**
 * What the client sends per attachment in a prompt body. The server NEVER
 * trusts a client-supplied `uri`, `data`, or `path` — only the `attachmentId`
 * is used to look up the canonical row server-side. `displayName` /
 * `mimeType` are echoed back into the ACP block but a future hardening pass
 * could swap them with the row's stored values too.
 */
export interface AttachmentRef {
  kind: "image" | "file";
  attachmentId: string;
  displayName: string;
  mimeType: string;
}

export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      mimeType: string;
    };

/**
 * Caller-injected logger so the bridge can keep its own tagged log scope
 * without dispatcher pulling a hard dependency on it.
 */
export interface DispatchLogger {
  warn: (msg: string) => void;
}

const NOOP_LOGGER: DispatchLogger = { warn: () => {} };

/**
 * Builds the ACP prompt blocks for one client-supplied attachment. Returns
 * a fallback text block on any failure (DB miss, disk miss, anchor breach,
 * cross-task reference) so the prompt turn never gets stuck in a retry
 * loop just because one image vanished.
 *
 * Trust boundary (decision 10 in uploads-plan v2.6): client only supplies
 * `attachmentId`. Everything else (realpath, anchor, MIME for read) comes
 * from the server-side row — including whether the payload is an image and
 * whether its mime is one the upstream model accepts. A client cannot
 * change the wire format by mislabelling the attachment.
 */
export class AttachmentDispatcher {
  private readonly store: Store;
  private readonly tasksAnchor: string;
  private readonly logger: DispatchLogger;

  constructor(
    store: Store,
    tasksAnchor: string,
    logger: DispatchLogger = NOOP_LOGGER,
  ) {
    this.store = store;
    this.tasksAnchor = tasksAnchor;
    this.logger = logger;
  }

  async dispatch(taskId: string, ref: AttachmentRef): Promise<PromptBlock[]> {
    const fallback = (reason: string): PromptBlock[] => {
      this.logger.warn(
        `[attachments] dispatch fallback (${reason}) for ${taskId}/${ref.attachmentId}`,
      );
      return [
        {
          type: "text",
          text: `[attachment removed: ${ref.displayName}]`,
        },
      ];
    };

    // Reject any client trying to smuggle a uri / data / path. The shape
    // of AttachmentRef already forbids these statically; this guard is a
    // belt-and-suspenders for callers passing a wider object via `as any`.
    const wider = ref as unknown as Record<string, unknown>;
    if (
      typeof wider.uri === "string" ||
      typeof wider.data === "string" ||
      typeof wider.path === "string"
    ) {
      return fallback("client_supplied_external_field");
    }

    const row = this.store.getAttachment(taskId, ref.attachmentId);
    if (!row) return fallback("row_not_found");

    // Cross-task reference — the row exists but for a DIFFERENT task.
    // store.getAttachment scopes by task_id so this should already be
    // caught by row_not_found, but assert defensively.
    if (row.task_id !== taskId) {
      return fallback("cross_task");
    }

    // Anchor check on the stored realpath. If the file was moved out from
    // under us, or a future bug let an attacker inject a row with a path
    // outside TASKS_ANCHOR/<sid>/attachments/, we MUST refuse to dispatch
    // it as a `file://` URI — the agent would happily read it.
    let resolvedPath: string;
    try {
      resolvedPath = await realpath(row.realpath);
    } catch {
      return fallback("realpath_failed");
    }
    if (!isInsideTaskAttachments(this.tasksAnchor, taskId, resolvedPath)) {
      return fallback("path_outside_anchor");
    }

    // Storage truth, not the client's `ref.kind`: the browser guesses the
    // mime from the file extension / OS registry (renaming IMG_1040.HEIC to
    // .jpg makes it claim image/jpeg), while `row.kind` is what the sniff on
    // upload produced.
    if (row.kind === "image") {
      if (isUpstreamImageMime(row.mime)) {
        try {
          const buf = await readFile(resolvedPath);
          return [
            {
              type: "image",
              data: buf.toString("base64"),
              mimeType: row.mime,
            },
          ];
        } catch {
          return fallback("read_failed");
        }
      }

      // Image container the upstream model rejects (heic/heif/avif/bmp/
      // tiff and other `image/*` containers — note an SVG sniffs as text,
      // so it never reaches this branch). Sending it as an image block
      // poisons the session history: the provider 400s on every later turn
      // too. Degrade to a file link plus a hint instead.
      this.logger.warn(
        `[attachments] image downgraded to resource_link (mime=${row.mime}) for ${taskId}/${ref.attachmentId}`,
      );
      return [
        {
          type: "text",
          text: `[attachment ${row.name} (${row.mime}) cannot be read as an inline image by the model; convert it to png or jpeg to make it readable]`,
        },
        this.resourceLink(row, resolvedPath),
      ];
    }

    // kind === "file" → ACP resource_link with file:// URI built from the
    // realpath (NOT from any client-supplied string).
    return [this.resourceLink(row, resolvedPath)];
  }

  private resourceLink(
    row: { name: string; mime: string },
    resolvedPath: string,
  ): PromptBlock {
    return {
      type: "resource_link",
      uri: pathToFileURL(resolvedPath).toString(),
      name: row.name,
      mimeType: row.mime,
    };
  }
}
