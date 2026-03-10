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
    const stateMod = await import("../public/js/state.js");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.js");
    commands = await import("../public/js/commands.js");
  });

  after(() => teardownDOM());

  beforeEach(() => {
    resetState(state, dom);
    (globalThis as any).Notification = { permission: "default", requestPermission: async () => "default" };
    globalThis.fetch = (() => Promise.resolve({ ok: true, json: () => Promise.resolve({ publicKey: "test-key" }) })) as any;
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
});

describe("push — visibility reporting", () => {
  let state: any;
  let dom: any;
  let connection: any;

  before(async () => {
    setupDOM();
    (globalThis as any).Notification = { permission: "default" };
    const stateMod = await import("../public/js/state.js");
    state = stateMod.state;
    dom = stateMod.dom;
    await import("../public/js/render.js");
    connection = await import("../public/js/connection.js");
  });

  after(() => teardownDOM());

  beforeEach(() => {
    resetState(state, dom);
  });

  it("sends visibility message when document visibility changes", () => {
    const ws = createMockWS();
    state.ws = ws;

    // Simulate visibilitychange
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    const event = new (globalThis.window as any).Event("visibilitychange");
    document.dispatchEvent(event);

    const visMsgs = ws.sent.filter((s: string) => {
      const m = JSON.parse(s);
      return m.type === "visibility";
    });
    assert.equal(visMsgs.length, 1);
    assert.deepEqual(JSON.parse(visMsgs[0]), { type: "visibility", visible: false });

    // Restore
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });
});
