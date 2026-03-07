import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState, createMockWS } from "./frontend-setup.ts";

describe("input", () => {
  let state: any;
  let dom: any;
  let inputModule: any;
  let fetchCalls: Array<{ url: string; init?: any }>;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.js");
    state = stateMod.state;
    dom = stateMod.dom;
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
    assert.equal(dom.sendBtn.textContent, "^C");
    assert.equal(dom.input.value, "");
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

  it("sends cancel on Ctrl+C while busy", () => {
    const ws = createMockWS();
    state.ws = ws;
    state.sessionId = "s1";
    state.busy = true;

    const event = keydown("c", { ctrlKey: true });

    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(JSON.parse(ws.sent[0]), {
      type: "cancel",
      sessionId: "s1",
    });
    assert.ok(dom.messages.textContent.includes("^C"));
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

  it("creates a new session from the plus button", () => {
    const ws = createMockWS();
    state.ws = ws;
    state.sessionId = "current";
    state.sessionCwd = "/repo";

    dom.newBtn.click();

    assert.deepEqual(JSON.parse(ws.sent[0]), {
      type: "new_session",
      cwd: "/repo",
      inheritFromSessionId: "current",
    });
    assert.ok(dom.messages.textContent.includes("Creating new session…"));
  });
});
