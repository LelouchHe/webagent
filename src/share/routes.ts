import { readFile, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../store.ts";
import type { SessionManager } from "../session-manager.ts";
import type { Config } from "../config.ts";
import type { StoredEvent } from "../types.ts";
import type { ShareRow } from "../store.ts";
import { generateShareToken } from "../tokens.ts";
import { SanitizeError, sanitizeEventsForShare } from "./sanitize.ts";
import { buildContentDisposition, isInlineMime } from "../attachments.ts";

// In-flight dedup for concurrent POST /share on the same session.
// First caller does the work; concurrent callers await the same promise.
// Idempotent because the body re-checks for an existing preview before
// inserting.
const pendingShareCreates = new Map<
  string,
  Promise<{ row: ShareRow; reused: boolean }>
>();

export interface ShareRouteDeps {
  store: Store;
  sessions?: SessionManager;
  config: Config["share"];
  dataDir?: string;
  publicDir?: string;
}

const MAX_TTL_HOURS = 168;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/**
 * Content Security Policy applied to the public viewer surface only. Strict:
 * no inline script, no inline style, no remote origins. Self-served assets +
 * data: URIs for images (marked emits some). Report-only when enforce=false.
 */
function viewerCsp(enforce: boolean): { name: string; value: string } {
  const name = enforce
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";
  const value = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
  return { name, value };
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s = Buffer.concat(chunks).toString();
      if (!s) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(s));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/**
 * Dispatch share-related routes. Returns true if the route was handled
 * (response ended). When `config.enabled === false`, returns false
 * immediately — share routes are invisible.
 *
 * URL space claimed:
 *   /s, /s/:token                       (viewer — C3)
 *   /api/v1/sessions/:id/share          (preview create — C2 here)
 *   /api/v1/sessions/:id/share/preview  (preview read — C2 here)
 *   /api/v1/sessions/:id/share/publish  (activate — C3)
 *   /api/v1/shares, /api/v1/shares/:t   (owner list/patch — C4)
 *   /api/v1/shared/:token               (public viewer JSON — C3)
 */
// eslint-disable-next-line complexity -- TODO: split per-method dispatch
export async function handleShareRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ShareRouteDeps,
): Promise<boolean> {
  if (!deps.config.enabled) return false;

  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // Viewer static assets (CSS/JS) — served under /s/_/ so the share viewer
  // is fully self-contained behind one URL prefix. CF Access / proxies only
  // need to whitelist /s/* (not /js/*, /styles.*.css, etc.). Must come
  // before the /s/:token match so `_` doesn't get parsed as a token.
  const assetMatch = url.match(/^\/s\/_\/([A-Za-z0-9._-]+)\/?(?:\?.*)?$/);
  if (assetMatch && method === "GET") {
    await handleViewerAsset(res, deps, assetMatch[1]);
    return true;
  }

  // Viewer image proxy — must come before general /s/:token HTML match.
  const imgMatch = url.match(
    /^\/s\/([A-Za-z0-9_-]{24})\/attachments\/([^/?]+)\/?(?:\?.*)?$/,
  );
  if (imgMatch && method === "GET") {
    await handleViewerImage(
      res,
      deps,
      imgMatch[1],
      decodeURIComponent(imgMatch[2]),
    );
    return true;
  }

  // Viewer HTML shell.
  const viewerMatch = url.match(/^\/s\/([A-Za-z0-9_-]{24})\/?(?:\?.*)?$/);
  if (viewerMatch && method === "GET") {
    await handleViewerHtml(res, deps, viewerMatch[1]);
    return true;
  }
  if (url === "/s" || url === "/s/") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("share token required");
    return true;
  }

  // POST /api/v1/sessions/:id/share — create preview
  const createMatch = url.match(
    /^\/api\/v1\/sessions\/([^/?]+)\/share\/?(?:\?.*)?$/,
  );
  if (createMatch && method === "POST") {
    await handlePreviewCreate(
      req,
      res,
      deps,
      decodeURIComponent(createMatch[1]),
    );
    return true;
  }

  // GET /api/v1/sessions/:id/share/preview — read preview + staleness
  const previewMatch = url.match(
    /^\/api\/v1\/sessions\/([^/?]+)\/share\/preview\/?(?:\?.*)?$/,
  );
  if (previewMatch && method === "GET") {
    await handlePreviewRead(
      req,
      res,
      deps,
      decodeURIComponent(previewMatch[1]),
    );
    return true;
  }

  // POST /api/v1/sessions/:id/share/publish — promote preview to public
  const publishMatch = url.match(
    /^\/api\/v1\/sessions\/([^/?]+)\/share\/publish\/?(?:\?.*)?$/,
  );
  if (publishMatch && method === "POST") {
    await handlePublish(req, res, deps, decodeURIComponent(publishMatch[1]));
    return true;
  }

  // GET /api/v1/shared/:token/events — public viewer JSON (no auth)
  const sharedEventsMatch = url.match(
    /^\/api\/v1\/shared\/([A-Za-z0-9_-]{24})\/events\/?(?:\?.*)?$/,
  );
  if (sharedEventsMatch && method === "GET") {
    await handleSharedEvents(res, deps, sharedEventsMatch[1]);
    return true;
  }

  const revokeMatch = url.match(
    /^\/api\/v1\/sessions\/([^/?]+)\/share\/?(?:\?.*)?$/,
  );
  // DELETE /api/v1/sessions/:id/share — hard-delete share row
  if (revokeMatch && method === "DELETE") {
    await handleRevoke(req, res, deps, decodeURIComponent(revokeMatch[1]));
    return true;
  }
  // PATCH /api/v1/sessions/:id/share — update display_name / owner_label
  if (revokeMatch && method === "PATCH") {
    await handlePatchLabel(req, res, deps, decodeURIComponent(revokeMatch[1]));
    return true;
  }

  if (
    url.match(/^\/api\/v1\/share\/by\/?(?:\?.*)?$/) &&
    (method === "GET" || method === "PUT")
  ) {
    if (method === "GET") {
      // GET /api/v1/share/by — read default display_name preference
      await handleByGet(req, res, deps);
    } else {
      // PUT /api/v1/share/by — update default display_name preference
      await handleByPut(req, res, deps);
    }
    return true;
  }

  // GET /api/v1/shares — owner's active share list
  if (url.match(/^\/api\/v1\/shares\/?(?:\?.*)?$/) && method === "GET") {
    await handleOwnerList(req, res, deps);
    return true;
  }

  // Any other /api/v1/shares[/...] or /api/v1/shared/... miss → 404.
  if (
    /^\/api\/v1\/sessions\/[^/]+\/share(?:\/|$|\?)/.test(url) ||
    url === "/api/v1/shares" ||
    url.startsWith("/api/v1/shares/") ||
    url.startsWith("/api/v1/shared/") ||
    url === "/api/v1/share" ||
    url.startsWith("/api/v1/share/")
  ) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return true;
  }

  return false;
}

