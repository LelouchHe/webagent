import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import type { TokenRecord } from "../auth-store.ts";
import { HTTP_STATUS } from "../http-status.ts";
import { log } from "../log.ts";
import { OPS_NAMESPACE, opIdentity } from "../op-identity.ts";
import type {
  OpsStore,
  StoredOpHeaders,
  StoredOpResponse,
} from "../store/ops.ts";

const olog = log.scope("ops");

export const OPS_WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const TOKEN_DELETE_ROUTE_RE = /^\/api\/v1\/tokens\/([^/?]+)\/?$/;
export const ATTACHMENT_UPLOAD_ROUTE_RE =
  /^\/api\/v1\/tasks\/([^/]+)\/attachments\/?$/;
export const COLLABORATION_MESSAGE_ROUTE_RE =
  /^\/api\/v1\/tasks\/([^/]+)\/messages\/?(?:\?.*)?$/;

const EXCLUDED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "date",
  "content-length",
]);

const opsClaimedRequests = new WeakSet<IncomingMessage>();

export function isOpsClaimedRequest(req: IncomingMessage): boolean {
  return opsClaimedRequests.has(req);
}

export function isTokensAdminWriteRoute(method: string, url: string): boolean {
  return (
    (method === "POST" && url === "/api/v1/tokens") ||
    (method === "DELETE" && TOKEN_DELETE_ROUTE_RE.test(url))
  );
}

/**
 * Static admin gate for `/api/v1/tokens` writes; runs before `ops` so 401/403
 * (including a same-name token re-issued as non-admin) always precedes replay.
 */
export function enforceTokensAdminWriteGate(
  req: IncomingMessage,
  res: ServerResponse,
  hasAuthStore: boolean,
  principal: TokenRecord | undefined,
): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  const url = req.url ?? "/";
  if (!isTokensAdminWriteRoute(method, url)) return false;
  if (!hasAuthStore || !principal) {
    sendJsonError(res, HTTP_STATUS.UNAUTHORIZED, "Unauthorized");
    return true;
  }
  if (principal.scope !== "admin") {
    sendJsonError(res, HTTP_STATUS.FORBIDDEN, "Forbidden");
    return true;
  }
  return false;
}

export function isOpsRejectedRoute(method: string, url: string): boolean {
  return (
    method === "POST" &&
    (url === "/api/v1/tokens" ||
      url === "/api/v1/sse-ticket" ||
      ATTACHMENT_UPLOAD_ROUTE_RE.test(url))
  );
}

export function isOpsBypassedRoute(
  method: string,
  url: string,
  path: string,
): boolean {
  return (
    method === "POST" &&
    (url === "/api/v1/tasks" ||
      COLLABORATION_MESSAGE_ROUTE_RE.test(url) ||
      path === "/api/v1/link/entries")
  );
}

export type ParsedClientOpId =
  { kind: "absent" } | { kind: "valid"; opId: string } | { kind: "invalid" };

function readPhysicalClientOpIdHeaders(
  req: IncomingMessage,
): string[] | undefined {
  const distinct = (
    req as { headersDistinct?: Record<string, string[] | undefined> }
  ).headersDistinct;
  if (distinct !== undefined) {
    return distinct["x-client-op-id"];
  }
  if (Array.isArray(req.rawHeaders)) {
    const found: string[] = [];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === "x-client-op-id") {
        found.push(req.rawHeaders[i + 1]);
      }
    }
    return found.length > 0 ? found : undefined;
  }
  const raw = req.headers["x-client-op-id"];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw : [raw];
}

export function parseClientOpIdHeader(req: IncomingMessage): ParsedClientOpId {
  const values = readPhysicalClientOpIdHeaders(req);
  if (!values || values.length === 0) return { kind: "absent" };
  if (values.length !== 1) return { kind: "invalid" };
  const value = values[0];
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return { kind: "invalid" };
  }
  return { kind: "valid", opId: value };
}

/**
 * Return the validated `X-Client-Op-Id` value for routes that already passed
 * entry validation (for echo correlation or fact-based idempotency).
 */
export function getValidatedClientOpId(req: IncomingMessage): string | null {
  const parsed = parseClientOpIdHeader(req);
  return parsed.kind === "valid" ? parsed.opId : null;
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  error: string,
  code?: string,
): void {
  if (res.destroyed || res.writableEnded) return;
  try {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(code ? { error, code } : { error }));
  } catch {
    // Socket closed before error could be written.
  }
}

function writeStoredResponse(
  res: ServerResponse,
  stored: StoredOpResponse,
): void {
  if (res.destroyed || res.writableEnded) return;
  try {
    res.writeHead(stored.status, stored.headers);
    if (stored.body.length > 0) {
      res.end(stored.body);
    } else {
      res.end();
    }
  } catch {
    // Socket write failure must not affect the already-persisted op record.
  }
}

