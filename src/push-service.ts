import webpush from "web-push";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Store } from "./store.ts";

const VAPID_FILE = "vapid.json";
/** Remove a subscription after this many consecutive send failures. */
const MAX_CONSECUTIVE_FAILURES = 5;

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export type PushNotification =
  | {
      kind: "notify";
      title: string;
      body: string;
      tag: string;
      data: { sessionId?: string; messageId?: string };
    }
  | {
      kind: "close";
      tag: string;
    };

/** Incoming event shape for sendForEvent. Caller passes enough info to derive the tag. */
export interface PushableEvent {
  type: string;
  title?: string; // permission_request.title
  command?: string; // bash_done.command
  exitCode?: number | string;
  /** DB event seq (bash) or ACP requestId (permission). String or number supported. */
  eventId?: number | string;
}

/** Slice of message fields needed for egress. Avoids coupling to the full MessageRow shape. */
export interface PushableMessage {
  id: string;
  to: string;
  body: string;
  from_label?: string;
  from_ref?: string;
  deliver?: "silent" | "inapp" | "push";
  /**
   * Optional collapse key. When present, the push tag is derived from
   * (to, dedup_key) rather than msg.id, so a later message with the same
   * key replaces the earlier banner on-device instead of stacking.
   */
  dedup_key?: string | null;
}

/** Derive the push tag for an ACP event. Kept module-level so it can be
 *  reused by the close-on-handle path without instantiating the service. */
export function pushTagForEvent(sessionId: string, event: PushableEvent): string {
  switch (event.type) {
    case "prompt_done":
      return `sess-${sessionId}-done`;
    case "permission_request":
      return `sess-${sessionId}-perm-${event.eventId ?? "0"}`;
    case "bash_done":
      return `sess-${sessionId}-bash-${event.eventId ?? "0"}`;
    default:
      return `sess-${sessionId}-${event.type}`;
  }
}

/**
 * True iff the push endpoint is an Apple (APNs / Web Push on Apple) host.
 *
 * We deliberately filter silent `kind:"close"` pushes to these endpoints in
 * `sendToAll` — iOS Safari PWA enforces an undocumented silent-push budget
 * that, once exhausted, causes WebKit to drop ALL subsequent pushes for the
 * subscription (including user-visible `kind:"notify"`). APNs returns 201
 * throughout, so the server has zero visibility.
 *
 * macOS Safari shares the same host but is not subject to that budget; the
 * conflation here is accepted collateral damage until we add a `platform`
 * column to `push_subscriptions`.
 */
export function isAppleEndpoint(endpoint: string): boolean {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "web.push.apple.com" || host.endsWith(".push.apple.com");
}

/**
 * Per-client presence record. Consolidates prior 3-Map state
 * (visibility/endpoint/sessionId) and adds the `visibleSince` stamp that
 * powers server-side TTL expiration of ghost visibility records.
 */
export interface ClientState {
  visible: boolean;
  sessionId: string | null;
  endpoint: string | null;
  /** ms timestamp (from injected `now()`) when `visible` last became true; 0 when not visible. */
  visibleSince: number;
}

/** Explicit input shape for `updateClient`. Distinguish "omitted" (preserve)
 *  from "explicit null" (clear) — caller must not pass undefined to clear. */
export interface ClientStatePatch {
  visible?: boolean;
  sessionId?: string | null; // undefined = preserve, null = explicit clear
  endpoint?: string | null; // undefined = preserve, null = explicit clear
}

/** What updateClient reports back. Used by the /visibility handler to
 *  fire sendClose edge-triggered instead of on every heartbeat refresh. */
export interface UpdateClientResult {
  /**
   * Non-null iff this update transitioned the client to
   * `visible + sessionId=X` (either from invisible → visible, or from a
   * different sessionId → X while visible). Repeated "still visible + same sid"
   * heartbeat refreshes return `null`.
   */
  becameVisibleForSession: string | null;
}