const DEFAULT_DISPLAY_NAME_KEY = "share.default_display_name";

function resolveDisplayName(
  deps: ShareRouteDeps,
  validated: string,
): string | null {
  if (validated !== "") return validated;
  return deps.store.getOwnerPref(DEFAULT_DISPLAY_NAME_KEY) ?? null;
}

/**
 * POST /api/v1/sessions/:id/share — create (or return existing) preview.
 *
 * share-plan §4.2 R1-c1: same-session dedup — if an un-activated preview
 * already exists, return it verbatim. Only create new on miss.
 *
 * Body (all optional):
 *   ttl_hours: number   — NULL/omitted falls back to config; 0 = never
 *                         expire; >0 clamped to MAX_TTL_HOURS (168)
 *   display_name: str   — shown as "by @<name>" in viewer footer
 *   owner_label: str    — private owner-side label (full validation in C4)
 */
async function handlePreviewCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ShareRouteDeps,
  sessionId: string,
): Promise<void> {
  const session = deps.store.getSession(sessionId);
  if (!session) {
    json(res, 404, { error: "session not found" });
    return;
  }

  // 409 guard: block while the agent is actively streaming into this session.
  if (deps.sessions?.getBusyKind(sessionId) === "agent") {
    json(res, 409, {
      error: "session busy",
      detail: "此 session 正在接收 agent 输出,请等 agent 输出结束后再分享",
    });
    return;
  }

  let body: {
    ttl_hours?: number | null;
    display_name?: string | null;
    owner_label?: string | null;
  };
  try {
    body = (await readJson(req)) as typeof body;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime defense; cast above lies to TS
    if (body === null || typeof body !== "object") body = {};
  } catch {
    json(res, 400, { error: "invalid JSON body" });
    return;
  }

  let ttlHours: number | null = null;
  if (body.ttl_hours != null) {
    if (!Number.isFinite(body.ttl_hours) || body.ttl_hours < 0) {
      json(res, 400, { error: "ttl_hours must be a non-negative number" });
      return;
    }
    ttlHours =
      body.ttl_hours === 0
        ? 0
        : Math.min(Math.floor(body.ttl_hours), MAX_TTL_HOURS);
  }

  // Labels are validated via the same helper as PATCH (V3 unify) — bidi/
  // control/size rejected at entry rather than silently dropped.
  const dnResult = validateLabel(body.display_name, "display_name", 256);
  if (!dnResult.ok) {
    json(res, 400, { error: dnResult.reason });
    return;
  }
  const olResult = validateLabel(body.owner_label, "owner_label", 1024);
  if (!olResult.ok) {
    json(res, 400, { error: olResult.reason });
    return;
  }
  const displayName = resolveDisplayName(deps, dnResult.value);
  const ownerLabel = olResult.value === "" ? null : olResult.value;

  try {
    const existingInflight = pendingShareCreates.get(sessionId);
    const inflight =
      existingInflight ??
      (async () => {
        // Dedup first — existing preview short-circuits the gate.
        const existing = deps.store.findActivePreviewBySession(sessionId);
        if (existing) return { row: existing, reused: true };

        // Flush buffered chunks so snapshot_seq includes the streaming tail.
        deps.sessions?.flushBuffers(sessionId);

        const allEvents = deps.store.getEvents(sessionId);
        const snapshotSeq =
          allEvents.length > 0 ? Math.max(...allEvents.map((e) => e.seq)) : 0;

        // Gate: run the sanitizer on-write. Hard-rejects throw here so we
        // never create a preview row for a session with leaked secrets.
        runSanitizeGate(allEvents, session.cwd, deps.config.internal_hosts);

        const token = generateShareToken();
        const row = deps.store.insertSharePreview({
          token,
          sessionId,
          snapshotSeq,
          ttlHours,
          displayName,
          ownerLabel,
        });
        return { row, reused: false };
      })().finally(() => {
        pendingShareCreates.delete(sessionId);
      });
    if (!existingInflight) pendingShareCreates.set(sessionId, inflight);
    const result = await inflight;

    json(res, result.reused ? 200 : 201, {
      token: result.row.token,
      session_id: sessionId,
      snapshot_seq: result.row.share_snapshot_seq,
      ttl_hours: result.row.ttl_hours,
      display_name: result.row.display_name,
      owner_label: result.row.owner_label,
      shared_at: result.row.shared_at,
      reused: result.reused,
    });
  } catch (err: unknown) {
    if (err instanceof SanitizeError) {
      json(res, 400, {
        error: "sanitize rejected",
        event_id: err.event_id,
        rule: err.rule,
        detail: err.message,
      });
      return;
    }
    const errorId = randomUUID();
    console.error(`[share] preview_create error_id=${errorId}`, err);
    json(res, 500, { error: "internal error", error_id: errorId });
  }
}

