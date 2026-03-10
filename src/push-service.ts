import webpush from "web-push";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";

const VAPID_FILE = "vapid.json";
const MERGE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

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
  private lastPush = new Map<string, number>(); // sessionId → timestamp
  private clientVisibility = new Map<string, boolean>(); // clientId → visible

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
    const title = sessionTitle ? `WebAgent · ${sessionTitle}` : "WebAgent";
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
  // Merge window
  // ---------------------------------------------------------------------------

  shouldNotify(sessionId: string): boolean {
    const last = this.lastPush.get(sessionId);
    if (last == null) return true;
    return Date.now() - last >= MERGE_WINDOW_MS;
  }

  recordNotification(sessionId: string): void {
    this.lastPush.set(sessionId, Date.now());
  }

  // ---------------------------------------------------------------------------
  // Client visibility tracking
  // ---------------------------------------------------------------------------

  setClientVisibility(clientId: string, visible: boolean): void {
    this.clientVisibility.set(clientId, visible);
  }

  removeClient(clientId: string): void {
    this.clientVisibility.delete(clientId);
  }

  hasVisibleClient(): boolean {
    for (const visible of this.clientVisibility.values()) {
      if (visible) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // High-level: decide whether to push, and if so, send
  // ---------------------------------------------------------------------------

  private static NOTIFIABLE = new Set(["permission_request", "prompt_done", "bash_done"]);

  /**
   * Check if this event should trigger a push notification.
   * Returns true if a notification was queued (caller should then call sendToAll).
   */
  maybeNotify(
    sessionId: string,
    sessionTitle: string | null,
    eventType: string,
    eventData: Record<string, unknown>,
  ): boolean {
    if (!PushService.NOTIFIABLE.has(eventType)) return false;
    if (this.hasVisibleClient()) return false;
    if (!this.shouldNotify(sessionId)) return false;

    this.recordNotification(sessionId);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Send push to all subscriptions
  // ---------------------------------------------------------------------------

  async sendToAll(notification: PushNotification): Promise<void> {
    const subs = this.store.getAllSubscriptions();
    if (subs.length === 0) return;

    const payload = JSON.stringify(notification);

    const results = await Promise.allSettled(
      subs.map((sub) =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { auth: sub.auth, p256dh: sub.p256dh } },
          payload,
        ),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") {
        const err = result.reason as { statusCode?: number };
        if (err.statusCode === 410) {
          // Subscription expired — clean up
          this.store.removeSubscription(subs[i].endpoint);
          console.log(`[push] removed expired subscription: ${subs[i].endpoint}`);
        } else {
          console.error(`[push] send failed for ${subs[i].endpoint}:`, result.reason);
        }
      }
    }
  }
}
