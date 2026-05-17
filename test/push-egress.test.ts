import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { PushService, isAppleEndpoint } from "../src/push-service.ts";
import type { PushNotification } from "../src/push-service.ts";
import { ClientRegistry } from "../src/client-registry.ts";

// Helper: post-Plan-C-Step-4, identity-layer state (visible/active) lives on
// the registry, not pushService. Auto-register on first use so setVisibility
// (which no-ops on unknown clients) takes effect.
function visBoth(
  _svc: unknown,
  reg: ClientRegistry,
  id: string,
  patch: { visible?: boolean; active?: string | null },
): void {
  if (!reg.get(id)) reg.register(id, { capabilities: [] });
  reg.setVisibility(id, patch);
}

class StubbedPushService extends PushService {
  public sent: Array<{ endpoint: string; payload: string; topic?: string }> =
    [];
  public shouldReject: { statusCode?: number } | null = null;
  protected override sendOne(
    sub: { endpoint: string; keys: { auth: string; p256dh: string } },
    payload: string,
    options?: { topic?: string },
  ): Promise<never> {
    this.sent.push({ endpoint: sub.endpoint, payload, topic: options?.topic });
    if (this.shouldReject)
      return Promise.reject(
        new Error(`HTTP ${this.shouldReject.statusCode ?? "?"}`),
      );
    return Promise.resolve(undefined as never);
  }
}