function runSanitizeGate(
  events: StoredEvent[],
  cwd: string,
  internalHosts: string[],
): void {
  // sanitizeEventsForShare throws SanitizeError on hard-reject.
  sanitizeEventsForShare({
    events,
    cwd,
    homeDir: homedir(),
    internalHosts,
  });
}

/**
 * GET /api/v1/sessions/:id/share/preview — read sanitized preview.
 *
 * Auth: owner + X-Share-Token header (token never in URL, never in logs).
 * Returns a `{schema_version, events, share}` bundle matching the public
 * viewer contract (minus public-only fields) so the overlay can share
 * the render path.
 */
async function handlePreviewRead(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ShareRouteDeps,
  sessionId: string,
): Promise<void> {
  const tokenHeader = req.headers["x-share-token"];
  const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
  if (!token) {
    json(res, 400, { error: "X-Share-Token header required" });
    return;
  }

  const row = deps.store.getShareByToken(token);
  if (!row) {
    json(res, 404, { error: "share not found" });
    return;
  }
  if (row.session_id !== sessionId) {
    json(res, 404, { error: "share not found" });
    return;
  }
  if (row.shared_at != null) {
    json(res, 409, { error: "share already active (use public viewer)" });
    return;
  }

  const session = deps.store.getSession(sessionId);
  if (!session) {
    json(res, 404, { error: "session not found" });
    return;
  }

  const allEvents = deps.store
    .getEvents(sessionId)
    .filter((e) => e.seq <= row.share_snapshot_seq);
  const currentLastSeq = deps.store
    .getEvents(sessionId)
    .reduce((m, e) => Math.max(m, e.seq), 0);

  try {
    const { events } = sanitizeEventsForShare({
      events: allEvents,
      cwd: session.cwd,
      homeDir: homedir(),
      internalHosts: deps.config.internal_hosts,
    });

    // Staleness metadata drives the owner sticky bar text (§2.1 R2-c3).
    const eventsSinceSnapshot = Math.max(
      0,
      currentLastSeq - row.share_snapshot_seq,
    );

    json(res, 200, {
      schema_version: "1.0",
      share: {
        token: row.token,
        session_id: sessionId,
        session_title: session.title,
        shared_at: null,
        snapshot_seq: row.share_snapshot_seq,
        current_last_seq: currentLastSeq,
        events_since_snapshot: eventsSinceSnapshot,
        created_at: row.created_at,
        display_name: row.display_name,
        owner_label: row.owner_label,
        ttl_hours: row.ttl_hours,
      },
      events,
    });
  } catch (err: unknown) {
    if (err instanceof SanitizeError) {
      json(res, 400, {
        error: "sanitize rejected",
        event_id: err.event_id,
        rule: err.rule,
      });
      return;
    }
    const errorId = randomUUID();
    console.error(`[share] preview_read error_id=${errorId}`, err);
    json(res, 500, { error: "internal error", error_id: errorId });
  }
}

