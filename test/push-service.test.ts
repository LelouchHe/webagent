import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";

// ---------------------------------------------------------------------------
// Store: push_subscriptions table
// ---------------------------------------------------------------------------

describe("Store — push_subscriptions", () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-push-test-"));
    store = new Store(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saveSubscription stores and getAllSubscriptions retrieves", () => {
    store.saveSubscription("https://push.example.com/1", "auth1", "p256dh1");
    store.saveSubscription("https://push.example.com/2", "auth2", "p256dh2");

    const subs = store.getAllSubscriptions();
    assert.equal(subs.length, 2);
    assert.equal(subs[0].endpoint, "https://push.example.com/1");
    assert.equal(subs[0].auth, "auth1");
    assert.equal(subs[0].p256dh, "p256dh1");
    assert.ok(subs[0].created_at);
  });

  it("saveSubscription upserts on duplicate endpoint", () => {
    store.saveSubscription("https://push.example.com/1", "auth-old", "p256dh-old");
    store.saveSubscription("https://push.example.com/1", "auth-new", "p256dh-new");

    const subs = store.getAllSubscriptions();
    assert.equal(subs.length, 1);
    assert.equal(subs[0].auth, "auth-new");
    assert.equal(subs[0].p256dh, "p256dh-new");
  });

  it("removeSubscription deletes by endpoint", () => {
    store.saveSubscription("https://push.example.com/1", "a", "b");
    store.saveSubscription("https://push.example.com/2", "c", "d");

    store.removeSubscription("https://push.example.com/1");

    const subs = store.getAllSubscriptions();
    assert.equal(subs.length, 1);
    assert.equal(subs[0].endpoint, "https://push.example.com/2");
  });

  it("removeSubscription is a no-op for unknown endpoint", () => {
    store.saveSubscription("https://push.example.com/1", "a", "b");
    store.removeSubscription("https://push.example.com/999");

    const subs = store.getAllSubscriptions();
    assert.equal(subs.length, 1);
  });

  it("getAllSubscriptions returns empty array when none exist", () => {
    assert.deepEqual(store.getAllSubscriptions(), []);
  });

  it("push_subscriptions table survives migration re-run", () => {
    store.saveSubscription("https://push.example.com/1", "a", "b");
    store.close();

    // Re-open same DB
    const store2 = new Store(tmpDir);
    const subs = store2.getAllSubscriptions();
    assert.equal(subs.length, 1);
    assert.equal(subs[0].endpoint, "https://push.example.com/1");
    store2.close();

    // Replace for afterEach cleanup
    store = new Store(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// PushService: VAPID key management + notification logic
// ---------------------------------------------------------------------------

import { PushService } from "../src/push-service.ts";

describe("PushService", () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-push-svc-"));
    store = new Store(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("VAPID key management", () => {
    it("generates and saves vapid.json on first init", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");

      const vapidPath = join(tmpDir, "vapid.json");
      assert.ok(existsSync(vapidPath), "vapid.json should be created");

      const keys = JSON.parse(readFileSync(vapidPath, "utf8"));
      assert.ok(keys.publicKey, "should have publicKey");
      assert.ok(keys.privateKey, "should have privateKey");
      assert.ok(keys.publicKey.length > 20, "publicKey should be non-trivial");
    });

    it("loads existing keys on subsequent init", () => {
      const svc1 = new PushService(store, tmpDir, "mailto:test@localhost");
      const key1 = svc1.getPublicKey();

      const svc2 = new PushService(store, tmpDir, "mailto:test@localhost");
      const key2 = svc2.getPublicKey();

      assert.equal(key1, key2, "public key should persist across restarts");
    });

    it("enforces 0600 permissions when loading existing keys", () => {
      // Create keys
      new PushService(store, tmpDir, "mailto:test@localhost");
      const filePath = join(tmpDir, "vapid.json");
      // Loosen permissions
      chmodSync(filePath, 0o644);
      assert.equal(statSync(filePath).mode & 0o777, 0o644);
      // Re-load — should fix permissions
      new PushService(store, tmpDir, "mailto:test@localhost");
      assert.equal(statSync(filePath).mode & 0o777, 0o600);
    });

    it("getPublicKey returns the VAPID public key", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      const key = svc.getPublicKey();

      assert.ok(typeof key === "string");
      assert.ok(key.length > 20);
    });
  });

  describe("formatNotification", () => {
    it("formats permission_request notification", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      const n = svc.formatNotification("session-1", "My Session", "permission_request", {
        description: "Execute rm -rf node_modules",
      });

      assert.equal(n.title, "My Session");
      assert.ok(n.body.includes("⚿"));
      assert.ok(n.body.includes("Execute rm -rf node_modules"));
      assert.equal(n.data.sessionId, "session-1");
    });

    it("formats prompt_done notification", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      const n = svc.formatNotification("s1", "Title", "prompt_done", {});

      assert.ok(n.body.includes("✓"));
    });

    it("formats bash_done notification", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      const n = svc.formatNotification("s1", "Title", "bash_done", {
        command: "npm run build",
        exitCode: 0,
      });

      assert.ok(n.body.includes("$"));
      assert.ok(n.body.includes("npm run build"));
    });

    it("uses fallback title when session title is null", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      const n = svc.formatNotification("s1", null, "prompt_done", {});

      assert.equal(n.title, "WebAgent");
    });
  });

  describe("visibility tracking", () => {
    it("starts with no visible clients", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      assert.equal(svc.hasVisibleClient(), false);
    });

    it("tracks client visibility", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      const clientId = "ws-1";

      svc.setClientVisibility(clientId, true);
      assert.equal(svc.hasVisibleClient(), true);

      svc.setClientVisibility(clientId, false);
      assert.equal(svc.hasVisibleClient(), false);
    });

    it("returns true if any client is visible", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      svc.setClientVisibility("ws-1", false);
      svc.setClientVisibility("ws-2", true);

      assert.equal(svc.hasVisibleClient(), true);
    });

    it("removes client on disconnect", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      svc.setClientVisibility("ws-1", true);
      svc.removeClient("ws-1");

      assert.equal(svc.hasVisibleClient(), false);
    });

    it("removeClient also clears endpoint mapping", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      svc.registerClient("ws-1", "https://push.example.com/1");
      svc.setClientVisibility("ws-1", true);
      assert.equal(svc.isEndpointVisible("https://push.example.com/1"), true);

      svc.removeClient("ws-1");
      assert.equal(svc.isEndpointVisible("https://push.example.com/1"), false);
    });
  });

  describe("per-subscription visibility", () => {
    it("endpoint is not visible when no client is registered", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      assert.equal(svc.isEndpointVisible("https://push.example.com/1"), false);
    });

    it("endpoint is visible when a registered client is visible", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      svc.registerClient("ws-1", "https://push.example.com/1");
      svc.setClientVisibility("ws-1", true);
      assert.equal(svc.isEndpointVisible("https://push.example.com/1"), true);
    });

    it("endpoint is not visible when registered client is hidden", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      svc.registerClient("ws-1", "https://push.example.com/1");
      svc.setClientVisibility("ws-1", false);
      assert.equal(svc.isEndpointVisible("https://push.example.com/1"), false);
    });

    it("multiple clients on different endpoints have independent visibility", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      svc.registerClient("ws-1", "https://push.example.com/desktop");
      svc.registerClient("ws-2", "https://push.example.com/phone");
      svc.setClientVisibility("ws-1", true);
      svc.setClientVisibility("ws-2", false);

      assert.equal(svc.isEndpointVisible("https://push.example.com/desktop"), true);
      assert.equal(svc.isEndpointVisible("https://push.example.com/phone"), false);
    });
  });

  describe("per-session visibility", () => {
    it("setClientSession tracks which session a client is viewing", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      svc.registerClient("cl-1", "https://push.example.com/1");
      svc.setClientVisibility("cl-1", true);
      svc.setClientSession("cl-1", "session-A");

      assert.equal(svc.isEndpointVisibleForSession("https://push.example.com/1", "session-A"), true);
      assert.equal(svc.isEndpointVisibleForSession("https://push.example.com/1", "session-B"), false);
    });

    it("client with no session does not suppress any session", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      svc.registerClient("cl-1", "https://push.example.com/1");
      svc.setClientVisibility("cl-1", true);
      // No setClientSession call

      assert.equal(svc.isEndpointVisibleForSession("https://push.example.com/1", "session-A"), false);
    });

    it("hidden client does not suppress even for its own session", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      svc.registerClient("cl-1", "https://push.example.com/1");
      svc.setClientVisibility("cl-1", false);
      svc.setClientSession("cl-1", "session-A");

      assert.equal(svc.isEndpointVisibleForSession("https://push.example.com/1", "session-A"), false);
    });

    it("two clients on same endpoint viewing different sessions", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      svc.registerClient("cl-1", "https://push.example.com/shared");
      svc.registerClient("cl-2", "https://push.example.com/shared");
      svc.setClientVisibility("cl-1", true);
      svc.setClientVisibility("cl-2", true);
      svc.setClientSession("cl-1", "session-A");
      svc.setClientSession("cl-2", "session-B");

      assert.equal(svc.isEndpointVisibleForSession("https://push.example.com/shared", "session-A"), true);
      assert.equal(svc.isEndpointVisibleForSession("https://push.example.com/shared", "session-B"), true);
      assert.equal(svc.isEndpointVisibleForSession("https://push.example.com/shared", "session-C"), false);
    });

    it("removeClient clears session mapping", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      svc.registerClient("cl-1", "https://push.example.com/1");
      svc.setClientVisibility("cl-1", true);
      svc.setClientSession("cl-1", "session-A");
      assert.equal(svc.isEndpointVisibleForSession("https://push.example.com/1", "session-A"), true);

      svc.removeClient("cl-1");
      assert.equal(svc.isEndpointVisibleForSession("https://push.example.com/1", "session-A"), false);
    });

    it("session switch updates which session is suppressed", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      svc.registerClient("cl-1", "https://push.example.com/1");
      svc.setClientVisibility("cl-1", true);
      svc.setClientSession("cl-1", "session-A");

      assert.equal(svc.isEndpointVisibleForSession("https://push.example.com/1", "session-A"), true);
      assert.equal(svc.isEndpointVisibleForSession("https://push.example.com/1", "session-B"), false);

      // User switches to session B
      svc.setClientSession("cl-1", "session-B");
      assert.equal(svc.isEndpointVisibleForSession("https://push.example.com/1", "session-A"), false);
      assert.equal(svc.isEndpointVisibleForSession("https://push.example.com/1", "session-B"), true);
    });
  });

  describe("maybeNotify", () => {
    it("returns true for notifiable event types", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");

      assert.equal(svc.maybeNotify("s1", "Title", "prompt_done", {}), true);
      assert.equal(svc.maybeNotify("s1", "Title", "permission_request", {}), true);
      assert.equal(svc.maybeNotify("s1", "Title", "bash_done", {}), true);
    });

    it("returns false for non-notifiable event types", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");

      const result = svc.maybeNotify("s1", "Title", "message_chunk", {});
      assert.equal(result, false);
    });
  });

  describe("sendToAll — consecutive failure cleanup", () => {
    type Outcome = "ok" | "fail" | "gone";

    class TestPushService extends PushService {
      outcomes = new Map<string, Outcome>();
      protected override sendOne(
        sub: { endpoint: string; keys: { auth: string; p256dh: string } },
        _payload: string,
      ): Promise<any> {
        const outcome = this.outcomes.get(sub.endpoint) ?? "ok";
        if (outcome === "gone") {
          const err = new Error("Gone") as Error & { statusCode: number };
          err.statusCode = 410;
          return Promise.reject(err);
        }
        if (outcome === "fail") {
          const err = new Error("Unexpected response") as Error & { statusCode: number };
          err.statusCode = 403;
          return Promise.reject(err);
        }
        return Promise.resolve({ statusCode: 201, body: "", headers: {} });
      }
    }

    it("removes subscription after 5 consecutive failures", async () => {
      const svc = new TestPushService(store, tmpDir, "mailto:test@localhost");
      store.saveSubscription("https://push.example.com/bad", "a", "b");
      store.saveSubscription("https://push.example.com/good", "c", "d");

      svc.outcomes.set("https://push.example.com/bad", "fail");
      svc.outcomes.set("https://push.example.com/good", "ok");

      const notification = { title: "T", body: "B", data: { sessionId: "s1" } };

      // Failures 1-4: subscription should still exist
      for (let i = 0; i < 4; i++) {
        await svc.sendToAll(notification);
      }
      assert.equal(store.getAllSubscriptions().length, 2, "should keep sub before threshold");

      // Failure 5: subscription should be removed
      await svc.sendToAll(notification);
      const remaining = store.getAllSubscriptions();
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].endpoint, "https://push.example.com/good");
    });

    it("resets failure count on successful send", async () => {
      const svc = new TestPushService(store, tmpDir, "mailto:test@localhost");
      store.saveSubscription("https://push.example.com/flaky", "a", "b");

      svc.outcomes.set("https://push.example.com/flaky", "fail");
      const notification = { title: "T", body: "B", data: { sessionId: "s1" } };

      // 4 failures
      for (let i = 0; i < 4; i++) {
        await svc.sendToAll(notification);
      }

      // One success resets the counter
      svc.outcomes.set("https://push.example.com/flaky", "ok");
      await svc.sendToAll(notification);

      // 4 more failures — should NOT hit threshold (reset to 0 + 4 = 4 < 5)
      svc.outcomes.set("https://push.example.com/flaky", "fail");
      for (let i = 0; i < 4; i++) {
        await svc.sendToAll(notification);
      }

      assert.equal(store.getAllSubscriptions().length, 1, "should still exist after reset + 4 failures");
    });

    it("still removes 410 Gone immediately", async () => {
      const svc = new TestPushService(store, tmpDir, "mailto:test@localhost");
      store.saveSubscription("https://push.example.com/gone", "a", "b");

      svc.outcomes.set("https://push.example.com/gone", "gone");

      const notification = { title: "T", body: "B", data: { sessionId: "s1" } };
      await svc.sendToAll(notification);

      assert.equal(store.getAllSubscriptions().length, 0, "410 should remove immediately");
    });

    it("skips endpoints with a visible client viewing the same session", async () => {
      const svc = new TestPushService(store, tmpDir, "mailto:test@localhost");
      store.saveSubscription("https://push.example.com/desktop", "a", "b");
      store.saveSubscription("https://push.example.com/phone", "c", "d");

      // Desktop client is visible, viewing session-A
      svc.registerClient("cl-1", "https://push.example.com/desktop");
      svc.setClientVisibility("cl-1", true);
      svc.setClientSession("cl-1", "session-A");

      svc.outcomes.set("https://push.example.com/desktop", "ok");
      svc.outcomes.set("https://push.example.com/phone", "ok");

      const sent: string[] = [];
      const realSendOne = TestPushService.prototype.sendOne;
      (svc as any).sendOne = function(sub: any, payload: string) {
        sent.push(sub.endpoint);
        return realSendOne.call(svc, sub, payload);
      };

      // Notification for session-A — desktop should be skipped (user is viewing it)
      await svc.sendToAll({ title: "T", body: "B", data: { sessionId: "session-A" } });
      assert.deepEqual(sent, ["https://push.example.com/phone"],
        "should only send to phone for session-A");

      // Notification for session-B — desktop should NOT be skipped (user is viewing different session)
      sent.length = 0;
      await svc.sendToAll({ title: "T", body: "B", data: { sessionId: "session-B" } });
      assert.deepEqual(sent.sort(), [
        "https://push.example.com/desktop",
        "https://push.example.com/phone",
      ], "should send to both for session-B");
    });

    it("visible client without session does not suppress push (no session = no suppression)", async () => {
      const svc = new TestPushService(store, tmpDir, "mailto:test@localhost");
      store.saveSubscription("https://push.example.com/desktop", "a", "b");
      store.saveSubscription("https://push.example.com/phone", "c", "d");

      // Desktop client is visible but has no session set
      svc.registerClient("cl-1", "https://push.example.com/desktop");
      svc.setClientVisibility("cl-1", true);

      svc.outcomes.set("https://push.example.com/desktop", "ok");
      svc.outcomes.set("https://push.example.com/phone", "ok");

      const sent: string[] = [];
      const realSendOne = TestPushService.prototype.sendOne;
      (svc as any).sendOne = function(sub: any, payload: string) {
        sent.push(sub.endpoint);
        return realSendOne.call(svc, sub, payload);
      };

      const notification = { title: "T", body: "B", data: { sessionId: "s1" } };
      await svc.sendToAll(notification);

      assert.deepEqual(sent.sort(), [
        "https://push.example.com/desktop",
        "https://push.example.com/phone",
      ], "should send to both — visible client has no session set");
    });

    it("sends to all endpoints when no client is registered", async () => {
      const svc = new TestPushService(store, tmpDir, "mailto:test@localhost");
      store.saveSubscription("https://push.example.com/a", "a", "b");
      store.saveSubscription("https://push.example.com/b", "c", "d");

      const sent: string[] = [];
      const realSendOne = TestPushService.prototype.sendOne;
      (svc as any).sendOne = function(sub: any, payload: string) {
        sent.push(sub.endpoint);
        return realSendOne.call(svc, sub, payload);
      };

      const notification = { title: "T", body: "B", data: { sessionId: "s1" } };
      await svc.sendToAll(notification);

      assert.equal(sent.length, 2, "should send to both when no clients registered");
    });
  });
});

// ---------------------------------------------------------------------------
// Config: push section
// ---------------------------------------------------------------------------

import { loadConfig } from "../src/config.ts";

describe("config — push section", () => {
  const originalArgv = [...process.argv];
  const originalLog = console.log;
  const tmpDirs: string[] = [];

  beforeEach(() => {
    process.argv = [...originalArgv];
    console.log = (() => {}) as typeof console.log;
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    console.log = originalLog;
    while (tmpDirs.length) {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("has push defaults when no config provided", () => {
    process.argv = ["node", "test"];
    const config = loadConfig();

    assert.equal(config.push.vapid_subject, "mailto:webagent@localhost");
  });

  it("reads push section from TOML", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "webagent-config-push-"));
    tmpDirs.push(tmpDir);
    const configPath = join(tmpDir, "config.toml");
    writeFileSync(configPath, `
[push]
vapid_subject = "mailto:me@example.com"
`);
    process.argv = ["node", "test", "--config", configPath];
    const config = loadConfig();

    assert.equal(config.push.vapid_subject, "mailto:me@example.com");
  });
});
