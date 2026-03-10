import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

      assert.equal(n.title, "WebAgent · My Session");
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

  describe("shouldNotify (merge window)", () => {
    it("allows first notification for a session", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      assert.equal(svc.shouldNotify("s1"), true);
    });

    it("suppresses notification within merge window", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      svc.recordNotification("s1");

      assert.equal(svc.shouldNotify("s1"), false);
    });

    it("allows notification for different sessions independently", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      svc.recordNotification("s1");

      assert.equal(svc.shouldNotify("s2"), true);
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
  });

  describe("maybeNotify", () => {
    it("returns false when a client is visible", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      svc.setClientVisibility("ws-1", true);

      const result = svc.maybeNotify("s1", "Title", "prompt_done", {});
      assert.equal(result, false);
    });

    it("returns true and records when no client is visible", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      // No clients → not visible

      const result = svc.maybeNotify("s1", "Title", "prompt_done", {});
      assert.equal(result, true);
      // Should now be in merge window
      assert.equal(svc.shouldNotify("s1"), false);
    });

    it("returns false when within merge window", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");
      svc.recordNotification("s1");

      const result = svc.maybeNotify("s1", "Title", "prompt_done", {});
      assert.equal(result, false);
    });

    it("returns false for non-notifiable event types", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost");

      const result = svc.maybeNotify("s1", "Title", "message_chunk", {});
      assert.equal(result, false);
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