/**
 * POST /api/v1/sessions/:id/share/publish — activate an existing preview.
 *
 * Body: { token, display_name?, owner_label? }
 * - token MUST match a preview row for this session that has not been
 *   activated or revoked.
 * - display_name / owner_label, if present, overwrite the preview row and
 *   are persisted into owner_prefs so the next /share defaults to them.
 *
 * Response: { token, session_id, shared_at, display_name, owner_label,
 *             public_url } on 200; 404/409/410 on state errors.
 */
// eslint-disable-next-line complexity -- TODO: split validation / state-update / response phases
async function handlePublish(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ShareRouteDeps,
  sessionId: string,
): Promise<void> {
  let body: {
    token?: string;
    display_name?: string | null;
    owner_label?: string | null;
  };
  try {
    body = (await readJson(req)) as typeof body;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime defense; cast above lies to TS
    if (body === null || typeof body !== "object") body = {};
  } catch {
    json(res, 400, { error: "invalid JSON body" });
    return;
  }

  if (!body.token || typeof body.token !== "string") {
    json(res, 400, { error: "token required" });
    return;
  }

  const row = deps.store.getShareByToken(body.token);
  if (!row) {
    json(res, 404, { error: "share not found" });
    return;
  }
  if (row.session_id !== sessionId) {
    json(res, 404, { error: "share not found" });
    return;
  }
  if (row.shared_at != null) {
    json(res, 409, {
      error: "share already active",
      token: row.token,
      shared_at: row.shared_at,
    });
    return;
  }

  // V3: publish uses the same validator as PATCH. Previously non-string or
  // over-limit input was silently coerced to null, overwriting whatever the
  // preview row (or an earlier PATCH) had set. Now reject at the edge.
  let displayName: string | null | undefined;
  if ("display_name" in body) {
    const r = validateLabel(body.display_name, "display_name", 256);
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    displayName = r.value === "" ? null : r.value;
  }
  let ownerLabel: string | null | undefined;
  if ("owner_label" in body) {
    const r = validateLabel(body.owner_label, "owner_label", 1024);
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    ownerLabel = r.value === "" ? null : r.value;
  }

  const activated = deps.store.activateShare(body.token, {
    ...(displayName !== undefined && { displayName }),
    ...(ownerLabel !== undefined && { ownerLabel }),
  });
  if (!activated) {
    // Race: concurrent revoke/activate between getShareByToken and activateShare.
    const fresh = deps.store.getShareByToken(body.token);
    if (!fresh) {
      json(res, 410, { error: "share revoked" });
      return;
    }
    if (fresh.shared_at != null) {
      json(res, 409, {
        error: "share already active",
        token: fresh.token,
        shared_at: fresh.shared_at,
      });
      return;
    }
    json(res, 500, { error: "unexpected activate failure" });
    return;
  }

  if (displayName !== undefined && displayName != null) {
    deps.store.setOwnerPref("share.default_display_name", displayName);
  }

  const after = deps.store.getShareByToken(body.token);
  if (!after) {
    json(res, 500, { error: "post-activate read failed" });
    return;
  }

  const origin =
    deps.config.viewer_origin && deps.config.viewer_origin !== ""
      ? deps.config.viewer_origin.replace(/\/$/, "")
      : "";
  json(res, 200, {
    token: after.token,
    session_id: sessionId,
    shared_at: after.shared_at,
    display_name: after.display_name,
    owner_label: after.owner_label,
    public_url: `${origin}/s/${after.token}`,
  });
}

