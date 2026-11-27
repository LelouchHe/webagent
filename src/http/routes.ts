import { readFile, mkdir, rename, unlink, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, extname, basename } from "node:path";
import { gzipSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import busboy from "busboy";
import {
  isEmptyExecutionSlot,
  type PendingCompactSummary,
  type Store,
} from "../store.ts";
import type { TaskManager } from "../task-manager.ts";
import { AgentUnavailableError } from "../agent-registry.ts";
import type { SseManager } from "../sse-manager.ts";
import type { Config } from "../config.ts";
import type { PushService } from "../push-service.ts";
import type { ClientRegistry } from "../client-registry.ts";
import { errorMessage, MessageIngressSchema } from "../types.ts";
import type { AgentEvent, ConfigOption } from "../types.ts";
import {
  AgentNotReadyError,
  InvalidTaskDirectoryError,
  TaskBusyError,
  TaskNotFoundError,
  TaskTreeBusyError,
} from "../task-manager.ts";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { handleShareRoutes } from "../share/routes.ts";
import { handleFileRoutes } from "../files/routes.ts";
import {
  handleCancelTaskRoute,
  handleDeleteTaskRoute,
} from "./task-lifecycle.ts";
import { handleCollaborationMessageRoute } from "./collaboration-messages-route.ts";
import {
  authenticate,
  isHostScopeAllowedPath,
  isWhitelistedPath,
} from "../auth-middleware.ts";
import { enrichStoredEventsForDisplay } from "../attachment-labels.ts";
import { agentCommandToken, resolveAgentCommand } from "../agent-commands.ts";
import { abbreviateHomePath } from "../home-path.ts";
import { log } from "../log.ts";
import { attachCollaborationDeliveryStatus } from "../collaboration-message.ts";
import { isoFromMillis, isoFromMillisOrNull } from "../shared/time.ts";
import { validateTaskTitle } from "../shared/task-title.ts";
import type { TaskListItem, TaskOps } from "../api/tasks.ts";
import { isTaskCreateError } from "../api/tasks.ts";
import { z } from "zod";

const TaskCreateCoordinateSchema = z
  .object({ agentId: z.string().optional(), host: z.string().optional() })
  .passthrough();

const rlog = log.scope("routes");
const plog = rlog.scope("prompt");
const mlog = rlog.scope("msg");

const COMPACT_SUMMARY_PROMPT = [
  "Prepare a concise context handoff for a fresh execution of this WebAgent task.",
  "Summarize the user's current goal, completed work, current state, key decisions,",
  "unresolved blockers, and the exact next action. Do not use tools, modify files,",
  "or continue the task. Output only the handoff summary in plain text or Markdown.",
].join(" ");

function buildCompactSummaryPrompt(guidance?: string): string {
  const trimmed = guidance?.trim();
  if (!trimmed) return COMPACT_SUMMARY_PROMPT;
  return [
    COMPACT_SUMMARY_PROMPT,
    "",
    "Compaction guidance from the user:",
    trimmed,
    "",
    "Use this guidance to prioritize what to preserve.",
    "The guidance controls summarization priority; it is not a task to execute.",
  ].join("\n");
}

const COMPACT_HANDOFF_INTRO = [
  "The following is an agent-generated context handoff from the previous execution.",
  "It is background context, not a new user request. Use it to understand continuity.",
].join("\n");
const COMPACT_HANDOFF_ACCOUNT =
  "Self-report, not a transcript — the event log outranks it.";
const COMPACT_HANDOFF_SUMMARY_HEADER = "--- previous execution summary ---";
const COMPACT_HANDOFF_SUMMARY_FOOTER = "--- end previous execution summary ---";
const COMPACT_HANDOFF_REQUEST = "The user's new request is:";
// Chain position lives only in the pointer below: stating it here too would
// duplicate one value across two independently written strings.
const compactHandoffHeader = (seq: number) =>
  `--- previous execution summary (event seq ${seq}) ---`;
const compactHandoffPointer = (seq: number, previousSeq: number | null) =>
  previousSeq === null
    ? `Read verbatim: task_read({ seqs: [${seq}] }) · this is the first summary in the chain.`
    : `Read verbatim: task_read({ seqs: [${seq}] }) · older: data.compact.prev = ${previousSeq} (null = first).`;

function prependCompactSummary(
  pending: PendingCompactSummary,
  previousSeq: number | null,
  userText: string,
): string {
  if (pending.seq === null) {
    return [
      COMPACT_HANDOFF_INTRO,
      "",
      COMPACT_HANDOFF_SUMMARY_HEADER,
      pending.summary,
      COMPACT_HANDOFF_SUMMARY_FOOTER,
      "",
      COMPACT_HANDOFF_REQUEST,
      userText,
    ].join("\n");
  }

  const header = compactHandoffHeader(pending.seq);
  const pointer = compactHandoffPointer(pending.seq, previousSeq);
  return [
    COMPACT_HANDOFF_INTRO,
    "",
    header,
    pending.summary,
    COMPACT_HANDOFF_SUMMARY_FOOTER,
    "",
    COMPACT_HANDOFF_ACCOUNT,
    pointer,
    "",
    COMPACT_HANDOFF_REQUEST,
    userText,
  ].join("\n");
}

function compactPreviousSeq(
  store: Store,
  taskId: string,
  seq: number,
): number | null {
  const event = store.getEvent(taskId, seq);
  if (!event) return null;
  try {
    const data = JSON.parse(event.data) as {
      compact?: { prev?: unknown };
    };
    return typeof data.compact?.prev === "number" &&
      Number.isInteger(data.compact.prev)
      ? data.compact.prev
      : null;
  } catch {
    return null;
  }
}

import type { AuthStore, Scope, TokenRecord } from "../auth-store.ts";
import type { TicketStore } from "../sse-ticket.ts";
import {
  signAttachmentUrl,
  verifyAttachmentSig,
  reSignAttachmentUrlsInJson,
} from "../auth.ts";
import { projectMarkdownImageReferences } from "../markdown-image-references.ts";
import {
  buildContentDisposition,
  classifyKind,
  isInlineMime,
  mimeToExt,
  normalizeDisplayName,
  sniffMime,
} from "../attachments.ts";
import { readImageInfo } from "../image-info.ts";
import { HTTP_STATUS } from "../http-status.ts";

const IS_WIN = process.platform === "win32";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function broadcastInboxCount(store: Store, sseManager: SseManager): void {
  sseManager.broadcastGlobal({
    type: "inbox_count_changed",
    pendingCount: store.countUnprocessed(),
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/**
 * HTML entrypoints served by this app. Any new HTML page MUST be registered
 * here. Tests in `test/html-entrypoints.test.ts`, `test/csp.test.ts` and
 * `test/inline-assets.test.ts` rely on this list to enforce security
 * invariants (CSP header, no inline scripts/styles).
 */
export const HTML_ENTRYPOINTS = [
  { urlPath: "/", file: "index.html" },
  { urlPath: "/login", file: "login.html" },
  // Share viewer — served by share's own dispatcher at /s/:token
  // (see src/share/routes.ts → handleViewerHtml). The urlPath here is a
  // pseudo-path used only by the test invariants (CSP/inline checks); the
  // real route is /s/:token. Keep both views in sync if either changes.
  { urlPath: "/s", file: "share-viewer.html" },
] as const;

/**
 * Strict Content-Security-Policy for HTML responses.
 *
 *  - default-src 'self': everything same-origin only
 *  - img-src adds data: + blob: for image-upload preview
 *  - script-src 'self' 'wasm-unsafe-eval' (no inline; theme bootstrap is
 *    /theme-init.js. 'wasm-unsafe-eval' is the narrow CSP3 token that
 *    permits WebAssembly.instantiate() WITHOUT re-enabling eval()/Function;
 *    needed by any wasm consumer.)
 *  - style-src 'self' (no inline; login styles live in /styles.css)
 *  - object-src 'none', frame-ancestors 'none', base-uri 'self', form-action 'self'
 *  - connect-src 'self' for fetch + EventSource
 */
export const CSP_POLICY = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

interface HostStatusRegistry {
  list(): Array<{
    name: string;
    url: string;
    state: string;
    reason?: string | null;
    since: number;
  }>;
  listRemoteChildrenOf(
    parentTaskIds: ReadonlySet<string>,
  ): Promise<Array<TaskListItem & { parentTaskId: string }>>;
}

interface LinkSyncOwnerPort {
  read(host: string, after: number, limit?: number): unknown[];
  watch(
    host: string,
    after: number,
    observer: {
      entry(entry: { pos: number; prev: number; data: unknown }): void;
      heartbeat?(): void;
      closed?(error: unknown): void;
    },
  ): () => void;
  push(host: string, raw: unknown): { status: number; body: unknown };
}

export interface RequestHandlerDeps {
  store: Store;
  tasks?: TaskManager;
  taskOps?: TaskOps;
  linkSyncOwner?: LinkSyncOwnerPort;
  sseManager: SseManager;
  clientRegistry?: ClientRegistry;
  publicDir: string;
  dataDir: string;
  /**
   * Ids of the configured agents, in configuration order. A metadata read must
   * never resolve or start an agent to answer which agents exist, so this is a
   * plain configuration fact (no PATH or process state).
   */
  agentIds?: string[];
  limits: Pick<Config["limits"], "bash_output" | "image_upload"> &
    Partial<
      Pick<
        Config["limits"],
        "file_upload" | "cancel_timeout" | "recent_paths" | "recent_paths_ttl"
      >
    >;
  pushService?: PushService;
  serverVersion?: string;
  debugLevel?: string;
  /** Share feature config. When `enabled=false`, share routes are invisible. */
  shareConfig?: Config["share"];
  /**
   * Optional auth store. When set, every request to `/api/**` outside the
   * whitelist (see auth-middleware.ts) requires a valid Bearer token.
   * When unset, the gate is disabled — used by older test files that
   * predate auth. Production must always wire this in.
   */
  authStore?: AuthStore;
  /** Optional SSE ticket store. Required alongside authStore for the
   *  /api/v1/sse-ticket route and ticket-based SSE auth. */
  ticketStore?: TicketStore;
  /** In-memory hub-to-owner connection status. Empty on an owner-only server. */
  hostRegistry?: HostStatusRegistry;
  /**
   * Support seam: called synchronously when a route starts reading the request
   * body — by definition *after* that route's pre-body checks have passed. It
   * lets an ordering-sensitive test prove the handler is blocked in the body
   * read instead of racing it with a sleep.
   */
  onRequestBodyReadStart?: (url: string) => void;
  /** Optional secret for HMAC-signed image URLs. When present, image GET
   *  requires `?sig=&exp=`; image upload returns a signed URL. When absent
   *  (legacy/tests), images are served unauthenticated. */
  attachmentSecret?: Buffer;
  /**
   * Optional MCP server endpoint. When present, `/mcp` requests are
   * dispatched here before the generic API router; the handler authenticates
   * by per-task capability (see src/mcp/server.ts).
   */
  mcpEndpoint?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
}

/** Read the full request body as a string. */
function readBodyRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString());
    });
    req.on("error", reject);
  });
}

/**
 * client-server-split M2: idempotency helpers for mutating REST.
 * Frontend generates a UUID per user-initiated action and sends it as
 * `X-Client-Op-Id`. Replays (after SSE/network reconnect) return the
 * cached response instead of re-executing side effects. Missing header →
 * non-idempotent path (back-compat for curl / older clients).
 */
function getClientOpId(req: IncomingMessage): string | null {
  const v = req.headers["x-client-op-id"];
  if (typeof v === "string" && v.length > 0 && v.length <= 128) return v;
  return null;
}

function logPromptRejectBeforeSave(fields: {
  taskId: string;
  status: number;
  reason: string;
  opId?: string | null;
  textLength?: number;
  attachmentCount?: number;
  busyKind?: string;
  error?: unknown;
}): void {
  plog.warn("rejected before save", {
    taskId: fields.taskId.slice(0, 8),
    status: fields.status,
    reason: fields.reason,
    ...(fields.opId ? { opId: fields.opId } : {}),
    ...(fields.textLength != null ? { textLength: fields.textLength } : {}),
    ...(fields.attachmentCount != null
      ? { attachmentCount: fields.attachmentCount }
      : {}),
    ...(fields.busyKind ? { busyKind: fields.busyKind } : {}),
    ...(fields.error ? { error: fields.error } : {}),
  });
}

function tryReplayClientOp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  taskId: string,
): { opId: string | null; replayed: boolean } {
  const opId = getClientOpId(req);
  if (!opId) return { opId: null, replayed: false };
  const cached = store.getClientOp(taskId, opId) as {
    status: number;
    body: unknown;
  } | null;
  if (
    cached &&
    typeof cached === "object" &&
    "status" in cached &&
    "body" in cached
  ) {
    json(res, cached.status, cached.body, req);
    return { opId, replayed: true };
  }
  return { opId, replayed: false };
}

function saveClientOpResult(
  store: Store,
  opId: string | null,
  taskId: string,
  status: number,
  body: unknown,
): void {
  if (!opId) return;
  store.saveClientOp(taskId, opId, { status, body });
}

/** Send a JSON response, gzip-compressed when the client supports it. */
function json(
  res: ServerResponse,
  status: number,
  data: unknown,
  req?: IncomingMessage,
): void {
  const body = JSON.stringify(data);
  if (
    req &&
    body.length > 1024 &&
    (req.headers["accept-encoding"] ?? "").includes("gzip")
  ) {
    const compressed = gzipSync(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Content-Length": compressed.length,
    });
    res.end(compressed);
  } else {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  }
}

/** Per-request principal storage. WeakMap keeps it tied to the request lifetime
 *  without monkey-patching IncomingMessage or relying on `any`. */
const principalByRequest = new WeakMap<IncomingMessage, TokenRecord>();

export function getPrincipal(req: IncomingMessage): TokenRecord | undefined {
  return principalByRequest.get(req);
}

/**
 * Multipart upload handler. Streams the `file` field straight to disk under
 * <data_dir>/tasks/<sid>/attachments/<uuid>.<ext>.tmp, atomic-renames on
 * success, deletes on any failure path. Inserts an attachments row with the
 * resolved realpath so the bridge / permission interceptor can match it
 * later.
 *
 * Wire format expected:
 *   - Content-Type: multipart/form-data; boundary=...
 *   - One file field named `file` (additional file fields are rejected).
 *   - Optional text fields are ignored — displayName comes from the file
 *     part's filename header, classification comes from its content-type.
 */
