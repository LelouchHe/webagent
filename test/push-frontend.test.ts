import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState, createMockWS } from "./frontend-setup.ts";

describe("push — /notify command", () => {
  let state: any;
  let dom: any;
  let commands: any;

  before(async () => {
    setupDOM();
    // Mock Notification API
    (globalThis as any).Notification = { permission: "default", requestPermission: async () => "default" };
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.ts");
    commands = await import("../public/js/commands.ts");
  });

  after(() => teardownDOM());

  beforeEach(() => {
    resetState(state, dom);
    (globalThis as any).Notification = { permission: "default", requestPermission: async () => "default" };
    globalThis.fetch = (() => Promise.resolve({ ok: true, json: () => Promise.resolve({ publicKey: "test-key" }) })) as any;
    // Mock pushManager with subscription tracking
    let activeSub: any = null;
    const mockPushManager = {
      getSubscription: async () => activeSub,
      subscribe: async () => {
        activeSub = {
          endpoint: "https://mock-push/endpoint",
          toJSON: () => ({ endpoint: "https://mock-push/endpoint", keys: { p256dh: "k1", auth: "k2" } }),
          unsubscribe: async () => { activeSub = null; return true; },
        };
        return activeSub;
      },
    };
    Object.defineProperty(globalThis, "navigator", {
      value: { serviceWorker: { ready: Promise.resolve({ pushManager: mockPushManager }) } },
      writable: true,
      configurable: true,
    });
  });

  function messageLines(): string[] {
    return [...dom.messages.children].map((el: any) => el.textContent);
  }

  it("/notify is a recognized command", async () => {
    state.ws = createMockWS();
    state.sessionId = "s1";

    const handled = await commands.handleSlashCommand("/notify");
    assert.equal(handled, true);
  });

  it("/notify shows current permission state", async () => {
    state.ws = createMockWS();
    state.sessionId = "s1";
    (globalThis as any).Notification = { permission: "default" };

    await commands.handleSlashCommand("/notify");
    const lines = messageLines();
    assert.ok(lines.some((l: string) => l.includes("notify") || l.includes("notification")),
      `expected status message, got: ${lines}`);
  });

  it("/notify on triggers permission request when default", async () => {
    state.ws = createMockWS();
    state.sessionId = "s1";
    let permRequested = false;
    (globalThis as any).Notification = {
      permission: "default",
      requestPermission: async () => { permRequested = true; return "granted"; },
    };

    await commands.handleSlashCommand("/notify on");
    assert.equal(permRequested, true, "should have called requestPermission");
  });

  it("/notify on shows denied message when permission denied", async () => {
    state.ws = createMockWS();
    state.sessionId = "s1";
    (globalThis as any).Notification = {
      permission: "default",
      requestPermission: async () => { (globalThis as any).Notification.permission = "denied"; return "denied"; },
    };

    await commands.handleSlashCommand("/notify on");
    const lines = messageLines();
    assert.ok(lines.some((l: string) => l.includes("blocked") || l.includes("denied")),
      `expected denied message, got: ${lines}`);
  });

  it("/notify off shows confirmation", async () => {
    state.ws = createMockWS();
    state.sessionId = "s1";

    await commands.handleSlashCommand("/notify off");
    const lines = messageLines();
    assert.ok(lines.some((l: string) => l.includes("off") || l.includes("disabled")),
      `expected off message, got: ${lines}`);
  });

  it("/notify shows off after /notify off even when permission is granted", async () => {
    state.ws = createMockWS();
    state.sessionId = "s1";
    (globalThis as any).Notification = {
      permission: "granted",
      requestPermission: async () => "granted",
    };

    // Enable first
    await commands.handleSlashCommand("/notify on");
    dom.messages.innerHTML = "";

    // Disable
    await commands.handleSlashCommand("/notify off");
    dom.messages.innerHTML = "";

    // Check status — should be off, not enabled
    await commands.handleSlashCommand("/notify");
    const lines = messageLines();
    assert.ok(lines.some((l: string) => l.includes("off")),
      `expected off status after disable, got: ${lines}`);
  });

  it("/notify on re-subscribes after previous /notify off", async () => {
    state.ws = createMockWS();
    state.sessionId = "s1";
    (globalThis as any).Notification = {
      permission: "granted",
      requestPermission: async () => "granted",
    };

    // Enable, disable, re-enable
    await commands.handleSlashCommand("/notify on");
    await commands.handleSlashCommand("/notify off");
    dom.messages.innerHTML = "";
    await commands.handleSlashCommand("/notify on");

    const lines = messageLines();
    assert.ok(lines.some((l: string) => l.includes("enabled")),
      `expected enabled after re-subscribe, got: ${lines}`);
  });
});

describe("push — visibility reporting", () => {
  let state: any;
  let dom: any;
  let connection: any;
  let fetchCalls: Array<{ url: string; init?: any }>;

  before(async () => {
    setupDOM();
    (globalThis as any).Notification = { permission: "default" };
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.ts");
    connection = await import("../public/js/connection.ts");
  });

  after(() => teardownDOM());

  beforeEach(() => {
    resetState(state, dom);
    fetchCalls = [];
    globalThis.fetch = (async (url: string, init?: any) => {
      fetchCalls.push({ url, init });
      return { ok: true, json: async () => ({}) };
    }) as any;
  });

  it("sends visibility message when document visibility changes", () => {
    state.clientId = "cl-test";

    // Simulate visibilitychange
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    const event = new (globalThis.window as any).Event("visibilitychange");
    document.dispatchEvent(event);

    const visCall = fetchCalls.find(c => c.url.includes("/visibility"));
    assert.ok(visCall, "expected a visibility fetch call");
    assert.equal(visCall!.url, "/api/clients/cl-test/visibility");
    assert.equal(visCall!.init?.method, "POST");
    const body = JSON.parse(visCall!.init?.body);
    assert.equal(body.visible, false);

    // Restore
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });
});
