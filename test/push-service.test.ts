import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { ClientRegistry } from "../src/client-registry.ts";

// ---------------------------------------------------------------------------
// Store: push_subscriptions table
// ---------------------------------------------------------------------------

describe("Store — push_subscriptions", () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-push-test-"));
    store = new Store(tmpDir, "test-agent");
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
    store.saveSubscription(
      "https://push.example.com/1",
      "auth-old",
      "p256dh-old",
    );
    store.saveSubscription(
      "https://push.example.com/1",
      "auth-new",
      "p256dh-new",
    );

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
    const store2 = new Store(tmpDir, "test-agent");
    const subs = store2.getAllSubscriptions();
    assert.equal(subs.length, 1);
    assert.equal(subs[0].endpoint, "https://push.example.com/1");
    store2.close();

    // Replace for afterEach cleanup
    store = new Store(tmpDir, "test-agent");
  });
});

// ---------------------------------------------------------------------------
// PushService: VAPID key management + notification logic
// ---------------------------------------------------------------------------

import { PushService } from "../src/push-service.ts";

describe("PushService", () => {
  let tmpDir: string;
  let store: Store;
  let registry: ClientRegistry;

  // Helper: post-Plan-C, push-service's visibility was demolished. Tests that
  // exercise hasVisibleClient / isEndpointVisible / isTaskVisibleToAnyClient
  // need to push state into the registry; auto-register on first encounter so
  // setVisibility (which no-ops on unknown clients) takes effect.
  function visBoth(
    _svc: unknown,
    reg: ClientRegistry,
    id: string,
    patch: { visible?: boolean; active?: string | null },
  ): void {
    if (!reg.get(id)) reg.register(id, { capabilities: [] });
    reg.setVisibility(id, patch);
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-push-svc-"));
    store = new Store(tmpDir, "test-agent");
    registry = new ClientRegistry();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("VAPID key management", () => {
    it("generates and saves vapid.json on first init", () => {
      new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });

      const vapidPath = join(tmpDir, "vapid.json");
      assert.ok(existsSync(vapidPath), "vapid.json should be created");

      const keys = JSON.parse(readFileSync(vapidPath, "utf8"));
      assert.ok(keys.publicKey, "should have publicKey");
      assert.ok(keys.privateKey, "should have privateKey");
      assert.ok(keys.publicKey.length > 20, "publicKey should be non-trivial");
    });

    it("loads existing keys on subsequent init", () => {
      const svc1 = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      const key1 = svc1.getPublicKey();

      const svc2 = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      const key2 = svc2.getPublicKey();

      assert.equal(key1, key2, "public key should persist across restarts");
    });

    it("enforces 0600 permissions when loading existing keys", () => {
      // Create keys
      new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      const filePath = join(tmpDir, "vapid.json");
      // Loosen permissions
      chmodSync(filePath, 0o644);
      assert.equal(statSync(filePath).mode & 0o777, 0o644);
      // Re-load — should fix permissions
      new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      assert.equal(statSync(filePath).mode & 0o777, 0o600);
    });

    it("getPublicKey returns the VAPID public key", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      const key = svc.getPublicKey();

      assert.ok(typeof key === "string");
      assert.ok(key.length > 20);
    });
  });

  describe("formatNotification", () => {
    it("formats permission_request notification", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      const n = svc.formatNotification(
        "task-1",
        "My Task",
        "permission_request",
        {
          description: "Execute rm -rf node_modules",
        },
        "test-tag",
      );
      if (n.kind !== "notify") throw new Error("unreachable");
      assert.equal(n.title, "My Task");
      assert.ok(n.body.includes("⚿"));
      assert.ok(n.body.includes("Execute rm -rf node_modules"));
      assert.equal(n.data.taskId, "task-1");
    });

    it("formats prompt_done notification", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      const n = svc.formatNotification(
        "s1",
        "Title",
        "prompt_done",
        {},
        "test-tag",
      );
      if (n.kind !== "notify") throw new Error("unreachable");
      assert.ok(n.body.includes("✓"));
    });

    it("formats bash_done notification", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      const n = svc.formatNotification(
        "s1",
        "Title",
        "bash_done",
        {
          command: "npm run build",
          exitCode: 0,
        },
        "test-tag",
      );
      if (n.kind !== "notify") throw new Error("unreachable");
      assert.ok(n.body.includes("$"));
      assert.ok(n.body.includes("npm run build"));
    });

    it("uses fallback title when task title is null", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      const n = svc.formatNotification(
        "s1",
        null,
        "prompt_done",
        {},
        "test-tag",
      );
      if (n.kind !== "notify") throw new Error("unreachable");
      assert.equal(n.title, "WebAgent");
    });
  });

  describe("visibility tracking", () => {
    it("starts with no visible clients", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      assert.equal(svc.hasVisibleClient(), false);
    });

    it("tracks client visibility", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      const clientId = "ws-1";

      visBoth(svc, registry, clientId, { visible: true });
      assert.equal(svc.hasVisibleClient(), true);

      visBoth(svc, registry, clientId, { visible: false });
      assert.equal(svc.hasVisibleClient(), false);
    });

    it("returns true if any client is visible", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      visBoth(svc, registry, "ws-1", { visible: false });
      visBoth(svc, registry, "ws-2", { visible: true });

      assert.equal(svc.hasVisibleClient(), true);
    });

    it("removes client on disconnect", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      visBoth(svc, registry, "ws-1", { visible: true });
      svc.removeClient("ws-1");

      assert.equal(svc.hasVisibleClient(), false);
    });

    it("removeClient also clears endpoint mapping", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      svc.registerClient("ws-1", "https://push.example.com/1");
      visBoth(svc, registry, "ws-1", { visible: true });
      assert.equal(svc.isEndpointVisible("https://push.example.com/1"), true);

      svc.removeClient("ws-1");
      assert.equal(svc.isEndpointVisible("https://push.example.com/1"), false);
    });
  });

  describe("per-subscription visibility", () => {
    it("endpoint is not visible when no client is registered", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      assert.equal(svc.isEndpointVisible("https://push.example.com/1"), false);
    });

    it("endpoint is visible when a registered client is visible", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      svc.registerClient("ws-1", "https://push.example.com/1");
      visBoth(svc, registry, "ws-1", { visible: true });
      assert.equal(svc.isEndpointVisible("https://push.example.com/1"), true);
    });

    it("endpoint is not visible when registered client is hidden", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      svc.registerClient("ws-1", "https://push.example.com/1");
      visBoth(svc, registry, "ws-1", { visible: false });
      assert.equal(svc.isEndpointVisible("https://push.example.com/1"), false);
    });

    it("multiple clients on different endpoints have independent visibility", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      svc.registerClient("ws-1", "https://push.example.com/desktop");
      svc.registerClient("ws-2", "https://push.example.com/phone");
      visBoth(svc, registry, "ws-1", { visible: true });
      visBoth(svc, registry, "ws-2", { visible: false });

      assert.equal(
        svc.isEndpointVisible("https://push.example.com/desktop"),
        true,
      );
      assert.equal(
        svc.isEndpointVisible("https://push.example.com/phone"),
        false,
      );
    });
  });

  describe("global task visibility (isTaskVisibleToAnyClient)", () => {
    it("returns true when a visible client is viewing the task", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      svc.registerClient("cl-1", "https://push.example.com/1");
      visBoth(svc, registry, "cl-1", { visible: true });
      visBoth(svc, registry, "cl-1", { active: "task-A" });

      assert.equal(svc.isTaskVisibleToAnyClient("task-A"), true);
      assert.equal(svc.isTaskVisibleToAnyClient("task-B"), false);
    });

    it("client with no task does not suppress any task", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      svc.registerClient("cl-1", "https://push.example.com/1");
      visBoth(svc, registry, "cl-1", { visible: true });
      // No setClientTask call

      assert.equal(svc.isTaskVisibleToAnyClient("task-A"), false);
    });

    it("hidden client does not suppress even for its own task", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      svc.registerClient("cl-1", "https://push.example.com/1");
      visBoth(svc, registry, "cl-1", { visible: false });
      visBoth(svc, registry, "cl-1", { active: "task-A" });

      assert.equal(svc.isTaskVisibleToAnyClient("task-A"), false);
    });

    it("two clients on different endpoints — one viewing suppresses globally", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      svc.registerClient("cl-1", "https://push.example.com/desktop");
      svc.registerClient("cl-2", "https://push.example.com/phone");
      visBoth(svc, registry, "cl-1", { visible: true });
      visBoth(svc, registry, "cl-2", { visible: false });
      visBoth(svc, registry, "cl-1", { active: "task-A" });

      // Desktop viewing task-A → globally visible
      assert.equal(svc.isTaskVisibleToAnyClient("task-A"), true);
      assert.equal(svc.isTaskVisibleToAnyClient("task-B"), false);
    });

    it("two clients viewing different tasks — each suppresses its own", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      svc.registerClient("cl-1", "https://push.example.com/shared");
      svc.registerClient("cl-2", "https://push.example.com/shared");
      visBoth(svc, registry, "cl-1", { visible: true });
      visBoth(svc, registry, "cl-2", { visible: true });
      visBoth(svc, registry, "cl-1", { active: "task-A" });
      visBoth(svc, registry, "cl-2", { active: "task-B" });

      assert.equal(svc.isTaskVisibleToAnyClient("task-A"), true);
      assert.equal(svc.isTaskVisibleToAnyClient("task-B"), true);
      assert.equal(svc.isTaskVisibleToAnyClient("task-C"), false);
    });

    it("removeClient clears task mapping", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      svc.registerClient("cl-1", "https://push.example.com/1");
      visBoth(svc, registry, "cl-1", { visible: true });
      visBoth(svc, registry, "cl-1", { active: "task-A" });
      assert.equal(svc.isTaskVisibleToAnyClient("task-A"), true);

      svc.removeClient("cl-1");
      assert.equal(svc.isTaskVisibleToAnyClient("task-A"), false);
    });

    it("task switch updates which task is suppressed", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      svc.registerClient("cl-1", "https://push.example.com/1");
      visBoth(svc, registry, "cl-1", { visible: true });
      visBoth(svc, registry, "cl-1", { active: "task-A" });

      assert.equal(svc.isTaskVisibleToAnyClient("task-A"), true);
      assert.equal(svc.isTaskVisibleToAnyClient("task-B"), false);

      // User switches to task B
      visBoth(svc, registry, "cl-1", { active: "task-B" });
      assert.equal(svc.isTaskVisibleToAnyClient("task-A"), false);
      assert.equal(svc.isTaskVisibleToAnyClient("task-B"), true);
    });
  });

  describe("maybeNotify", () => {
    it("returns true for notifiable event types", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });

      assert.equal(svc.maybeNotify("s1", "Title", "prompt_done", {}), true);
      assert.equal(
        svc.maybeNotify("s1", "Title", "permission_request", {}),
        true,
      );
      assert.equal(svc.maybeNotify("s1", "Title", "bash_done", {}), true);
    });

    it("returns false for non-notifiable event types", () => {
      const svc = new PushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });

      const result = svc.maybeNotify("s1", "Title", "message_chunk", {});
      assert.equal(result, false);
    });
  });

  describe("sendToAll — consecutive failure cleanup", () => {
    type Outcome = "ok" | "fail" | "gone";

    class TestPushService extends PushService {
      outcomes = new Map<string, Outcome>();
      override sendOne(
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
          const err = new Error("Unexpected response") as Error & {
            statusCode: number;
          };
          err.statusCode = 403;
          return Promise.reject(err);
        }
        return Promise.resolve({ statusCode: 201, body: "", headers: {} });
      }
    }

    it("removes subscription after 5 consecutive failures", async () => {
      const svc = new TestPushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      store.saveSubscription("https://push.example.com/bad", "a", "b");
      store.saveSubscription("https://push.example.com/good", "c", "d");

      svc.outcomes.set("https://push.example.com/bad", "fail");
      svc.outcomes.set("https://push.example.com/good", "ok");

      const notification = {
        kind: "notify" as const,
        title: "T",
        body: "B",
        tag: "test",
        data: { taskId: "s1" },
      };

      // Failures 1-4: subscription should still exist
      for (let i = 0; i < 4; i++) {
        await svc.sendToAll(notification);
      }
      assert.equal(
        store.getAllSubscriptions().length,
        2,
        "should keep sub before threshold",
      );

      // Failure 5: subscription should be removed
      await svc.sendToAll(notification);
      const remaining = store.getAllSubscriptions();
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].endpoint, "https://push.example.com/good");
    });

    it("resets failure count on successful send", async () => {
      const svc = new TestPushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      store.saveSubscription("https://push.example.com/flaky", "a", "b");

      svc.outcomes.set("https://push.example.com/flaky", "fail");
      const notification = {
        kind: "notify" as const,
        title: "T",
        body: "B",
        tag: "test",
        data: { taskId: "s1" },
      };

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

      assert.equal(
        store.getAllSubscriptions().length,
        1,
        "should still exist after reset + 4 failures",
      );
    });

    it("still removes 410 Gone immediately", async () => {
      const svc = new TestPushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      store.saveSubscription("https://push.example.com/gone", "a", "b");

      svc.outcomes.set("https://push.example.com/gone", "gone");

      const notification = {
        kind: "notify" as const,
        title: "T",
        body: "B",
        tag: "test",
        data: { taskId: "s1" },
      };
      await svc.sendToAll(notification);

      assert.equal(
        store.getAllSubscriptions().length,
        0,
        "410 should remove immediately",
      );
    });

    it("suppresses all endpoints when any client views the task", async () => {
      const svc = new TestPushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      store.saveSubscription("https://push.example.com/desktop", "a", "b");
      store.saveSubscription("https://push.example.com/phone", "c", "d");

      // Desktop client is visible, viewing task-A
      svc.registerClient("cl-1", "https://push.example.com/desktop");
      visBoth(svc, registry, "cl-1", { visible: true });
      visBoth(svc, registry, "cl-1", { active: "task-A" });

      svc.outcomes.set("https://push.example.com/desktop", "ok");
      svc.outcomes.set("https://push.example.com/phone", "ok");

      const sent: string[] = [];
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const realSendOne = TestPushService.prototype.sendOne;
      (svc as any).sendOne = function (sub: any, payload: string) {
        sent.push(sub.endpoint);
        return realSendOne.call(svc, sub, payload);
      };

      // Notification for task-A — ALL endpoints suppressed (user is viewing it on desktop)
      await svc.sendToAll({
        kind: "notify" as const,
        title: "T",
        body: "B",
        tag: "test",
        data: { taskId: "task-A" },
      });
      assert.deepEqual(
        sent,
        [],
        "should suppress all endpoints for task-A (global visibility)",
      );

      // Notification for task-B — both endpoints should fire (no one is viewing it)
      sent.length = 0;
      await svc.sendToAll({
        kind: "notify" as const,
        title: "T",
        body: "B",
        tag: "test",
        data: { taskId: "task-B" },
      });
      assert.deepEqual(
        sent.sort(),
        ["https://push.example.com/desktop", "https://push.example.com/phone"],
        "should send to both for task-B",
      );
    });

    it("visible client without task does not suppress push (no task = no suppression)", async () => {
      const svc = new TestPushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      store.saveSubscription("https://push.example.com/desktop", "a", "b");
      store.saveSubscription("https://push.example.com/phone", "c", "d");

      // Desktop client is visible but has no task set
      svc.registerClient("cl-1", "https://push.example.com/desktop");
      visBoth(svc, registry, "cl-1", { visible: true });

      svc.outcomes.set("https://push.example.com/desktop", "ok");
      svc.outcomes.set("https://push.example.com/phone", "ok");

      const sent: string[] = [];
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const realSendOne = TestPushService.prototype.sendOne;
      (svc as any).sendOne = function (sub: any, payload: string) {
        sent.push(sub.endpoint);
        return realSendOne.call(svc, sub, payload);
      };

      const notification = {
        kind: "notify" as const,
        title: "T",
        body: "B",
        tag: "test",
        data: { taskId: "s1" },
      };
      await svc.sendToAll(notification);

      assert.deepEqual(
        sent.sort(),
        ["https://push.example.com/desktop", "https://push.example.com/phone"],
        "should send to both — visible client has no task set",
      );
    });

    it("sends to all endpoints when no client is registered", async () => {
      const svc = new TestPushService(store, tmpDir, "mailto:test@localhost", {
        clientRegistry: registry,
      });
      store.saveSubscription("https://push.example.com/a", "a", "b");
      store.saveSubscription("https://push.example.com/b", "c", "d");

      const sent: string[] = [];
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const realSendOne = TestPushService.prototype.sendOne;
      (svc as any).sendOne = function (sub: any, payload: string) {
        sent.push(sub.endpoint);
        return realSendOne.call(svc, sub, payload);
      };

      const notification = {
        kind: "notify" as const,
        title: "T",
        body: "B",
        tag: "test",
        data: { taskId: "s1" },
      };
      await svc.sendToAll(notification);

      assert.equal(
        sent.length,
        2,
        "should send to both when no clients registered",
      );
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

    assert.equal(config.push.vapid_subject, "mailto:noreply@example.com");
  });

  it("reads push section from TOML", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "webagent-config-push-"));
    tmpDirs.push(tmpDir);
    const configPath = join(tmpDir, "config.toml");
    writeFileSync(
      configPath,
      `
[push]
vapid_subject = "mailto:me@example.com"
`,
    );
    process.argv = ["node", "test", "--config", configPath];
    const config = loadConfig();

    assert.equal(config.push.vapid_subject, "mailto:me@example.com");
  });
});