async function handleAttachmentUpload(
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
  deps: RequestHandlerDeps,
): Promise<void> {
  const { store, dataDir, limits, tasks } = deps;
  const fileUploadLimit = limits.file_upload ?? 52_428_800;
  if (!store.getTask(taskId)) {
    json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
    return;
  }
  const dir = join(dataDir, "tasks", taskId, "attachments");
  await mkdir(dir, { recursive: true });

  const uploadId = randomUUID();
  let tmpPath: string | null = null;
  let finalPath: string | null = null;
  let bytesWritten = 0;
  let fileMime = "";
  let fileExt = "bin";
  let displayName: string | null = null;
  let kind: "image" | "file" = "file";
  let limit = Math.max(limits.image_upload, fileUploadLimit);
  let limitExceeded = false;
  let sawFile = false;
  let aborted = false;
  let writeError: Error | null = null;
  let resolved = false;
  // Resolves when the write stream backing the file part has flushed and
  // closed. busboy's `close` can fire before fs has finished writing the
  // last chunk to disk, so we must await this before renaming the .tmp.
  let writeDone: Promise<void> = Promise.resolve();

  // Single-shot response. We only ever respond to the request once even
  // though multiple busboy callbacks could converge on the same outcome
  // (e.g. file-too-large + close-after-finish).
  const respond = (status: number, body: Record<string, unknown>): void => {
    if (resolved) return;
    resolved = true;
    json(res, status, body);
  };

  const cleanupTmp = async (): Promise<void> => {
    if (tmpPath) {
      await unlink(tmpPath).catch(() => {});
      tmpPath = null;
    }
  };

  return new Promise<void>((resolveOuter) => {
    const finish = async (
      status: number,
      body: Record<string, unknown>,
    ): Promise<void> => {
      respond(status, body);
      resolveOuter();
    };

    let bb: ReturnType<typeof busboy>;
    try {
      bb = busboy({
        headers: req.headers,
        defParamCharset: "utf8",
        limits: {
          // We enforce the size cap manually via per-file byte tracking
          // (so we can pick the right cap based on classified kind and
          // emit a 413 the moment we cross the line). Cap files = 1
          // and field count = 16 as belt-and-suspenders.
          files: 1,
          fields: 16,
          fieldNameSize: 100,
          fieldSize: 1024,
        },
      });
    } catch {
      void finish(HTTP_STATUS.BAD_REQUEST, { error: "Invalid multipart" });
      return;
    }

    bb.on("file", (fieldName, stream, info) => {
      if (sawFile) {
        // Extra file part — drain and ignore (busboy `files: 1` should
        // already prevent this, but be defensive).
        stream.resume();
        return;
      }
      sawFile = true;
      if (fieldName !== "file") {
        stream.resume();
        void finish(HTTP_STATUS.BAD_REQUEST, {
          error: "Unexpected field name",
        });
        return;
      }
      fileMime = (info.mimeType || "application/octet-stream").toLowerCase();
      kind = classifyKind(fileMime);
      limit = kind === "image" ? limits.image_upload : fileUploadLimit;
      fileExt = mimeToExt(fileMime);
      displayName = info.filename ? normalizeDisplayName(info.filename) : null;
      displayName ??= kind === "image" ? "image" : "file";
      tmpPath = join(dir, `${uploadId}.${fileExt}.tmp`);
      finalPath = join(dir, `${uploadId}.${fileExt}`);
      const ws = createWriteStream(tmpPath);
      writeDone = new Promise<void>((resolveWs) => {
        ws.on("close", () => {
          resolveWs();
        });
      });
      stream.on("data", (chunk: Buffer) => {
        bytesWritten += chunk.length;
        if (bytesWritten > limit) {
          limitExceeded = true;
          stream.unpipe(ws);
          ws.destroy();
          stream.resume();
          // Abort the whole busboy pipeline. We respond on `close`.
          req.unpipe(bb);
          req.resume();
        }
      });
      stream.on("error", (err: Error) => {
        writeError = err;
      });
      ws.on("error", (err: Error) => {
        writeError = err;
      });
      stream.pipe(ws);
    });

    bb.on("error", (err: unknown) => {
      writeError = err instanceof Error ? err : new Error(String(err));
    });

    req.on("aborted", () => {
      aborted = true;
    });

    bb.on("close", () => {
      void (async () => {
        try {
          await writeDone;
          if (aborted) {
            await cleanupTmp();
            await finish(HTTP_STATUS.BAD_REQUEST, { error: "Upload aborted" });
            return;
          }
          if (limitExceeded) {
            await cleanupTmp();
            await finish(HTTP_STATUS.PAYLOAD_TOO_LARGE, {
              error: "Upload too large",
            });
            return;
          }
          if (writeError) {
            await cleanupTmp();
            await finish(HTTP_STATUS.INTERNAL_SERVER_ERROR, {
              error: "Upload failed",
            });
            return;
          }
          if (!sawFile || !tmpPath || !finalPath || !displayName) {
            await cleanupTmp();
            await finish(HTTP_STATUS.BAD_REQUEST, {
              error: "Missing file part",
            });
            return;
          }
          // Sniff the actual mime from file content (magic bytes + UTF-8
          // text fallback). Clients lie about Content-Type — browsers send
          // application/octet-stream for any extension the OS doesn't know
          // (.clj, .lua, .rs, ...), and ACP agents (Copilot CLI) refuse to
          // read attachments tagged octet-stream. The sniffed mime wins
          // silently; we override fileMime / kind / extension / final path
          // before insertAttachment so DB and disk reflect reality.
          const head = await readFile(tmpPath).catch(() => Buffer.alloc(0));
          const headSlice = head.subarray(0, 4096);
          const sniffed = await sniffMime(headSlice);
          if (sniffed !== fileMime) {
            fileMime = sniffed;
            kind = classifyKind(fileMime);
            const newExt = mimeToExt(fileMime);
            if (newExt !== fileExt) {
              fileExt = newExt;
              const newTmp = join(dir, `${uploadId}.${fileExt}.tmp`);
              if (newTmp !== tmpPath) {
                await rename(tmpPath, newTmp);
                tmpPath = newTmp;
              }
              finalPath = join(dir, `${uploadId}.${fileExt}`);
            }
          }
          // The same bytes answer the mime question above and, for an image,
          // the pixel dimensions stored on the row.
          const imageInfo = kind === "image" ? readImageInfo(head) : null;
          await rename(tmpPath, finalPath);
          const rp = await realpath(finalPath);
          const row = store.insertAttachment({
            id: uploadId,
            taskId,
            kind,
            name: displayName,
            mime: fileMime,
            size: bytesWritten,
            realpath: rp,
            width: imageInfo?.width ?? null,
            height: imageInfo?.height ?? null,
          });
          // Invalidate the per-task attachment label cache so the
          // next egress (SSE broadcast or replay) sees this new row.
          tasks?.invalidateLabelCache(taskId);
          const fileName = `${row.id}.${fileExt}`;
          const basePath = `/api/v1/tasks/${taskId}/attachments/${fileName}`;
          // 1h signed URL — long enough that the browser holds the rendered
          // image in <img> cache for the full task lifetime, short enough
          // that a leaked URL (screenshot, link share) expires within the day.
          const fileUrl = deps.attachmentSecret
            ? `${basePath}?${signAttachmentUrl(basePath, deps.attachmentSecret, 3600)}`
            : basePath;
          await finish(HTTP_STATUS.OK, {
            attachmentId: row.id,
            displayName: row.name,
            mimeType: row.mime,
            size: row.size,
            width: row.width,
            height: row.height,
            kind: row.kind,
            path: `tasks/${taskId}/attachments/${fileName}`,
            url: fileUrl,
          });
        } catch (err) {
          await cleanupTmp();
          await finish(HTTP_STATUS.INTERNAL_SERVER_ERROR, {
            error: errorMessage(err),
          });
        }
      })();
    });

    req.pipe(bb);
  });
}

