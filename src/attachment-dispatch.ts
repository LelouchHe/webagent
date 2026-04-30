import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isInsideSessionAttachments } from "./sessions-anchor.ts";
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
 * Builds the ACP prompt block for one client-supplied attachment. Returns
 * a fallback text block on any failure (DB miss, disk miss, anchor breach,
 * cross-session reference) so the prompt turn never gets stuck in a retry
 * loop just because one image vanished.
 *
 * Trust boundary (decision 10 in uploads-plan v2.6): client only supplies
 * `attachmentId`. Everything else (realpath, anchor, MIME for read) comes
 * from the server-side row.
 */
export class AttachmentDispatcher {
  private readonly store: Store;
  private readonly sessionsAnchor: string;
  private readonly logger: DispatchLogger;

  constructor(
    store: Store,
    sessionsAnchor: string,
    logger: DispatchLogger = NOOP_LOGGER,
  ) {
    this.store = store;
    this.sessionsAnchor = sessionsAnchor;
    this.logger = logger;
  }

  async dispatch(sessionId: string, ref: AttachmentRef): Promise<PromptBlock> {
    const fallback = (reason: string): PromptBlock => {
      this.logger.warn(
        `[attachments] dispatch fallback (${reason}) for ${sessionId}/${ref.attachmentId}`,
      );
      return {
        type: "text",
        text: `[attachment removed: ${ref.displayName}]`,
      };
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

    const row = this.store.getAttachment(sessionId, ref.attachmentId);
    if (!row) return fallback("row_not_found");

    // Cross-session reference — the row exists but for a DIFFERENT session.
    // store.getAttachment scopes by session_id so this should already be
    // caught by row_not_found, but assert defensively.
    if (row.session_id !== sessionId) {
      return fallback("cross_session");
    }

    // Anchor check on the stored realpath. If the file was moved out from
    // under us, or a future bug let an attacker inject a row with a path
    // outside SESSIONS_ANCHOR/<sid>/attachments/, we MUST refuse to dispatch
    // it as a `file://` URI — the agent would happily read it.
    let resolvedPath: string;
    try {
      resolvedPath = await realpath(row.realpath);
    } catch {
      return fallback("realpath_failed");
    }
    if (
      !isInsideSessionAttachments(this.sessionsAnchor, sessionId, resolvedPath)
    ) {
      return fallback("path_outside_anchor");
    }

    if (ref.kind === "image") {
      try {
        const buf = await readFile(resolvedPath);
        return {
          type: "image",
          data: buf.toString("base64"),
          mimeType: row.mime,
        };
      } catch {
        return fallback("read_failed");
      }
    }

    // kind === "file" → ACP resource_link with file:// URI built from the
    // realpath (NOT from any client-supplied string).
    return {
      type: "resource_link",
      uri: pathToFileURL(resolvedPath).toString(),
      name: row.name,
      mimeType: row.mime,
    };
  }
}