type BodyReadOutcome =
  | { kind: "ok"; bytes: Buffer }
  | { kind: "aborted" }
  | { kind: "error"; error: unknown };

function readFullRequestBody(req: IncomingMessage): Promise<BodyReadOutcome> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (outcome: BodyReadOutcome) => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
      req.off("close", onClose);
      resolve(outcome);
    };
    const onData = (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    };
    const onEnd = () => {
      if (req.aborted || (req.destroyed && req.complete === false)) {
        finish({ kind: "aborted" });
        return;
      }
      finish({ kind: "ok", bytes: Buffer.concat(chunks) });
    };
    const onAborted = () => {
      finish({ kind: "aborted" });
    };
    const onClose = () => {
      if (req.complete === false || req.aborted) {
        finish({ kind: "aborted" });
      }
    };
    const onError = (error: unknown) => {
      if (req.aborted || req.complete === false) {
        finish({ kind: "aborted" });
        return;
      }
      finish({ kind: "error", error });
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.once("aborted", onAborted);
    req.once("close", onClose);
    req.once("error", onError);
  });
}

/**
 * Re-expose buffered request bytes on the original `IncomingMessage` instance
 * so downstream `readBody`, `share`'s `readJson`, and `push/*` async iteration
 * all consume the same body without replacing `req` (preserving WeakMap auth
 * principal identity).
 */
function attachBufferedBody(req: IncomingMessage, bytes: Buffer): void {
  const replay = new EventEmitter();
  let scheduled = false;
  const scheduleReplay = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      if (bytes.length > 0) replay.emit("data", bytes);
      replay.emit("end");
    });
  };
  const origOn = req.on.bind(req);
  const origOnce = req.once.bind(req);
  const origAddListener = req.addListener.bind(req);
  const origOff = req.off.bind(req);
  const origRemoveListener = req.removeListener.bind(req);
  const isBodyEvent = (event: string | symbol) =>
    event === "data" || event === "end";

  req.on = ((
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ) => {
    if (isBodyEvent(event)) {
      replay.on(event, listener);
      scheduleReplay();
      return req;
    }
    return origOn(event, listener);
  }) as IncomingMessage["on"];
  req.addListener = ((
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ) => {
    if (isBodyEvent(event)) {
      replay.addListener(event, listener);
      scheduleReplay();
      return req;
    }
    return origAddListener(event, listener);
  }) as IncomingMessage["addListener"];
  req.once = ((
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ) => {
    if (isBodyEvent(event)) {
      replay.once(event, listener);
      scheduleReplay();
      return req;
    }
    return origOnce(event, listener);
  }) as IncomingMessage["once"];
  req.off = ((
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ) => {
    if (isBodyEvent(event)) {
      replay.off(event, listener);
      return req;
    }
    return origOff(event, listener);
  }) as IncomingMessage["off"];
  req.removeListener = ((
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ) => {
    if (isBodyEvent(event)) {
      replay.removeListener(event, listener);
      return req;
    }
    return origRemoveListener(event, listener);
  }) as IncomingMessage["removeListener"];
  req[Symbol.asyncIterator] = async function* (): AsyncGenerator<
    Buffer,
    undefined,
    unknown
  > {
    if (bytes.length > 0) yield bytes;
    return undefined;
  };
}

function normalizeHeaderValue(
  value: number | string | readonly string[] | undefined,
): string | string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return [...value];
}

function toChunkBuffer(
  chunk: unknown,
  encoding?: BufferEncoding,
): Buffer | null {
  if (chunk === undefined || chunk === null) return null;
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (typeof chunk === "string") {
    return Buffer.from(chunk, encoding ?? "utf8");
  }
  return null;
}

class ResponseCapture extends EventEmitter {
  statusCode: number = HTTP_STATUS.OK;
  statusMessage = "";
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  private readonly headers = new Map<string, string | string[]>();
  private readonly chunks: Buffer[] = [];

  setHeader(name: string, value: number | string | readonly string[]): this {
    const normalized = normalizeHeaderValue(value);
    if (normalized !== undefined) {
      this.headers.set(name.toLowerCase(), normalized);
    }
    return this;
  }

  getHeader(name: string): string | string[] | undefined {
    return this.headers.get(name.toLowerCase());
  }

  getHeaders(): StoredOpHeaders {
    const out: StoredOpHeaders = {};
    for (const [k, v] of this.headers) out[k] = v;
    return out;
  }

  getHeaderNames(): string[] {
    return [...this.headers.keys()];
  }

