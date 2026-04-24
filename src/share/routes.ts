import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../store.ts";
import type { SessionManager } from "../session-manager.ts";
import type { Config } from "../config.ts";
import type { StoredEvent } from "../types.ts";
import { generateShareToken } from "./token.ts";
import { assertOwner, OwnerAuthError } from "./auth.ts";
import { SanitizeError, type SanitizeInputEvent } from "./sanitize.ts";
import { getOrComputeProjection } from "./projection.ts";
import { withSessionLock } from "./mutex.ts";

export interface ShareRouteDeps {
  store: Store;
  sessions?: SessionManager;
  config: Config["share"];
}

const MAX_TTL_HOURS = 168;

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s = Buffer.concat(chunks).toString();
      if (!s) { resolve({}); return; }
      try { resolve(JSON.parse(s)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
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
export async function handleShareRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ShareRouteDeps,
): Promise<boolean> {
  if (!deps.config.enabled) return false;

  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // Viewer HTML (real shell in C3).
  if (url === "/s" || url.startsWith("/s/") || url.startsWith("/s?")) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("share viewer not yet implemented (C3)");
    return true;
  }

  const createMatch = url.match(/^\/api\/v1\/sessions\/([^/?]+)\/share\/?(?:\?.*)?$/);
  if (createMatch && method === "POST") {
    await handlePreviewCreate(req, res, deps, decodeURIComponent(createMatch[1]));
    return true;
  }

  const previewMatch = url.match(/^\/api\/v1\/sessions\/([^/?]+)\/share\/preview\/?(?:\?.*)?$/);
  if (previewMatch && method === "GET") {
    await handlePreviewRead(req, res, deps, decodeURIComponent(previewMatch[1]));
    return true;
  }

  // Other share sub-routes (publish, revoke, list, shared/*) — C3/C4.
  if (
    /^\/api\/v1\/sessions\/[^/]+\/share(?:\/|$|\?)/.test(url) ||
    url === "/api/v1/shares" ||
    url.startsWith("/api/v1/shares/") ||
    url.startsWith("/api/v1/shared/")
  ) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "share API not yet implemented" }));
    return true;
  }

  return false;
}

function ownerReject(res: ServerResponse, err: OwnerAuthError): void {
  json(res, err.status, { error: "owner auth required", reason: err.reason });
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
 *   display_name: str   — shown as "shared by @<name>"
 *   owner_label: str    — private owner-side label (full validation in C4)
 */
async function handlePreviewCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ShareRouteDeps,
  sessionId: string,
): Promise<void> {
  try {
    assertOwner(req);
  } catch (e) {
    if (e instanceof OwnerAuthError) { ownerReject(res, e); return; }
    throw e;
  }

  const session = deps.store.getSession(sessionId);
  if (!session) { json(res, 404, { error: "session not found" }); return; }

  // 409 guard: block while the agent is actively streaming into this session.
  if (deps.sessions?.getBusyKind(sessionId) === "agent") {
    json(res, 409, {
      error: "session busy",
      detail: "此 session 正在接收 agent 输出,请等 agent 输出结束后再分享",
    });
    return;
  }

  let body: { ttl_hours?: number | null; display_name?: string | null; owner_label?: string | null };
  try {
    body = (await readJson(req)) as typeof body;
    if (body === null || typeof body !== "object") body = {};
  } catch { json(res, 400, { error: "invalid JSON body" }); return; }

  let ttlHours: number | null = null;
  if (body.ttl_hours != null) {
    if (!Number.isFinite(body.ttl_hours) || body.ttl_hours < 0) {
      json(res, 400, { error: "ttl_hours must be a non-negative number" });
      return;
    }
    ttlHours = body.ttl_hours === 0 ? 0 : Math.min(Math.floor(body.ttl_hours), MAX_TTL_HOURS);
  }

  // Full validation of display_name/owner_label lands in C4 (1024 byte cap,
  // control char + bidi override reject). v2 accepts pass-through with a
  // basic length guard so the contract shape is exercised.
  const displayName = typeof body.display_name === "string" && body.display_name.length <= 256
    ? body.display_name : null;
  const ownerLabel = typeof body.owner_label === "string" && body.owner_label.length <= 1024
    ? body.owner_label : null;

  try {
    const result = await withSessionLock(`share:${sessionId}`, async () => {
      // Dedup first — existing preview short-circuits the gate.
      const existing = deps.store.findActivePreviewBySession(sessionId);
      if (existing) return { row: existing, reused: true };

      // Flush buffered chunks so snapshot_seq includes the streaming tail.
      deps.sessions?.flushBuffers(sessionId);

      const allEvents = deps.store.getEvents(sessionId);
      const snapshotSeq = allEvents.length > 0 ? Math.max(...allEvents.map(e => e.seq)) : 0;

      // Gate: run the sanitizer on-write. Hard-rejects throw here so we
      // never create a preview row for a session with leaked secrets.
      runSanitizeGate(allEvents, session.cwd, deps.config.internal_hosts);

      const token = generateShareToken();
      const row = deps.store.insertSharePreview({
        token, sessionId, snapshotSeq, ttlHours, displayName, ownerLabel,
      });
      return { row, reused: false };
    });

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
      json(res, 400, { error: "sanitize rejected", event_id: err.event_id, rule: err.rule, detail: err.message });
      return;
    }
    const errorId = randomUUID();
    console.error(`[share] preview_create error_id=${errorId}`, err);
    json(res, 500, { error: "internal error", error_id: errorId });
  }
}