export interface PushServiceOptions {
  /** When false, `isSessionVisibleToAnyClient` always returns false —
   *  kill switch for the cross-device global suppression feature. */
  globalVisibilitySuppression?: boolean;
  /** Visibility records older than this (ms since last refresh) are treated
   *  as stale and do not suppress. Default 60_000. */
  visibilityTtlMs?: number;
  /** Injection point for tests. Default Date.now. */
  now?: () => number;
}

function emptyClientState(): ClientState {
  return { visible: false, sessionId: null, endpoint: null, visibleSince: 0 };
}

export class PushService {
  private readonly store: Store;
  private readonly vapidKeys: VapidKeys;
  /**
   * Consolidated per-client state. Previously 3 separate Maps
   * (clientVisibility/clientEndpoints/clientSessions) which drifted under
   * partial updates. v2 merges them; `visibleSince` stamps when the client
   * transitioned to visible so the server can TTL-expire "ghost" visibility
   * records left by iOS PWA process suspension (where the client never gets
   * to POST visible:false).
   */
  private readonly clients = new Map<string, ClientState>();
  /** endpoint → consecutive failure count (absent or 0 = healthy) */
  private readonly failureCounts = new Map<string, number>();
  private readonly globalVisibilitySuppression: boolean;
  private readonly visibilityTtlMs: number;
  private readonly now: () => number;

