import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "./store.ts";
import type { SessionManager } from "./session-manager.ts";
import type { AgentBridge } from "./bridge.ts";
import type { Config } from "./config.ts";
import type { PushService } from "./push-service.ts";
import type { AgentEvent } from "./types.ts";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface RequestHandlerDeps {
  store: Store;
  sessions?: SessionManager;
  getBridge?: () => (Pick<AgentBridge, "newSession" | "setConfigOption" | "loadSession" | "cancel" | "prompt" | "resolvePermission" | "denyPermission"> | null);
  publicDir: string;
  dataDir: string;
  limits: Pick<Config["limits"], "bash_output" | "image_upload"> & Partial<Pick<Config["limits"], "cancel_timeout">>;
  pushService?: PushService;
  broadcast?: (event: AgentEvent) => void;
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

/** Send a JSON response. */
function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function createRequestHandler(deps: RequestHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** @deprecated Use object form instead. */
export function createRequestHandler(store: Store, publicDir: string, dataDir: string, limits: RequestHandlerDeps["limits"], pushService?: PushService): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
export function createRequestHandler(
  storeOrDeps: Store | RequestHandlerDeps,
  publicDir?: string,
  dataDir?: string,
  limits?: RequestHandlerDeps["limits"],
  pushService?: PushService,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  // Normalize to deps object (support legacy positional args)
  const deps: RequestHandlerDeps = (storeOrDeps instanceof Store)
    ? { store: storeOrDeps, publicDir: publicDir!, dataDir: dataDir!, limits: limits!, pushService }
    : storeOrDeps as RequestHandlerDeps;

  const { store, sessions, getBridge, broadcast } = deps;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? "/";

    // --- API routes ---
    if (url.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");

      // GET /api/sessions
      if (url.startsWith("/api/sessions") && !url.slice("/api/sessions".length).match(/^\//) && req.method === "GET") {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const source = params.get("source") ?? undefined;
        res.end(JSON.stringify(store.listSessions(source ? { source } : undefined)));
        return;
      }

      // --- GET /api/config ---
      if (url === "/api/config" && req.method === "GET") {
        json(res, 200, {
          configOptions: sessions?.cachedConfigOptions ?? [],
          cancelTimeout: deps.limits.cancel_timeout ?? 0,
        });
        return;
      }

      // --- POST /api/sessions/:id/cancel ---
      const cancelMatch = url.match(/^\/api\/sessions\/([^/]+)\/cancel\/?$/);
      if (cancelMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(cancelMatch[1]);
        const session = store.getSession(sessionId);
        if (!session) { json(res, 404, { error: "Session not found" }); return; }
        const bridge = getBridge?.();
        if (!bridge) { json(res, 503, { error: "Agent not ready yet" }); return; }

        // Kill running bash process if any
        const proc = sessions?.runningBashProcs.get(sessionId);
        if (proc) {
          try { proc.kill(); } catch { /* already dead */ }
          sessions!.runningBashProcs.delete(sessionId);
        }
        // Cancel agent prompt
        if (sessions?.activePrompts.has(sessionId)) {
          await bridge.cancel(sessionId);
          sessions.activePrompts.delete(sessionId);
        }
        json(res, 200, { ok: true });
        return;
      }

      // --- GET /api/sessions/:id/status ---
      const statusMatch = url.match(/^\/api\/sessions\/([^/]+)\/status\/?$/);
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

      // --- POST /api/sessions/:id/messages ---
      const messagesMatch = url.match(/^\/api\/sessions\/([^/]+)\/messages\/?(\?.*)?$/);
      if (messagesMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(messagesMatch[1]);
        const session = store.getSession(sessionId);
        if (!session) { json(res, 404, { error: "Session not found" }); return; }
        const bridge = getBridge?.();
        if (!bridge) { json(res, 503, { error: "Agent not ready yet" }); return; }
        if (!sessions) { json(res, 503, { error: "Session manager not available" }); return; }

        // Check if session is busy
        const busyKind = sessions.getBusyKind(sessionId);
        if (busyKind) {
          json(res, 409, { error: "Session is busy", busyKind });
          return;
        }

        let body: { text?: string; images?: Array<{ data: string; mimeType: string }> };
        try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
        if (!body.text) { json(res, 400, { error: "Missing required field: text" }); return; }

        // Store user_message event and update last_active_at
        store.saveEvent(sessionId, "user_message", { text: body.text, images: body.images });
        store.updateSessionLastActive(sessionId);
        broadcast?.({ type: "user_message", sessionId, text: body.text, images: body.images } as AgentEvent);

        // Fire prompt asynchronously (don't await — response is 202)
        sessions.activePrompts.add(sessionId);
        bridge.prompt(sessionId, body.text, body.images).catch((err: unknown) => {
          console.error(`[prompt] error for ${sessionId}:`, err);
        }).finally(() => {
          sessions!.activePrompts.delete(sessionId);
        });

        json(res, 202, { status: "accepted" });
        return;
      }

      // --- GET /api/sessions/:id/messages ---
      if (messagesMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(messagesMatch[1]);
        const session = store.getSession(sessionId);
        if (!session) { json(res, 404, { error: "Session not found" }); return; }
        const params = new URLSearchParams(messagesMatch[2]?.slice(1) ?? "");
        const excludeThinking = params.get("thinking") === "0";
        const afterSeqRaw = params.get("after_seq");
        const afterSeq = afterSeqRaw != null ? Number(afterSeqRaw) : undefined;
        const events = store.getEvents(sessionId, { excludeThinking, afterSeq });
        json(res, 200, events);
        return;
      }

      // --- Session CRUD: /api/sessions/:id ---
      const sessionIdMatch = url.match(/^\/api\/sessions\/([^/?]+)\/?(\?.*)?$/);
      if (sessionIdMatch) {
        const sessionId = decodeURIComponent(sessionIdMatch[1]);

        // POST /api/sessions (create) — handled below since :id would match "sessions" literally
        // This match is for /api/sessions/:id only (not /api/sessions)

        // GET /api/sessions/:id
        if (req.method === "GET") {
          const session = store.getSession(sessionId);
          if (!session) {
            json(res, 404, { error: "Session not found" });
            return;
          }
          // Auto-resume if not live
          if (sessions && getBridge && !sessions.liveSessions.has(sessionId)) {
            const bridge = getBridge();
            if (bridge) {
              try {
                await sessions.resumeSession(bridge, sessionId);
              } catch (err) {
                json(res, 500, { error: `Failed to resume session: ${err instanceof Error ? err.message : String(err)}` });
                return;
              }
            }
          }
          const configOptions = sessions ? (() => {
            // Build configOptions from cached + stored overrides
            const opts = sessions.cachedConfigOptions.map(opt => {
              const stored: Record<string, string | null> = { model: session.model, mode: session.mode, reasoning_effort: session.reasoning_effort };
              const override = stored[opt.id];
              return override ? { ...opt, currentValue: override } : opt;
            });
            return opts;
          })() : [];
          json(res, 200, {
            id: session.id,
            cwd: session.cwd,
            title: session.title,
            source: session.source,
            model: session.model,
            mode: session.mode,
            configOptions,
            busy: sessions?.getBusyKind(sessionId) != null,
            busyKind: sessions?.getBusyKind(sessionId) ?? null,
          });
          return;
        }

        // DELETE /api/sessions/:id
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
          broadcast?.({ type: "session_deleted", sessionId } as AgentEvent);
          res.writeHead(204);
          res.end();
          return;
        }

        // PATCH /api/sessions/:id
        if (req.method === "PATCH") {
          const session = store.getSession(sessionId);
          if (!session) {
            json(res, 404, { error: "Session not found" });
            return;
          }
          const bridge = getBridge?.();
          if (!bridge) {
            json(res, 503, { error: "Agent not ready yet" });
            return;
          }
          let body: Record<string, string>;
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            json(res, 400, { error: "Invalid JSON" });
            return;
          }
          // Expect exactly one of: model, mode, reasoning_effort
          const configId = Object.keys(body).find(k => ["model", "mode", "reasoning_effort"].includes(k));
          if (!configId || !body[configId]) {
            json(res, 400, { error: "Expected one of: model, mode, reasoning_effort" });
            return;
          }
          try {
            const configOptions = await bridge.setConfigOption(sessionId, configId, body[configId]);
            for (const opt of configOptions) {
              store.updateSessionConfig(sessionId, opt.id, opt.currentValue);
            }
            broadcast?.({ type: "config_option_update", sessionId, configOptions } as AgentEvent);
            json(res, 200, { configOptions });
          } catch (err) {
            json(res, 500, { error: `Failed to set ${configId}: ${err instanceof Error ? err.message : String(err)}` });
          }
          return;
        }
      }

      // POST /api/sessions (create new session)
      if (url === "/api/sessions" && req.method === "POST") {
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
          broadcast?.({
            type: "session_created",
            sessionId,
            cwd: session?.cwd,
            title: session?.title,
            configOptions,
          } as AgentEvent);
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

      // GET /api/sessions/:id/events?thinking=0|1
      const eventsMatch = url.match(/^\/api\/sessions\/([^/]+)\/events(\?.*)?$/);
      if (eventsMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(eventsMatch[1]);
        const params = new URLSearchParams(eventsMatch[2]?.slice(1) ?? "");
        const excludeThinking = params.get("thinking") === "0";
        const afterSeqRaw = params.get("after_seq");
        const afterSeq = afterSeqRaw != null ? Number(afterSeqRaw) : undefined;
        const session = store.getSession(sessionId);
        if (!session) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Session not found" }));
          return;
        }
        const events = store.getEvents(sessionId, { excludeThinking, afterSeq });
        res.end(JSON.stringify(events));
        return;
      }

      // POST /api/images/:sessionId
      const imgMatch = url.match(/^\/api\/images\/([^/]+)$/);
      if (imgMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(imgMatch[1]);
        if (!SAFE_ID.test(sessionId)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid session ID" }));
          return;
        }
        // Enforce upload size limit
        const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);
        if (contentLength > deps.limits.image_upload) {
          res.writeHead(413);
          res.end(JSON.stringify({ error: "Upload too large" }));
          return;
        }
        const chunks: Buffer[] = [];
        let totalSize = 0;
        for await (const chunk of req) {
          totalSize += (chunk as Buffer).length;
          if (totalSize > deps.limits.image_upload) {
            res.writeHead(413);
            res.end(JSON.stringify({ error: "Upload too large" }));
            return;
          }
          chunks.push(chunk as Buffer);
        }
        let body: { data: string; mimeType: string };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        const { data, mimeType } = body;
        const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
        const seq = Date.now();
        const relPath = `images/${sessionId}/${seq}.${ext}`;
        const absPath = join(deps.dataDir, relPath);
        await mkdir(join(deps.dataDir, "images", sessionId), { recursive: true });
        await writeFile(absPath, Buffer.from(data, "base64"));
        const imgUrl = `/data/${relPath}`;
        res.end(JSON.stringify({ path: relPath, url: imgUrl }));
        return;
      }

      // --- Push notification routes ---

      // GET /api/push/vapid-key
      if (url === "/api/push/vapid-key" && req.method === "GET") {
        if (!deps.pushService) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Push not configured" }));
          return;
        }
        res.end(JSON.stringify({ publicKey: deps.pushService.getPublicKey() }));
        return;
      }

      // POST /api/push/subscribe
      if (url === "/api/push/subscribe" && req.method === "POST") {
        if (!deps.pushService) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Push not configured" }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: { endpoint?: string; keys?: { auth?: string; p256dh?: string } };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        if (!body.endpoint || !body.keys?.auth || !body.keys?.p256dh) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing endpoint or keys (auth, p256dh)" }));
          return;
        }
        store.saveSubscription(body.endpoint, body.keys.auth, body.keys.p256dh);
        res.writeHead(201);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/push/unsubscribe
      if (url === "/api/push/unsubscribe" && req.method === "POST") {
        if (!deps.pushService) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Push not configured" }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: { endpoint?: string };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        if (body.endpoint) {
          store.removeSubscription(body.endpoint);
        }
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // --- Serve uploaded images: /data/images/... ---
    if (url.startsWith("/data/images/")) {
      const filePath = join(deps.dataDir, url.slice(6)); // strip "/data/"
      if (!filePath.startsWith(join(deps.dataDir, "images"))) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      try {
        const data = await readFile(filePath);
        const ext = extname(filePath);
        res.writeHead(200, {
          "Content-Type": MIME[ext] ?? "application/octet-stream",
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    // --- Static files ---
    const filePath = join(deps.publicDir, url === "/" ? "/index.html" : url);
    if (!filePath.startsWith(deps.publicDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    try {
      const data = await readFile(filePath);
      const ext = extname(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  };
}