/**
 * GET /s/:token — public viewer HTML shell. Sets a strict CSP header. No
 * owner auth; the viewer JS will fetch /api/v1/shared/:token/events.
 */
async function handleViewerHtml(
  res: ServerResponse,
  deps: ShareRouteDeps,
  token: string,
): Promise<void> {
  const row = deps.store.getShareByToken(token);
  if (row?.shared_at == null) {
    // Preview tokens (shared_at IS NULL) MUST NOT resolve publicly.
    const csp = viewerCsp(deps.config.csp_enforce);
    res.writeHead(410, {
      "Content-Type": "text/html; charset=utf-8",
      [csp.name]: csp.value,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    });
    res.end(
      "<!doctype html><html><body><h1>410</h1><p>此链接已撤销或过期。</p></body></html>",
    );
    return;
  }

  if (isExpired(row)) {
    const csp = viewerCsp(deps.config.csp_enforce);
    res.writeHead(410, {
      "Content-Type": "text/html; charset=utf-8",
      [csp.name]: csp.value,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    });
    res.end(
      "<!doctype html><html><body><h1>410</h1><p>此链接已过期。</p></body></html>",
    );
    return;
  }

  if (!deps.publicDir) {
    json(res, 500, { error: "publicDir not configured" });
    return;
  }

  try {
    const html = await readFile(
      join(deps.publicDir, "share-viewer.html"),
      "utf-8",
    );
    const csp = viewerCsp(deps.config.csp_enforce);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      [csp.name]: csp.value,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    });
    res.end(html);
    // Fire-and-forget: bump last_accessed_at so prune logic can age untouched shares.
    deps.store.touchShareAccessed(token);
  } catch (err: unknown) {
    const errorId = randomUUID();
    console.error(`[share] viewer_html error_id=${errorId}`, err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`viewer unavailable (error_id=${errorId})`);
  }
}

/**
 * GET /api/v1/shared/:token/events — public JSON. Re-runs the sanitizer
 * on every call (cached by projection LRU). No owner auth.
 */
async function handleSharedEvents(
  res: ServerResponse,
  deps: ShareRouteDeps,
  token: string,
): Promise<void> {
  const row = deps.store.getShareByToken(token);
  if (row?.shared_at == null) {
    json(res, 410, { error: "share revoked or not found" });
    return;
  }
  if (isExpired(row)) {
    json(res, 410, { error: "share expired" });
    return;
  }

  // Public viewer must keep working after the owner deletes the source
  // session — events stay alive as long as any active share references
  // them (Store.deleteSession soft-deletes when shares exist).
  const session = deps.store.getSessionIncludingDeleted(row.session_id);
  if (!session) {
    json(res, 500, { error: "session vanished" });
    return;
  }

  const allEvents = deps.store
    .getEvents(row.session_id)
    .filter((e) => e.seq <= row.share_snapshot_seq);

  try {
    const { events } = sanitizeEventsForShare({
      events: allEvents,
      cwd: session.cwd,
      homeDir: homedir(),
      internalHosts: deps.config.internal_hosts,
    });

    // Public response: DOES NOT expose session_id. Only title + display_name + meta.
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(
      JSON.stringify({
        schema_version: "1.0",
        share: {
          token: row.token,
          session_title: session.title,
          shared_at: row.shared_at,
          snapshot_seq: row.share_snapshot_seq,
          display_name: row.display_name,
          created_at: row.created_at,
          ttl_hours: row.ttl_hours,
        },
        events,
      }),
    );
  } catch (err: unknown) {
    if (err instanceof SanitizeError) {
      // Hard-reject on a LIVE active share — owner's session gained a
      // post-publish leak. Return 410 publicly; owner sees root cause via
      // preview re-gate.
      console.error("[share] shared_events hard-reject", {
        rule: err.rule,
        event_id: err.event_id,
      });
      json(res, 410, { error: "share unavailable" });
      return;
    }
    const errorId = randomUUID();
    console.error(`[share] shared_events error_id=${errorId}`, err);
    json(res, 500, { error: "internal error", error_id: errorId });
  }
}

