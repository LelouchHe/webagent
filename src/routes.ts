import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, extname } from "node:path";
import { gzipSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "./store.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SseManager } from "./sse-manager.ts";
import type { AgentBridge } from "./bridge.ts";
import type { Config } from "./config.ts";
import type { PushService } from "./push-service.ts";
import type { TitleService } from "./title-service.ts";
import type { ClientRegistry } from "./client-registry.ts";
import { errorMessage, MessageIngressSchema } from "./types.ts";
import type { AgentEvent } from "./types.ts";
import { interruptBashProc } from "./session-manager.ts";
import { randomUUID } from "node:crypto";
import { authenticate, isWhitelistedPath, requireScope } from "./auth-middleware.ts";
import type { AuthStore, TokenRecord } from "./auth-store.ts";
import type { TicketStore } from "./sse-ticket.ts";
import { signImageUrl, verifyImageSig, reSignImageUrlsInJson } from "./auth.ts";

const IS_WIN = process.platform === "win32";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

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
] as const;

/**
 * Strict Content-Security-Policy for HTML responses.
 *
 *  - default-src 'self': everything same-origin only
 *  - img-src adds data: + blob: for image-upload preview
 *  - script-src 'self' (no inline; theme bootstrap is /theme-init.js)
 *  - style-src 'self' (no inline; login styles live in /styles.css)
 *  - object-src 'none', frame-ancestors 'none', base-uri 'self', form-action 'self'
 *  - connect-src 'self' for fetch + EventSource
 */
export const CSP_POLICY = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export interface RequestHandlerDeps {
  store: Store;
  sessions?: SessionManager;
  sseManager: SseManager;
  clientRegistry?: ClientRegistry;
  titleService?: TitleService;
  getBridge?: () => (Pick<AgentBridge, "newSession" | "setConfigOption" | "loadSession" | "cancel" | "prompt" | "resolvePermission" | "denyPermission" | "restart" | "reloading"> | null);
  publicDir: string;
  dataDir: string;
  limits: Pick<Config["limits"], "bash_output" | "image_upload"> & Partial<Pick<Config["limits"], "cancel_timeout" | "recent_paths" | "recent_paths_ttl">>;
  pushService?: PushService;
  serverVersion?: string;
  debugLevel?: string;
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
  /** Optional secret for HMAC-signed image URLs. When present, image GET
   *  requires `?sig=&exp=`; image upload returns a signed URL. When absent
   *  (legacy/tests), images are served unauthenticated. */
  imageSecret?: Buffer;
}

