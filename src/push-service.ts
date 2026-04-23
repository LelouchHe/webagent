import webpush from "web-push";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";

const VAPID_FILE = "vapid.json";
/** Remove a subscription after this many consecutive send failures. */
const MAX_CONSECUTIVE_FAILURES = 5;

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushNotification {
  title: string;
  body: string;
  data: { sessionId: string };
}

export class PushService {
  private store: Store;
  private vapidKeys: VapidKeys;
  private clientVisibility = new Map<string, boolean>(); // clientId → visible
  private clientEndpoints = new Map<string, string>(); // clientId → push endpoint
  private clientSessions = new Map<string, string>(); // clientId → currently viewed sessionId
  /** endpoint → consecutive failure count (absent or 0 = healthy) */
  private failureCounts = new Map<string, number>();

  constructor(store: Store, dataDir: string, vapidSubject: string) {
    this.store = store;
    this.vapidKeys = this.loadOrGenerateKeys(dataDir);
    webpush.setVapidDetails(vapidSubject, this.vapidKeys.publicKey, this.vapidKeys.privateKey);
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
  ): PushNotification {
    const title = sessionTitle || "WebAgent";
    let body: string;

    switch (eventType) {
      case "permission_request":
        body = `⚿ ${eventData.description ?? "Permission requested"}`;
        break;
      case "prompt_done":
        body = "✓ Task complete";
        break;
      case "bash_done": {
        const cmd = eventData.command ?? "command";
        const code = eventData.exitCode ?? "?";
        body = `$ ${cmd} — exit ${code}`;
        break;
      }
      default:
        body = eventType;
    }

    return { title, body, data: { sessionId } };
  }

  // ---------------------------------------------------------------------------
  // Client visibility tracking
  // ---------------------------------------------------------------------------

  setClientVisibility(clientId: string, visible: boolean): void {
    this.clientVisibility.set(clientId, visible);
  }

  setClientSession(clientId: string, sessionId: string): void {
    this.clientSessions.set(clientId, sessionId);
  }

  registerClient(clientId: string, endpoint: string): void {
    this.clientEndpoints.set(clientId, endpoint);
  }

  removeClient(clientId: string): void {
    this.clientVisibility.delete(clientId);
    this.clientEndpoints.delete(clientId);
    this.clientSessions.delete(clientId);
  }

  hasVisibleClient(): boolean {
    for (const visible of this.clientVisibility.values()) {
      if (visible) return true;
    }
    return false;
  }

  /** Check if a specific endpoint has at least one visible client. */
  isEndpointVisible(endpoint: string): boolean {
    for (const [clientId, ep] of this.clientEndpoints) {
      if (ep === endpoint && this.clientVisibility.get(clientId)) return true;
    }
    return false;
  }

  /**
   * Check if any client (across all endpoints) is visible and viewing the given session.
   * A client with no session set does not suppress any session's push.
   * Used for global suppression: if any client sees this session, all endpoints are skipped.
   */
  isSessionVisibleToAnyClient(sessionId: string): boolean {
    for (const [clientId, visible] of this.clientVisibility) {
      if (visible && this.clientSessions.get(clientId) === sessionId) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // High-level: decide whether to push, and if so, send
  // ---------------------------------------------------------------------------

  private static NOTIFIABLE = new Set(["permission_request", "prompt_done", "bash_done"]);

  /**
   * Check if this event should trigger a push notification.
   * Returns true if a notification should be sent (caller should then call sendToAll).
   * Global session visibility suppression happens inside sendToAll.
   */
  maybeNotify(
    sessionId: string,
    sessionTitle: string | null,
    eventType: string,
    eventData: Record<string, unknown>,
  ): boolean {
    if (!PushService.NOTIFIABLE.has(eventType)) return false;

    return true;
  }

  // ---------------------------------------------------------------------------
  // Send push to all subscriptions
  // ---------------------------------------------------------------------------

  async sendToAll(notification: PushNotification): Promise<void> {
    const subs = this.store.getAllSubscriptions();
    if (subs.length === 0) return;

    const payload = JSON.stringify(notification);

    // Global visibility: if any client is viewing this session, suppress all push
    if (this.isSessionVisibleToAnyClient(notification.data.sessionId)) return;

    const results = await Promise.allSettled(
      subs.map((sub) =>
        this.sendOne(
          { endpoint: sub.endpoint, keys: { auth: sub.auth, p256dh: sub.p256dh } },
          payload,
        ),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const endpoint = subs[i].endpoint;
      if (result.status === "fulfilled") {
        this.failureCounts.delete(endpoint);
      } else {
        const err = result.reason as { statusCode?: number };
        if (err.statusCode === 410) {
          // Subscription expired — clean up immediately
          this.store.removeSubscription(endpoint);
          this.failureCounts.delete(endpoint);
          console.log(`[push] removed expired subscription (410): ${endpoint.slice(0, 60)}…`);
        } else {
          const count = (this.failureCounts.get(endpoint) ?? 0) + 1;
          if (count >= MAX_CONSECUTIVE_FAILURES) {
            this.store.removeSubscription(endpoint);
            this.failureCounts.delete(endpoint);
            console.log(`[push] removed subscription after ${count} consecutive failures: ${endpoint.slice(0, 60)}…`);
          } else {
            this.failureCounts.set(endpoint, count);
            console.error(`[push] send failed (${count}/${MAX_CONSECUTIVE_FAILURES}) for ${endpoint.slice(0, 60)}…:`, result.reason);
          }
        }
      }
    }
  }

  /**
   * Send a "close banner" silent push for a tag. Stubbed until C11-C13 wires
   * the cross-device banner recall path. Intentionally a no-op so C8 route
   * handlers can call it unconditionally.
   */
  async sendClose(_tag: string): Promise<void> {
    return;
  }

  /**
   * Send a push notification for an inbox message. Stubbed until C11-C13.
   * Returns true if at least one endpoint would have been reached (placeholder
   * so call-sites compile; actual implementation ships with push work).
   */
  async sendForMessage(_msg: {
    id: string;
    to: string;
    body: string;
    from_label?: string | null;
    from_ref: string;
    deliver: "silent" | "inapp" | "push";
    dedup_key?: string | null;
  }): Promise<boolean> {
    return false;
  }

  /** Send a single push notification. Extracted for testability. */
  protected sendOne(
    sub: { endpoint: string; keys: { auth: string; p256dh: string } },
    payload: string,
  ): Promise<webpush.SendResult> {
    return webpush.sendNotification(sub, payload);
  }
}