/**
 * GET /s/_/<file> — viewer-namespaced static asset proxy. Serves the same
 * hashed CSS/JS bundles as the main app, but under a /s/* path so the
 * viewer is fully self-contained behind one URL prefix (single CF Access
 * bypass, no leakage of owner-only paths). Read-only allowlist of safe
 * filename patterns; hashed bundles get immutable cache, dev-mode unhashed
 * bundles get no-cache.
 */
async function handleViewerAsset(
  res: ServerResponse,
  deps: ShareRouteDeps,
  file: string,
): Promise<void> {
  if (!deps.publicDir) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("publicDir not configured");
    return;
  }

  // Strict filename allowlist — only the bundles share-viewer.html references.
  // Hashed prod: styles.HASH.css, share-viewer.HASH.css, viewer.HASH.js, chunk.HASH.js
  // Dev unhashed: styles.css, share-viewer.css, viewer.js
  const cssMatch = /^(styles|share-viewer)(?:\.[A-Za-z0-9_-]+)?\.css$/.test(
    file,
  );
  const jsMatch = /^(viewer|chunk)(?:\.[A-Za-z0-9_-]+)?\.js$/.test(file);
  if (!cssMatch && !jsMatch) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }

  const filePath = jsMatch
    ? join(deps.publicDir, "js", file)
    : join(deps.publicDir, file);

  // Hashed bundles (X.HASH.css|js) are content-addressed → immutable.
  // Dev unhashed bundles (X.css|js) revalidate every load.
  const hashed = /\.[A-Za-z0-9_-]{6,}\.(css|js)$/.test(file);
  const cacheControl = hashed
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  const contentType = jsMatch
    ? "text/javascript; charset=utf-8"
    : "text/css; charset=utf-8";

  try {
    const buf = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}

/**
 * GET /s/:token/attachments/:file — token-scoped image proxy. Resolves the token
 * to a session_id on-demand; directly serving /api/v1/sessions/:id/images
 * would leak session_id.
 */