export function createRequestHandler(
  deps: RequestHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { store, tasks, sseManager } = deps;
  /** Every body read in this handler reports that it started. */
  const readBody = (req: IncomingMessage): Promise<string> => {
    deps.onRequestBodyReadStart?.(req.url ?? "/");
    return readBodyRaw(req);
  };
  // The branches that can answer are all backed by a task row, so `cwd` is
  // present at runtime; the helper's shared shape types it as optional.
  let bootstrapTaskPromise: Promise<{
    id: string;
    cwd?: string;
    cwdDisplay?: string;
    parentId?: string | null;
    parentAgentId?: string | null;
    agentId?: string | null;
    title: string | null;
    source: string;
    configOptions: ConfigOption[];
    agentCommands: ReturnType<TaskManager["getAgentCommands"]>;
    created: boolean;
  }> | null = null;

  /** The configured agents a client may target, in configuration order. */
  const agentDirectory = (): Array<{ id: string }> =>
    (deps.agentIds ?? []).map((id) => ({ id }));

  /**
   * The fields every activation payload carries, so adding one does not mean
   * editing every producer. Each site keeps its own `id`/`taskId`, `title`,
   * `source`, `configOptions`, `agentCommands`, and flags.
   *
   * `agentId` may be supplied when the caller already knows it (root
   * materialization); otherwise it is read for `taskId`. A row that could not
   * be read keeps the caller's parent fallback and reports no parent binding:
   * there is no row to trust.
   */
  const activationFields = (
    task: { id: string; cwd: string; parent_id: string | null } | undefined,
    options: {
      taskId: string;
      agentId?: string | null;
      /** Parent id when the row is unavailable (a create branch). */
      parentId?: string | null;
    },
  ): {
    cwd: string | undefined;
    cwdDisplay: string | undefined;
    parentId: string | null;
    parentAgentId: string | null;
    agentId: string | null;
  } => {
    const parentId = task ? task.parent_id : (options.parentId ?? null);
    return {
      cwd: task?.cwd,
      cwdDisplay: task?.cwd ? abbreviateHomePath(task.cwd) : undefined,
      parentId,
      parentAgentId:
        task && parentId !== null
          ? (store.getBindingAgent(parentId) ?? null)
          : null,
      agentId:
        options.agentId !== undefined
          ? options.agentId
          : (store.getBindingAgent(options.taskId) ?? null),
    };
  };

  // eslint-disable-next-line complexity -- TODO: refactor main route handler into smaller handlers
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? "/";
    const queryStart = url.indexOf("?");
    const path = queryStart === -1 ? url : url.slice(0, queryStart);
    const requestParams = new URLSearchParams(
      queryStart === -1 ? "" : url.slice(queryStart + 1),
    );

    // --- MCP server: claims /mcp before the auth gate (the endpoint
    // is outside /api/** and authenticates by per-task capability).
    if (deps.mcpEndpoint && (await deps.mcpEndpoint(req, res))) return;

    // --- Auth gate: any /api/** outside whitelist requires Bearer ---
    if (deps.authStore && path.startsWith("/api/")) {
      const method = req.method ?? "GET";
      if (!isWhitelistedPath(method, path)) {
        const result = authenticate(req.headers, deps.authStore);
        if (!result.ok) {
          res.writeHead(HTTP_STATUS.UNAUTHORIZED, {
            "Content-Type": "application/json",
            "WWW-Authenticate": "Bearer",
          });
          res.end(
            JSON.stringify({ error: "Unauthorized", reason: result.reason }),
          );
          return;
        }
        principalByRequest.set(req, result.principal);
        if (
          result.principal.scope === "host" &&
          !isHostScopeAllowedPath(method, path)
        ) {
          res.writeHead(HTTP_STATUS.FORBIDDEN, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify({ error: "Forbidden", reason: "host_scope" }));
          return;
        }
      }
    }

    // Share routes — early dispatch so /s/* and /api/v1/shares* claim
    // their URL space before the generic /api/v1 branch. When
    // `shareConfig.enabled === false` handleShareRoutes is a no-op.
    // The auth gate above has already enforced Bearer on owner endpoints
    // (/api/v1/tasks/:id/share*, /api/v1/shares); viewer endpoints
    // (/s/:token, /api/v1/shared/:token/events) must be whitelisted in
    // auth-middleware.ts so they remain public.
    if (
      deps.shareConfig &&
      (await handleShareRoutes(req, res, {
        store,
        tasks,
        config: deps.shareConfig,
        dataDir: deps.dataDir,
        publicDir: deps.publicDir,
      }))
    ) {
      return;
    }

    // File viewer — task-less read-only access to arbitrary local paths.
    // Claims /api/v1/files/{info,list,content} before the generic /api/v1
    // branch. info/list use the Bearer gate above; content is whitelisted
    // only because its handler requires an HMAC-signed URL for headerless
    // media/download fetches (see src/files/routes.ts).
    if (await handleFileRoutes(req, res, { secret: deps.attachmentSecret })) {
      return;
    }

    // --- API routes ---
    if (url === "/api/v1" || url.startsWith("/api/v1/")) {
      res.setHeader("Content-Type", "application/json");

      // GET /api/v1 — discovery endpoint
      if (url === "/api/v1" && req.method === "GET") {
        json(res, HTTP_STATUS.OK, {
          version: "v1",
          endpoints: {
            tasks: "/api/v1/tasks",
            paths: "/api/v1/recent-paths",
            files: "/api/v1/files",
            config: "/api/v1/config",
            events_stream: "/api/v1/events/stream",
            prompt: "/api/beta/prompt",
            push: "/api/beta/push",
            clients: "/api/beta/clients",
            hosts: "/api/v1/hosts",
          },
        });
        return;
      }

      // GET /api/v1/hosts — read in-memory outbound host connection states.
      if (url === "/api/v1/hosts" && req.method === "GET") {
        json(
          res,
          HTTP_STATUS.OK,
          (deps.hostRegistry?.list() ?? []).map((host) => ({
            name: host.name,
            url: host.url,
            state: host.state,
            ...(host.reason ? { reason: host.reason } : {}),
            since: isoFromMillis(host.since),
          })),
        );
        return;
      }

      // GET /api/v1/tasks
      if (
        url.startsWith("/api/v1/tasks") &&
        !url.slice("/api/v1/tasks".length).match(/^\//) &&
        req.method === "GET"
      ) {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const source = params.get("source") ?? undefined;
        // Global by default; `?agent=` narrows to tasks whose current binding
        // names that agent. Filtering is a read concern, never a gate.
        const agentFilter = params.get("agent") ?? undefined;
        // Archived trees are the parentless non-Root subtrees. The default read
        // is the active tree; `archived=true` selects archived trees only.
        // There is no combined read: a caller that needs both asks twice.
        const archivedParam = params.get("archived");
        let archivedFilter = false;
        if (archivedParam !== null) {
          if (archivedParam === "true") archivedFilter = true;
          else if (archivedParam !== "false") {
            json(res, HTTP_STATUS.BAD_REQUEST, {
              error: "archived must be 'true' or 'false'",
            });
            return;
          }
        }
        const archivedIds = store.listArchivedTaskIds();
        const listedTasks = store.listTasks({
          ...(source ? { source } : {}),
          ...(agentFilter !== undefined ? { agentId: agentFilter } : {}),
          archived: archivedFilter,
        });
        const publicTasks = listedTasks.map((task) => {
          const {
            pending_compact_summary: _pendingCompactSummary,
            has_user_input: hasUserInput,
            remote_parent_id: remoteParentId,
            ...publicTask
          } = task;
          // Home-abbreviated display form for menus and lists; the raw cwd
          // stays the canonical round-trip value. Every timestamp field is
          // rendered ISO-8601 at egress (DB rows hold integer millis).
          return {
            ...publicTask,
            agentId: store.getBindingAgent(task.id) ?? null,
            created_at: isoFromMillis(task.created_at),
            last_active_at: isoFromMillis(task.last_active_at),
            deleted_at: isoFromMillisOrNull(task.deleted_at),
            cwdDisplay: abbreviateHomePath(task.cwd),
            hasUserInput: Boolean(hasUserInput),
            isRoot: store.isRootTaskId(task.id),
            // Egress fact, not a column: clients keep the full topology and
            // decide which reads (`/switch`, path roots) exclude these.
            archived: archivedIds.has(task.id),
          };
        });
        // Remote children follow their local parent into the same read, so
        // a client sees the tree MCP `task_list` sees. Display-only mirror
        // values; an unknown title is null.
        const externalParents = [
          ...new Set(
            listedTasks
              .filter((task) => task.remote_parent_id)
              .map((task) => task.remote_parent_id) as string[],
          ),
        ].map((id) => ({
          id,
          host: null,
          parent_id: null,
          title: null,
        }));
        const remoteTasks = (
          (await deps.hostRegistry?.listRemoteChildrenOf(
            new Set(publicTasks.map((task) => task.id)),
          )) ?? []
        ).map((item) => ({
          id: item.id,
          host: item.host,
          parent_id: item.parentTaskId,
          title: item.title ?? null,
          ...(item.workflowStatus !== undefined
            ? { workflow_status: item.workflowStatus }
            : {}),
          ...(item.unreachable ? { unreachable: true } : {}),
        }));
        res.end(
          JSON.stringify([...publicTasks, ...remoteTasks, ...externalParents]),
        );
        return;
      }

      // --- GET /api/v1/config ---
      // Cold start: reporting the default agent's schema never starts it. An
      // agent that has not run yet simply has no schema to report.
      if (url === "/api/v1/config" && req.method === "GET") {
        json(res, HTTP_STATUS.OK, {
          rootTaskId: store.rootTaskId,
          configOptions: tasks?.configOptionsFor(tasks.defaultAgentId) ?? [],
          cancelTimeout: deps.limits.cancel_timeout ?? 0,
          recentPathsLimit: deps.limits.recent_paths ?? 10,
          agents: agentDirectory(),
          defaultAgentId: tasks?.defaultAgentId ?? null,
        });
        return;
      }

      // GET /api/v1/recent-paths
      if (url.startsWith("/api/v1/recent-paths") && req.method === "GET") {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const limitParam = params.get("limit");
        const limit =
          limitParam != null ? Math.max(0, parseInt(limitParam, 10)) : 0;
        const ttlDays = deps.limits.recent_paths_ttl ?? 30;
        const paths = store.listRecentPaths({
          limit: isNaN(limit) ? 0 : limit,
          ttlDays,
        });
        json(
          res,
          HTTP_STATUS.OK,
          paths.map((entry) => ({
            ...entry,
            last_used_at: isoFromMillis(entry.last_used_at),
            cwdDisplay: abbreviateHomePath(entry.cwd),
          })),
        );
        return;
      }

      // GET /api/v1/version
      if (url === "/api/v1/version" && req.method === "GET") {
        // Same rule as /config: metadata reads never start a process.
        json(res, HTTP_STATUS.OK, {
          server: deps.serverVersion ?? "unknown",
          agent: tasks?.agentInfoFor(tasks.defaultAgentId) ?? null,
        });
        return;
      }

      // GET /api/v1/auth/verify — token validation probe
      if (url === "/api/v1/auth/verify" && req.method === "GET") {
        const principal = principalByRequest.get(req);
        if (!principal) {
          json(res, HTTP_STATUS.UNAUTHORIZED, { error: "Unauthorized" });
          return;
        }
        json(res, HTTP_STATUS.OK, {
          ok: true,
          name: principal.name,
          scope: principal.scope,
          hash: principal.hash,
        });
        return;
      }

      // POST /api/v1/sse-ticket — mint short-lived ticket for EventSource
      if (url === "/api/v1/sse-ticket" && req.method === "POST") {
        const principal = principalByRequest.get(req);
        if (!principal) {
          json(res, HTTP_STATUS.UNAUTHORIZED, { error: "Unauthorized" });
          return;
        }
        if (principal.scope === "host") {
          json(res, HTTP_STATUS.FORBIDDEN, { error: "Forbidden" });
          return;
        }
        if (!deps.ticketStore) {
          json(res, HTTP_STATUS.NOT_IMPLEMENTED, {
            error: "SSE not available",
          });
          return;
        }
        const ticket = deps.ticketStore.mint({
          tokenName: principal.name,
          scope: principal.scope,
          hash: principal.hash,
        });
        json(res, HTTP_STATUS.OK, { ticket, expiresIn: 60 });
        return;
      }

      // --- Host link transport routes ---
      if (path === "/api/v1/link/outbox" && req.method === "GET") {
        const principal = principalByRequest.get(req);
        if (principal?.scope !== "host") {
          json(res, HTTP_STATUS.FORBIDDEN, { error: "Forbidden" });
          return;
        }
        if (!deps.linkSyncOwner) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: "Link sync is not configured",
          });
          return;
        }
        const afterParam = requestParams.get("after");
        const limitParam = requestParams.get("limit");
        const after = afterParam === null ? 0 : Number(afterParam);
        const limit = limitParam === null ? 100 : Number(limitParam);
        if (
          !Number.isInteger(after) ||
          after < 0 ||
          !Number.isInteger(limit) ||
          limit < 1
        ) {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "after must be >= 0 and limit must be >= 1",
          });
          return;
        }
        json(res, HTTP_STATUS.OK, {
          entries: deps.linkSyncOwner.read(principal.name, after, limit),
        });
        return;
      }

      if (path === "/api/v1/link/watch" && req.method === "GET") {
        const principal = principalByRequest.get(req);
        if (principal?.scope !== "host") {
          json(res, HTTP_STATUS.FORBIDDEN, { error: "Forbidden" });
          return;
        }
        if (!deps.linkSyncOwner) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: "Link sync is not configured",
          });
          return;
        }
        const afterParam = requestParams.get("after");
        const after = afterParam === null ? 0 : Number(afterParam);
        if (!Number.isInteger(after) || after < 0) {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "after must be >= 0" });
          return;
        }
        res.writeHead(HTTP_STATUS.OK, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write("event: connected\ndata: {}\n\n");
        let unsubscribe = () => {};
        unsubscribe = deps.linkSyncOwner.watch(principal.name, after, {
          entry: (frame) => {
            if (res.writableEnded) throw new Error("link_watch_closed");
            res.write(
              `event: entry\nid: ${frame.pos}\ndata: ${JSON.stringify(frame)}\n\n`,
            );
          },
          heartbeat: () => {
            if (res.writableEnded) {
              unsubscribe();
              return;
            }
            if (
              deps.authStore &&
              !deps.authStore.hasTokenHash(principal.hash)
            ) {
              unsubscribe();
              try {
                res.end();
              } catch {
                /* already torn down */
              }
              return;
            }
            try {
              res.write("event: heartbeat\ndata: {}\n\n");
            } catch {
              unsubscribe();
            }
          },
          closed: () => {
            try {
              res.end();
            } catch {
              /* already torn down */
            }
          },
        });
        res.on("close", () => {
          unsubscribe();
        });
        return;
      }

      if (path === "/api/v1/link/entries" && req.method === "POST") {
        const principal = principalByRequest.get(req);
        if (principal?.scope !== "host") {
          json(res, HTTP_STATUS.FORBIDDEN, { error: "Forbidden" });
          return;
        }
        if (!deps.linkSyncOwner) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: "Link sync is not configured",
          });
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req)) as unknown;
        } catch {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
          return;
        }
        const result = deps.linkSyncOwner.push(principal.name, body);
        json(res, result.status, result.body, req);
        return;
      }

      // --- Token management (admin scope) ---
      // GET /api/v1/tokens — list tokens.
      // admin: full list. api: own token only (self-row, so the slash
      // menu can show the user's own metadata without leaking peers).
      if (url === "/api/v1/tokens" && req.method === "GET") {
        const principal = principalByRequest.get(req);
        if (!deps.authStore || !principal) {
          json(res, HTTP_STATUS.UNAUTHORIZED, { error: "Unauthorized" });
          return;
        }
        const all = deps.authStore.list();
        const visible =
          principal.scope === "admin"
            ? all
            : all.filter((t) => t.name === principal.name);
        const list = visible.map((t) => ({
          name: t.name,
          scope: t.scope,
          createdAt: isoFromMillis(t.createdAt),
          lastUsedAt: isoFromMillisOrNull(t.lastUsedAt),
          isSelf: t.name === principal.name,
        }));
        json(res, HTTP_STATUS.OK, list);
        return;
      }

      // POST /api/v1/tokens — create a non-admin token, return raw value once
      if (url === "/api/v1/tokens" && req.method === "POST") {
        const principal = principalByRequest.get(req);
        if (!deps.authStore || !principal) {
          json(res, HTTP_STATUS.UNAUTHORIZED, { error: "Unauthorized" });
          return;
        }
        if (principal.scope !== "admin") {
          json(res, HTTP_STATUS.FORBIDDEN, { error: "Forbidden" });
          return;
        }
        let body: { name?: unknown; scope?: unknown };
        try {
          body = JSON.parse(await readBody(req)) as {
            name?: unknown;
            scope?: unknown;
          };
        } catch {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
          return;
        }
        const name = typeof body.name === "string" ? body.name : "";
        // REST can mint `api` (default) or the host connection scope. `admin`
        // is deliberately CLI-only so a compromised token cannot escalate.
        const scope = body.scope === undefined ? "api" : body.scope;
        if (scope !== "api" && scope !== "host") {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "scope must be 'api' or 'host'",
          });
          return;
        }
        try {
          const created = await deps.authStore.addToken(name, scope);
          json(res, HTTP_STATUS.CREATED, {
            token: created.token,
            name: created.record.name,
            scope: created.record.scope,
          });
        } catch (err: unknown) {
          const msg = errorMessage(err);
          if (/already exists|duplicate/i.test(msg)) {
            json(res, HTTP_STATUS.CONFLICT, { error: msg });
          } else {
            json(res, HTTP_STATUS.BAD_REQUEST, { error: msg });
          }
        }
        return;
      }

      // DELETE /api/v1/tokens/:name — revoke
      const tokenDelMatch = url.match(/^\/api\/v1\/tokens\/([^/?]+)\/?$/);
      if (tokenDelMatch && req.method === "DELETE") {
        const principal = principalByRequest.get(req);
        if (!deps.authStore || !principal) {
          json(res, HTTP_STATUS.UNAUTHORIZED, { error: "Unauthorized" });
          return;
        }
        if (principal.scope !== "admin") {
          json(res, HTTP_STATUS.FORBIDDEN, { error: "Forbidden" });
          return;
        }
        const name = decodeURIComponent(tokenDelMatch[1]);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid token name" });
          return;
        }
        if (name === principal.name) {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "Cannot revoke the token you are using",
          });
          return;
        }
        try {
          const ok = await deps.authStore.revokeToken(name);
          if (!ok) {
            json(res, HTTP_STATUS.NOT_FOUND, { error: "Token not found" });
            return;
          }
          res.writeHead(HTTP_STATUS.NO_CONTENT);
          res.end();
        } catch (err: unknown) {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: errorMessage(err) });
        }
        return;
      }

      // --- POST /api/v1/bridge/reload ---
      // Targets the binding agent of `taskId` when supplied; otherwise every
      // agent that already has a process. A reload never starts an agent.
      if (url === "/api/v1/bridge/reload" && req.method === "POST") {
        if (!tasks) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: "Task manager not available",
          });
          return;
        }
        let body: { taskId?: string } = {};
        try {
          const raw = await readBody(req);
          if (raw) body = JSON.parse(raw) as { taskId?: string };
        } catch {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
          return;
        }
        if (body.taskId !== undefined && typeof body.taskId !== "string") {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid taskId" });
          return;
        }
        if (body.taskId && !store.hasBinding(body.taskId)) {
          json(res, HTTP_STATUS.CONFLICT, {
            error: "Task has no agent to reload",
          });
          return;
        }
        try {
          await tasks.reloadAgent(body.taskId);
          json(res, HTTP_STATUS.OK, { ok: true });
        } catch (err: unknown) {
          if (err instanceof TaskNotFoundError) {
            json(res, HTTP_STATUS.NOT_FOUND, { error: err.message });
            return;
          }
          if (
            err instanceof AgentUnavailableError ||
            err instanceof AgentNotReadyError
          ) {
            json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
              error: "Agent not ready yet",
            });
            return;
          }
          if (err instanceof Error && err.message === "Already reloading") {
            json(res, HTTP_STATUS.CONFLICT, { error: err.message });
            return;
          }
          json(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
            error: errorMessage(err),
          });
        }
        return;
      }

      // --- Permissions (task-scoped) ---

      // GET /api/v1/tasks/:id/permissions
      const permListMatch = url.match(
        /^\/api\/v1\/tasks\/([^/]+)\/permissions\/?(\?.*)?$/,
      );
      if (permListMatch && req.method === "GET") {
        const taskId = decodeURIComponent(permListMatch[1]);
        const perms = tasks?.getPendingPermissions(taskId) ?? [];
        json(res, HTTP_STATUS.OK, perms);
        return;
      }

      // POST /api/v1/tasks/:id/permissions/:reqId
      const permActionMatch = url.match(
        /^\/api\/v1\/tasks\/([^/]+)\/permissions\/([^/?]+)\/?$/,
      );
      if (permActionMatch && req.method === "POST") {
        const taskId = decodeURIComponent(permActionMatch[1]);
        const requestId = decodeURIComponent(permActionMatch[2]);
        const { opId, replayed } = tryReplayClientOp(req, res, store, taskId);
        if (replayed) return;
        const perm = tasks?.pendingPermissions.get(requestId);
        if (!perm) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Permission not found" });
          return;
        }
        if (perm.taskId !== taskId) {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Task ID mismatch" });
          return;
        }
        const pendingTransport = tasks?.permissionTransport(perm) ?? null;
        if (!pendingTransport) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: "Agent not ready yet",
          });
          return;
        }

        let body: { optionId?: string; denied?: boolean };
        try {
          body = JSON.parse(await readBody(req)) as {
            optionId?: string;
            denied?: boolean;
          };
        } catch {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
          return;
        }
        if (!body.optionId && !body.denied) {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "Provide optionId or denied:true",
          });
          return;
        }

        // The approval is authorised at the execution boundary, after the body
        // await: the same pending row must still be there, its captured lease
        // must still name the task's current generation, and the task must
        // still be bound to the agent that produced the request. Nothing below
        // this check awaits, so the decision and the write cannot be split.
        const stillPending = tasks!.pendingPermissions.get(requestId);
        if (
          stillPending !== perm ||
          !tasks!.acceptsPendingPermission(perm) ||
          !(pendingTransport.isAvailable?.() ?? true)
        ) {
          json(res, HTTP_STATUS.CONFLICT, {
            error: "Permission belongs to a replaced execution",
          });
          return;
        }

        const denied = Boolean(body.denied);
        const optionId = body.optionId ?? "deny";
        const optionName =
          perm.options.find((o) => o.optionId === optionId)?.label ?? optionId;

        if (denied) {
          pendingTransport.denyPermission(requestId);
        } else {
          pendingTransport.resolvePermission(requestId, optionId);
        }

        tasks!.pendingPermissions.delete(requestId);
        tasks!.syncPendingPermissions(taskId);

        // Store event and broadcast (same type so SSE drops are recoverable via sync)
        const permEventData = { requestId, optionName, denied };
        store.saveEvent(
          perm.taskId,
          "permission_response",
          { ...permEventData, optionId },
          { from_ref: "user" },
        );
        sseManager.broadcast({
          type: "permission_response",
          taskId: perm.taskId,
          ...permEventData,
        });

        // Cross-device banner recall: close the permission banner on
        // every subscribed endpoint now that the permission has been
        // handled by this client.
        if (deps.pushService) {
          void deps.pushService.sendClose(
            `sess-${perm.taskId}-perm-${requestId}`,
          );
        }

        const okBody = { ok: true };
        saveClientOpResult(store, opId, taskId, HTTP_STATUS.OK, okBody);
        json(res, HTTP_STATUS.OK, okBody);
        return;
      }

      // --- POST /api/v1/tasks/:id/cancel ---
      const cancelMatch = url.match(/^\/api\/v1\/tasks\/([^/]+)\/cancel\/?$/);
      if (cancelMatch && req.method === "POST") {
        await handleCancelTaskRoute({
          ...deps,
          req,
          res,
          taskId: decodeURIComponent(cancelMatch[1]),
          principal: principalByRequest.get(req),
          readBody,
          json,
          tryReplayClientOp,
          saveClientOpResult,
        });
        return;
      }

      // --- GET /api/v1/tasks/:id/status ---
      const statusMatch = url.match(/^\/api\/v1\/tasks\/([^/]+)\/status\/?$/);
      if (statusMatch && req.method === "GET") {
        const taskId = decodeURIComponent(statusMatch[1]);
        const task = store.getTask(taskId);
        const principal = principalByRequest.get(req);
        const externalParent =
          principal?.scope === "host"
            ? store.getExternalParentLink(taskId)
            : null;
        if (
          !task ||
          (principal?.scope === "host" &&
            externalParent?.remote_host !== principal.name)
        ) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
          return;
        }
        const busyKind = tasks?.getBusyKind(taskId) ?? null;
        const pendingPerms = tasks?.getPendingPermissions(taskId) ?? [];
        const lastEventAt = store.getLatestEventTimes([taskId]).get(taskId);
        json(res, HTTP_STATUS.OK, {
          busy: busyKind != null,
          busyKind,
          pendingPermissions: pendingPerms,
          title: task.title,
          workflowStatus: task.workflow_status,
          executionState: tasks?.getExecutionState(taskId) ?? "idle",
          lastEventAt: isoFromMillisOrNull(lastEventAt),
          lastAgentActivityAt: tasks?.getLastAgentActivityAt(taskId) ?? null,
        });
        return;
      }

      // --- GET /api/v1/tasks/:id/snapshot ---
      // client-server-split M1: single source of truth for "what state is
      // this task in right now". Frontend calls this on connect / reconnect
      // / after long backgrounding, then applies incremental `state_patch`
      // SSE events.
      const snapshotMatch = path.match(
        /^\/api\/v1\/tasks\/([^/]+)\/snapshot\/?$/,
      );
      if (snapshotMatch && req.method === "GET") {
        const taskId = decodeURIComponent(snapshotMatch[1]);
        const warm = requestParams.get("warm") === "1";
        const task = store.getTask(taskId);
        if (!task) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
          return;
        }
        if (!tasks) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: "Task manager not available",
          });
          return;
        }
        // An explicit warm restores in the background and reports back through
        // `task_runtime_warmed`; a plain snapshot never starts an execution.
        if (warm && !tasks.liveTasks.has(taskId)) {
          tasks.warmTaskInBackground(taskId);
        }
        tasks.syncBusy(taskId);
        tasks.syncPendingPermissions(taskId);
        const runtimeState = tasks.state.getState(taskId);
        const lastEventSeq = store.getLastEventSeq(taskId);
        json(
          res,
          HTTP_STATUS.OK,
          {
            version: 1,
            seq: runtimeState.seq,
            task: {
              id: task.id,
              title: task.title,
              cwd: task.cwd,
              cwdDisplay: abbreviateHomePath(task.cwd),
              model: task.model,
              mode: task.mode,
              agentId: store.getBindingAgent(task.id) ?? null,
              createdAt: isoFromMillis(task.created_at),
              lastEventSeq,
            },
            runtime: runtimeState.runtime,
            agentCommands: tasks.getAgentCommands(taskId),
          },
          req,
        );
        return;
      }

      // --- POST /api/v1/tasks/:sourceTaskId/messages ---
      const collaborationMessageMatch = url.match(
        /^\/api\/v1\/tasks\/([^/]+)\/messages\/?(?:\?.*)?$/,
      );
      if (collaborationMessageMatch && req.method === "POST") {
        await handleCollaborationMessageRoute({
          req,
          res,
          sourceTaskId: decodeURIComponent(collaborationMessageMatch[1]),
          principal: principalByRequest.get(req),
          store,
          tasks,
          sseManager,
          readBody,
          json,
        });
        return;
      }

      // --- POST /api/v1/tasks/:id/prompt ---
      const promptMatch = url.match(
        /^\/api\/v1\/tasks\/([^/]+)\/prompt\/?(\?.*)?$/,
      );
      if (promptMatch && req.method === "POST") {
        const taskId = decodeURIComponent(promptMatch[1]);
        const requestOpId = getClientOpId(req);
        const task = store.getTask(taskId);
        if (!task) {
          logPromptRejectBeforeSave({
            taskId,
            status: HTTP_STATUS.NOT_FOUND,
            reason: "task_not_found",
            opId: requestOpId,
          });
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
          return;
        }
        if (!tasks) {
          logPromptRejectBeforeSave({
            taskId,
            status: HTTP_STATUS.SERVICE_UNAVAILABLE,
            reason: "task_manager_unavailable",
            opId: requestOpId,
          });
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: "Task manager not available",
          });
          return;
        }
        // The prompt goes to this task's current binding: resolving starts the
        // agent when needed, and an unavailable agent is refused with the
        // rescue path instead of being silently redirected.
        let execution;
        try {
          execution = await tasks.resolveTaskExecution(taskId);
        } catch (err) {
          const unavailable = err instanceof AgentUnavailableError;
          logPromptRejectBeforeSave({
            taskId,
            status: HTTP_STATUS.SERVICE_UNAVAILABLE,
            reason: unavailable ? "agent_unavailable" : "execution_unresolved",
            opId: requestOpId,
            error: errorMessage(err),
          });
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: unavailable
              ? "Agent is not available for this task. Restart it or clear the task onto another agent."
              : "Failed to resolve the task's agent",
          });
          return;
        }
        const bridge = execution.bridge;

        const { opId, replayed } = tryReplayClientOp(req, res, store, taskId);
        if (replayed) return;

        // A restore that a read started is still in flight at this point.
        // Waiting for it below is what a prompt needs; the restore alone must
        // not refuse the submission. Every other busy source (a live turn, a
        // queued submission, bash, a rotation) still refuses.
        const promptSubmissionId = tasks.reservePromptSubmission(taskId, {
          allowRestoring: true,
        });
        if (promptSubmissionId === null) {
          const busyKind = tasks.getGateBusyKind(taskId);
          logPromptRejectBeforeSave({
            taskId,
            status: HTTP_STATUS.CONFLICT,
            reason: "task_busy",
            opId,
            busyKind: busyKind ?? undefined,
          });
          json(res, HTTP_STATUS.CONFLICT, {
            error: "Task is busy",
            busyKind,
          });
          return;
        }
        const requestState: { aborted: boolean } = { aborted: false };
        const isRequestAborted = () => requestState.aborted;
        const abortPromptSubmission = () => {
          requestState.aborted = true;
          tasks.releasePromptSubmission(taskId, promptSubmissionId);
        };
        res.once("finish", () => {
          tasks.releasePromptSubmission(taskId, promptSubmissionId);
        });
        req.once("aborted", abortPromptSubmission);
        res.once("close", () => {
          if (!res.writableEnded) abortPromptSubmission();
        });

        // Ensure task is live in ACP before prompting (awaits in-flight resume).
        // The restore is shared (`pendingResumes`), so a prompt that arrives
        // while a read is still restoring waits for that restore instead of
        // being refused as busy; a failed one is reported as such.
        try {
          await tasks.ensureResumed(bridge, taskId);
        } catch (err) {
          if (isRequestAborted()) return;
          logPromptRejectBeforeSave({
            taskId,
            status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
            reason: "resume_failed",
            opId,
            error: errorMessage(err),
          });
          json(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
            error: `Failed to resume task: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }

        if (
          isRequestAborted() ||
          tasks.isPromptSubmissionCancelled(promptSubmissionId)
        ) {
          logPromptRejectBeforeSave({
            taskId,
            status: HTTP_STATUS.CONFLICT,
            reason: "prompt_cancelled_before_start",
            opId,
          });
          json(res, HTTP_STATUS.CONFLICT, {
            error: "Prompt was cancelled before start",
          });
          return;
        }

        let body: {
          text?: string;
          attachments?: Array<{
            kind: "image" | "file";
            attachmentId: string;
            displayName: string;
            mimeType: string;
          }>;
        };
        try {
          body = JSON.parse(await readBody(req)) as typeof body;
        } catch {
          if (isRequestAborted()) return;
          logPromptRejectBeforeSave({
            taskId,
            status: HTTP_STATUS.BAD_REQUEST,
            reason: "invalid_json",
            opId,
          });
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
          return;
        }
        if (
          isRequestAborted() ||
          tasks.isPromptSubmissionCancelled(promptSubmissionId)
        ) {
          json(res, HTTP_STATUS.CONFLICT, {
            error: "Prompt was cancelled before start",
          });
          return;
        }
        if (!body.text) {
          logPromptRejectBeforeSave({
            taskId,
            status: HTTP_STATUS.BAD_REQUEST,
            reason: "missing_text",
            opId,
            textLength: 0,
            attachmentCount: Array.isArray(body.attachments)
              ? body.attachments.length
              : undefined,
          });
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "Missing required field: text",
          });
          return;
        }

        // Validate attachment shape: client must NEVER supply uri/data/path,
        // only the four canonical fields. Anything else → 400 immediately so
        // we don't even hand it to the dispatcher fallback.
        const attachments = body.attachments;
        if (attachments) {
          if (!Array.isArray(attachments)) {
            logPromptRejectBeforeSave({
              taskId,
              status: HTTP_STATUS.BAD_REQUEST,
              reason: "attachments_not_array",
              opId,
              textLength: body.text.length,
            });
            json(res, HTTP_STATUS.BAD_REQUEST, {
              error: "attachments must be an array",
            });
            return;
          }
          for (const raw of attachments) {
            const att = raw as unknown as Record<string, unknown> | null;
            if (
              !att ||
              typeof att !== "object" ||
              (att.kind !== "image" && att.kind !== "file") ||
              typeof att.attachmentId !== "string" ||
              typeof att.displayName !== "string" ||
              typeof att.mimeType !== "string"
            ) {
              logPromptRejectBeforeSave({
                taskId,
                status: HTTP_STATUS.BAD_REQUEST,
                reason: "invalid_attachment_entry",
                opId,
                textLength: body.text.length,
                attachmentCount: attachments.length,
              });
              json(res, HTTP_STATUS.BAD_REQUEST, {
                error: "Invalid attachment entry",
              });
              return;
            }
            if (
              typeof att.uri === "string" ||
              typeof att.data === "string" ||
              typeof att.path === "string" ||
              typeof att.width === "number" ||
              typeof att.height === "number"
            ) {
              logPromptRejectBeforeSave({
                taskId,
                status: HTTP_STATUS.BAD_REQUEST,
                reason: "client_supplied_attachment_data",
                opId,
                textLength: body.text.length,
                attachmentCount: attachments.length,
              });
              json(res, HTTP_STATUS.BAD_REQUEST, {
                error: "Client must not supply uri/data/path/width/height",
              });
              return;
            }
          }
        }

        let agentText = body.text;
        if (body.text.startsWith("//")) {
          const resolved = resolveAgentCommand(
            body.text,
            tasks.getAgentCommands(taskId).commands,
          );
          if (!resolved) {
            const command = agentCommandToken(body.text);
            logPromptRejectBeforeSave({
              taskId,
              status: HTTP_STATUS.UNPROCESSABLE_CONTENT,
              reason: "unknown_command",
              opId,
              textLength: body.text.length,
              attachmentCount: attachments?.length,
            });
            json(res, HTTP_STATUS.UNPROCESSABLE_CONTENT, {
              error: "Unknown command",
              command,
              prefix: "//",
            });
            return;
          }
          agentText = resolved.agentText;
        }

        const pendingCompactSummary = store.getPendingCompactSummary(taskId);
        if (pendingCompactSummary) {
          const previousSeq =
            pendingCompactSummary.seq === null
              ? null
              : compactPreviousSeq(store, taskId, pendingCompactSummary.seq);
          agentText = prependCompactSummary(
            pendingCompactSummary,
            previousSeq,
            agentText,
          );
        }

        // Stored shape mirrors the wire shape PLUS a server-derived `path`
        // for renderers. The path is the unsigned base URL
        // (`/api/v1/tasks/<sid>/attachments/<filename>`); reSign on
        // egress (history GET + SSE broadcast) appends a fresh `?sig=&exp=`.
        // Renderers use it to mount `<img>` (kind=image) or `<a>` (kind=file).
        // Refs whose attachment row is missing are dropped (defense — the
        // dispatcher's [attachment removed] fallback covers that case).
        const storedAttachments = attachments?.flatMap((a) => {
          const row = store.getAttachment(taskId, a.attachmentId);
          if (!row) return [];
          const fileName = basename(row.realpath);
          return [
            {
              kind: a.kind,
              attachmentId: a.attachmentId,
              displayName: a.displayName,
              mimeType: a.mimeType,
              path: `/api/v1/tasks/${taskId}/attachments/${fileName}`,
              ...(row.width != null && row.height != null
                ? { width: row.width, height: row.height }
                : {}),
            },
          ];
        });
        // A background task can trigger unsolicited Main-agent output after
        // the foreground ACP prompt has ended. Its chunks remain buffered
        // until a real protocol boundary arrives; seal them before this user
        // row so they cannot merge into the next turn's assistant response.
        tasks.flushBuffers(taskId);

        const eventClientOpId = opId ?? randomUUID();
        store.saveEvent(
          taskId,
          "user_message",
          {
            text: body.text,
            clientOpId: eventClientOpId,
            ...(storedAttachments?.length
              ? { attachments: storedAttachments }
              : {}),
          },
          { from_ref: "user" },
        );
        store.updateTaskLastActive(taskId);
        store.touchRecentPath(task.cwd);
        const userMsgEvent = {
          type: "user_message",
          taskId,
          text: body.text,
          clientOpId: eventClientOpId,
          attachments: storedAttachments,
        } as AgentEvent;
        sseManager.broadcast(userMsgEvent);

        // Fire prompt asynchronously (don't await — response is 202)
        // The reservation→active transfer is synchronous: from here this route
        // holds the task's ACP prompt slot until the turn ends.
        tasks.releasePromptSubmission(taskId, promptSubmissionId, false);
        tasks.beginAgentTurn(taskId, {
          origin: "interactive",
          submissionId: promptSubmissionId,
        });
        const promptId =
          tasks.state.getState(taskId).runtime.busy?.promptId ?? undefined;
        tasks.notePromptSubmitted(taskId);
        const promptPromise = bridge.prompt(
          taskId,
          agentText,
          attachments,
          promptId,
        );
        // Clear the one-shot handoff only after the ACP prompt promise settles
        // successfully. If the bridge rejects before it reaches ACP, retain
        // the summary so the next real prompt can retry the handoff.
        promptPromise
          .then(() => {
            if (pendingCompactSummary) {
              store.clearPendingCompactSummary(
                taskId,
                pendingCompactSummary.raw,
              );
            }
          })
          .catch((err: unknown) => {
            plog.error("error", { taskId, error: err });
          })
          .finally(() => {
            // A turn that outlived its own supersession must not clear the
            // busy state of the turn that replaced it.
            tasks.endTurn(taskId, { promptId });
          });

        const acceptedBody = { status: "accepted" };
        saveClientOpResult(
          store,
          opId,
          taskId,
          HTTP_STATUS.ACCEPTED,
          acceptedBody,
        );
        json(res, HTTP_STATUS.ACCEPTED, acceptedBody);
        return;
      }

      // --- POST /api/v1/tasks/:id/bash ---
      const bashMatch = url.match(/^\/api\/v1\/tasks\/([^/]+)\/bash\/?$/);
      if (bashMatch && req.method === "POST") {
        const taskId = decodeURIComponent(bashMatch[1]);
        const task = store.getTask(taskId);
        if (!task) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
          return;
        }
        if (!tasks) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: "Task manager not available",
          });
          return;
        }
        if (tasks.runningBashProcs.has(taskId)) {
          json(res, HTTP_STATUS.CONFLICT, {
            error: "A bash command is already running in this task",
          });
          return;
        }

        let body: { command?: string };
        try {
          body = JSON.parse(await readBody(req)) as { command?: string };
        } catch {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
          return;
        }
        if (!body.command) {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "Missing required field: command",
          });
          return;
        }

        const cwd = tasks.getTaskCwd(taskId);
        store.saveEvent(
          taskId,
          "bash_command",
          { command: body.command },
          { from_ref: "user" },
        );
        const bashCmdEvent = {
          type: "bash_command",
          taskId,
          command: body.command,
        } as AgentEvent;
        sseManager.broadcast(bashCmdEvent);

        const shell = IS_WIN
          ? (process.env.COMSPEC ?? "cmd.exe")
          : (process.env.SHELL ?? "bash");
        const shellArgs = IS_WIN
          ? ["/s", "/c", body.command]
          : ["-c", body.command];
        const child = spawn(shell, shellArgs, {
          cwd,
          detached: !IS_WIN,
          env: { ...process.env, TERM: "dumb" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        tasks.runningBashProcs.set(taskId, child);
        tasks.syncBusy(taskId);
        let output = "";
        let outputTruncated = false;
        const limit = deps.limits.bash_output;

        const onData = (stream: string) => (chunk: Buffer) => {
          const text = chunk.toString();
          if (!outputTruncated) {
            output += text;
            if (output.length > limit) {
              output = output.slice(-limit);
              outputTruncated = true;
            }
          } else {
            output = (output + text).slice(-limit);
          }
          const bashOutEvent = {
            type: "bash_output",
            taskId,
            text,
            stream,
          } as AgentEvent;
          sseManager.broadcast(bashOutEvent);
        };
        child.stdout.on("data", onData("stdout"));
        child.stderr.on("data", onData("stderr"));

        child.on("close", (code, signal) => {
          tasks.releaseBashProc(taskId, child);
          tasks.syncBusy(taskId);
          const stored = outputTruncated ? "[truncated]\n" + output : output;
          store.saveEvent(
            taskId,
            "bash_result",
            { output: stored, code, signal },
            { from_ref: "system" },
          );
          const bashDoneEvent = {
            type: "bash_done",
            taskId,
            code,
            signal,
          } as AgentEvent;
          sseManager.broadcast(bashDoneEvent);
        });

        child.on("error", (err) => {
          tasks.releaseBashProc(taskId, child);
          tasks.syncBusy(taskId);
          const errMsg = errorMessage(err);
          store.saveEvent(
            taskId,
            "bash_result",
            { output: errMsg, code: -1, signal: null },
            { from_ref: "system" },
          );
          const bashErrEvent = {
            type: "bash_done",
            taskId,
            code: -1,
            signal: null,
            error: errMsg,
          } as AgentEvent;
          sseManager.broadcast(bashErrEvent);
        });

        json(res, HTTP_STATUS.ACCEPTED, { status: "accepted" });
        return;
      }

      // --- POST /api/v1/tasks/:id/bash/cancel ---
      const bashCancelMatch = url.match(
        /^\/api\/v1\/tasks\/([^/]+)\/bash\/cancel\/?$/,
      );
      if (bashCancelMatch && req.method === "POST") {
        const taskId = decodeURIComponent(bashCancelMatch[1]);
        const task = store.getTask(taskId);
        if (!task) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
          return;
        }
        // Ask the run to stop with a bounded escalation; the handle stays
        // registered until the process actually closes.
        tasks?.requestBashStop(taskId);
        json(res, HTTP_STATUS.OK, { ok: true });
        return;
      }

      // --- PUT /api/v1/tasks/:id/{model,mode,reasoning-effort} ---
      // --- PUT /api/v1/tasks/:id/config/:configId ---
      const legacyConfigPutMatch = url.match(
        /^\/api\/v1\/tasks\/([^/]+)\/(model|mode|reasoning-effort)\/?$/,
      );
      const genericConfigPutMatch = url.match(
        /^\/api\/v1\/tasks\/([^/]+)\/config\/([^/]+)\/?$/,
      );
      const configPutMatch = legacyConfigPutMatch ?? genericConfigPutMatch;
      if (configPutMatch && req.method === "PUT") {
        const taskId = decodeURIComponent(configPutMatch[1]);
        const configPath = decodeURIComponent(configPutMatch[2]);
        const configId = configPath.replace(/-/g, "_");
        const task = store.getTask(taskId);
        if (!task) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
          return;
        }
        if (!tasks) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: "Task manager not available",
          });
          return;
        }
        // The execution is captured before the body read. The request may
        // sit here while a `/clear` rotates the task, so the projection into
        // the agent's session is re-authorised below — the bridge would
        // otherwise resolve the *new* binding and send a config request for
        // this task into an execution that never asked for it.
        let execution;
        try {
          execution = await tasks.resolveTaskExecution(taskId);
        } catch (err) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error:
              err instanceof AgentUnavailableError
                ? "Agent is not available for this task"
                : errorMessage(err),
          });
          return;
        }
        const capturedLease = tasks.authority.leaseFor(taskId);
        let body: { value?: string | boolean };
        try {
          body = JSON.parse(await readBody(req)) as {
            value?: string | boolean;
          };
        } catch {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
          return;
        }
        if (body.value === undefined) {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "Missing required field: value",
          });
          return;
        }
        if (
          !tasks.authority.accepts(capturedLease) ||
          store.getBindingAgent(taskId) !== execution.agentId
        ) {
          json(res, HTTP_STATUS.CONFLICT, {
            error: "Task execution was replaced; retry the request",
          });
          return;
        }
        // A config write goes into the ACP session, so it waits for a restore
        // a read started instead of failing with "not connected". The lease is
        // re-checked afterwards, immediately before the call, so a rotation
        // that landed during the wait is still refused.
        try {
          await tasks.ensureResumed(execution.bridge, taskId);
        } catch (err) {
          json(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
            error: `Failed to resume task: ${errorMessage(err)}`,
          });
          return;
        }
        if (
          !tasks.authority.accepts(capturedLease) ||
          store.getBindingAgent(taskId) !== execution.agentId
        ) {
          json(res, HTTP_STATUS.CONFLICT, {
            error: "Task execution was replaced; retry the request",
          });
          return;
        }
        try {
          const configOptions = await execution.bridge.setConfigOption(
            taskId,
            configId,
            body.value,
          );
          for (const opt of configOptions) {
            if (typeof opt.currentValue === "string") {
              store.updateTaskConfig(taskId, opt.id, opt.currentValue);
            }
          }
          sseManager.broadcast({
            type: "config_option_update",
            taskId,
            configOptions,
          });
          const resolvedOption = configOptions.find(
            (option) => option.id === configId,
          );
          if (resolvedOption) {
            sseManager.broadcast({
              type: "config_set",
              taskId,
              configId,
              value: resolvedOption.currentValue,
            } as AgentEvent);
          }
          json(res, HTTP_STATUS.OK, { configOptions });
        } catch (err) {
          json(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
            error: `Failed to set ${configId}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return;
      }

      // --- PUT /api/v1/tasks/:id/title ---
      const titlePutMatch = url.match(/^\/api\/v1\/tasks\/([^/]+)\/title\/?$/);
      if (titlePutMatch && req.method === "PUT") {
        const taskId = decodeURIComponent(titlePutMatch[1]);
        const task = store.getTask(taskId);
        if (!task) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
          return;
        }
        let body: { value?: string };
        try {
          body = JSON.parse(await readBody(req)) as { value?: string };
        } catch {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
          return;
        }
        if (!body.value) {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "Missing required field: value",
          });
          return;
        }
        // The live sibling-title unique index turns an unguarded rename into
        // a thrown constraint error; validate the same grammar as creation
        // and reject collisions before the store sees them.
        const title = validateTaskTitle(body.value);
        if (title === null) {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error:
              "Title must be non-empty and must not be '.', '..', or contain '/'",
          });
          return;
        }
        if (
          task.parent_id !== null &&
          store
            // Rename collisions are a storage constraint across the whole
            // sibling set, including siblings inside an archived tree.
            .listTasks()
            .concat(store.listTasks({ archived: true }))
            .some(
              (live) =>
                live.parent_id === task.parent_id &&
                live.id !== task.id &&
                live.title === title,
            )
        ) {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "A sibling task already has that title",
          });
          return;
        }
        try {
          store.updateTaskTitle(taskId, title);
        } catch (err) {
          // A concurrent rename can still hit the partial unique index between
          // the check above and this write. Answer as a conflict, never as an
          // unhandled rejection.
          if (/UNIQUE constraint failed/i.test(String(err))) {
            json(res, HTTP_STATUS.BAD_REQUEST, {
              error: "A sibling task already has that title",
            });
            return;
          }
          throw err;
        }
        const titleEvent = {
          type: "task_title_updated",
          taskId,
          title,
        } as AgentEvent;
        sseManager.broadcast(titleEvent);
        json(res, HTTP_STATUS.OK, { title });
        return;
      }

      // POST /api/v1/tasks/bootstrap — atomically return the current
      // agent's latest task, creating one only when none exists.
      if (url === "/api/v1/tasks/bootstrap" && req.method === "POST") {
        if (!tasks) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: "Task manager not available",
          });
          return;
        }
        const taskManager = tasks;
        // A task is a persisted entity; only creating one needs an agent.
        // Resolving happens inside the (deduplicated) creation branch so
        // returning an existing task never starts a process.

        bootstrapTaskPromise ??= (async () => {
          // "Resume my task" is scoped to the default agent: the list is
          // global, so asking it globally could resume a task another agent
          // carries.
          const existing = store
            // Bootstrap resumes an active task only; an archived tree is not
            // a startup destination.
            .listTasks({
              agentId: taskManager.defaultAgentId,
            })
            .at(0);
          if (existing) {
            return {
              id: existing.id,
              ...activationFields(existing, { taskId: existing.id }),
              title: existing.title,
              source: existing.source,
              configOptions: [],
              agentCommands: taskManager.getAgentCommands(existing.id),
              created: false,
            };
          }

          // A Root that already has a real execution is a readable task even
          // when another agent (or an unavailable one) carries it. Returning
          // its metadata must not resolve anything: reading is not a reason to
          // start a process or to move the binding.
          const rootBinding = store.getCurrentExecutionBinding(
            store.rootTaskId,
          );
          const rootMaterialized =
            rootBinding !== undefined &&
            !isEmptyExecutionSlot(
              store.rootTaskId,
              rootBinding.agent_session_id,
            );
          if (rootMaterialized) {
            const root = store.getTask(store.rootTaskId);
            if (root) {
              return {
                id: root.id,
                ...activationFields(root, {
                  taskId: root.id,
                  agentId: rootBinding.agent_key,
                }),
                title: root.title,
                source: root.source,
                configOptions: [],
                agentCommands: taskManager.getAgentCommands(root.id),
                created: false,
              };
            }
          }

          // No task for the default agent, and the Root has no execution yet:
          // the workspace's first task is the Root anchor. Its first use
          // attaches one (never bound) or materializes its empty slot.
          const root = await taskManager.ensureRootLive();
          const result = {
            id: root.id,
            ...activationFields(root, { taskId: root.id }),
            title: root.title,
            source: root.source,
            configOptions: taskManager.applyStoredConfig(
              taskManager.configOptionsForTask(root.id),
              root,
            ),
            agentCommands: taskManager.getAgentCommands(root.id),
            created: true,
          };
          sseManager.broadcast({
            type: "task_created",
            taskId: root.id,
            cwd: result.cwd,
            cwdDisplay: result.cwdDisplay,
            title: result.title,
            parentId: result.parentId,
            parentAgentId: result.parentAgentId,
            agentId: result.agentId,
            configOptions: result.configOptions,
            agentCommands: result.agentCommands,
          });
          return result;
        })().finally(() => {
          bootstrapTaskPromise = null;
        });

        try {
          const result = await bootstrapTaskPromise;
          json(res, HTTP_STATUS.OK, {
            ...result,
            // A brand-new client needs the directory from this response alone:
            // it may not read /config again after bootstrapping.
            agents: agentDirectory(),
            defaultAgentId: taskManager.defaultAgentId,
            clientOpId: getClientOpId(req) ?? undefined,
          });
        } catch (err) {
          json(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      // POST /api/v1/tasks/:id/compact — generate a visible assistant
      // handoff, rotate the ACP execution, and defer injecting the handoff
      // until the next real user prompt.
      const compactTaskMatch = url.match(
        /^\/api\/v1\/tasks\/([^/?]+)\/compact\/?$/,
      );
      if (compactTaskMatch && req.method === "POST") {
        const taskId = decodeURIComponent(compactTaskMatch[1]);
        const task = store.getTask(taskId);
        if (!task) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
          return;
        }
        let compactGuidance: string | undefined;
        try {
          const body = JSON.parse(await readBody(req)) as {
            prompt?: unknown;
          };
          if (body.prompt !== undefined && typeof body.prompt !== "string") {
            json(res, HTTP_STATUS.BAD_REQUEST, {
              error: "Compact prompt must be a string",
            });
            return;
          }
          compactGuidance = body.prompt;
        } catch {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
          return;
        }
        if (!tasks) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: "Task manager not available",
          });
          return;
        }
        // `/compact` runs on the task's current execution with its current
        // session id; it never creates a second session of its own.
        let execution;
        try {
          execution = await tasks.resolveTaskExecution(taskId);
        } catch (err) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error:
              err instanceof AgentUnavailableError
                ? "Agent is not available for this task"
                : errorMessage(err),
          });
          return;
        }
        const bridge = execution.bridge;
        if (!bridge.promptForText) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: "Agent not ready yet",
          });
          return;
        }
        // Compaction needs the execution ready, so a restore that a read
        // started is awaited rather than reported as "cancel active work".
        // Anything genuinely busy is still refused by the check below.
        try {
          await tasks.ensureResumed(bridge, taskId);
        } catch (err) {
          json(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
            error: `Failed to resume task: ${errorMessage(err)}`,
          });
          return;
        }
        if (tasks.getGateBusyKind(taskId) !== null) {
          json(res, HTTP_STATUS.CONFLICT, {
            error: "Cancel active work before compacting the task",
          });
          return;
        }
        if (store.getPendingCompactSummary(taskId)) {
          json(res, HTTP_STATUS.CONFLICT, {
            error: "Task already has a pending compact summary",
          });
          return;
        }

        const submissionId = tasks.reservePromptSubmission(taskId);
        if (submissionId === null) {
          json(res, HTTP_STATUS.CONFLICT, {
            error: "Task is busy",
            busyKind: tasks.getGateBusyKind(taskId),
          });
          return;
        }
        const agentSessionId = store.getAgentSessionIdAt(
          taskId,
          execution.agentId,
        );
        // A placeholder slot is not an execution, even though it is a row.
        if (!agentSessionId || isEmptyExecutionSlot(taskId, agentSessionId)) {
          tasks.releasePromptSubmission(taskId, submissionId);
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: "Task is not available for the current agent",
          });
          return;
        }
        const promptForText = bridge.promptForText;

        tasks.compactingTasks.add(taskId);
        tasks.releasePromptSubmission(taskId, submissionId, false);
        // `/compact` reaches the same ACP prompt slot as a normal prompt because
        // it submits a silent prompt (`promptForText`) to the task's execution,
        // so it holds a turn of its own — and `promptForText` never emits a turn
        // terminator, so this path must close it in its own `finally`.
        // `/clear` is the opposite case: it submits no prompt, it replaces the
        // execution, which *ends* the turn (`resetTaskRuntime`) instead of
        // opening one. It still leaves a transcript record (`agent_rotation`
        // system message, "history and outstanding work are unchanged"); the
        // agent recovers the earlier turns through the MCP history tools, which
        // the new session is told about at `initialize`, not through a prompt.
        tasks.beginAgentTurn(taskId, {
          origin: "interactive",
          submissionId,
        });
        tasks.notePromptSubmitted(taskId);
        const previousAgentSessionId = agentSessionId;

        void (async () => {
          let summary = "";
          try {
            summary = (
              await promptForText.call(
                bridge,
                agentSessionId,
                buildCompactSummaryPrompt(compactGuidance),
              )
            ).trim();
            if (!summary) throw new Error("Agent returned an empty summary");

            const summaryEvent = store.saveCompactSummary(taskId, summary);
            sseManager.broadcast({
              type: "assistant_message",
              taskId,
              text: summary,
              seq: summaryEvent.seq,
            });

            const clearResult = await tasks.clearTask(
              bridge,
              taskId,
              undefined,
              {
                preservePendingCompactSummary: true,
                preserveRuntimeState: true,
                // This turn owns the task's busy state; the rotation is its
                // own controlled internal path.
                allowCompacting: true,
                // Compaction is a rotation too: it leaves its own transcript
                // line instead of being an unrecorded internal replacement.
                reason: "compact",
              },
            );
            tasks.state.patch(taskId, {
              runtime: {
                streaming: { assistant: false, thinking: false },
                pendingPermissions: [],
                plan: null,
                contextUsage: null,
              },
            });
            // Clear the compaction busy source through syncBusy so a delivery
            // queued during rotation gets the normal busy→idle recovery edge.
            tasks.compactingTasks.delete(taskId);
            tasks.syncBusy(taskId);

            const fresh = store.getTask(taskId);
            if (!fresh) throw new Error("Task disappeared during compaction");
            sseManager.broadcast({
              type: "task_created",
              taskId,
              ...activationFields(fresh, { taskId }),
              title: fresh.title,
              configOptions: clearResult.configOptions,
              agentCommands: tasks.getAgentCommands(taskId),
            } satisfies AgentEvent);
          } catch (err) {
            // If rotation did not move the binding, the old ACP execution is
            // still current and must not receive this handoff on its next turn.
            if (
              summary &&
              store.getAgentSessionId(taskId) === previousAgentSessionId
            ) {
              store.clearPendingCompactSummary(taskId, summary);
            }
            const message = `Compact failed: ${errorMessage(err)}`;
            // The task may have been deleted mid-compaction (cascade); the
            // FK rejects writes to a removed row, so make the error event
            // optional and keep the SSE broadcast authoritative.
            try {
              store.saveEvent(
                taskId,
                "error",
                { message },
                {
                  from_ref: "system",
                },
              );
            } catch {
              // Task is gone; nothing durable to write.
            }
            sseManager.broadcast({
              type: "error",
              taskId,
              message,
            });
          } finally {
            // Close the turn here: compaction's busy sources are released in one
            // patch, so the slot itself must not re-project busy first.
            tasks.endTurn(taskId, { sync: false });
            tasks.compactingTasks.delete(taskId);
            tasks.syncBusy(taskId);
          }
        })();

        json(res, HTTP_STATUS.ACCEPTED, { status: "accepted" });
        return;
      }

      // POST /api/v1/tasks/:id/clear — rotate the ACP execution while
      // preserving the stable WebAgent task identity and its records.
      const clearTaskMatch = url.match(
        /^\/api\/v1\/tasks\/([^/?]+)\/clear\/?$/,
      );
      if (clearTaskMatch && req.method === "POST") {
        const taskId = decodeURIComponent(clearTaskMatch[1]);
        const task = store.getTask(taskId);
        if (!task) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
          return;
        }
        if (!tasks) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: "Task manager not available",
          });
          return;
        }
        if (tasks.getGateBusyKind(taskId) !== null) {
          json(res, HTTP_STATUS.CONFLICT, {
            error: "Cancel active work before clearing the task",
          });
          return;
        }
        let body: { cwd?: string; agentId?: unknown } = {};
        try {
          const raw = await readBody(req);
          if (raw) body = JSON.parse(raw) as typeof body;
        } catch {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
          return;
        }
        if (body.agentId !== undefined && typeof body.agentId !== "string") {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "agentId must be a string",
          });
          return;
        }
        // Rescue target: an explicitly named configured agent, otherwise the
        // task's own binding agent, otherwise the default. A binding agent
        // that left the configuration is replaced by the default.
        const boundAgent = store.getBindingAgent(taskId);
        const targetAgentId =
          body.agentId ??
          (boundAgent && tasks.isAgentConfigured(boundAgent)
            ? boundAgent
            : tasks.defaultAgentId);
        if (!tasks.isAgentConfigured(targetAgentId)) {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: `Agent ${targetAgentId} is not configured`,
          });
          return;
        }
        let bridge;
        try {
          bridge = await tasks.resolveAgentTransport(targetAgentId);
        } catch (err) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: `Agent ${targetAgentId} is not available: ${errorMessage(err)}`,
            // The target was chosen by the server (explicit, bound, or
            // default), so the caller cannot always know which agent it tried.
            // Naming it lets a rescue exclude the agent that just failed.
            agentId: targetAgentId,
          });
          return;
        }
        try {
          const result = await tasks.clearTask(bridge, taskId, body.cwd, {
            // Explicit rotation: same transition as an implicit takeover, with
            // the trigger recorded in the transcript.
            reason: "explicit_clear",
          });
          const fresh = store.getTask(taskId)!;
          const event = {
            type: "task_created",
            taskId,
            ...activationFields(fresh, { taskId }),
            title: fresh.title,
            configOptions: result.configOptions,
            agentCommands: tasks.getAgentCommands(taskId),
          } satisfies AgentEvent;
          sseManager.broadcast(event);
          json(res, HTTP_STATUS.OK, {
            id: taskId,
            ...activationFields(fresh, { taskId }),
            title: fresh.title,
            source: fresh.source,
            configOptions: result.configOptions,
            agentCommands: tasks.getAgentCommands(taskId),
          });
        } catch (err) {
          if (err instanceof TaskBusyError) {
            json(res, HTTP_STATUS.CONFLICT, { error: err.message });
            return;
          }
          if (err instanceof TaskNotFoundError) {
            json(res, HTTP_STATUS.NOT_FOUND, { error: err.message });
            return;
          }
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      // POST /api/v1/tasks/:id/archive — detach the task (and therefore its
      // whole subtree) from the tree by clearing `parent_id`. Nothing marks
      // the row; the one record written is a system message on the detached
      // task naming the parent it came from. `POST .../unarchive` can undo it.
      const archiveMatch = url.match(
        /^\/api\/v1\/tasks\/([^/]+)\/archive\/?(?:\?.*)?$/,
      );
      if (archiveMatch && req.method === "POST") {
        const taskId = decodeURIComponent(archiveMatch[1]);
        const task = store.getTask(taskId);
        if (!task) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
          return;
        }
        if (store.isRootTaskId(taskId)) {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "Root cannot be archived",
          });
          return;
        }
        // A debt to the former parent does not block archiving. Archiving cuts
        // that edge, so a later task_update is recorded but not delivered to a
        // parent the task no longer belongs to. The response warns the caller.
        const pendingAccount =
          task.parent_id !== null &&
          tasks?.hasOpenObligation(task.parent_id, taskId) === true;
        let result: ReturnType<typeof store.archiveTask>;
        try {
          // With a manager, the store transaction and the post-commit memory
          // cleanup are one operation; without one (headless store users) only
          // the transaction applies and no in-memory edge exists.
          result = tasks
            ? tasks.archiveTask(taskId)
            : store.archiveTask(taskId);
        } catch (err) {
          // The store's transaction rolls back on its own; report a diagnosable
          // API error instead of an unhandled rejection.
          json(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
            error: `Archive failed: ${errorMessage(err)}`,
          });
          return;
        }
        if (!result) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
          return;
        }
        if (result.status === "archived") {
          if (result.message) {
            sseManager.broadcast({
              type: "system_message",
              taskId,
              kind: result.message.kind,
              title: result.message.title,
              body: result.message.body,
            });
          }
        }
        json(res, HTTP_STATUS.OK, {
          status: result.status,
          taskId,
          parentId: result.parentId,
          parentPath: result.parentPath,
          pendingAccount,
        });
        return;
      }

      // POST /api/v1/tasks/:id/unarchive — re-attach an archived tree top
      // under the parent recorded by its latest task_archive message.
      const unarchiveMatch = url.match(
        /^\/api\/v1\/tasks\/([^/]+)\/unarchive\/?(?:\?.*)?$/,
      );
      if (unarchiveMatch && req.method === "POST") {
        const taskId = decodeURIComponent(unarchiveMatch[1]);
        let result: ReturnType<typeof store.unarchiveTask>;
        try {
          result = (tasks ?? store).unarchiveTask(taskId);
        } catch (err) {
          if (/UNIQUE constraint failed/i.test(String(err))) {
            json(res, HTTP_STATUS.CONFLICT, {
              error:
                "A task with that title already exists under the original parent",
              reason: "title_conflict",
            });
            return;
          }
          json(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
            error: `Unarchive failed: ${errorMessage(err)}`,
          });
          return;
        }
        if (result.status === "not_found") {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
          return;
        }
        if (result.status === "not_archived") {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "Only an archived tree top can be unarchived",
          });
          return;
        }
        if (result.status === "conflict") {
          const conflictMessage = {
            original_parent_unavailable:
              "The original parent is inside an archived tree; restore that tree first",
            title_conflict:
              "A task with that title already exists under the destination parent",
          }[result.reason];
          json(res, HTTP_STATUS.CONFLICT, {
            error: conflictMessage,
            reason: result.reason,
          });
          return;
        }
        sseManager.broadcast({
          type: "system_message",
          taskId,
          kind: result.message.kind,
          title: result.message.title,
          body: result.message.body,
        });
        json(res, HTTP_STATUS.OK, {
          status: result.status,
          taskId,
          parentId: result.parentId,
          parentPath: result.parentPath,
        });
        return;
      }

      // --- Task CRUD: /api/v1/tasks/:id ---
      const taskIdMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)\/?$/);
      if (taskIdMatch) {
        const taskId = decodeURIComponent(taskIdMatch[1]);

        // POST /api/v1/tasks (create) — handled below since :id would match "tasks" literally
        // This match is for /api/v1/tasks/:id only (not /api/tasks)

        // GET /api/v1/tasks/:id
        if (req.method === "GET") {
          const warm = requestParams.get("warm") === "1";
          const task = store.getTask(taskId);
          if (!task) {
            json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
            return;
          }
          // A plain detail read returns only currently known metadata. A
          // requested warm retains the browser's previous behavior.
          const wasLive = tasks?.liveTasks.has(taskId) ?? true;
          if (tasks && warm && !wasLive) tasks.warmTaskInBackground(taskId);
          const freshTask = store.getTask(taskId) ?? task;
          const configOptions = tasks
            ? tasks.applyStoredConfig(
                tasks.configOptionsForTask(freshTask.id),
                freshTask,
                { persist: warm },
              )
            : [];
          json(
            res,
            HTTP_STATUS.OK,
            {
              id: freshTask.id,
              ...activationFields(freshTask, { taskId: freshTask.id }),
              title: freshTask.title,
              source: freshTask.source,
              model: freshTask.model,
              mode: freshTask.mode,
              workflowStatus: freshTask.workflow_status,
              archived: store.isArchivedTask(freshTask.id),
              configOptions,
            },
            req,
          );
          return;
        }

        // DELETE /api/v1/tasks/:id
        if (req.method === "DELETE") {
          await handleDeleteTaskRoute({
            req,
            res,
            taskId,
            principal: getPrincipal(req),
            clientOpId: getClientOpId(req),
            store,
            tasks,
            sseManager,
            activationFields,
            json,
          });
          return;
        }
      }

      // POST /api/v1/tasks (create new task)
      if (url === "/api/v1/tasks" && req.method === "POST") {
        const clientOpId = getClientOpId(req);
        const taskOps = deps.taskOps;
        if (!tasks || !taskOps) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: "Task manager not available",
          });
          return;
        }
        let body: {
          cwd?: string;
          inheritFromTaskId?: string;
          source?: string;
          parentId?: string;
          title?: string;
          agentId?: string;
          host?: string;
        };
        try {
          const raw = JSON.parse(await readBody(req)) as unknown;
          const parsed = TaskCreateCoordinateSchema.safeParse(raw);
          if (!parsed.success) {
            const field = parsed.error.issues[0]?.path[0];
            json(res, HTTP_STATUS.BAD_REQUEST, {
              error: `${field === "host" ? "host" : "agentId"} must be a string`,
            });
            return;
          }
          body = raw as typeof body;
        } catch {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
          return;
        }
        const requestPrincipal = principalByRequest.get(req);
        const source = body.source ?? "auto";
        const title =
          body.title !== undefined ? validateTaskTitle(body.title) : undefined;
        if (
          title !== undefined &&
          (title === null ||
            (!body.parentId && requestPrincipal?.scope !== "host"))
        ) {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "a named child needs a non-empty title and a parent",
          });
          return;
        }
        try {
          const created = await taskOps.create(
            requestPrincipal?.scope === "host"
              ? { kind: "host", name: requestPrincipal.name }
              : { kind: "user", tokenName: requestPrincipal?.name },
            {
              cwd: body.cwd,
              inheritFromTaskId: body.inheritFromTaskId,
              source,
              parentId: body.parentId,
              title: title ?? undefined,
              workflowStatus: title ? "idle" : undefined,
              agentId: body.agentId,
              host: body.host,
              opId: clientOpId,
            },
          );
          const session = created.session;
          if (!session) throw new Error("missing_create_session");
          json(res, HTTP_STATUS.CREATED, {
            id: created.task.id,
            cwd: created.task.cwd,
            cwdDisplay: session.cwdDisplay,
            parentId: created.task.parentId,
            parentAgentId: session.parentAgentId,
            agentId: created.task.agentId,
            title: created.task.title,
            ...(requestPrincipal?.scope === "host"
              ? {
                  model: created.task.model,
                  thinking: created.task.thinking,
                }
              : {}),
            workflowStatus: created.task.workflowStatus,
            source: created.task.source,
            configOptions: session.configOptions,
            agentCommands: session.agentCommands,
            clientOpId: clientOpId ?? undefined,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isTaskCreateError(err)) {
            const classified = err;
            switch (classified.kind) {
              case "input":
                json(res, HTTP_STATUS.BAD_REQUEST, {
                  error: classified.clientMessage,
                  code: classified.code,
                });
                return;
              case "conflict":
                json(res, HTTP_STATUS.CONFLICT, {
                  error: classified.message,
                });
                return;
              case "deleted":
                json(res, HTTP_STATUS.NOT_FOUND, {
                  error: classified.message,
                });
                return;
              case "agent_not_configured":
                json(res, HTTP_STATUS.BAD_REQUEST, {
                  error: `Agent ${classified.agentId} is not configured`,
                });
                return;
              case "agent_start":
                json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
                  error: classified.unavailable
                    ? `Agent ${classified.agentId} is not available: ${classified.reason}`
                    : classified.reason,
                  agentId: classified.agentId,
                });
                return;
              case "host_not_configured":
                json(res, HTTP_STATUS.BAD_REQUEST, {
                  error: `Host ${classified.host} is not configured`,
                });
                return;
              case "remote_config":
                json(res, HTTP_STATUS.BAD_REQUEST, {
                  error: `Remote task creation does not support ${classified.logicalId} overrides`,
                });
                return;
              case "rejected":
                json(res, HTTP_STATUS.BAD_GATEWAY, {
                  error: classified.reason,
                  host: classified.host,
                  remoteStatus: classified.status,
                  outcome: "rejected",
                });
                return;
              case "not_sent":
                json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
                  error: `Remote task request was not sent: ${classified.reason}`,
                  host: classified.host,
                  outcome: "not_sent",
                });
                return;
              case "unknown":
                json(res, HTTP_STATUS.BAD_GATEWAY, {
                  error: "Remote task creation result is unknown",
                  reason: classified.reason,
                  host: classified.host,
                  outcome: "unknown",
                });
                return;
              case "partial_success":
                json(res, HTTP_STATUS.BAD_GATEWAY, {
                  error:
                    "Remote task was created, but the local link could not be registered",
                  host: classified.host,
                  remoteTaskId: classified.remoteTaskId,
                  outcome: "partial_success",
                });
                return;
              case "config":
                break;
            }
          }
          if (msg === "parent_not_found") {
            json(res, HTTP_STATUS.BAD_REQUEST, {
              error: "Parent task not found",
            });
          } else if (
            err instanceof InvalidTaskDirectoryError ||
            err instanceof TaskNotFoundError
          ) {
            json(res, HTTP_STATUS.BAD_REQUEST, { error: msg });
          } else if (err instanceof TaskTreeBusyError) {
            json(res, HTTP_STATUS.CONFLICT, { error: msg });
          } else if (
            msg.includes(
              "UNIQUE constraint failed: tasks.parent_id, tasks.title",
            )
          ) {
            json(res, HTTP_STATUS.BAD_REQUEST, {
              error: "A sibling task already has that title",
            });
          } else {
            json(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, { error: msg });
          }
        }
        return;
      }

      // GET /api/v1/tasks/:id/events?thinking=0|1&limit=N&before=SEQ&after=SEQ
      const eventsMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)\/events$/);
      if (eventsMatch && req.method === "GET") {
        const taskId = decodeURIComponent(eventsMatch[1]);
        const flush = requestParams.get("flush") === "1";
        const excludeThinking = requestParams.get("thinking") === "0";
        const afterRaw = requestParams.get("after");
        const afterSeq = afterRaw != null ? Number(afterRaw) : undefined;
        const beforeRaw = requestParams.get("before");
        const beforeSeq = beforeRaw != null ? Number(beforeRaw) : undefined;
        const limitRaw = requestParams.get("limit");
        const limit =
          limitRaw != null
            ? Math.max(1, Math.min(10000, Number(limitRaw)))
            : undefined;
        const task = store.getTask(taskId);
        const principal = principalByRequest.get(req);
        const externalParent =
          principal?.scope === "host"
            ? store.getExternalParentLink(taskId)
            : null;
        if (
          !task ||
          (principal?.scope === "host" &&
            externalParent?.remote_host !== principal.name)
        ) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
          return;
        }
        // Flushing is explicit because it writes events and advances seq. Track
        // whether each buffer was non-empty so the browser can keep the last
        // thinking/assistant element open for continued live streaming.
        let streamingThinking = false;
        let streamingAssistant = false;
        if (tasks && flush) {
          const runtimeStreaming = tasks.state.peekStreaming(taskId);
          streamingThinking =
            runtimeStreaming.thinking ||
            Boolean(tasks.thinkingBuffers.get(taskId));
          streamingAssistant =
            runtimeStreaming.assistant ||
            Boolean(tasks.assistantBuffers.get(taskId));
          tasks.flushThinkingBuffer(taskId);
          tasks.flushAssistantBuffer(taskId);
        }
        const allEvents = store.getEvents(taskId);
        const events = store.getEvents(taskId, {
          excludeThinking,
          afterSeq,
          beforeSeq,
          limit,
        });
        // Derive the sender's delivery mark from the deliveries row. The event
        // is never rewritten in storage.
        attachCollaborationDeliveryStatus(events, (messageIds) => {
          const rows = store.getCollaborationDeliveriesForMessages(messageIds);
          return new Map(
            [...rows].map(([messageId, row]) => [
              messageId,
              {
                status: row.status,
                deliveredAt: row.delivered_at,
                failureReason: row.failure_reason,
              },
            ]),
          );
        });
        // Replace internal uuid attachment paths with `<name> [#<id4>]`
        // labels at egress (CLAUDE.md "Attachment label egress
        // rewrite"). DB rows still hold raw paths.
        if (tasks) {
          enrichStoredEventsForDisplay(events, tasks.getLabelMap(taskId));
        }
        // Re-sign image URLs at egress so 1h-old stored URLs become valid
        // again — the user can reload history days later and images still
        // resolve. Mutates `data` in-place; safe because store.getEvents
        // returns fresh records.
        if (deps.attachmentSecret) {
          for (const ev of events) {
            if (
              typeof ev.data === "string" &&
              ev.data.includes("/attachments/")
            ) {
              ev.data = reSignAttachmentUrlsInJson(
                ev.data,
                deps.attachmentSecret,
              );
            }
          }
        }
        const envelope: Record<string, unknown> = {
          events: events.map((event) => ({
            ...event,
            created_at: isoFromMillis(event.created_at),
          })),
          streaming: {
            thinking: streamingThinking,
            assistant: streamingAssistant,
          },
          imageReferences: (() => {
            const projected = projectMarkdownImageReferences(
              store,
              taskId,
              allEvents,
            );
            if (!deps.attachmentSecret) return projected;
            return JSON.parse(
              reSignAttachmentUrlsInJson(
                JSON.stringify(projected),
                deps.attachmentSecret,
              ),
            ) as unknown;
          })(),
        };
        if (limit != null) {
          const total = store.getEventCount(taskId, { excludeThinking });
          const hasMore =
            events.length > 0
              ? store.getEvents(taskId, {
                  excludeThinking,
                  beforeSeq: events[0].seq,
                  limit: 1,
                }).length > 0
              : false;
          envelope.total = total;
          envelope.hasMore = hasMore;
        }
        json(res, HTTP_STATUS.OK, envelope, req);
        return;
      }

      // --- SSE stream endpoints ---

      // GET /api/v1/events/stream — global SSE stream
      if (url.startsWith("/api/v1/events/stream") && req.method === "GET") {
        // Ticket-based auth (EventSource cannot send Authorization header).
        // When authStore is configured, every SSE connection MUST present a
        // valid single-use ticket from POST /api/v1/sse-ticket.
        let tokenName: string | undefined;
        const receiveBusinessEvents = true;
        if (deps.authStore) {
          const ticket =
            new URLSearchParams(url.split("?")[1] ?? "").get("ticket") ?? "";
          const principal = deps.ticketStore?.consume(ticket);
          if (!principal) {
            json(res, HTTP_STATUS.UNAUTHORIZED, {
              error: "Invalid or expired ticket",
            });
            return;
          }
          if (principal.scope === "host") {
            json(res, HTTP_STATUS.FORBIDDEN, { error: "Forbidden" });
            return;
          }
          tokenName = principal.tokenName;
        }

        const clientId = sseManager.generateClientId();

        res.writeHead(HTTP_STATUS.OK, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const client: import("../sse-manager.ts").SseClient = {
          id: clientId,
          res,
          tokenName,
          receiveBusinessEvents,
        };
        sseManager.add(client);

        // Send connected event
        const pendingCount = store.countUnprocessed();
        sseManager.sendEvent(client, {
          type: "connected",
          clientId,
          debugLevel: deps.debugLevel ?? "off",
          pendingCount,
        } as unknown as AgentEvent);
        sseManager.writeHeartbeat(client);
        return;
      }

      // GET /api/v1/tasks/:id/events/stream — per-task SSE stream
      const sseTaskMatch = url.match(
        /^\/api\/v1\/tasks\/([^/]+)\/events\/stream(\?.*)?$/,
      );
      if (sseTaskMatch && req.method === "GET") {
        const taskId = decodeURIComponent(sseTaskMatch[1]);

        let tokenName: string | undefined;
        let scope: Scope | undefined;
        if (deps.authStore) {
          const ticket =
            new URLSearchParams(url.split("?")[1] ?? "").get("ticket") ?? "";
          const principal = deps.ticketStore?.consume(ticket);
          if (!principal) {
            json(res, HTTP_STATUS.UNAUTHORIZED, {
              error: "Invalid or expired ticket",
            });
            return;
          }
          tokenName = principal.tokenName;
          scope = principal.scope;
          if (scope === "host") {
            json(res, HTTP_STATUS.FORBIDDEN, {
              error: "Host tickets cannot subscribe to task events",
            });
            return;
          }
        }

        const task = store.getTask(taskId);
        if (!task) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Task not found" });
          return;
        }

        const clientId = sseManager.generateClientId();
        res.writeHead(HTTP_STATUS.OK, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Host-Connection-Id": clientId,
        });

        const client: import("../sse-manager.ts").SseClient = {
          id: clientId,
          res,
          taskId,
          tokenName,
        };
        sseManager.add(client);

        // Send connected event
        sseManager.sendEvent(client, {
          type: "connected",
          clientId,
          debugLevel: deps.debugLevel ?? "off",
          pendingCount: store.countUnprocessed(),
        } as unknown as AgentEvent);
        sseManager.writeHeartbeat(client);

        // Replay events from Last-Event-ID if provided
        const lastEventId = req.headers["last-event-id"];
        if (lastEventId) {
          const afterSeq = parseInt(lastEventId as string, 10);
          if (!isNaN(afterSeq)) {
            const events = store.getEvents(taskId, { afterSeq });
            for (const evt of events) {
              try {
                sseManager.sendEvent(
                  client,
                  {
                    type: evt.type as AgentEvent["type"],
                    ...(JSON.parse(evt.data) as Record<string, unknown>),
                  } as AgentEvent,
                  evt.seq,
                );
              } catch {
                // Skip malformed event data
              }
            }
          }
        }
        return;
      }

      // --- Attachments (task-scoped) ---

      // POST /api/v1/tasks/:id/attachments — multipart/form-data upload.
      //
      // Wire format: a single `file` field. busboy streams chunks straight
      // to <data_dir>/tasks/<sid>/attachments/<uuid>.<ext>.tmp; on close
      // we atomic-rename to the final name and insert an attachments row.
      // Aborts / mid-stream errors / oversize / wrong field name all leave
      // the .tmp removed before responding.
      const imgUploadMatch = url.match(
        /^\/api\/v1\/tasks\/([^/]+)\/attachments\/?$/,
      );
      if (imgUploadMatch && req.method === "POST") {
        const taskId = decodeURIComponent(imgUploadMatch[1]);
        if (!SAFE_ID.test(taskId)) {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid task ID" });
          return;
        }
        const ctype = req.headers["content-type"] ?? "";
        if (!ctype.toLowerCase().startsWith("multipart/form-data")) {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "Expected multipart/form-data",
          });
          return;
        }
        await handleAttachmentUpload(req, res, taskId, deps);
        return;
      }

      // GET /api/v1/tasks/:id/attachments/:file — serve a previously
      // uploaded attachment. Mime + displayName are looked up from the
      // attachments table so the response carries the original filename
      // (RFC 5987) and the per-mime inline/attachment disposition.
      const imgGetMatch = url.match(
        /^\/api\/v1\/tasks\/([^/]+)\/attachments\/([^/?]+)(\?.*)?$/,
      );
      if (imgGetMatch && req.method === "GET") {
        const taskId = decodeURIComponent(imgGetMatch[1]);
        const file = decodeURIComponent(imgGetMatch[2]);
        // When secret is configured, GET requires sig+exp in query — there
        // is no Bearer fallback because <img src=...> / <a href=...> can't
        // carry headers. Verify before any disk I/O.
        if (deps.attachmentSecret) {
          const params = new URLSearchParams(url.split("?")[1] ?? "");
          const sig = params.get("sig") ?? "";
          const exp = params.get("exp") ?? "";
          const basePath = `/api/v1/tasks/${taskId}/attachments/${file}`;
          if (!verifyAttachmentSig(basePath, exp, sig, deps.attachmentSecret)) {
            res.writeHead(HTTP_STATUS.UNAUTHORIZED, {
              "Content-Type": "application/json",
            });
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return;
          }
        }
        const filePath = join(
          deps.dataDir,
          "tasks",
          taskId,
          "attachments",
          file,
        );
        if (!filePath.startsWith(join(deps.dataDir, "tasks"))) {
          res.writeHead(HTTP_STATUS.FORBIDDEN);
          res.end("Forbidden");
          return;
        }
        // Look up the row to recover the original mime + display name.
        // Pre-attachments-table uploads (none in v0.4+) would miss here;
        // we degrade gracefully to extension-based mime.
        const row = store.getAttachmentByFile(taskId, file);
        try {
          const fileData = await readFile(filePath);
          const mime =
            row?.mime ??
            (MIME[extname(filePath)] || "application/octet-stream");
          const headers: Record<string, string> = {
            "Content-Type": mime,
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
          };
          if (row) {
            const disposition = isInlineMime(mime) ? "inline" : "attachment";
            headers["Content-Disposition"] = buildContentDisposition(
              disposition,
              row.name,
            );
          }
          res.writeHead(HTTP_STATUS.OK, headers);
          res.end(fileData);
        } catch {
          res.writeHead(HTTP_STATUS.NOT_FOUND);
          res.end("Not found");
        }
        return;
      }

      // --- Inbox messages (Stage B primitive) ---

      // POST /api/v1/messages — create ingress message
      if (url === "/api/v1/messages" && req.method === "POST") {
        // client-server-split M2: idempotency for the ingress message
        // creator. /messages has no real task id, so we scope the
        // cache under the synthetic key "__ingress__".
        const { opId, replayed } = tryReplayClientOp(
          req,
          res,
          store,
          "__ingress__",
        );
        if (replayed) return;

        let raw: string;
        try {
          raw = await readBody(req);
        } catch {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Failed to read body" });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
          return;
        }
        const validation = MessageIngressSchema.safeParse(parsed);
        if (!validation.success) {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "Invalid body",
            issues: validation.error.issues,
          });
          return;
        }
        const input = validation.data;
        const id = `msg-${randomUUID().replace(/-/g, "").slice(0, 16)}`;

        if (input.to.startsWith("task:")) {
          const targetSid = input.to.slice("task:".length);
          const task = store.getTask(targetSid);
          if (!task) {
            json(res, HTTP_STATUS.BAD_REQUEST, { error: "task_not_found" });
            return;
          }
          tasks?.flushBuffers(targetSid);
          const data = {
            message_id: id,
            from_ref: input.from_ref,
            from_label: input.from_label ?? null,
            title: input.title,
            body: input.body,
            cwd: input.cwd ?? null,
          };
          store.saveEvent(targetSid, "message", data, {
            from_ref: input.from_ref,
          });
          sseManager.broadcast({
            type: "message",
            taskId: targetSid,
            ...data,
          });
          if (deps.pushService) {
            void deps.pushService.sendForMessage({
              id,
              to: input.to,
              body: input.body,
              from_label: input.from_label,
              from_ref: input.from_ref,
              deliver: input.deliver,
              dedup_key: input.dedup_key ?? null,
            });
          }
          mlog.info("ingress bound", {
            msg_id: id,
            sess_id: targetSid.slice(0, 8),
          });
          const boundBody = { id, delivered: "task" };
          saveClientOpResult(
            store,
            opId,
            "__ingress__",
            HTTP_STATUS.OK,
            boundBody,
          );
          json(res, HTTP_STATUS.OK, boundBody);
          return;
        }

        // Unbound: to=user → rows in `messages` table
        const dedupKey = input.dedup_key ?? null;
        if (dedupKey) {
          const prior = store.findBySupersede(input.to, dedupKey);
          if (prior) {
            store.deleteMessage(prior.id);
            mlog.info("dedup_key supersede", {
              to: input.to,
              dedup_key: dedupKey,
              old_msg_id: prior.id,
              new_msg_id: id,
            });
          }
        }
        store.createMessage({
          id,
          from_ref: input.from_ref,
          from_label: input.from_label ?? null,
          to_ref: input.to,
          deliver: input.deliver,
          dedup_key: dedupKey,
          title: input.title,
          body: input.body,
          cwd: input.cwd ?? null,
          created_at: Date.now(),
        });
        sseManager.broadcast({ type: "message_created", messageId: id });
        broadcastInboxCount(store, sseManager);
        if (deps.pushService) {
          void deps.pushService.sendForMessage({
            id,
            to: input.to,
            body: input.body,
            from_label: input.from_label,
            from_ref: input.from_ref,
            deliver: input.deliver,
            dedup_key: dedupKey,
          });
        }
        mlog.info("ingress unbound", {
          msg_id: id,
          from_ref: input.from_ref,
        });
        const unboundBody = { id, delivered: "pending" };
        saveClientOpResult(
          store,
          opId,
          "__ingress__",
          HTTP_STATUS.OK,
          unboundBody,
        );
        json(res, HTTP_STATUS.OK, unboundBody);
        return;
      }

      // GET /api/v1/messages — list unprocessed
      if (url === "/api/v1/messages" && req.method === "GET") {
        json(res, HTTP_STATUS.OK, {
          messages: store.listUnprocessed().map((message) => ({
            ...message,
            created_at: isoFromMillis(message.created_at),
          })),
        });
        return;
      }

      // /api/v1/messages/:id... — GET single, POST :id/consume, POST :id/ack, DELETE :id
      if (url.startsWith("/api/v1/messages/")) {
        const tail = url.slice("/api/v1/messages/".length);

        const consumeMatch = tail.match(/^([^/?]+)\/consume\/?$/);
        if (consumeMatch && req.method === "POST") {
          const id = decodeURIComponent(consumeMatch[1]);
          let inheritFromTaskId: string | undefined;
          try {
            const rawBody = await readBody(req);
            if (rawBody) {
              const body = JSON.parse(rawBody) as Record<string, unknown>;
              if (
                body.inheritFromTaskId !== undefined &&
                typeof body.inheritFromTaskId !== "string"
              ) {
                json(res, HTTP_STATUS.BAD_REQUEST, {
                  error: "inheritFromTaskId must be a string",
                });
                return;
              }
              inheritFromTaskId = body.inheritFromTaskId;
            }
          } catch {
            json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
            return;
          }
          if (!tasks) {
            json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
              error: "Task manager not available",
            });
            return;
          }
          // Materializing an inbox message creates a task, so it targets the
          // configured default agent; an unavailable one is an explicit error.
          let bridge;
          try {
            bridge = await tasks.resolveDefaultTransport();
          } catch (err) {
            json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
              error: `Agent not available: ${errorMessage(err)}`,
            });
            return;
          }
          let out: {
            taskId: string;
            alreadyConsumed: boolean;
          } | null;
          try {
            out = await tasks.consumeMessage(bridge, id, inheritFromTaskId);
          } catch (err) {
            if (err instanceof InvalidTaskDirectoryError) {
              json(res, HTTP_STATUS.BAD_REQUEST, {
                error: err.message,
              });
              return;
            }
            json(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
              error: errorMessage(err),
            });
            return;
          }
          if (!out) {
            json(res, HTTP_STATUS.NOT_FOUND, { error: "Message not found" });
            return;
          }
          sseManager.broadcast({
            type: "message_consumed",
            messageId: id,
            taskId: out.taskId,
          });
          broadcastInboxCount(store, sseManager);
          if (!out.alreadyConsumed && deps.pushService) {
            void deps.pushService.sendClose(id);
          }
          mlog.info("consume", {
            msg_id: id,
            sess_id: out.taskId.slice(0, 8),
            already_consumed: out.alreadyConsumed,
          });
          json(res, HTTP_STATUS.OK, {
            taskId: out.taskId,
            alreadyConsumed: out.alreadyConsumed,
          });
          return;
        }

        const ackPost = tail.match(/^([^/?]+)\/ack\/?$/);
        const idOnly = tail.match(/^([^/?]+)\/?$/);
        const isAck =
          (ackPost !== null && req.method === "POST") ||
          (idOnly !== null && req.method === "DELETE");
        if (isAck) {
          const id = decodeURIComponent((ackPost ?? idOnly)![1]);
          const changes = store.deleteMessage(id);
          if (changes === 0) {
            json(res, HTTP_STATUS.NOT_FOUND, { error: "Message not found" });
            return;
          }
          sseManager.broadcast({ type: "message_acked", messageId: id });
          broadcastInboxCount(store, sseManager);
          if (deps.pushService) void deps.pushService.sendClose(id);
          mlog.info("ack", { msg_id: id });
          json(res, HTTP_STATUS.OK, { ok: true });
          return;
        }

        if (idOnly && req.method === "GET") {
          const id = decodeURIComponent(idOnly[1]);
          const row = store.getMessage(id);
          if (!row) {
            json(res, HTTP_STATUS.NOT_FOUND, { error: "Message not found" });
            return;
          }
          json(res, HTTP_STATUS.OK, {
            ...row,
            created_at: isoFromMillis(row.created_at),
          });
          return;
        }
      }

      json(res, HTTP_STATUS.NOT_FOUND, { error: "Not found" });
      return;
    }

    // --- Beta API routes ---
    if (url.startsWith("/api/beta/")) {
      res.setHeader("Content-Type", "application/json");

      // POST /api/beta/prompt — quick one-shot prompt (create temp task + send)
      if (url === "/api/beta/prompt" && req.method === "POST") {
        if (!tasks) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: "Agent not available",
          });
          return;
        }

        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        } catch {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
          return;
        }

        const text = body.text as string | undefined;
        if (!text || typeof text !== "string") {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "Missing required field: text",
          });
          return;
        }

        const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
        let bridge;
        try {
          bridge = await tasks.resolveDefaultTransport();
        } catch (err) {
          json(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
            error: `Agent not available: ${errorMessage(err)}`,
          });
          return;
        }
        const { taskId } = await tasks.createTask(
          bridge,
          cwd,
          undefined,
          "auto",
        );
        const streamUrl = `/api/v1/tasks/${taskId}/events/stream`;

        // `createTask` already broadcast `task_created`.
        json(res, HTTP_STATUS.ACCEPTED, { taskId, streamUrl });

        // Fire-and-forget: send the prompt asynchronously, tracking busy state
        tasks.beginAgentTurn(taskId, { origin: "interactive" });
        const betaPromptId =
          tasks.state.getState(taskId).runtime.busy?.promptId ?? undefined;
        tasks.notePromptSubmitted(taskId);
        bridge
          .prompt(taskId, text, undefined, betaPromptId)
          .catch(() => {})
          .finally(() => {
            tasks.endTurn(taskId, { promptId: betaPromptId });
          });
        return;
      }

      // POST /api/beta/clients/:clientId/visibility
      const visMatch = url.match(/^\/api\/beta\/clients\/([^/]+)\/visibility$/);
      if (visMatch && req.method === "POST") {
        const clientId = decodeURIComponent(visMatch[1]);

        // Trust boundary: accept if the client is (a) currently connected
        // via SSE, or (b) known to the ClientRegistry (populated on /hello,
        // persists across SSE disconnect). Registry check fixes the
        // pagehide-beacon race where iOS PWA suspension drops the SSE TCP
        // connection before the beacon egresses.
        const clientKnown =
          sseManager.clients.has(clientId) ||
          deps.clientRegistry?.get(clientId) !== undefined;
        if (!clientKnown) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Client not found" });
          return;
        }

        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        } catch {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
          return;
        }

        if (typeof body.visible !== "boolean") {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "Missing or invalid 'visible' field",
          });
          return;
        }

        // taskId patch semantics: absent = preserve, null = clear,
        // string = replace. Zod can't distinguish omitted from explicit
        // null after parse, so branch on raw body key.
        const hasTaskIdKey = Object.prototype.hasOwnProperty.call(
          body,
          "taskId",
        );
        let taskIdPatch: string | null | undefined;
        if (!hasTaskIdKey) {
          taskIdPatch = undefined;
        } else if (body.taskId === null) {
          taskIdPatch = null;
        } else if (typeof body.taskId === "string" && body.taskId.length > 0) {
          taskIdPatch = body.taskId;
        } else {
          taskIdPatch = null;
        }

        if (deps.clientRegistry) {
          // setVisibility no-ops on unknown clients; auto-register here so
          // SSE-only clients (which haven't sent /hello yet) still take
          // effect. The trust boundary above already gated on identity.
          if (!deps.clientRegistry.get(clientId)) {
            deps.clientRegistry.register(clientId, { capabilities: [] });
          }
          const { becameVisibleFor } = deps.clientRegistry.setVisibility(
            clientId,
            {
              visible: body.visible,
              active: taskIdPatch,
            },
          );
          // Edge-triggered only: heartbeat refreshes repeat the same
          // (visible:true, taskId:X) POST every 15s — firing sendClose
          // on each would hammer banner recall. Only the first such
          // transition after a change should recall stale banners.
          if (becameVisibleFor && deps.pushService) {
            void deps.pushService.sendClose(`sess-${becameVisibleFor}-done`);
            if (tasks) {
              for (const perm of tasks.pendingPermissions.values()) {
                if (perm.taskId === becameVisibleFor) {
                  void deps.pushService.sendClose(
                    `sess-${becameVisibleFor}-perm-${perm.requestId}`,
                  );
                }
              }
            }
          }
        }

        json(res, HTTP_STATUS.OK, { ok: true });
        return;
      }

      // --- Push notification routes ---

      // GET /api/beta/push/vapid-key
      if (url === "/api/beta/push/vapid-key" && req.method === "GET") {
        if (!deps.pushService) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Push not configured" });
          return;
        }
        json(res, HTTP_STATUS.OK, {
          publicKey: deps.pushService.getPublicKey(),
        });
        return;
      }

      // POST /api/beta/push/subscribe
      if (url === "/api/beta/push/subscribe" && req.method === "POST") {
        if (!deps.pushService) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Push not configured" });
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: {
          endpoint?: string;
          keys?: { auth?: string; p256dh?: string };
          clientId?: string;
        };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString()) as {
            endpoint?: string;
            keys?: { auth?: string; p256dh?: string };
            clientId?: string;
          };
        } catch {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
          return;
        }
        if (!body.endpoint || !body.keys?.auth || !body.keys.p256dh) {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "Missing endpoint or keys (auth, p256dh)",
          });
          return;
        }
        store.saveSubscription(body.endpoint, body.keys.auth, body.keys.p256dh);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive
        if (body.clientId && deps.pushService) {
          deps.pushService.registerClient(body.clientId, body.endpoint);
        }
        json(res, HTTP_STATUS.CREATED, { ok: true });
        return;
      }

      // POST /api/beta/push/register-client — associate clientId with push endpoint
      if (url === "/api/beta/push/register-client" && req.method === "POST") {
        if (!deps.pushService) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Push not configured" });
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: { clientId?: string; endpoint?: string };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString()) as {
            clientId?: string;
            endpoint?: string;
          };
        } catch {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
          return;
        }
        if (!body.clientId || !body.endpoint) {
          json(res, HTTP_STATUS.BAD_REQUEST, {
            error: "Missing clientId or endpoint",
          });
          return;
        }
        deps.pushService.registerClient(body.clientId, body.endpoint);
        json(res, HTTP_STATUS.OK, { ok: true });
        return;
      }

      // POST /api/beta/push/unsubscribe
      if (url === "/api/beta/push/unsubscribe" && req.method === "POST") {
        if (!deps.pushService) {
          json(res, HTTP_STATUS.NOT_FOUND, { error: "Push not configured" });
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: { endpoint?: string };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString()) as {
            endpoint?: string;
          };
        } catch {
          json(res, HTTP_STATUS.BAD_REQUEST, { error: "Invalid JSON" });
          return;
        }
        if (body.endpoint) {
          store.removeSubscription(body.endpoint);
        }
        json(res, HTTP_STATUS.OK, { ok: true });
        return;
      }

      json(res, HTTP_STATUS.NOT_FOUND, { error: "Not found" });
      return;
    }

    // --- Static files ---
    let staticPath = url.split("?")[0] ?? url;
    const htmlEntry = HTML_ENTRYPOINTS.find((e) => e.urlPath === staticPath);
    if (htmlEntry) staticPath = "/" + htmlEntry.file;
    const filePath = join(deps.publicDir, staticPath);
    if (!filePath.startsWith(deps.publicDir)) {
      res.writeHead(HTTP_STATUS.FORBIDDEN);
      res.end("Forbidden");
      return;
    }
    try {
      const data = await readFile(filePath);
      const ext = extname(filePath);
      const base = filePath.slice(filePath.lastIndexOf("/") + 1);
      const isHashedAsset = /\.[A-Za-z0-9_-]{8,}\.(js|css)$/.test(base);
      // `/lib/**` is vendored third-party content pinned by upstream SHA in
      // package metadata — treat as immutable just like content-hashed bundles.
      // Avoids re-downloading multi-hundred-KB wasm on every consumer init.
      const isVendoredLib = staticPath.startsWith("/lib/");
      const cacheControl =
        isHashedAsset || isVendoredLib
          ? "public, max-age=31536000, immutable"
          : "no-cache";
      const headers: Record<string, string> = {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Cache-Control": cacheControl,
      };
      // CSP applies to HTML entrypoints (where script/style execute).
      if (htmlEntry) headers["Content-Security-Policy"] = CSP_POLICY;
      res.writeHead(HTTP_STATUS.OK, headers);
      res.end(data);
    } catch {
      res.writeHead(HTTP_STATUS.NOT_FOUND);
      res.end("Not found");
    }
  };
}