/** Read the full request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
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

function tryReplayClientOp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  sessionId: string,
): { opId: string | null; replayed: boolean } {
  const opId = getClientOpId(req);
  if (!opId) return { opId: null, replayed: false };
  const cached = store.getClientOp(sessionId, opId) as { status: number; body: unknown } | null;
  if (cached && typeof cached === "object" && "status" in cached && "body" in cached) {
    json(res, cached.status, cached.body, req);
    return { opId, replayed: true };
  }
  return { opId, replayed: false };
}

function saveClientOpResult(store: Store, opId: string | null, sessionId: string, status: number, body: unknown): void {
  if (!opId) return;
  store.saveClientOp(sessionId, opId, { status, body });
}

/** Send a JSON response, gzip-compressed when the client supports it. */
function json(res: ServerResponse, status: number, data: unknown, req?: IncomingMessage): void {
  const body = JSON.stringify(data);
  if (req && body.length > 1024 && (req.headers["accept-encoding"] || "").includes("gzip")) {
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

export function createRequestHandler(deps: RequestHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { store, sessions, getBridge, sseManager, titleService } = deps;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? "/";

    // --- Auth gate: any /api/** outside whitelist requires Bearer ---
    if (deps.authStore && url.startsWith("/api/")) {
      const path = url.split("?")[0] ?? url;
      const method = req.method ?? "GET";
      if (!isWhitelistedPath(method, path)) {
        const result = authenticate(req.headers, deps.authStore);
        if (!result.ok) {
          res.writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": "Bearer",
          });
          res.end(JSON.stringify({ error: "Unauthorized", reason: result.reason }));
          return;
        }
        principalByRequest.set(req, result.principal);
      }
    }

    // --- API routes ---
    if (url === "/api/v1" || url.startsWith("/api/v1/")) {
      res.setHeader("Content-Type", "application/json");

      // GET /api/v1 — discovery endpoint
      if (url === "/api/v1" && req.method === "GET") {
        json(res, 200, {
          version: "v1",
          endpoints: {
            sessions: "/api/v1/sessions",
            paths: "/api/v1/recent-paths",
            config: "/api/v1/config",
            events_stream: "/api/v1/events/stream",
            prompt: "/api/beta/prompt",
            push: "/api/beta/push",
            clients: "/api/beta/clients",
          },
        });
        return;
      }

      // GET /api/v1/sessions
      if (url.startsWith("/api/v1/sessions") && !url.slice("/api/v1/sessions".length).match(/^\//) && req.method === "GET") {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const source = params.get("source") ?? undefined;
        res.end(JSON.stringify(store.listSessions(source ? { source } : undefined)));
        return;
      }

      // --- GET /api/v1/config ---
      if (url === "/api/v1/config" && req.method === "GET") {
        json(res, 200, {
          configOptions: sessions?.cachedConfigOptions ?? [],
          cancelTimeout: deps.limits.cancel_timeout ?? 0,
          recentPathsLimit: deps.limits.recent_paths ?? 10,
        });
        return;
      }

      // GET /api/v1/recent-paths
      if (url.startsWith("/api/v1/recent-paths") && req.method === "GET") {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const limitParam = params.get("limit");
        const limit = limitParam != null ? Math.max(0, parseInt(limitParam, 10)) : 0;
        const ttlDays = deps.limits.recent_paths_ttl ?? 30;
        const paths = store.listRecentPaths({
          limit: isNaN(limit) ? 0 : limit,
          ttlDays,
        });
        json(res, 200, paths);
        return;
      }

      // GET /api/v1/version
      if (url === "/api/v1/version" && req.method === "GET") {
        json(res, 200, {
          server: deps.serverVersion ?? "unknown",
          agent: sessions?.agentInfo ?? null,
        });
        return;
      }

      // GET /api/v1/auth/verify — token validation probe
      if (url === "/api/v1/auth/verify" && req.method === "GET") {
        const principal = principalByRequest.get(req);
        if (!principal) {
          json(res, 401, { error: "Unauthorized" });
          return;
        }
        json(res, 200, { ok: true, name: principal.name, scope: principal.scope });
        return;
      }

      // POST /api/v1/sse-ticket — mint short-lived ticket for EventSource
      if (url === "/api/v1/sse-ticket" && req.method === "POST") {
        const principal = principalByRequest.get(req);
        if (!principal) { json(res, 401, { error: "Unauthorized" }); return; }
        if (!deps.ticketStore) { json(res, 501, { error: "SSE not available" }); return; }
        const ticket = deps.ticketStore.mint({
          tokenName: principal.name,
          scope: principal.scope,
        });
        json(res, 200, { ticket, expiresIn: 60 });
        return;
      }

      // --- Token management (admin scope) ---
      // GET /api/v1/tokens — list all tokens (no hash field)
      if (url === "/api/v1/tokens" && req.method === "GET") {
        const principal = principalByRequest.get(req);
        if (!deps.authStore || !principal) { json(res, 401, { error: "Unauthorized" }); return; }
        if (principal.scope !== "admin") { json(res, 403, { error: "Forbidden" }); return; }
        const list = deps.authStore.list().map((t) => ({
          name: t.name,
          scope: t.scope,
          createdAt: t.createdAt,
          lastUsedAt: t.lastUsedAt,
          isSelf: t.name === principal.name,
        }));
        json(res, 200, list);
        return;
      }

      // POST /api/v1/tokens — create new api-scope token, return raw value once
      if (url === "/api/v1/tokens" && req.method === "POST") {
        const principal = principalByRequest.get(req);
        if (!deps.authStore || !principal) { json(res, 401, { error: "Unauthorized" }); return; }
        if (principal.scope !== "admin") { json(res, 403, { error: "Forbidden" }); return; }
        let body: { name?: unknown };
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: "Invalid JSON" });
          return;
        }
        const name = typeof body.name === "string" ? body.name : "";
        try {
          const created = await deps.authStore.addToken(name, "api");
          json(res, 201, {
            token: created.token,
            name: created.record.name,
            scope: created.record.scope,
          });
        } catch (err: unknown) {
          const msg = errorMessage(err);
          if (/already exists|duplicate/i.test(msg)) {
            json(res, 409, { error: msg });
          } else {
            json(res, 400, { error: msg });
          }
        }
        return;
      }

      // DELETE /api/v1/tokens/:name — revoke
      const tokenDelMatch = url.match(/^\/api\/v1\/tokens\/([^/?]+)\/?$/);
      if (tokenDelMatch && req.method === "DELETE") {
        const principal = principalByRequest.get(req);
        if (!deps.authStore || !principal) { json(res, 401, { error: "Unauthorized" }); return; }
        if (principal.scope !== "admin") { json(res, 403, { error: "Forbidden" }); return; }
        const name = decodeURIComponent(tokenDelMatch[1]!);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
          json(res, 400, { error: "Invalid token name" });
          return;
        }
        if (name === principal.name) {
          json(res, 400, { error: "Cannot revoke the token you are using" });
          return;
        }
        try {
          const ok = await deps.authStore.revokeToken(name);
          if (!ok) { json(res, 404, { error: "Token not found" }); return; }
          res.writeHead(204);
          res.end();
        } catch (err: unknown) {
          json(res, 400, { error: errorMessage(err) });
        }
        return;
      }

      // --- POST /api/v1/bridge/reload ---
      if (url === "/api/v1/bridge/reload" && req.method === "POST") {
        const bridge = getBridge?.();
        if (!bridge) { json(res, 503, { error: "Agent not ready yet" }); return; }
        if (bridge.reloading) { json(res, 409, { error: "Already reloading" }); return; }
        try {
          await bridge.restart(sessions!, titleService!);
          json(res, 200, { ok: true });
        } catch (err: unknown) {
          json(res, 500, { error: errorMessage(err) });
        }
        return;
      }

      // --- Permissions (session-scoped) ---

      // GET /api/v1/sessions/:id/permissions
      const permListMatch = url.match(/^\/api\/v1\/sessions\/([^/]+)\/permissions\/?(\?.*)?$/);
      if (permListMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(permListMatch[1]);
        const perms = sessions?.getPendingPermissions(sessionId) ?? [];
        json(res, 200, perms);
        return;
      }

      // POST /api/v1/sessions/:id/permissions/:reqId
      const permActionMatch = url.match(/^\/api\/v1\/sessions\/([^/]+)\/permissions\/([^/?]+)\/?$/);
      if (permActionMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(permActionMatch[1]);
        const requestId = decodeURIComponent(permActionMatch[2]);
        const { opId, replayed } = tryReplayClientOp(req, res, store, sessionId);
        if (replayed) return;
        const perm = sessions?.pendingPermissions.get(requestId);
        if (!perm) { json(res, 404, { error: "Permission not found" }); return; }
        if (perm.sessionId !== sessionId) { json(res, 400, { error: "Session ID mismatch" }); return; }
        const bridge = getBridge?.();
        if (!bridge) { json(res, 503, { error: "Agent not ready yet" }); return; }

        let body: { optionId?: string; denied?: boolean };
        try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
        if (!body.optionId && !body.denied) { json(res, 400, { error: "Provide optionId or denied:true" }); return; }

        const denied = !!body.denied;
        const optionId = body.optionId ?? "deny";
        const optionName = perm.options.find(o => o.optionId === optionId)?.label ?? optionId;

        if (denied) {
          await bridge.denyPermission(requestId);
        } else {
          await bridge.resolvePermission(requestId, optionId);
        }

        sessions!.pendingPermissions.delete(requestId);
        sessions!.syncPendingPermissions(sessionId);

        // Store event and broadcast (same type so SSE drops are recoverable via sync)
        const permEventData = { requestId, optionName, denied };
        store.saveEvent(perm.sessionId, "permission_response", { ...permEventData, optionId }, { from_ref: "user" });
        sseManager.broadcast({
          type: "permission_response",
          sessionId: perm.sessionId,
          ...permEventData,
        } as AgentEvent);

        // Cross-device banner recall: close the permission banner on
        // every subscribed endpoint now that the permission has been
        // handled by this client.
        if (deps.pushService) {
          void deps.pushService.sendClose(`sess-${perm.sessionId}-perm-${requestId}`);
        }

        const okBody = { ok: true };
        saveClientOpResult(store, opId, sessionId, 200, okBody);
        json(res, 200, okBody);
        return;
      }

      // --- POST /api/v1/sessions/:id/cancel ---
      const cancelMatch = url.match(/^\/api\/v1\/sessions\/([^/]+)\/cancel\/?$/);
      if (cancelMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(cancelMatch[1]);
        const session = store.getSession(sessionId);
        if (!session) { json(res, 404, { error: "Session not found" }); return; }
        const bridge = getBridge?.();
        if (!bridge) { json(res, 503, { error: "Agent not ready yet" }); return; }

        const { opId, replayed } = tryReplayClientOp(req, res, store, sessionId);
        if (replayed) return;

        // Kill running bash process if any
        const proc = sessions?.runningBashProcs.get(sessionId);
        if (proc) {
          interruptBashProc(proc);
          sessions!.runningBashProcs.delete(sessionId);
        }
        // Cancel agent prompt
        if (sessions?.activePrompts.has(sessionId)) {
          await bridge.cancel(sessionId);
          sessions.activePrompts.delete(sessionId);
        }
        // Arm backend safety net: if prompt_done doesn't arrive within the
        // configured timeout, force-clear busy so the UI unstalls. Replaces
        // the old frontend-side cancel timer.
        const cancelTimeout = deps.limits.cancel_timeout ?? 0;
        if (sessions && cancelTimeout > 0) sessions.state.armCancelSafety(sessionId, cancelTimeout);
        sessions?.syncBusy(sessionId);
        const okBody = { ok: true };
        saveClientOpResult(store, opId, sessionId, 200, okBody);
        json(res, 200, okBody);
        return;
      }

      // --- GET /api/v1/sessions/:id/status ---
      const statusMatch = url.match(/^\/api\/v1\/sessions\/([^/]+)\/status\/?$/);
      if (statusMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(statusMatch[1]);
        const session = store.getSession(sessionId);
        if (!session) { json(res, 404, { error: "Session not found" }); return; }
        const busyKind = sessions?.getBusyKind(sessionId) ?? null;
        const pendingPerms = sessions?.getPendingPermissions(sessionId) ?? [];
        json(res, 200, {
          busy: busyKind != null,
          busyKind,
          pendingPermissions: pendingPerms,
        });
        return;
      }

      // --- GET /api/v1/sessions/:id/snapshot ---
      // client-server-split M1: single source of truth for "what state is
      // this session in right now". Frontend calls this on connect / reconnect
      // / after long backgrounding, then applies incremental `state_patch`
      // SSE events.
      const snapshotMatch = url.match(/^\/api\/v1\/sessions\/([^/]+)\/snapshot\/?$/);
      if (snapshotMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(snapshotMatch[1]);
        const session = store.getSession(sessionId);
        if (!session) { json(res, 404, { error: "Session not found" }); return; }
        if (!sessions) { json(res, 503, { error: "Session manager not available" }); return; }
        // Make sure runtime reflects the current activePrompts/bash state even
        // if no patch has been emitted yet for this session.
        sessions.syncBusy(sessionId);
        sessions.syncPendingPermissions(sessionId);
        const runtimeState = sessions.state.getState(sessionId);
        const lastEventSeq = store.getLastEventSeq(sessionId);
        json(res, 200, {
          version: 1,
          seq: runtimeState.seq,
          session: {
            id: session.id,
            title: session.title,
            cwd: session.cwd,
            model: session.model,
            mode: session.mode,
            createdAt: session.created_at ?? null,
            lastEventSeq,
          },
          runtime: runtimeState.runtime,
        }, req);
        return;
      }

      // --- POST /api/v1/sessions/:id/prompt ---
      const promptMatch = url.match(/^\/api\/v1\/sessions\/([^/]+)\/prompt\/?(\?.*)?$/);
      if (promptMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(promptMatch[1]);
        const session = store.getSession(sessionId);
        if (!session) { json(res, 404, { error: "Session not found" }); return; }
        const bridge = getBridge?.();
        if (!bridge) { json(res, 503, { error: "Agent not ready yet" }); return; }
        if (!sessions) { json(res, 503, { error: "Session manager not available" }); return; }

        const { opId, replayed } = tryReplayClientOp(req, res, store, sessionId);
        if (replayed) return;

        // Ensure session is live in ACP before prompting (awaits in-flight resume)
        try {
          await sessions.ensureResumed(bridge, sessionId);
        } catch (err) {
          json(res, 500, { error: `Failed to resume session: ${err instanceof Error ? err.message : String(err)}` });
          return;
        }

        // Check if session is busy
        const busyKind = sessions.getBusyKind(sessionId);
        if (busyKind) {
          json(res, 409, { error: "Session is busy", busyKind });
          return;
        }

        let body: { text?: string; images?: Array<{ data: string; mimeType: string; path?: string }> };
        try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
        if (!body.text) { json(res, 400, { error: "Missing required field: text" }); return; }

        // Store user_message event (strip base64 data, keep only path + mimeType)
        const storedImages = body.images?.map(i => ({ path: i.path, mimeType: i.mimeType }));
        store.saveEvent(sessionId, "user_message", { text: body.text, ...(storedImages?.length && { images: storedImages }) }, { from_ref: "user" });
        store.updateSessionLastActive(sessionId);
        store.touchRecentPath(session.cwd);
        const userMsgEvent = { type: "user_message", sessionId, text: body.text, images: storedImages } as AgentEvent;
        sseManager.broadcast(userMsgEvent);

        // Generate title (fire-and-forget)
        if (titleService && sessions && !sessions.sessionHasTitle.has(sessionId)) {
          titleService.generate(bridge as AgentBridge, body.text, sessionId, (title) => {
            const titleEvent = { type: "session_title_updated", sessionId, title } as AgentEvent;
            sseManager.broadcast(titleEvent);
          });
        }

        // Fire prompt asynchronously (don't await — response is 202)
        sessions.activePrompts.add(sessionId);
        sessions.syncBusy(sessionId);
        bridge.prompt(sessionId, body.text, body.images).catch((err: unknown) => {
          console.error(`[prompt] error for ${sessionId}:`, err);
        }).finally(() => {
          sessions!.activePrompts.delete(sessionId);
          sessions!.syncBusy(sessionId);
        });

        const acceptedBody = { status: "accepted" };
        saveClientOpResult(store, opId, sessionId, 202, acceptedBody);
        json(res, 202, acceptedBody);
        return;
      }

      // --- POST /api/v1/sessions/:id/bash ---
      const bashMatch = url.match(/^\/api\/v1\/sessions\/([^/]+)\/bash\/?$/);
      if (bashMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(bashMatch[1]);
        const session = store.getSession(sessionId);
        if (!session) { json(res, 404, { error: "Session not found" }); return; }
        if (!sessions) { json(res, 503, { error: "Session manager not available" }); return; }
        if (sessions.runningBashProcs.has(sessionId)) {
          json(res, 409, { error: "A bash command is already running in this session" });
          return;
        }

        let body: { command?: string };
        try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
        if (!body.command) { json(res, 400, { error: "Missing required field: command" }); return; }

        const cwd = sessions.getSessionCwd(sessionId);
        store.saveEvent(sessionId, "bash_command", { command: body.command }, { from_ref: "user" });
        const bashCmdEvent = { type: "bash_command", sessionId, command: body.command } as AgentEvent;
        sseManager.broadcast(bashCmdEvent);

        const shell = IS_WIN ? (process.env.COMSPEC || "cmd.exe") : (process.env.SHELL || "bash");
        const shellArgs = IS_WIN ? ["/s", "/c", body.command] : ["-c", body.command];
        const child = spawn(shell, shellArgs, {
          cwd,
          detached: !IS_WIN,
          env: { ...process.env, TERM: "dumb" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        sessions.runningBashProcs.set(sessionId, child);
        sessions.syncBusy(sessionId);
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
          const bashOutEvent = { type: "bash_output", sessionId, text, stream } as AgentEvent;
          sseManager.broadcast(bashOutEvent);
        };
        child.stdout!.on("data", onData("stdout"));
        child.stderr!.on("data", onData("stderr"));

        child.on("close", (code, signal) => {
          sessions!.runningBashProcs.delete(sessionId);
          sessions!.syncBusy(sessionId);
          const stored = outputTruncated ? "[truncated]\n" + output : output;
          store.saveEvent(sessionId, "bash_result", { output: stored, code, signal }, { from_ref: "system" });
          const bashDoneEvent = { type: "bash_done", sessionId, code, signal } as AgentEvent;
          sseManager.broadcast(bashDoneEvent);
        });

        child.on("error", (err) => {
          sessions!.runningBashProcs.delete(sessionId);
          sessions!.syncBusy(sessionId);
          const errMsg = errorMessage(err);
          store.saveEvent(sessionId, "bash_result", { output: errMsg, code: -1, signal: null }, { from_ref: "system" });
          const bashErrEvent = { type: "bash_done", sessionId, code: -1, signal: null, error: errMsg } as AgentEvent;
          sseManager.broadcast(bashErrEvent);
        });

        json(res, 202, { status: "accepted" });
        return;
      }

      // --- POST /api/v1/sessions/:id/bash/cancel ---
      const bashCancelMatch = url.match(/^\/api\/v1\/sessions\/([^/]+)\/bash\/cancel\/?$/);
      if (bashCancelMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(bashCancelMatch[1]);
        const session = store.getSession(sessionId);
        if (!session) { json(res, 404, { error: "Session not found" }); return; }
        interruptBashProc(sessions?.runningBashProcs.get(sessionId));
        json(res, 200, { ok: true });
        return;
      }

      // --- PUT /api/v1/sessions/:id/{model,mode,reasoning-effort} ---
      const configPutMatch = url.match(/^\/api\/v1\/sessions\/([^/]+)\/(model|mode|reasoning-effort)\/?$/);
      if (configPutMatch && req.method === "PUT") {
        const sessionId = decodeURIComponent(configPutMatch[1]);
        const configPath = configPutMatch[2];
        const configId = configPath === "reasoning-effort" ? "reasoning_effort" : configPath;
        const session = store.getSession(sessionId);
        if (!session) { json(res, 404, { error: "Session not found" }); return; }
        const bridge = getBridge?.();
        if (!bridge) { json(res, 503, { error: "Agent not ready yet" }); return; }
        let body: { value?: string };
        try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
        if (!body.value) { json(res, 400, { error: "Missing required field: value" }); return; }
        try {
          const configOptions = await bridge.setConfigOption(sessionId, configId, body.value);
          for (const opt of configOptions) {
            store.updateSessionConfig(sessionId, opt.id, opt.currentValue);
          }
          sseManager.broadcast({ type: "config_option_update", sessionId, configOptions } as AgentEvent);
          sseManager.broadcast({ type: "config_set", sessionId, configId, value: body.value } as AgentEvent);
          json(res, 200, { configOptions });
        } catch (err) {
          json(res, 500, { error: `Failed to set ${configId}: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }

      // --- PUT /api/v1/sessions/:id/title ---
      const titlePutMatch = url.match(/^\/api\/v1\/sessions\/([^/]+)\/title\/?$/);
      if (titlePutMatch && req.method === "PUT") {
        const sessionId = decodeURIComponent(titlePutMatch[1]);
        const session = store.getSession(sessionId);
        if (!session) { json(res, 404, { error: "Session not found" }); return; }
        let body: { value?: string };
        try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
        if (!body.value) { json(res, 400, { error: "Missing required field: value" }); return; }
        store.updateSessionTitle(sessionId, body.value);
        if (sessions) sessions.sessionHasTitle.add(sessionId);
        const bridge = getBridge?.();
        if (titleService && bridge) titleService.cancel(sessionId, bridge as AgentBridge);
        const titleEvent = { type: "session_title_updated", sessionId, title: body.value } as AgentEvent;
        sseManager.broadcast(titleEvent);
        json(res, 200, { title: body.value });
        return;
      }

      // --- Session CRUD: /api/v1/sessions/:id ---
      const sessionIdMatch = url.match(/^\/api\/v1\/sessions\/([^/?]+)\/?(\?.*)?$/);
      if (sessionIdMatch) {
        const sessionId = decodeURIComponent(sessionIdMatch[1]);

        // POST /api/v1/sessions (create) — handled below since :id would match "sessions" literally
        // This match is for /api/v1/sessions/:id only (not /api/sessions)

        // GET /api/v1/sessions/:id
        if (req.method === "GET") {
          const session = store.getSession(sessionId);
          if (!session) {
            json(res, 404, { error: "Session not found" });
            return;
          }
          // Start resume in background (non-blocking) so the client gets metadata fast.
          // BUT: if cache is cold (cold-restart case), block on resume up to 8s so
          // configOptions returns inline. This eliminates the race where the
          // post-resume `config_option_update` broadcast can arrive before the
          // client's SSE is fully wired up — a flake observed on slow CI runners.
          const wasLive = sessions?.liveSessions.has(sessionId) ?? true;
          let resumePromise: Promise<void> | null = null;
          if (sessions && getBridge && !wasLive) {
            const bridge = getBridge();
            if (bridge) {
              resumePromise = sessions.ensureResumed(bridge, sessionId);
              // Broadcast config_option_update too, so any OTHER client viewing
              // the same session (whose own GET may have raced and returned cold)
              // also picks up the warm values.
              resumePromise.then(() => {
                const cur = store.getSession(sessionId);
                if (!cur || !sessions.cachedConfigOptions.length) return;
                const opts = sessions.cachedConfigOptions.map((opt) => {
                  const stored: Record<string, string | null> = {
                    model: cur.model,
                    mode: cur.mode,
                    reasoning_effort: cur.reasoning_effort,
                  };
                  const override = stored[opt.id];
                  return override ? { ...opt, currentValue: override } : opt;
                });
                sseManager.broadcast({
                  type: "config_option_update",
                  sessionId,
                  configOptions: opts,
                } as AgentEvent);
              }).catch(() => {});
              // Auto-retry if the last turn was interrupted (must wait for resume)
              const hasInterrupted = store.hasInterruptedTurn(sessionId);
              if (hasInterrupted) {
                // Optimistically mark busy so concurrent POST sees the session as active
                sessions.activePrompts.add(sessionId);
                sessions.syncBusy(sessionId);
                resumePromise.then(() => {
                  if (!sessions!.autoRetryIfNeeded(bridge, sessionId)) {
                    // Retry not needed after all — release the optimistic lock
                    sessions!.activePrompts.delete(sessionId);
                    sessions!.syncBusy(sessionId);
                  }
                }).catch(() => {
                  sessions!.activePrompts.delete(sessionId);
                  sessions!.syncBusy(sessionId);
                });
              } else {
                resumePromise.catch((err) => {
                  console.error(`[session] background resume failed for ${sessionId.slice(0, 8)}…:`, err);
                });
              }
            }
          }
          // If cache is cold and we kicked off a resume, wait briefly so the
          // GET response includes warm configOptions. Bounded to 8s — past that
          // we fall back to returning empty configOptions and rely on the
          // broadcast above. The frontend retries (re-fetches) on broadcast.
          if (resumePromise && !sessions?.cachedConfigOptions.length) {
            let timer: NodeJS.Timeout | null = null;
            const timeoutPromise = new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 8000);
            });
            await Promise.race([
              resumePromise.finally(() => { if (timer) clearTimeout(timer); }),
              timeoutPromise,
            ]).catch(() => {});
          }
          // Re-read session in case resume mutated stored config
          const freshSession = store.getSession(sessionId) ?? session;
          const configOptions = sessions ? (() => {
            // Build configOptions from cached + stored overrides
            const opts = sessions.cachedConfigOptions.map(opt => {
              const stored: Record<string, string | null> = { model: freshSession.model, mode: freshSession.mode, reasoning_effort: freshSession.reasoning_effort };
              const override = stored[opt.id];
              return override ? { ...opt, currentValue: override } : opt;
            });
            return opts;
          })() : [];
          json(res, 200, {
            id: freshSession.id,
            cwd: freshSession.cwd,
            title: freshSession.title,
            source: freshSession.source,
            model: freshSession.model,
            mode: freshSession.mode,
            configOptions,
          }, req);
          return;
        }

        // DELETE /api/v1/sessions/:id
        if (req.method === "DELETE") {
          const session = store.getSession(sessionId);
          if (!session) {
            json(res, 404, { error: "Session not found" });
            return;
          }
          if (sessions) {
            sessions.deleteSession(sessionId);
          } else {
            store.deleteSession(sessionId);
          }
          sseManager.broadcast({ type: "session_deleted", sessionId } as AgentEvent);
          res.writeHead(204);
          res.end();
          return;
        }
      }

      // POST /api/v1/sessions (create new session)
      if (url === "/api/v1/sessions" && req.method === "POST") {
        const bridge = getBridge?.();
        if (!bridge) {
          json(res, 503, { error: "Agent not ready yet" });
          return;
        }
        if (!sessions) {
          json(res, 503, { error: "Session manager not available" });
          return;
        }
        let body: { cwd?: string; inheritFromSessionId?: string; source?: string };
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: "Invalid JSON" });
          return;
        }
        const source = body.source ?? "auto";
        try {
          const { sessionId, configOptions } = await sessions.createSession(bridge, body.cwd, body.inheritFromSessionId, source);
          const session = store.getSession(sessionId);
          const sessionCreatedEvent = {
            type: "session_created",
            sessionId,
            cwd: session?.cwd,
            title: session?.title,
            configOptions,
          } as AgentEvent;
          sseManager.broadcast(sessionCreatedEvent);
          // ACP's session_created event fires before inheritance runs, so
          // broadcast final configOptions so SSE clients get the inherited values.
          if (configOptions.length) {
            sseManager.broadcast({ type: "config_option_update", sessionId, configOptions } as AgentEvent);
          }
          json(res, 201, {
            id: sessionId,
            cwd: session?.cwd ?? body.cwd,
            title: session?.title ?? null,
            source: session?.source ?? source,
            configOptions,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("does not exist")) {
            json(res, 400, { error: msg });
          } else {
            json(res, 500, { error: msg });
          }
        }
        return;
      }

      // GET /api/v1/sessions/:id/events?thinking=0|1&limit=N&before=SEQ&after=SEQ
      const eventsMatch = url.match(/^\/api\/v1\/sessions\/([^/]+)\/events(\?.*)?$/);
      if (eventsMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(eventsMatch[1]);
        const params = new URLSearchParams(eventsMatch[2]?.slice(1) ?? "");
        const excludeThinking = params.get("thinking") === "0";
        const afterRaw = params.get("after");
        const afterSeq = afterRaw != null ? Number(afterRaw) : undefined;
        const beforeRaw = params.get("before");
        const beforeSeq = beforeRaw != null ? Number(beforeRaw) : undefined;
        const limitRaw = params.get("limit");
        const limit = limitRaw != null ? Math.max(1, Math.min(10000, Number(limitRaw))) : undefined;
        const session = store.getSession(sessionId);
        if (!session) {
          json(res, 404, { error: "Session not found" });
          return;
        }
        // Flush pending buffers so their content becomes part of the event list.
        // Track whether each buffer was non-empty so the frontend can keep the
        // last thinking/assistant element "open" for continued live streaming.
        let streamingThinking = false;
        let streamingAssistant = false;
        if (sessions) {
          if (sessions.thinkingBuffers.has(sessionId)) {
            streamingThinking = true;
            sessions.flushThinkingBuffer(sessionId);
          }
          if (sessions.assistantBuffers.has(sessionId)) {
            streamingAssistant = true;
            sessions.flushAssistantBuffer(sessionId);
          }
        }
        const events = store.getEvents(sessionId, { excludeThinking, afterSeq, beforeSeq, limit });
        // Re-sign image URLs at egress so 1h-old stored URLs become valid
        // again — the user can reload history days later and images still
        // resolve. Mutates `data` in-place; safe because store.getEvents
        // returns fresh records.
        if (deps.imageSecret) {
          for (const ev of events) {
            if (typeof ev.data === "string" && ev.data.includes("/images/")) {
              ev.data = reSignImageUrlsInJson(ev.data, deps.imageSecret);
            }
          }
        }
        const envelope: Record<string, unknown> = {
          events,
          streaming: { thinking: streamingThinking, assistant: streamingAssistant },
        };
        if (limit != null) {
          const total = store.getEventCount(sessionId, { excludeThinking });
          const hasMore = events.length > 0
            ? (store.getEvents(sessionId, { excludeThinking, beforeSeq: events[0].seq, limit: 1 }).length > 0)
            : false;
          envelope.total = total;
          envelope.hasMore = hasMore;
        }
        json(res, 200, envelope, req);
        return;
      }

      // --- SSE stream endpoints ---

      // GET /api/v1/events/stream — global SSE stream
      if (url.startsWith("/api/v1/events/stream") && req.method === "GET") {
        if (!deps.sseManager) { json(res, 501, { error: "SSE not available" }); return; }
        const sseManager = deps.sseManager;

        // Ticket-based auth (EventSource cannot send Authorization header).
        // When authStore is configured, every SSE connection MUST present a
        // valid single-use ticket from POST /api/v1/sse-ticket.
        let tokenName: string | undefined;
        if (deps.authStore) {
          const ticket = new URLSearchParams(url.split("?")[1] ?? "").get("ticket") ?? "";
          const principal = deps.ticketStore?.consume(ticket);
          if (!principal) {
            json(res, 401, { error: "Invalid or expired ticket" });
            return;
          }
          tokenName = principal.tokenName;
        }

        const clientId = sseManager.generateClientId();

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        const client: import("./sse-manager.ts").SseClient = { id: clientId, res, tokenName };
        sseManager.add(client);

        // Send connected event
        sseManager.sendEvent(client, { type: "connected", clientId, debugLevel: deps.debugLevel ?? "off" } as unknown as AgentEvent);
        sseManager.writeHeartbeat(client);
        return;
      }

      // GET /api/v1/sessions/:id/events/stream — per-session SSE stream
      const sseSessionMatch = url.match(/^\/api\/v1\/sessions\/([^/]+)\/events\/stream(\?.*)?$/);
      if (sseSessionMatch && req.method === "GET") {
        if (!deps.sseManager) { json(res, 501, { error: "SSE not available" }); return; }
        const sseManager = deps.sseManager;
        const sessionId = decodeURIComponent(sseSessionMatch[1]);

        let tokenName: string | undefined;
        if (deps.authStore) {
          const ticket = new URLSearchParams(url.split("?")[1] ?? "").get("ticket") ?? "";
          const principal = deps.ticketStore?.consume(ticket);
          if (!principal) {
            json(res, 401, { error: "Invalid or expired ticket" });
            return;
          }
          tokenName = principal.tokenName;
        }

        const session = store.getSession(sessionId);
        if (!session) {
          json(res, 404, { error: "Session not found" });
          return;
        }

        const clientId = sseManager.generateClientId();
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        const client: import("./sse-manager.ts").SseClient = { id: clientId, res, sessionId, tokenName };
        sseManager.add(client);

        // Send connected event
        sseManager.sendEvent(client, { type: "connected", clientId, debugLevel: deps.debugLevel ?? "off" } as unknown as AgentEvent);
        sseManager.writeHeartbeat(client);

        // Replay events from Last-Event-ID if provided
        const lastEventId = req.headers["last-event-id"];
        if (lastEventId) {
          const afterSeq = parseInt(lastEventId as string, 10);
          if (!isNaN(afterSeq)) {
            const events = store.getEvents(sessionId, { afterSeq });
            for (const evt of events) {
              try {
                sseManager.sendEvent(client, { type: evt.type, ...JSON.parse(evt.data) } as unknown as AgentEvent, evt.seq);
              } catch {
                // Skip malformed event data
              }
            }
          }
        }
        return;
      }

      // --- Images (session-scoped) ---

      // POST /api/v1/sessions/:id/images
      const imgUploadMatch = url.match(/^\/api\/v1\/sessions\/([^/]+)\/images\/?$/);
      if (imgUploadMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(imgUploadMatch[1]);
        if (!SAFE_ID.test(sessionId)) {
          json(res, 400, { error: "Invalid session ID" });
          return;
        }
        // Enforce upload size limit
        const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);
        if (contentLength > deps.limits.image_upload) {
          json(res, 413, { error: "Upload too large" });
          return;
        }
        const chunks: Buffer[] = [];
        let totalSize = 0;
        for await (const chunk of req) {
          totalSize += (chunk as Buffer).length;
          if (totalSize > deps.limits.image_upload) {
            json(res, 413, { error: "Upload too large" });
            return;
          }
          chunks.push(chunk as Buffer);
        }
        let body: { data: string; mimeType: string };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          json(res, 400, { error: "Invalid JSON" });
          return;
        }
        const { data, mimeType } = body;
        const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
        const seq = Date.now();
        const fileName = `${seq}.${ext}`;
        const relPath = `images/${sessionId}/${fileName}`;
        const absPath = join(deps.dataDir, relPath);
        await mkdir(join(deps.dataDir, "images", sessionId), { recursive: true });
        await writeFile(absPath, Buffer.from(data, "base64"));
        const basePath = `/api/v1/sessions/${sessionId}/images/${fileName}`;
        // 1h signed URL — long enough that the browser holds the rendered
        // image in <img> cache for the full session lifetime, short enough
        // that a leaked URL (screenshot, link share) expires within the day.
        const imgUrl = deps.imageSecret
          ? `${basePath}?${signImageUrl(basePath, deps.imageSecret, 3600)}`
          : basePath;
        json(res, 200, { path: relPath, url: imgUrl });
        return;
      }

      // GET /api/v1/sessions/:id/images/:file
      const imgGetMatch = url.match(/^\/api\/v1\/sessions\/([^/]+)\/images\/([^/?]+)(\?.*)?$/);
      if (imgGetMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(imgGetMatch[1]);
        const file = decodeURIComponent(imgGetMatch[2]);
        // When secret is configured, image GET requires sig+exp in query —
        // there is no Bearer fallback because <img src=...> can't carry
        // headers. Verify before any disk I/O.
        if (deps.imageSecret) {
          const params = new URLSearchParams(url.split("?")[1] ?? "");
          const sig = params.get("sig") ?? "";
          const exp = params.get("exp") ?? "";
          const basePath = `/api/v1/sessions/${sessionId}/images/${file}`;
          if (!verifyImageSig(basePath, exp, sig, deps.imageSecret)) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return;
          }
        }
        const filePath = join(deps.dataDir, "images", sessionId, file);
        if (!filePath.startsWith(join(deps.dataDir, "images"))) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }
        try {
          const fileData = await readFile(filePath);
          const ext = extname(filePath);
          res.writeHead(200, {
            "Content-Type": MIME[ext] ?? "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          res.end(fileData);
        } catch {
          res.writeHead(404);
          res.end("Not found");
        }
        return;
      }

      // --- Inbox messages (Stage B primitive) ---

      // POST /api/v1/messages — create ingress message
      if (url === "/api/v1/messages" && req.method === "POST") {
        // client-server-split M2: idempotency for the ingress message
        // creator. /messages has no real session id, so we scope the
        // cache under the synthetic key "__ingress__".
        const { opId, replayed } = tryReplayClientOp(req, res, store, "__ingress__");
        if (replayed) return;

        let raw: string;
        try { raw = await readBody(req); } catch { json(res, 400, { error: "Failed to read body" }); return; }
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
        const validation = MessageIngressSchema.safeParse(parsed);
        if (!validation.success) {
          json(res, 400, { error: "Invalid body", issues: validation.error.issues });
          return;
        }
        const input = validation.data;
        const id = `msg-${randomUUID().replace(/-/g, "").slice(0, 16)}`;

        if (input.to.startsWith("session:")) {
          const targetSid = input.to.slice("session:".length);
          const session = store.getSession(targetSid);
          if (!session) { json(res, 400, { error: "session_not_found" }); return; }
          sessions?.flushBuffers(targetSid);
          const data = {
            message_id: id,
            from_ref: input.from_ref,
            from_label: input.from_label ?? null,
            title: input.title,
            body: input.body,
            cwd: input.cwd ?? null,
          };
          store.saveEvent(targetSid, "message", data, { from_ref: input.from_ref });
          sseManager.broadcast({ type: "message", sessionId: targetSid, ...data });
          if (deps.pushService) {
            void deps.pushService.sendForMessage({
              id, to: input.to, body: input.body,
              from_label: input.from_label, from_ref: input.from_ref,
              deliver: input.deliver, dedup_key: input.dedup_key ?? null,
            });
          }
          console.info(`[msg] ingress bound msg_id=${id} sess_id=${targetSid.slice(0, 8)}`);
          const boundBody = { id, delivered: "session" };
          saveClientOpResult(store, opId, "__ingress__", 200, boundBody);
          json(res, 200, boundBody);
          return;
        }

        // Unbound: to=user → rows in `messages` table
        const dedupKey = input.dedup_key ?? null;
        if (dedupKey) {
          const prior = store.findBySupersede(input.to, dedupKey);
          if (prior) {
            store.deleteMessage(prior.id);
            console.info(`[msg] dedup_key supersede to=${input.to} dedup_key=${dedupKey} old_msg_id=${prior.id} new_msg_id=${id}`);
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
        if (deps.pushService) {
          void deps.pushService.sendForMessage({
            id, to: input.to, body: input.body,
            from_label: input.from_label, from_ref: input.from_ref,
            deliver: input.deliver, dedup_key: dedupKey,
          });
        }
        console.info(`[msg] ingress unbound msg_id=${id} from_ref=${input.from_ref}`);
        const unboundBody = { id, delivered: "pending" };
        saveClientOpResult(store, opId, "__ingress__", 200, unboundBody);
        json(res, 200, unboundBody);
        return;
      }

      // GET /api/v1/messages — list unprocessed
      if (url === "/api/v1/messages" && req.method === "GET") {
        json(res, 200, { messages: store.listUnprocessed() });
        return;
      }

      // /api/v1/messages/:id... — GET single, POST :id/consume, POST :id/ack, DELETE :id
      if (url.startsWith("/api/v1/messages/")) {
        const tail = url.slice("/api/v1/messages/".length);

        const consumeMatch = tail.match(/^([^/?]+)\/consume\/?$/);
        if (consumeMatch && req.method === "POST") {
          const id = decodeURIComponent(consumeMatch[1]);
          const newSid = randomUUID();
          let out: { sessionId: string; alreadyConsumed: boolean };
          try {
            out = store.consumeMessageTx(id, { sessionId: newSid });
          } catch (err) {
            if (/message not found/.test(errorMessage(err))) { json(res, 404, { error: "Message not found" }); return; }
            throw err;
          }
          sseManager.broadcast({ type: "message_consumed", messageId: id, sessionId: out.sessionId });
          if (!out.alreadyConsumed && deps.pushService) {
            void deps.pushService.sendClose(id);
          }
          console.info(`[msg] consume msg_id=${id} sess_id=${out.sessionId.slice(0, 8)} already_consumed=${out.alreadyConsumed}`);
          json(res, 200, { sessionId: out.sessionId, alreadyConsumed: out.alreadyConsumed });
          return;
        }

        const ackPost = tail.match(/^([^/?]+)\/ack\/?$/);
        const idOnly = tail.match(/^([^/?]+)\/?$/);
        const isAck = (ackPost && req.method === "POST") || (idOnly && req.method === "DELETE");
        if (isAck) {
          const id = decodeURIComponent((ackPost ?? idOnly)![1]);
          const changes = store.deleteMessage(id);
          if (changes === 0) { json(res, 404, { error: "Message not found" }); return; }
          sseManager.broadcast({ type: "message_acked", messageId: id });
          if (deps.pushService) void deps.pushService.sendClose(id);
          console.info(`[msg] ack msg_id=${id}`);
          json(res, 200, { ok: true });
          return;
        }

        if (idOnly && req.method === "GET") {
          const id = decodeURIComponent(idOnly[1]);
          const row = store.getMessage(id);
          if (!row) { json(res, 404, { error: "Message not found" }); return; }
          json(res, 200, row);
          return;
        }
      }

      json(res, 404, { error: "Not found" });
      return;
    }

    // --- Beta API routes ---
    if (url.startsWith("/api/beta/")) {
      res.setHeader("Content-Type", "application/json");

      // POST /api/beta/prompt — quick one-shot prompt (create temp session + send)
      if (url === "/api/beta/prompt" && req.method === "POST") {
        if (!sessions || !getBridge) {
          json(res, 503, { error: "Agent not available" });
          return;
        }
        const bridge = getBridge();
        if (!bridge) {
          json(res, 503, { error: "Agent not available" });
          return;
        }

        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: "Invalid JSON" });
          return;
        }

        const text = body.text as string | undefined;
        if (!text || typeof text !== "string") {
          json(res, 400, { error: "Missing required field: text" });
          return;
        }

        const cwd = (body.cwd as string) || undefined;
        const { sessionId } = await sessions.createSession(bridge, cwd, undefined, "auto");
        const streamUrl = `/api/v1/sessions/${sessionId}/events/stream`;

        json(res, 202, { sessionId, streamUrl });

        // Fire-and-forget: send the prompt asynchronously, tracking busy state
        sessions.activePrompts.add(sessionId);
        sessions.syncBusy(sessionId);
        // Generate title (fire-and-forget)
        if (titleService && !sessions.sessionHasTitle.has(sessionId)) {
          titleService.generate(bridge as AgentBridge, text, sessionId, (title) => {
            const titleEvent = { type: "session_title_updated", sessionId, title } as AgentEvent;
            sseManager.broadcast(titleEvent);
          });
        }
        bridge.prompt(sessionId, text)
          .catch(() => {})
          .finally(() => {
            sessions.activePrompts.delete(sessionId);
            sessions.syncBusy(sessionId);
          });
        return;
      }

      // POST /api/beta/clients/:clientId/visibility
      const visMatch = url.match(/^\/api\/beta\/clients\/([^/]+)\/visibility$/);
      if (visMatch && req.method === "POST") {
        if (!deps.sseManager) { json(res, 501, { error: "SSE not available" }); return; }
        const sseManager = deps.sseManager;
        const clientId = decodeURIComponent(visMatch[1]);

        // Trust boundary: accept if the client is (a) currently connected
        // via SSE, or (b) known to the ClientRegistry (populated on /hello,
        // persists across SSE disconnect). Registry check fixes the
        // pagehide-beacon race where iOS PWA suspension drops the SSE TCP
        // connection before the beacon egresses.
        const clientKnown =
          sseManager.clients.has(clientId) || deps.clientRegistry?.get(clientId) !== undefined;
        if (!clientKnown) {
          json(res, 404, { error: "Client not found" });
          return;
        }

        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: "Invalid JSON" });
          return;
        }

        if (typeof body.visible !== "boolean") {
          json(res, 400, { error: "Missing or invalid 'visible' field" });
          return;
        }

        // sessionId patch semantics: absent = preserve, null = clear,
        // string = replace. Zod can't distinguish omitted from explicit
        // null after parse, so branch on raw body key.
        const hasSessionIdKey = Object.prototype.hasOwnProperty.call(body, "sessionId");
        let sessionIdPatch: string | null | undefined;
        if (!hasSessionIdKey) {
          sessionIdPatch = undefined;
        } else if (body.sessionId === null) {
          sessionIdPatch = null;
        } else if (typeof body.sessionId === "string" && body.sessionId.length > 0) {
          sessionIdPatch = body.sessionId;
        } else {
          sessionIdPatch = null;
        }

        if (deps.pushService) {
          const { becameVisibleForSession } = deps.pushService.updateClient(clientId, {
            visible: body.visible,
            sessionId: sessionIdPatch,
          });
          // Edge-triggered only: heartbeat refreshes repeat the same
          // (visible:true, sessionId:X) POST every 15s — firing sendClose
          // on each would hammer banner recall. Only the first such
          // transition after a change should recall stale banners.
          if (becameVisibleForSession) {
            void deps.pushService.sendClose(`sess-${becameVisibleForSession}-done`);
            if (sessions) {
              for (const perm of sessions.pendingPermissions.values()) {
                if (perm.sessionId === becameVisibleForSession) {
                  void deps.pushService.sendClose(
                    `sess-${becameVisibleForSession}-perm-${perm.requestId}`,
                  );
                }
              }
            }
          }
        }

        json(res, 200, { ok: true });
        return;
      }

      // --- Push notification routes ---

      // GET /api/beta/push/vapid-key
      if (url === "/api/beta/push/vapid-key" && req.method === "GET") {
        if (!deps.pushService) {
          json(res, 404, { error: "Push not configured" });
          return;
        }
        json(res, 200, { publicKey: deps.pushService.getPublicKey() });
        return;
      }

      // POST /api/beta/push/subscribe
      if (url === "/api/beta/push/subscribe" && req.method === "POST") {
        if (!deps.pushService) {
          json(res, 404, { error: "Push not configured" });
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: { endpoint?: string; keys?: { auth?: string; p256dh?: string }; clientId?: string };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          json(res, 400, { error: "Invalid JSON" });
          return;
        }
        if (!body.endpoint || !body.keys?.auth || !body.keys?.p256dh) {
          json(res, 400, { error: "Missing endpoint or keys (auth, p256dh)" });
          return;
        }
        store.saveSubscription(body.endpoint, body.keys.auth, body.keys.p256dh);
        if (body.clientId && deps.pushService) {
          deps.pushService.registerClient(body.clientId, body.endpoint);
        }
        json(res, 201, { ok: true });
        return;
      }

      // POST /api/beta/push/register-client — associate clientId with push endpoint
      if (url === "/api/beta/push/register-client" && req.method === "POST") {
        if (!deps.pushService) {
          json(res, 404, { error: "Push not configured" });
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: { clientId?: string; endpoint?: string };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          json(res, 400, { error: "Invalid JSON" });
          return;
        }
        if (!body.clientId || !body.endpoint) {
          json(res, 400, { error: "Missing clientId or endpoint" });
          return;
        }
        deps.pushService.registerClient(body.clientId, body.endpoint);
        json(res, 200, { ok: true });
        return;
      }

      // POST /api/beta/push/unsubscribe
      if (url === "/api/beta/push/unsubscribe" && req.method === "POST") {
        if (!deps.pushService) {
          json(res, 404, { error: "Push not configured" });
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: { endpoint?: string };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          json(res, 400, { error: "Invalid JSON" });
          return;
        }
        if (body.endpoint) {
          store.removeSubscription(body.endpoint);
        }
        json(res, 200, { ok: true });
        return;
      }

      json(res, 404, { error: "Not found" });
      return;
    }

    // --- Static files ---
    let staticPath = url;
    const htmlEntry = HTML_ENTRYPOINTS.find((e) => e.urlPath === staticPath);
    if (htmlEntry) staticPath = "/" + htmlEntry.file;
    const filePath = join(deps.publicDir, staticPath);
    if (!filePath.startsWith(deps.publicDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    try {
      const data = await readFile(filePath);
      const ext = extname(filePath);
      const base = filePath.slice(filePath.lastIndexOf("/") + 1);
      const isHashedAsset = /\.[A-Za-z0-9_-]{8,}\.(js|css)$/.test(base);
      const cacheControl = isHashedAsset
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      const headers: Record<string, string> = {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Cache-Control": cacheControl,
      };
      // CSP applies to HTML entrypoints (where script/style execute).
      if (htmlEntry) headers["Content-Security-Policy"] = CSP_POLICY;
      res.writeHead(200, headers);
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  };
}