async function handleViewerImage(
  res: ServerResponse,
  deps: ShareRouteDeps,
  token: string,
  file: string,
): Promise<void> {
  if (!deps.dataDir) {
    json(res, 500, { error: "dataDir not configured" });
    return;
  }

  const row = deps.store.getShareByToken(token);
  if (row?.shared_at == null) {
    json(res, 410, { error: "share unavailable" });
    return;
  }
  if (isExpired(row)) {
    json(res, 410, { error: "share expired" });
    return;
  }

  // Only allow simple filenames — reject any path separators / dotfiles / traversal.
  if (!/^[A-Za-z0-9._-]+$/.test(file) || file.startsWith(".")) {
    json(res, 404, { error: "invalid file" });
    return;
  }

  const sessionRoot = join(
    deps.dataDir,
    "sessions",
    row.session_id,
    "attachments",
  );
  const filePath = join(sessionRoot, file);
  // Final realpath-style guard: must stay under <dataDir>/sessions/<sid>/attachments.
  if (!filePath.startsWith(sessionRoot + "/") && filePath !== sessionRoot) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const buf = await readFile(filePath);
    // Look up the attachment row to recover the original mime + display
    // name. Without this iOS Safari sees Content-Type: octet-stream and
    // appends ".bin" to the <a download> name (e.g. zhihu.user.js →
    // zhihu.user.js.bin). The owner-side route at routes.ts does the
    // same lookup; share viewer needs parity for non-image attachments.
    const att = deps.store.getAttachmentByFile(row.session_id, file);
    const ext = extname(filePath).toLowerCase();
    let mime = att?.mime;
    mime ??= IMAGE_MIME[ext];
    mime ??= "application/octet-stream";
    const headers: Record<string, string> = {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "X-Robots-Tag": "noindex, nofollow",
    };
    if (att) {
      const disposition = isInlineMime(mime) ? "inline" : "attachment";
      headers["Content-Disposition"] = buildContentDisposition(
        disposition,
        att.name,
      );
    }
    res.writeHead(200, headers);
    res.end(buf);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

function isExpired(row: ShareRow): boolean {
  if (row.ttl_hours == null || row.ttl_hours === 0) return false;
  const anchor = row.shared_at ?? row.created_at;
  return Date.now() > anchor + row.ttl_hours * 3600_000;
}

/**
 * Validate owner-supplied label/display_name text. Rules:
 * - string only (null/undefined → empty string, treated as "unset")
 * - UTF-8 byte length ≤ maxBytes (default 1024 for owner_label, 256 for display_name)
 * - reject C0 controls (\x00..\x1f) except TAB (\t)
 * - reject DEL (\x7f)
 * - reject bidi override / isolate codepoints U+202A..U+202E, U+2066..U+2069
 *
 * Unpaired surrogates are intentionally NOT rejected. Labels are rendered
 * via textContent in the viewer; a lone surrogate renders as U+FFFD replacement
 * with no security implication. SQLite (WTF-8) and JSON.stringify both
 * tolerate them.
 *
 * Returns `{ ok: true, value }` on accept, `{ ok: false, reason }` on reject.
 * Empty string is accepted (caller decides semantics).
 */
export function validateLabel(
  input: unknown,
  field: string,
  maxBytes: number = 1024,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (input == null) return { ok: true, value: "" };
  if (typeof input !== "string")
    return { ok: false, reason: `${field} must be a string` };
  if (Buffer.byteLength(input, "utf8") > maxBytes) {
    return { ok: false, reason: `${field} exceeds ${maxBytes} bytes` };
  }
  // Iterate by Unicode codepoint (for..of uses the string iterator, which
  // yields one codepoint per step — supplementary chars are not split into
  // two surrogate halves). All checked ranges are in the BMP so charCodeAt
  // would also work, but codepoint iteration keeps the code UTF-16 agnostic.
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 && cp !== 0x09)
      return { ok: false, reason: `${field} contains control character` };
    if (cp === 0x7f)
      return { ok: false, reason: `${field} contains DEL character` };
    if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) {
      return { ok: false, reason: `${field} contains bidi override` };
    }
  }
  return { ok: true, value: input };
}

/**
 * DELETE /api/v1/sessions/:id/share — revoke an active or preview share.
 * Body: { token }.
 * Idempotent: already-revoked tokens return 200 with revoked=false.
 * Returns { ok, token, revoked, purge_status }. purge_status is always
 * 'skipped' in v1 — image/event purge is a future hardening pass.
 */
async function handleRevoke(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ShareRouteDeps,
  sessionId: string,
): Promise<void> {
  let body: { token?: string };
  try {
    body = (await readJson(req)) as typeof body;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime defense; cast above lies to TS
    if (body === null || typeof body !== "object") body = {};
  } catch {
    json(res, 400, { error: "invalid JSON body" });
    return;
  }

  if (!body.token || typeof body.token !== "string") {
    json(res, 400, { error: "token required" });
    return;
  }

  const row = deps.store.getShareByToken(body.token);
  if (!row) {
    // Idempotent DELETE: row already gone (revoked or never existed).
    // We can't verify session ownership without a row, but the token
    // is opaque/random so leaking "revoked or never existed" is fine.
    json(res, 200, {
      ok: true,
      token: body.token,
      revoked: false,
      purge_status: "skipped",
    });
    return;
  }
  if (row.session_id !== sessionId) {
    json(res, 404, { error: "share not found" });
    return;
  }

  const revoked = deps.store.revokeShare(body.token);
  // If this was the last share on a soft-deleted session, finish the
  // hard-delete (events + sessions row) so we don't leak orphans.
  if (revoked) {
    const reaped = deps.store.reapTombstoneIfOrphaned(row.session_id);
    if (reaped && deps.dataDir) {
      // Tombstoned session is fully gone; sweep its attachments directory too.
      rm(join(deps.dataDir, "sessions", row.session_id), {
        recursive: true,
        force: true,
      }).catch(() => {});
    }
  }
  json(res, 200, {
    ok: true,
    token: body.token,
    revoked,
    purge_status: "skipped",
  });
}

