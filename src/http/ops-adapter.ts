import { createHash } from "node:crypto";
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
const bufferedRequestBodies = new WeakMap<IncomingMessage, Buffer>();

export function isOpsClaimedRequest(req: IncomingMessage): boolean {
  return opsClaimedRequests.has(req);
}

export function getBufferedRequestBody(
  req: IncomingMessage,
): Buffer | undefined {
  return bufferedRequestBodies.get(req);
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

export function parseClientOpIdHeader(req: IncomingMessage): ParsedClientOpId {
  const values = req.headersDistinct["x-client-op-id"];
  if (!values || values.length === 0) return { kind: "absent" };
  if (values.length !== 1) return { kind: "invalid" };
  const value = values[0];
  if (value.length === 0 || value.length > 128) return { kind: "invalid" };
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

function isResponseClosed(res: ServerResponse): boolean {
  return res.destroyed || res.writableEnded || res.socket?.destroyed === true;
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  error: string,
  code?: string,
): void {
  if (isResponseClosed(res)) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(code ? { error, code } : { error }));
}

function writeStoredResponse(
  res: ServerResponse,
  stored: StoredOpResponse,
): void {
  if (isResponseClosed(res)) return;
  res.writeHead(stored.status, stored.headers);
  if (stored.body.length > 0) {
    res.end(stored.body);
  } else {
    res.end();
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

class ResponseCapture {
  statusCode: number = HTTP_STATUS.OK;
  ended = false;
  private readonly headers = new Map<string, string | string[]>();
  private body: Buffer = Buffer.alloc(0);

  setHeader(name: string, value: number | string | readonly string[]): this {
    this.headers.set(
      name.toLowerCase(),
      typeof value === "number"
        ? String(value)
        : typeof value === "string"
          ? value
          : [...value],
    );
    return this;
  }

  getHeader(name: string): string | string[] | undefined {
    return this.headers.get(name.toLowerCase());
  }

  writeHead(statusCode: number, headers?: OutgoingHttpHeaders): this {
    this.statusCode = statusCode;
    if (headers) {
      for (const [key, val] of Object.entries(headers)) {
        if (val !== undefined) this.setHeader(key, val);
      }
    }
    return this;
  }

  end(chunk?: string | Buffer | Uint8Array): this {
    if (chunk !== undefined) {
      this.body = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk, "utf8")
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    this.ended = true;
    return this;
  }

  toStoredResponse(): StoredOpResponse {
    const filtered: StoredOpHeaders = {};
    for (const [key, value] of this.headers) {
      if (EXCLUDED_RESPONSE_HEADERS.has(key)) continue;
      filtered[key] = value;
    }
    return { status: this.statusCode, headers: filtered, body: this.body };
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

export type ActiveOpKeySet = Pick<ReadonlySet<string>, "size" | "has">;

export interface OpsAdapterDeps {
  ops: OpsStore;
  getPrincipal: (req: IncomingMessage) => TokenRecord | undefined;
  clock?: () => number;
}

export interface OpsAdapter {
  readonly activeKeys: ActiveOpKeySet;
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
      if (!capture.ended) {
        throw new Error("ops_handler_did_not_end_response");
      }
      stored = capture.toStoredResponse();
    } catch (err) {
      // Discard any response staged in `capture` before the handler rejected.
      stored = errorResponseFromCatch(req, err);
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
    bufferedRequestBodies.set(req, rawBodyBytes);
    const promise = executeClaimed(req, key, claimed.createdAt, innerHandler);
    inFlight.set(key, { fingerprint, promise });

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
      if (!isResponseClosed(res)) res.end();
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
    activeKeys: inFlight,
    handle,
  };
}