  constructor(
    store: Store,
    dataDir: string,
    vapidSubject: string,
    options: PushServiceOptions = {},
  ) {
    this.store = store;
    this.vapidKeys = this.loadOrGenerateKeys(dataDir);
    webpush.setVapidDetails(vapidSubject, this.vapidKeys.publicKey, this.vapidKeys.privateKey);
    this.globalVisibilitySuppression = options.globalVisibilitySuppression ?? true;
    this.visibilityTtlMs = options.visibilityTtlMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  // ---------------------------------------------------------------------------
  // VAPID keys
  // ---------------------------------------------------------------------------

  private loadOrGenerateKeys(dataDir: string): VapidKeys {
    const filePath = join(dataDir, VAPID_FILE);
    if (existsSync(filePath)) {
      chmodSync(filePath, 0o600);
      const keys = JSON.parse(readFileSync(filePath, "utf8")) as VapidKeys;
      console.log("[push] loaded VAPID keys");
      return keys;
    }

    const keys = webpush.generateVAPIDKeys();
    writeFileSync(filePath, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
    console.log("[push] generated new VAPID keys");
    return keys;
  }

  getPublicKey(): string {
    return this.vapidKeys.publicKey;
  }

  // ---------------------------------------------------------------------------
  // Notification formatting
  // ---------------------------------------------------------------------------

  formatNotification(
    sessionId: string,
    sessionTitle: string | null,
    eventType: string,
    eventData: Record<string, unknown>,
    tag: string,
  ): PushNotification {
    const title = sessionTitle ?? "WebAgent";
    let body: string;

    switch (eventType) {
      case "permission_request":
        body = `⚿ ${typeof eventData.description === "string" ? eventData.description : "Permission requested"}`;
        break;
      case "prompt_done":
        body = "✓ Task complete";
        break;
      case "bash_done": {
        const cmd = typeof eventData.command === "string" ? eventData.command : "command";
        const code =
          typeof eventData.exitCode === "number" || typeof eventData.exitCode === "string"
            ? String(eventData.exitCode)
            : "?";
        body = `$ ${cmd} — exit ${code}`;
        break;
      }
      default:
        body = eventType;
    }

    return { kind: "notify", title, body, tag, data: { sessionId } };
  }

  // ---------------------------------------------------------------------------
  // Client visibility tracking
  // ---------------------------------------------------------------------------

  /**
   * Atomic consolidated setter. All visibility/session/endpoint updates
   * should route through here. Callers distinguish "preserve" from "clear"
   * by omitting the key vs passing `null`. Returns an edge flag so the
   * caller can fire edge-triggered side effects (e.g. sendClose) without
   * double-firing on every heartbeat refresh.
   */
  updateClient(clientId: string, patch: ClientStatePatch): UpdateClientResult {
    const prev = this.clients.get(clientId) ?? emptyClientState();
    const wasVisibleForSession = prev.visible && prev.sessionId != null ? prev.sessionId : null;

    const next: ClientState = { ...prev };
    if (patch.visible !== undefined) {
      next.visible = patch.visible;
      next.visibleSince = patch.visible ? this.now() : 0;
    }
    if (patch.sessionId !== undefined) next.sessionId = patch.sessionId;
    if (patch.endpoint !== undefined) next.endpoint = patch.endpoint;

    const becameVisibleForSession =
      next.visible && next.sessionId != null && next.sessionId !== wasVisibleForSession
        ? next.sessionId
        : null;
    // Any transition into "visible + session X" restarts the TTL clock,
    // including a session-switch that arrives without an explicit
    // visible:true in the patch (e.g. a session_created POST that only
    // carries sessionId). Otherwise the TTL would keep counting from the
    // previous session's first-visible moment and could prematurely
    // declare the newly-focused session "stale".
    if (becameVisibleForSession) {
      next.visibleSince = this.now();
    }
    this.clients.set(clientId, next);

    return { becameVisibleForSession };
  }

  /**
   * Read-only snapshot for tests and diagnostics. Do NOT mutate the
   * returned object.
   */
  getClientState(clientId: string): ClientState | null {
    return this.clients.get(clientId) ?? null;
  }

  /** @deprecated Shim: prefer `updateClient({ visible })`. */
  setClientVisibility(clientId: string, visible: boolean): void {
    this.updateClient(clientId, { visible });
  }

  /** @deprecated Shim: prefer `updateClient({ sessionId })`. */
  setClientSession(clientId: string, sessionId: string): void {
    this.updateClient(clientId, { sessionId });
  }

  /** @deprecated Shim: prefer `updateClient({ endpoint })`. */
  registerClient(clientId: string, endpoint: string): void {
    this.updateClient(clientId, { endpoint });
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  hasVisibleClient(): boolean {
    const now = this.now();
    for (const s of this.clients.values()) {
      if (s.visible && now - s.visibleSince <= this.visibilityTtlMs) return true;
    }
    return false;
  }

  /** Check if a specific endpoint has at least one visible (non-stale) client. */
  isEndpointVisible(endpoint: string): boolean {
    const now = this.now();
    for (const s of this.clients.values()) {
      if (s.endpoint !== endpoint) continue;
      if (!s.visible) continue;
      if (now - s.visibleSince > this.visibilityTtlMs) continue;
      return true;
    }
    return false;
  }

  /**
   * Check if any client (across all endpoints) is visible and viewing the
   * given session. A client with no session set does not suppress any
   * session's push. Stale records (older than `visibilityTtlMs` since the
   * last heartbeat refresh) are ignored — this is the server-side safety
   * net for iOS PWA suspension, where the client's `visible:false` POST may
   * never leave the device.
   *
   * Returns false unconditionally when global suppression is disabled via
   * the `globalVisibilitySuppression` option (kill switch).
   */
  isSessionVisibleToAnyClient(sessionId: string): boolean {
    if (!this.globalVisibilitySuppression) return false;
    const now = this.now();
    for (const s of this.clients.values()) {
      if (!s.visible) continue;
      if (s.sessionId !== sessionId) continue;
      if (now - s.visibleSince > this.visibilityTtlMs) continue;
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // High-level: decide whether to push, and if so, send
  // ---------------------------------------------------------------------------

  private static readonly NOTIFIABLE = new Set(["permission_request", "prompt_done", "bash_done"]);

  /**
   * Check if this event should trigger a push notification.
   * Returns true if a notification should be sent (caller should then call sendToAll).
   * Global session visibility suppression happens inside sendToAll.
   */
  maybeNotify(
    sessionId: string,
    sessionTitle: string | null,
    eventType: string,
    _eventData: Record<string, unknown>,
  ): boolean {
    if (!PushService.NOTIFIABLE.has(eventType)) return false;

    return true;
  }

  // ---------------------------------------------------------------------------
  // Send push to all subscriptions
  // ---------------------------------------------------------------------------

  async sendToAll(notification: PushNotification): Promise<void> {
    const allSubs = this.store.getAllSubscriptions();
    if (allSubs.length === 0) return;

    // Global visibility: if any client is viewing this session, suppress notify pushes.
    // Close pushes are never suppressed — they're silent and are the mechanism
    // by which cross-device recall actually closes banners on the "losing" devices.
    if (notification.kind === "notify") {
      const targetSession = notification.data.sessionId;
      if (targetSession && this.isSessionVisibleToAnyClient(targetSession)) return;
    }

    // Skip Apple endpoints for silent close pushes to preserve iOS PWA's
    // silent-push budget. See isAppleEndpoint() for rationale.
    let subs = allSubs;
    let filteredApple = 0;
    if (notification.kind === "close") {
      subs = allSubs.filter((s) => {
        if (isAppleEndpoint(s.endpoint)) {
          filteredApple++;
          return false;
        }
        return true;
      });
      if (subs.length === 0) {
        console.log(
          `[egress] sendClose tag=${notification.tag} endpoints=0 ok=0 fail=0 fail_410=0 filtered_apple=${filteredApple}`,
        );
        return;
      }
    }

    const payload = JSON.stringify(notification);
    // Derive an RFC 8030 Topic so push services can collapse undelivered
    // pushes on the wire. FCM (Chrome/Firefox desktop + Android) honors
    // this and collapses correctly. APNs (iOS Safari PWA) does NOT — we
    // verified in dogfood that two same-Topic pushes still surface as
    // two stacked banners on iOS 17, even combined with the SW-side
    // close-before-show workaround (see public/sw.js). Keep the header
    // anyway: it's spec-compliant, cheap, and benefits every non-Apple
    // client. iOS banner stacking is a platform limitation we accept.
    const topic = tagToTopic(notification.tag);

    const results = await Promise.allSettled(
      subs.map((sub) =>
        this.sendOne(
          { endpoint: sub.endpoint, keys: { auth: sub.auth, p256dh: sub.p256dh } },
          payload,
          { topic },
        ),
      ),
    );

    let ok = 0;
    let fail = 0;
    let fail410 = 0;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const endpoint = subs[i].endpoint;
      if (result.status === "fulfilled") {
        this.failureCounts.delete(endpoint);
        ok++;
      } else {
        fail++;
        const err = result.reason as { statusCode?: number };
        if (err.statusCode === 410) {
          fail410++;
          this.store.removeSubscription(endpoint);
          this.failureCounts.delete(endpoint);
          console.log(`[push] removed expired subscription (410): ${endpoint.slice(0, 60)}…`);
        } else {
          const count = (this.failureCounts.get(endpoint) ?? 0) + 1;
          if (count >= MAX_CONSECUTIVE_FAILURES) {
            this.store.removeSubscription(endpoint);
            this.failureCounts.delete(endpoint);
            console.log(
              `[push] removed subscription after ${count} consecutive failures: ${endpoint.slice(0, 60)}…`,
            );
          } else {
            this.failureCounts.set(endpoint, count);
            console.error(
              `[push] send failed (${count}/${MAX_CONSECUTIVE_FAILURES}) for ${endpoint.slice(0, 60)}…:`,
              result.reason,
            );
          }
        }
      }
    }

    if (notification.kind === "close") {
      // Observability signal #6 — aggregated per-call close outcome.
      console.log(
        `[egress] sendClose tag=${notification.tag} endpoints=${subs.length} ok=${ok} fail=${fail} fail_410=${fail410} filtered_apple=${filteredApple}`,
      );
    }
  }

  /** Send a silent close push for the given tag. Never visibility-suppressed. */
  async sendClose(tag: string): Promise<void> {
    await this.sendToAll({ kind: "close", tag });
  }

  /**
   * Send a push for an external message. Respects the message's `deliver`
   * intent: `silent` sends nothing, `inapp` and `push` both send through
   * web-push (the `inapp` vs `push` distinction is enforced by the SW /
   * frontend rendering, not by the server).
   *
   * Tag = `msg-<id>` for unbound messages; bound messages get the
   * `sess-<sid>-msg-<eid>` tag by taking a different code path in the
   * consume handler.
   */
  async sendForMessage(msg: PushableMessage): Promise<boolean> {
    const deliver = msg.deliver ?? "push";
    if (deliver === "silent") return false;

    const subs = this.store.getAllSubscriptions();
    const title = msg.from_label ?? msg.from_ref ?? "Message";
    const body = msg.body.length > 140 ? msg.body.slice(0, 137) + "…" : msg.body;
    const tag = msg.dedup_key ? `dedup-${msg.to}-${msg.dedup_key}` : msg.id;
    // If this message targets a specific session, surface the sid in the
    // push data so SW notificationclick can route the user there. Without
    // this, clicks fall back to "/" and land on whatever session was last
    // open — a confusing UX when multiple sessions get background pushes.
    const sessionId = msg.to.startsWith("session:") ? msg.to.slice("session:".length) : undefined;

    // Observability signal #7 — sendForMessage entry.
    console.log(
      `[egress] sendForMessage msg_id=${msg.id} tag=${tag} deliver=${deliver} endpoints=${subs.length} suppressed_by_visibility=false`,
    );

    await this.sendToAll({
      kind: "notify",
      title,
      body,
      tag,
      data: sessionId ? { messageId: msg.id, sessionId } : { messageId: msg.id },
    });
    return true;
  }

  /**
   * Send a push for an ACP session event (permission_request / prompt_done /
   * bash_done). Handles tag derivation, visibility suppression, and session-
   * title lookup. Returns `true` if a push attempt was made.
   */
  async sendForEvent(sessionId: string, event: PushableEvent): Promise<boolean> {
    if (!PushService.NOTIFIABLE.has(event.type)) return false;

    const session = this.store.getSession(sessionId);
    const sessionTitle = session?.title ?? null;
    const tag = pushTagForEvent(sessionId, event);

    const eventData: Record<string, unknown> = {};
    if (event.type === "permission_request" && event.title !== undefined) {
      eventData.description = event.title;
    }
    if (event.type === "bash_done") {
      if (event.command !== undefined) eventData.command = event.command;
      if (event.exitCode !== undefined) eventData.exitCode = event.exitCode;
    }

    const suppressed = this.isSessionVisibleToAnyClient(sessionId);
    const subs = this.store.getAllSubscriptions();
    console.log(
      `[egress] sendForEvent sess_id=${sessionId.slice(0, 8)} type=${event.type} tag=${tag} endpoints=${subs.length} suppressed_by_visibility=${suppressed}`,
    );

    const notification = this.formatNotification(
      sessionId,
      sessionTitle,
      event.type,
      eventData,
      tag,
    );
    await this.sendToAll(notification);
    return true;
  }

  /** Send a single push notification. Extracted for testability. */
  protected sendOne(
    sub: { endpoint: string; keys: { auth: string; p256dh: string } },
    payload: string,
    options?: { topic?: string },
  ): Promise<webpush.SendResult> {
    return webpush.sendNotification(sub, payload, options);
  }
}

/**
 * Derive an RFC 8030 `Topic` header value from a notification tag. The
 * spec limits topic to ≤32 chars of URL-safe Base64, so we hash and
 * truncate. FCM maps this to its on-wire collapse key and works
 * correctly. APNs is documented to map Topic → `apns-collapse-id`,
 * but in practice iOS Safari PWA (≤17 at least) still surfaces
 * stacked banners for same-Topic pushes — confirmed in dogfood.
 * We keep the header for the platforms where it does work and for
 * spec compliance; don't expect it to fix iOS.
 */
function tagToTopic(tag: string): string {
  return createHash("sha256").update(tag).digest("base64url").slice(0, 22);
}
