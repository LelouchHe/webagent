import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState, createMockWS } from "./frontend-setup.ts";

describe("slash menu — Tab vs Click behavior", () => {
  let state: any;
  let dom: any;
  let commands: any;

  before(async () => {
    setupDOM();
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
    state.ws = createMockWS();
    state.sessionId = "s1";
  });

  function makeTabEvent(): any {
    return { key: "Tab", preventDefault() {} };
  }

  function messageLines(): string[] {
    return [...dom.messages.children].map((el: any) => el.textContent);
  }

  // -----------------------------------------------------------------------
  // Tab: always fills input, never executes
  // -----------------------------------------------------------------------

  it("Tab on top-level command fills input without executing", () => {
    dom.input.value = "/";
    commands.updateSlashMenu();
    assert.ok(dom.slashMenu.classList.contains("active"), "menu should be active");

    const handled = commands.handleSlashMenuKey(makeTabEvent());
    assert.equal(handled, true, "Tab should be handled");
    // Input should have a command filled in (e.g. "/cancel" or "/help")
    assert.ok(dom.input.value.startsWith("/"), `input should have command, got: ${dom.input.value}`);
    // No system messages should appear (no execution)
    assert.equal(messageLines().length, 0, "Tab should not execute the command");
  });

  it("Tab on notify submenu fills input with /notify <option> without executing", () => {
    dom.input.value = "/notify ";
    commands.updateSlashMenu();
    assert.ok(dom.slashMenu.classList.contains("active"), "notify submenu should be active");

    const handled = commands.handleSlashMenuKey(makeTabEvent());
    assert.equal(handled, true, "Tab should be handled");
    // Input should be filled with the full command
    assert.ok(
      dom.input.value.startsWith("/notify ") && dom.input.value.length > "/notify ".length,
      `input should have /notify on or /notify off, got: "${dom.input.value}"`,
    );
    // No execution — no system messages
    assert.equal(messageLines().length, 0, "Tab should not execute /notify");
  });

  it("Tab on config submenu fills input with /model <option> without executing", () => {
    state.configOptions = [
      { id: "model", name: "Model", options: [{ value: "opus", name: "opus" }, { value: "sonnet", name: "sonnet" }] },
    ];
    dom.input.value = "/model ";
    commands.updateSlashMenu();
    assert.ok(dom.slashMenu.classList.contains("active"), "model submenu should be active");

    const handled = commands.handleSlashMenuKey(makeTabEvent());
    assert.equal(handled, true, "Tab should be handled");
    assert.ok(
      dom.input.value.startsWith("/model "),
      `input should have /model <name>, got: "${dom.input.value}"`,
    );
    // No WS message sent (no execution)
    const ws = state.ws;
    const configMsgs = ws.sent.filter((s: string) => JSON.parse(s).type === "set_config_option");
    assert.equal(configMsgs.length, 0, "Tab should not send config change");
  });

  it("Tab on config submenu uses option name not value", () => {
    state.configOptions = [
      { id: "mode", name: "Mode", options: [
        { value: "https://some-uri/agent", name: "Agent" },
        { value: "https://some-uri/plan", name: "Plan" },
      ] },
    ];
    dom.input.value = "/mode ";
    commands.updateSlashMenu();

    commands.handleSlashMenuKey(makeTabEvent());
    assert.equal(dom.input.value, "/mode Agent", "should use name, not URI value");
  });

  // -----------------------------------------------------------------------
  // Click: fills input AND executes (tab + enter)
  // -----------------------------------------------------------------------

  it("click on notify submenu item executes the command", async () => {
    dom.input.value = "/notify ";
    commands.updateSlashMenu();
    assert.ok(dom.slashMenu.classList.contains("active"));

    // Simulate click on first item
    const item = dom.slashMenu.querySelector(".slash-item");
    assert.ok(item, "menu should have items");
    const mouseEvent = new (globalThis.window as any).MouseEvent("mousedown", { bubbles: true });
    item.dispatchEvent(mouseEvent);

    // handleSlashCommand is async — wait a tick
    await new Promise(r => setTimeout(r, 10));

    // Should have executed — system message should appear
    const lines = messageLines();
    assert.ok(lines.length > 0, `click should execute command, got no messages`);
  });

  it("click on config submenu item executes the command", () => {
    state.configOptions = [
      { id: "model", name: "Model", options: [{ value: "opus", name: "opus" }, { value: "sonnet", name: "sonnet" }] },
    ];
    dom.input.value = "/model ";
    commands.updateSlashMenu();
    assert.ok(dom.slashMenu.classList.contains("active"));

    // Simulate click on first item
    const item = dom.slashMenu.querySelector(".slash-item");
    assert.ok(item, "menu should have items");
    const mouseEvent = new (globalThis.window as any).MouseEvent("mousedown", { bubbles: true });
    item.dispatchEvent(mouseEvent);

    // Should have sent a config change
    const ws = state.ws;
    const configMsgs = ws.sent.filter((s: string) => JSON.parse(s).type === "set_config_option");
    assert.equal(configMsgs.length, 1, "click should execute config change");
  });
});
