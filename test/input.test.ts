import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState, createMockWS } from "./frontend-setup.ts";

describe("input", () => {
  let state: any;
  let dom: any;
  let setBusy: any;
  let inputModule: any;
  let fetchCalls: Array<{ url: string; init?: any }>;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.js");
    state = stateMod.state;
    dom = stateMod.dom;
    setBusy = stateMod.setBusy;
    await import("../public/js/render.js");
    await import("../public/js/events.js");
    await import("../public/js/commands.js");
    await import("../public/js/images.js");
    inputModule = await import("../public/js/input.js");
    void inputModule;
  });

  after(() => teardownDOM());

  beforeEach(() => {
    resetState(state, dom);
    fetchCalls = [];
    globalThis.fetch = undefined as any;
  });

  function clickSend() {
    dom.sendBtn.click();
  }

  function keydown(key: string, options: Record<string, unknown> = {}) {
    const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
    dom.input.dispatchEvent(event);
    return event;
  }

  function docKeydown(key: string, options: Record<string, unknown> = {}) {
    const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
    document.dispatchEvent(event);
    return event;
  }

  function setFetch(handler: (url: string, init?: any) => Promise<any> | any) {
    globalThis.fetch = (async (url: string, init?: any) => {
      fetchCalls.push({ url, init });
      return handler(url, init);
    }) as any;
  }

  it("sends prompts for normal messages and enters busy state", () => {
    const ws = createMockWS();
    state.ws = ws;
    state.sessionId = "s1";
    dom.input.value = "hello";

    clickSend();

    assert.deepEqual(JSON.parse(ws.sent[0]), {
      type: "prompt",
      sessionId: "s1",
      text: "hello",
    });
    assert.equal(state.busy, true);
    assert.equal(dom.sendBtn.textContent, "^X");
    assert.equal(dom.input.value, "");
  });

  it("resets turnEnded when sending a new prompt", () => {
    const ws = createMockWS();
    state.ws = ws;
    state.sessionId = "s1";
    state.turnEnded = true;
    dom.input.value = "next question";

    clickSend();

    assert.equal(state.turnEnded, false, "turnEnded should be cleared on send");
    assert.equal(state.busy, true);
  });

  it("routes bang-prefixed input to bash execution", () => {
    const ws = createMockWS();
    state.ws = ws;
    state.sessionId = "s1";
    dom.input.value = "!echo hello";

    clickSend();

    assert.deepEqual(JSON.parse(ws.sent[0]), {
      type: "bash_exec",
      sessionId: "s1",
      command: "echo hello",
    });
    assert.equal(state.busy, true);
    assert.ok(dom.messages.textContent.includes("echo hello"));
  });

  it("allows slash commands while busy", () => {
    const ws = createMockWS();
    state.ws = ws;
    state.sessionId = "s1";
    state.busy = true;
    dom.input.value = "/pwd";

    keydown("Enter");

    assert.ok(dom.messages.textContent.includes("s1") || dom.messages.textContent.includes("unknown"));
    assert.equal(dom.input.value, "");
  });

  it("blocks regular messages while busy", () => {
    const ws = createMockWS();
    state.ws = ws;
    state.sessionId = "s1";
    state.busy = true;
    dom.input.value = "hello";

    keydown("Enter");

    assert.equal(ws.sent.length, 0);
    assert.equal(dom.input.value, "hello");
  });

  it("send button shows ↵ when typing a command while busy", () => {
    state.busy = true;
    setBusy(true);
    dom.input.value = "/switch";
    dom.input.dispatchEvent(new globalThis.window.Event("input"));

    assert.equal(dom.sendBtn.textContent, "↵");
    assert.ok(!dom.sendBtn.classList.contains("cancel"));
  });

  it("send button reverts to ^X when command is cleared while busy", () => {
    state.busy = true;
    setBusy(true);
    dom.input.value = "/switch";
    dom.input.dispatchEvent(new globalThis.window.Event("input"));
    assert.equal(dom.sendBtn.textContent, "↵");

    dom.input.value = "";
    dom.input.dispatchEvent(new globalThis.window.Event("input"));
    assert.equal(dom.sendBtn.textContent, "^X");
    assert.ok(dom.sendBtn.classList.contains("cancel"));
  });

  it("send button executes command instead of cancel while busy", () => {
    const ws = createMockWS();
    state.ws = ws;
    state.sessionId = "s1";
    state.sessionCwd = "/test";
    state.busy = true;
    setBusy(true);
    dom.input.value = "/pwd";

    clickSend();

    assert.ok(dom.messages.textContent.includes("/test"));
    assert.equal(dom.input.value, "");
  });

  it("warns instead of sending when the session is not ready", () => {
    const ws = createMockWS();
    state.ws = ws;
    dom.input.value = "hello";

    clickSend();

    assert.equal(ws.sent.length, 0);
    assert.ok(dom.messages.textContent.includes("warn: Session not ready yet"));
  });

  it("uploads pending images before sending the prompt", async () => {
    const ws = createMockWS();
    state.ws = ws;
    state.sessionId = "s1";
    state.pendingImages.push({
      data: "abc123",
      mimeType: "image/png",
      previewUrl: "data:image/png;base64,abc123",
    });
    setFetch(async (url: string) => {
      assert.equal(url, "/api/images/s1");
      return { json: async () => ({ path: "uploads/image.png" }) };
    });

    clickSend();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fetchCalls.length, 1);
    assert.deepEqual(JSON.parse(ws.sent[0]), {
      type: "prompt",
      sessionId: "s1",
      text: "What is in this image?",
      images: [{
        data: "abc123",
        mimeType: "image/png",
        path: "uploads/image.png",
      }],
    });
  });

  it("sends cancel on global Ctrl+X while busy", () => {
    const ws = createMockWS();
    state.ws = ws;
    state.sessionId = "s1";
    state.busy = true;

    const event = docKeydown("x", { ctrlKey: true });

    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(JSON.parse(ws.sent[0]), {
      type: "cancel",
      sessionId: "s1",
    });
    assert.ok(dom.messages.textContent.includes("^X"));
  });

  it("opens the file picker on Ctrl+U", () => {
    let clicked = 0;
    dom.fileInput.click = () => { clicked += 1; };

    const event = keydown("u", { ctrlKey: true });

    assert.equal(event.defaultPrevented, true);
    assert.equal(clicked, 1);
  });

  it("cycles mode on Ctrl+M", () => {
    const ws = createMockWS();
    state.ws = ws;
    state.sessionId = "s1";
    state.configOptions = [{
      id: "mode",
      name: "Mode",
      currentValue: "agent",
      options: [
        { value: "agent", name: "Agent" },
        { value: "chat#plan", name: "Plan" },
        { value: "chat#autopilot", name: "Autopilot" },
      ],
    }];

    const event = docKeydown("m", { ctrlKey: true });

    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(JSON.parse(ws.sent[0]), {
      type: "set_config_option",
      sessionId: "s1",
      configId: "mode",
      value: "chat#plan",
    });
    assert.ok(dom.messages.textContent.includes("Mode → Plan"));
  });

  it("fills /new into input from the plus button", async () => {
    state.sessionId = "current";
    state.sessionCwd = "/repo";
    dom.input.value = "some existing text";
    // fetch is undefined (beforeEach default) — fetchPathsForMenu hits catch, no timer leak

    dom.newBtn.click();

    assert.strictEqual(dom.input.value, "/new ");
    assert.strictEqual(document.activeElement, dom.input);
  });

  it("does not send prompt when ws is not open and shows warning", () => {
    const ws = createMockWS();
    ws.readyState = 3; // WebSocket.CLOSED
    state.ws = ws;
    state.sessionId = "s1";
    dom.input.value = "hello";

    clickSend();

    assert.equal(ws.sent.length, 0, "should not send when disconnected");
    assert.ok(dom.messages.textContent.includes("Not connected"), "should warn user");
    assert.equal(state.busy, false, "should not enter busy state");
  });

  it("does not send bash command when ws is not open", () => {
    const ws = createMockWS();
    ws.readyState = 3; // WebSocket.CLOSED
    state.ws = ws;
    state.sessionId = "s1";
    dom.input.value = "!echo hi";

    clickSend();

    assert.equal(ws.sent.length, 0, "should not send bash when disconnected");
    assert.ok(dom.messages.textContent.includes("Not connected"), "should warn user");
    assert.equal(state.busy, false, "should not enter busy state");
  });

  it("does not send prompt with images when ws is not open", async () => {
    const ws = createMockWS();
    ws.readyState = 3; // WebSocket.CLOSED
    state.ws = ws;
    state.sessionId = "s1";
    state.pendingImages.push({
      data: "abc123",
      mimeType: "image/png",
      previewUrl: "data:image/png;base64,abc123",
    });
    setFetch(async () => ({ json: async () => ({ path: "uploads/image.png" }) }));

    clickSend();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(ws.sent.length, 0, "should not send when disconnected");
    assert.equal(state.busy, false, "should not enter busy state");
  });
});