  hasHeader(name: string): boolean {
    return this.headers.has(name.toLowerCase());
  }

  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase());
  }

  flushHeaders(): void {
    this.headersSent = true;
  }

  cork(): void {}
  uncork(): void {}

  writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | OutgoingHttpHeaders | readonly string[],
    maybeHeaders?: OutgoingHttpHeaders | readonly string[],
  ): this {
    this.statusCode = statusCode;
    let headersArg: OutgoingHttpHeaders | readonly string[] | undefined;
    if (typeof statusMessageOrHeaders === "string") {
      this.statusMessage = statusMessageOrHeaders;
      headersArg = maybeHeaders;
    } else {
      headersArg = statusMessageOrHeaders;
    }
    if (Array.isArray(headersArg)) {
      for (let i = 0; i + 1 < headersArg.length; i += 2) {
        this.setHeader(String(headersArg[i]), String(headersArg[i + 1]));
      }
    } else if (headersArg && typeof headersArg === "object") {
      for (const [key, val] of Object.entries(
        headersArg as OutgoingHttpHeaders,
      )) {
        if (val !== undefined) this.setHeader(key, val);
      }
    }
    this.headersSent = true;
    return this;
  }

  write(
    chunk: unknown,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    const encoding =
      typeof encodingOrCb === "string" ? encodingOrCb : undefined;
    const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
    this.headersSent = true;
    const buf = toChunkBuffer(chunk, encoding);
    if (buf && buf.length > 0) this.chunks.push(buf);
    callback?.(null);
    return true;
  }

  end(
    chunkOrCb?: unknown,
    encodingOrCb?: BufferEncoding | (() => void),
    cb?: () => void,
  ): this {
    let chunk: unknown;
    let encoding: BufferEncoding | undefined;
    let callback: (() => void) | undefined;
    if (typeof chunkOrCb === "function") {
      callback = chunkOrCb as () => void;
    } else {
      chunk = chunkOrCb;
      if (typeof encodingOrCb === "function") {
        callback = encodingOrCb;
      } else {
        encoding = encodingOrCb;
        callback = cb;
      }
    }
    const buf = toChunkBuffer(chunk, encoding);
    if (buf && buf.length > 0) this.chunks.push(buf);
    this.headersSent = true;
    if (!this.writableEnded) {
      this.writableEnded = true;
      this.emit("finish");
    }
    callback?.();
    return this;
  }

  toStoredResponse(): StoredOpResponse {
    const filtered: StoredOpHeaders = {};
    for (const [key, value] of this.headers) {
      if (EXCLUDED_RESPONSE_HEADERS.has(key)) continue;
      filtered[key] = value;
    }
    return {
      status: this.statusCode,
      headers: filtered,
      body: Buffer.concat(this.chunks),
    };
  }
}

function opCallerScope(principal: TokenRecord | undefined): string {
  if (principal?.scope === "host") {
    return `host:${principal.name}`;
  }
  return `token:${principal?.name ?? "anonymous"}`;
}

function computeRequestFingerprint(
  method: string,
  url: string,
  rawBodyBytes: Buffer,
): string {
  return createHash("sha256")
    .update(method, "utf8")
    .update("\0", "utf8")
    .update(url, "utf8")
    .update("\0", "utf8")
    .update(rawBodyBytes)
    .digest("hex");
}

function errorResponseFromCatch(
  req: IncomingMessage,
  err: unknown,
): StoredOpResponse {
  if (err instanceof URIError) {
    return {
      status: HTTP_STATUS.BAD_REQUEST,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ error: "Invalid URL encoding" })),
    };
  }
  log.error("request handler rejected", {
    method: req.method,
    url: req.url,
    error: err instanceof Error ? err.message : "unknown error",
  });
  return {
    status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ error: "Internal Server Error" })),
  };
}

export interface OpsAdapterDeps {
  ops: OpsStore;
  getPrincipal: (req: IncomingMessage) => TokenRecord | undefined;
  clock?: () => number;
}

export interface OpsAdapter {
  readonly activeKeys: ReadonlySet<string>;
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    innerHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ): Promise<void>;
}