function runSanitizeGate(events: StoredEvent[], cwd: string, internalHosts: string[]): void {
  // getOrComputeProjection throws SanitizeError on hard-reject.
  getOrComputeProjection({
    sessionId: "__gate__",
    events: events as SanitizeInputEvent[],
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
  try {
    assertOwner(req);
  } catch (e) {
    if (e instanceof OwnerAuthError) { ownerReject(res, e); return; }
    throw e;
  }

  const tokenHeader = req.headers["x-share-token"];
  const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
  if (!token) { json(res, 400, { error: "X-Share-Token header required" }); return; }

  const row = deps.store.getShareByToken(token);
  if (!row) { json(res, 404, { error: "share not found" }); return; }
  if (row.session_id !== sessionId) { json(res, 404, { error: "token does not match session" }); return; }
  if (row.revoked_at != null) { json(res, 410, { error: "share revoked" }); return; }
  if (row.shared_at != null) { json(res, 409, { error: "share already active (use public viewer)" }); return; }

  const session = deps.store.getSession(sessionId);
  if (!session) { json(res, 404, { error: "session not found" }); return; }

  const allEvents = deps.store.getEvents(sessionId).filter(e => e.seq <= row.share_snapshot_seq);
  const currentLastSeq = deps.store.getEvents(sessionId).reduce((m, e) => Math.max(m, e.seq), 0);

  try {
    const { events, cacheHit } = getOrComputeProjection({
      sessionId,
      events: allEvents as SanitizeInputEvent[],
      cwd: session.cwd,
      homeDir: homedir(),
      internalHosts: deps.config.internal_hosts,
    });

    // Staleness metadata drives the owner sticky bar text (§2.1 R2-c3).
    const eventsSinceSnapshot = Math.max(0, currentLastSeq - row.share_snapshot_seq);

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
      cache_hit: cacheHit,
    });
  } catch (err: unknown) {
    if (err instanceof SanitizeError) {
      json(res, 400, { error: "sanitize rejected", event_id: err.event_id, rule: err.rule });
      return;
    }
    const errorId = randomUUID();
    console.error(`[share] preview_read error_id=${errorId}`, err);
    json(res, 500, { error: "internal error", error_id: errorId });
  }
}