/**
 * PATCH /api/v1/sessions/:id/share — update owner_label / display_name on
 * a live (non-revoked) share. Body: { token, owner_label?, display_name? }.
 *
 * Full validation: UTF-8 ≤1024B, no C0 controls (except TAB), no DEL, no
 * bidi overrides. Fields omitted from body are left unchanged; fields set
 * to empty string clear the value.
 */
async function handlePatchLabel(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ShareRouteDeps,
  sessionId: string,
): Promise<void> {
  let body: { token?: string; owner_label?: unknown; display_name?: unknown };
  try {
    body = (await readJson(req)) as typeof body;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime defense; cast above lies to TS
    if (body === null || typeof body !== "object") body = {};
  } catch {
    json(res, 400, { error: "invalid JSON body" });
    return;
  }

  if (!body.token || typeof body.token !== "string") {
    json(res, 400, { error: "token required" });
    return;
  }

  const row = deps.store.getShareByToken(body.token);
  if (!row) {
    json(res, 404, { error: "share not found" });
    return;
  }
  if (row.session_id !== sessionId) {
    json(res, 404, { error: "share not found" });
    return;
  }

  let ownerLabel: string | null | undefined = undefined;
  if ("owner_label" in body) {
    const v = validateLabel(body.owner_label, "owner_label", 1024);
    if (!v.ok) {
      json(res, 400, { error: v.reason });
      return;
    }
    ownerLabel = v.value === "" ? null : v.value;
  }

  let displayName: string | null | undefined = undefined;
  if ("display_name" in body) {
    const v = validateLabel(body.display_name, "display_name", 256);
    if (!v.ok) {
      json(res, 400, { error: v.reason });
      return;
    }
    displayName = v.value === "" ? null : v.value;
  }

  if (ownerLabel !== undefined)
    deps.store.updateShareOwnerLabel(body.token, ownerLabel);
  if (displayName !== undefined)
    deps.store.updateShareDisplayName(body.token, displayName);

  const after = deps.store.getShareByToken(body.token);
  if (!after) {
    json(res, 500, { error: "post-patch read failed" });
    return;
  }
  json(res, 200, {
    token: after.token,
    session_id: sessionId,
    owner_label: after.owner_label,
    display_name: after.display_name,
  });
}

/**
 * GET /api/v1/shares — owner-only list of live (non-revoked) shares.
 * Returns { shares: [...] } with preview + active rows separated by
 * shared_at (null = preview).
 */
async function handleOwnerList(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ShareRouteDeps,
): Promise<void> {
  const rows = deps.store.listOwnerShares();
  json(res, 200, { shares: rows });
}

/**
 * GET /api/v1/share/by — read the owner's default display_name (used by
 * the slash menu to surface the current value as secondary text).
 * Returns { value: string | null }; null = not set / will publish anonymously.
 */
async function handleByGet(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ShareRouteDeps,
): Promise<void> {
  const value = deps.store.getOwnerPref(DEFAULT_DISPLAY_NAME_KEY) ?? null;
  json(res, 200, { value });
}

/**
 * PUT /api/v1/share/by — set or clear the owner's default display_name.
 * Body { value: string | null }. null / empty string clears. Validation
 * mirrors the publish/PATCH endpoints (≤256 bytes UTF-8, no controls/bidi).
 */
async function handleByPut(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ShareRouteDeps,
): Promise<void> {
  let body: { value?: unknown };
  try {
    body = (await readJson(req)) as typeof body;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime defense; cast above lies to TS
    if (body === null || typeof body !== "object") body = {};
  } catch {
    json(res, 400, { error: "invalid JSON body" });
    return;
  }

  const v = validateLabel(body.value, "value", 256);
  if (!v.ok) {
    json(res, 400, { error: v.reason });
    return;
  }
  if (v.value === "") {
    deps.store.clearOwnerPref(DEFAULT_DISPLAY_NAME_KEY);
    json(res, 200, { value: null });
  } else {
    deps.store.setOwnerPref(DEFAULT_DISPLAY_NAME_KEY, v.value);
    json(res, 200, { value: v.value });
  }
}