export function createOpsAdapter(deps: OpsAdapterDeps): OpsAdapter {
  const clock = deps.clock ?? (() => Date.now());
  const inFlight = new Map<
    string,
    { fingerprint: string; promise: Promise<StoredOpResponse> }
  >();
  const activeKeys = new Set<string>();

  async function executeClaimed(
    req: IncomingMessage,
    key: string,
    createdAt: number,
    innerHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ): Promise<StoredOpResponse> {
    const capture = new ResponseCapture();
    opsClaimedRequests.add(req);
    let stored: StoredOpResponse;
    try {
      await innerHandler(req, capture as unknown as ServerResponse);
      stored = capture.toStoredResponse();
    } catch (err) {
      if (capture.headersSent) {
        log.error("request handler rejected", {
          method: req.method,
          url: req.url,
          error: err instanceof Error ? err.message : "unknown error",
        });
        stored = capture.toStoredResponse();
      } else {
        stored = errorResponseFromCatch(req, err);
      }
    }

    let persisted: boolean;
    try {
      persisted = deps.ops.complete(key, stored, createdAt);
    } catch (err) {
      olog.error("failed to persist op response", {
        method: req.method,
        url: req.url,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    if (!persisted) {
      const err = new Error("ops_complete_not_updated");
      olog.error("failed to persist op response", {
        method: req.method,
        url: req.url,
        error: err.message,
      });
      throw err;
    }
    return stored;
  }

  async function handleClaimedOrCoalesced(
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    fingerprint: string,
    rawBodyBytes: Buffer,
    innerHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ): Promise<void> {
    // Live in-flight check takes precedence over DB TTL so long-running
    // requests (>24h) are never overwritten and concurrent duplicates coalesce.
    const active = inFlight.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) {
        sendJsonError(
          res,
          HTTP_STATUS.CONFLICT,
          "Client operation ID conflict",
          "op_conflict",
        );
        return;
      }
      try {
        const stored = await active.promise;
        writeStoredResponse(res, stored);
      } catch {
        sendJsonError(
          res,
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
          "Internal Server Error",
        );
      }
      return;
    }

    const claimed = deps.ops.claim(key, fingerprint, clock());
    if (claimed.kind === "conflict") {
      sendJsonError(
        res,
        HTTP_STATUS.CONFLICT,
        "Client operation ID conflict",
        "op_conflict",
      );
      return;
    }
    if (claimed.kind === "pending") {
      sendJsonError(
        res,
        HTTP_STATUS.CONFLICT,
        "Previous attempt with this operation ID did not complete",
        "op_aborted",
      );
      return;
    }
    if (claimed.kind === "replay") {
      writeStoredResponse(res, claimed.response);
      return;
    }

    // No `await` between `claim` returning `new` and registering `inFlight`.
    attachBufferedBody(req, rawBodyBytes);
    const promise = executeClaimed(req, key, claimed.createdAt, innerHandler);
    inFlight.set(key, { fingerprint, promise });
    activeKeys.add(key);

    let stored: StoredOpResponse;
    try {
      stored = await promise;
    } catch {
      sendJsonError(
        res,
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        "Internal Server Error",
      );
      return;
    } finally {
      if (inFlight.get(key)?.promise === promise) {
        inFlight.delete(key);
        activeKeys.delete(key);
      }
    }
    writeStoredResponse(res, stored);
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    innerHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = req.url ?? "/";
    const queryStart = url.indexOf("?");
    const path = queryStart === -1 ? url : url.slice(0, queryStart);

    if (!path.startsWith("/api/") || !OPS_WRITE_METHODS.has(method)) {
      await innerHandler(req, res);
      return;
    }

    const parsedOpId = parseClientOpIdHeader(req);
    if (parsedOpId.kind === "absent") {
      await innerHandler(req, res);
      return;
    }

    if (isOpsRejectedRoute(method, url)) {
      sendJsonError(
        res,
        HTTP_STATUS.BAD_REQUEST,
        "X-Client-Op-Id is not supported on this endpoint",
        "op_id_not_supported",
      );
      return;
    }

    if (parsedOpId.kind === "invalid") {
      sendJsonError(
        res,
        HTTP_STATUS.BAD_REQUEST,
        "Invalid X-Client-Op-Id header",
        "invalid_op_id",
      );
      return;
    }

    if (isOpsBypassedRoute(method, url, path)) {
      await innerHandler(req, res);
      return;
    }

    const bodyResult = await readFullRequestBody(req);
    if (bodyResult.kind === "aborted") {
      if (!res.destroyed && !res.writableEnded) {
        try {
          res.end();
        } catch {
          // Connection already gone.
        }
      }
      return;
    }
    if (bodyResult.kind === "error") {
      sendJsonError(
        res,
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        "Internal Server Error",
      );
      return;
    }

    const caller = opCallerScope(deps.getPrincipal(req));
    const key = opIdentity(OPS_NAMESPACE, caller, parsedOpId.opId);
    const fingerprint = computeRequestFingerprint(
      method,
      url,
      bodyResult.bytes,
    );
    await handleClaimedOrCoalesced(
      req,
      res,
      key,
      fingerprint,
      bodyResult.bytes,
      innerHandler,
    );
  }

  return {
    activeKeys,
    handle,
  };
}