describe("PushService — PushNotification payload shape", () => {
  let tmpDir: string;
  let store: Store;
  let push: StubbedPushService;
  let registry: ClientRegistry;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-push-egress-"));
    store = new Store(tmpDir);
    registry = new ClientRegistry();
    push = new StubbedPushService(store, tmpDir, "mailto:test@example.com", {
      clientRegistry: registry,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("notify payload carries kind='notify' + tag + data", async () => {
    store.saveSubscription("https://push.example.com/1", "auth1", "p256dh1");
    const note: PushNotification = {
      kind: "notify",
      title: "Hello",
      body: "world",
      tag: "msg-abc",
      data: { messageId: "abc" },
    };
    await push.sendToAll(note);
    assert.equal(push.sent.length, 1);
    const payload = JSON.parse(push.sent[0].payload);
    assert.equal(payload.kind, "notify");
    assert.equal(payload.tag, "msg-abc");
    assert.equal(payload.data.messageId, "abc");
  });

  it("close payload has kind='close' + tag only", async () => {
    store.saveSubscription("https://push.example.com/1", "auth1", "p256dh1");
    await push.sendClose("msg-abc");
    assert.equal(push.sent.length, 1);
    const payload = JSON.parse(push.sent[0].payload);
    assert.equal(payload.kind, "close");
    assert.equal(payload.tag, "msg-abc");
    assert.equal(payload.title, undefined);
    assert.equal(payload.body, undefined);
  });

  it("sendClose skips visibility suppression (close always fires)", async () => {
    store.saveSubscription("https://push.example.com/1", "auth1", "p256dh1");
    push.registerClient("c1", "https://push.example.com/1");
    visBoth(push, registry, "c1", { visible: true });
    visBoth(push, registry, "c1", { active: "sess-abc" });
    // A notify tied to this session would be suppressed; close must NOT be.
    await push.sendClose("sess-sess-abc-done");
    assert.equal(push.sent.length, 1);
  });

  it("sendForMessage uses msg.id directly as tag (no double msg- prefix)", async () => {
    // In production, message ids are minted as `msg-${hex}` by routes.ts.
    // The tag must equal msg.id exactly — not `msg-${msg.id}` which would
    // produce `msg-msg-<hex>` and break SW getNotifications({tag}) matching.
    store.saveSubscription("https://push.example.com/1", "auth1", "p256dh1");
    await push.sendForMessage({
      id: "msg-abc123def456",
      to: "*",
      body: "hello",
      deliver: "push",
    });
    assert.equal(push.sent.length, 1);
    const payload = JSON.parse(push.sent[0].payload);
    assert.equal(payload.tag, "msg-abc123def456");
    assert.equal(payload.data.messageId, "msg-abc123def456");
  });

  it("sendForMessage passes an RFC 8030 Topic so APNs collapses on-wire", async () => {
    // iOS displays two stacked banners for same-tag pushes unless the
    // upstream push includes a Topic header (mapped to apns-collapse-id).
    // Topic is derived from the notification tag and must be a ≤32-char
    // URL-safe-Base64 string.
    store.saveSubscription("https://push.example.com/1", "auth1", "p256dh1");
    await push.sendForMessage({
      id: "msg-a",
      to: "session:abc",
      body: "first",
      deliver: "push",
      dedup_key: "disk-full",
    });
    await push.sendForMessage({
      id: "msg-b",
      to: "session:abc",
      body: "second",
      deliver: "push",
      dedup_key: "disk-full",
    });
    assert.equal(push.sent.length, 2);
    const t1 = push.sent[0].topic;
    const t2 = push.sent[1].topic;
    assert.ok(t1, "first send must have a topic");
    assert.ok(t2, "second send must have a topic");
    assert.equal(t1, t2, "same tag must produce identical topic for collapse");
    assert.ok(
      t1.length > 0 && t1.length <= 32,
      `topic must be ≤32 chars (got ${t1.length})`,
    );
    assert.match(t1, /^[A-Za-z0-9_-]+$/, "topic must be URL-safe Base64");
  });

  it("sendForMessage emits a notify with tag equal to msg.id", async () => {
    store.saveSubscription("https://push.example.com/1", "auth1", "p256dh1");
    await push.sendForMessage({
      id: "msg-m1",
      to: "*",
      body: "hello from cron",
      from_label: "cron-job",
      deliver: "push",
    });
    assert.equal(push.sent.length, 1);
    const payload = JSON.parse(push.sent[0].payload);
    assert.equal(payload.kind, "notify");
    assert.equal(payload.tag, "msg-m1");
    assert.equal(payload.data.messageId, "msg-m1");
    assert.ok(payload.body.includes("hello from cron"));
  });

  it("sendForMessage with dedup_key uses dedup-<to>-<key> as tag", async () => {
    // Same dedup_key + same target must collapse the banner on the device.
    // Tag is derived from (to, dedup_key), not msg.id, so two distinct
    // msg rows can share a single push slot.
    store.saveSubscription("https://push.example.com/1", "auth1", "p256dh1");
    await push.sendForMessage({
      id: "msg-first",
      to: "*",
      body: "first",
      deliver: "push",
      dedup_key: "disk-full",
    });
    await push.sendForMessage({
      id: "msg-second",
      to: "*",
      body: "second",
      deliver: "push",
      dedup_key: "disk-full",
    });
    assert.equal(push.sent.length, 2);
    const p1 = JSON.parse(push.sent[0].payload);
    const p2 = JSON.parse(push.sent[1].payload);
    assert.equal(p1.tag, p2.tag, "same dedup_key must produce same tag");
    assert.equal(p1.tag, "dedup-*-disk-full");
    // Messages with different `to` must NOT collapse with each other.
    await push.sendForMessage({
      id: "msg-third",
      to: "session:abc",
      body: "third",
      deliver: "push",
      dedup_key: "disk-full",
    });
    const p3 = JSON.parse(push.sent[2].payload);
    assert.notEqual(p3.tag, p1.tag);
    assert.equal(p3.tag, "dedup-session:abc-disk-full");
  });

  it("sendForMessage to=session:<sid> puts sessionId in data for click routing", async () => {
    // Without sessionId in the push data, notificationclick in sw.js falls
    // back to "/" which lands on the current session, not the target one.
    store.saveSubscription("https://push.example.com/1", "auth1", "p256dh1");
    await push.sendForMessage({
      id: "msg-m1",
      to: "session:abcd1234",
      body: "jump here",
      deliver: "push",
    });
    const payload = JSON.parse(push.sent[0].payload);
    assert.equal(payload.data.sessionId, "abcd1234");
    assert.equal(payload.data.messageId, "msg-m1");
  });

  it("sendForMessage to non-session target omits sessionId", async () => {
    store.saveSubscription("https://push.example.com/1", "auth1", "p256dh1");
    await push.sendForMessage({
      id: "msg-m2",
      to: "*",
      body: "broadcast",
      deliver: "push",
    });
    const payload = JSON.parse(push.sent[0].payload);
    assert.equal(payload.data.sessionId, undefined);
  });

  it("sendForMessage with deliver='silent' does NOT push", async () => {
    store.saveSubscription("https://push.example.com/1", "auth1", "p256dh1");
    await push.sendForMessage({
      id: "m2",
      to: "*",
      body: "quiet",
      deliver: "silent",
    });
    assert.equal(push.sent.length, 0);
  });

  it("sendForEvent uses sess-<sid>-done tag for prompt_done", async () => {
    store.saveSubscription("https://push.example.com/1", "auth1", "p256dh1");
    const sessionId = "abcd1234-aaaa-bbbb-cccc-dddddddddddd";
    store.createSession(sessionId, "/tmp");
    store.updateSessionTitle(sessionId, "My work");
    await push.sendForEvent(sessionId, { type: "prompt_done" });
    assert.equal(push.sent.length, 1);
    const payload = JSON.parse(push.sent[0].payload);
    assert.equal(payload.kind, "notify");
    assert.equal(payload.tag, `sess-${sessionId}-done`);
  });

  it("sendForEvent uses sess-<sid>-perm-<eid> for permission_request", async () => {
    store.saveSubscription("https://push.example.com/1", "auth1", "p256dh1");
    const sessionId = "abcd1234-aaaa-bbbb-cccc-dddddddddddd";
    store.createSession(sessionId, "/tmp");
    await push.sendForEvent(sessionId, {
      type: "permission_request",
      title: "Run ls?",
      eventId: 17,
    });
    assert.equal(push.sent.length, 1);
    const payload = JSON.parse(push.sent[0].payload);
    assert.equal(payload.tag, `sess-${sessionId}-perm-17`);
  });

  it("sendForEvent uses sess-<sid>-bash-<eid> for bash_done", async () => {
    store.saveSubscription("https://push.example.com/1", "auth1", "p256dh1");
    const sessionId = "abcd1234-aaaa-bbbb-cccc-dddddddddddd";
    store.createSession(sessionId, "/tmp");
    await push.sendForEvent(sessionId, {
      type: "bash_done",
      command: "ls",
      exitCode: 0,
      eventId: 42,
    });
    assert.equal(push.sent.length, 1);
    const payload = JSON.parse(push.sent[0].payload);
    assert.equal(payload.tag, `sess-${sessionId}-bash-42`);
  });

  it("sendForEvent suppresses push when the target session is visible", async () => {
    store.saveSubscription("https://push.example.com/1", "auth1", "p256dh1");
    const sessionId = "abcd1234-aaaa-bbbb-cccc-dddddddddddd";
    store.createSession(sessionId, "/tmp");
    push.registerClient("c1", "https://push.example.com/1");
    visBoth(push, registry, "c1", { visible: true });
    visBoth(push, registry, "c1", { active: sessionId });
    await push.sendForEvent(sessionId, { type: "prompt_done" });
    assert.equal(push.sent.length, 0);
  });

  it("sendForEvent returns false for non-notifiable event types", async () => {
    store.saveSubscription("https://push.example.com/1", "auth1", "p256dh1");
    const sessionId = "abcd1234-aaaa-bbbb-cccc-dddddddddddd";
    store.createSession(sessionId, "/tmp");
    const sent = await push.sendForEvent(sessionId, {
      type: "assistant_message",
    });
    assert.equal(sent, false);
    assert.equal(push.sent.length, 0);
  });

  it("[egress] log emitted on sendForMessage entry", async () => {
    store.saveSubscription("https://push.example.com/1", "auth1", "p256dh1");
    const logs: string[] = [];
    const { setLogLevel, setLogSink } = await import("../src/log.ts");
    const prevLevel = (await import("../src/log.ts")).getLogLevel();
    setLogLevel("info");
    setLogSink((_stream, line) => {
      logs.push(line);
    });
    try {
      await push.sendForMessage({
        id: "msg-m1",
        to: "*",
        body: "x",
        deliver: "push",
      });
    } finally {
      setLogSink(null);
      setLogLevel(prevLevel);
    }
    const egressLine = logs.find(
      (l) => l.includes("[egress]") && l.includes("sendForMessage"),
    );
    assert.ok(
      egressLine,
      `expected [egress] sendForMessage log, got: ${logs.join(" | ")}`,
    );
    assert.ok(egressLine.includes('"msg_id":"msg-m1"'));
    assert.ok(egressLine.includes('"tag":"msg-m1"'));
  });
});

describe("isAppleEndpoint", () => {
  it("matches canonical APNs host", () => {
    assert.equal(isAppleEndpoint("https://web.push.apple.com/abc123"), true);
  });

  it("matches regional subdomain", () => {
    assert.equal(isAppleEndpoint("https://eu.web.push.apple.com/xyz"), true);
  });

  it("matches hypothetical api.push.apple.com", () => {
    // Apple has historically rebranded push hosts; defensive matching.
    assert.equal(
      isAppleEndpoint("https://api.push.apple.com/3/device/token"),
      true,
    );
  });

  it("does not match FCM", () => {
    assert.equal(
      isAppleEndpoint("https://fcm.googleapis.com/fcm/send/AAA"),
      false,
    );
  });

  it("does not match Mozilla push", () => {
    assert.equal(
      isAppleEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc"),
      false,
    );
  });

  it("does not match a lookalike domain", () => {
    // Guard against naive substring matches.
    assert.equal(
      isAppleEndpoint("https://push.apple.com.evil.example.com/token"),
      false,
    );
  });

  it("handles malformed URLs gracefully", () => {
    assert.equal(isAppleEndpoint("not a url"), false);
    assert.equal(isAppleEndpoint(""), false);
  });
});

describe("PushService — Apple endpoint skip for kind:'close'", () => {
  let tmpDir: string;
  let store: Store;
  let push: StubbedPushService;
  let registry: ClientRegistry;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-push-apple-filter-"));
    store = new Store(tmpDir);
    registry = new ClientRegistry();
    push = new StubbedPushService(store, tmpDir, "mailto:test@example.com", {
      clientRegistry: registry,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sendClose skips Apple endpoints and dispatches to FCM only", async () => {
    store.saveSubscription("https://web.push.apple.com/ios-token", "a1", "p1");
    store.saveSubscription(
      "https://fcm.googleapis.com/fcm/send/chrome",
      "a2",
      "p2",
    );

    await push.sendClose("sess-abc-done");

    assert.equal(
      push.sent.length,
      1,
      "expected only FCM to be hit, Apple must be filtered",
    );
    assert.equal(
      push.sent[0].endpoint,
      "https://fcm.googleapis.com/fcm/send/chrome",
    );
  });

  it("sendClose with only Apple subs sends nothing at the network layer", async () => {
    store.saveSubscription("https://web.push.apple.com/ios1", "a1", "p1");
    store.saveSubscription("https://eu.web.push.apple.com/ios2", "a2", "p2");

    await push.sendClose("sess-xyz-done");

    assert.equal(
      push.sent.length,
      0,
      "no dispatches expected; all subs are Apple",
    );
  });

  it("sendToAll with kind:'notify' still dispatches to Apple (regression guard)", async () => {
    store.saveSubscription("https://web.push.apple.com/ios-token", "a1", "p1");
    store.saveSubscription(
      "https://fcm.googleapis.com/fcm/send/chrome",
      "a2",
      "p2",
    );

    const note: PushNotification = {
      kind: "notify",
      title: "New message",
      body: "hi",
      tag: "msg-1",
      data: { messageId: "msg-1" },
    };
    await push.sendToAll(note);

    assert.equal(
      push.sent.length,
      2,
      "notify must reach all endpoints including Apple",
    );
    const endpoints = push.sent.map((s) => s.endpoint).sort();
    assert.deepEqual(endpoints, [
      "https://fcm.googleapis.com/fcm/send/chrome",
      "https://web.push.apple.com/ios-token",
    ]);
  });
});
