import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("input", () => {
  let state: any;
  let dom: any;
  let setBusy: any;
  let inputModule: any;
  let fetchCalls: Array<{ url: string; init?: any }>;

  before(async () => {
    setupDOM();
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    setBusy = stateMod.setBusy;
    await import("../public/js/render.ts");
    await import("../public/js/events.ts");
    await import("../public/js/commands.ts");
    await import("../public/js/images.ts");
    inputModule = await import("../public/js/input.ts");
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
    setFetch(() => ({ ok: true, json: async () => ({ status: "accepted" }), text: async () => '{"status":"accepted"}' }));
    state.sessionId = "s1";
    state.clientId = "cl-1";
    dom.input.value = "hello";

    clickSend();

    const call = fetchCalls.find(c => c.url.includes("/prompt"));
    assert.ok(call, "expected a prompt fetch call");
    assert.equal(call!.url, "/api/v1/sessions/s1/prompt");
    assert.equal(call!.init?.method, "POST");
    assert.deepEqual(JSON.parse(call!.init?.body), { text: "hello" });
    assert.equal(state.busy, true);
    assert.equal(dom.sendBtn.textContent, "^X");
    assert.equal(dom.input.value, "");
  });

  it("resets turnEnded when sending a new prompt", () => {
    setFetch(() => ({ ok: true, json: async () => ({}), text: async () => '{}' }));
    state.sessionId = "s1";
    state.clientId = "cl-1";
    state.turnEnded = true;
    dom.input.value = "next question";

    clickSend();

    assert.equal(state.turnEnded, false, "turnEnded should be cleared on send");
    assert.equal(state.busy, true);
  });

  it("routes bang-prefixed input to bash execution", () => {
    setFetch(() => ({ ok: true, json: async () => ({}), text: async () => '{}' }));
    state.sessionId = "s1";
    state.clientId = "cl-1";
    dom.input.value = "!echo hello";

    clickSend();

    const call = fetchCalls.find(c => c.url.includes("/bash"));
    assert.ok(call, "expected a bash fetch call");
    assert.equal(call!.url, "/api/v1/sessions/s1/bash");
    assert.equal(call!.init?.method, "POST");
    assert.deepEqual(JSON.parse(call!.init?.body), { command: "echo hello" });
    assert.equal(state.busy, true);
    assert.ok(dom.messages.textContent.includes("echo hello"));
  });

  it("allows slash commands while busy", () => {
    state.sessionId = "s1";
    state.clientId = "cl-1";
    state.busy = true;
    dom.input.value = "/pwd";

    keydown("Enter");

    assert.ok(dom.messages.textContent.includes("s1") || dom.messages.textContent.includes("unknown"));
    assert.equal(dom.input.value, "");
  });

  it("blocks regular messages while busy", () => {
    state.sessionId = "s1";
    state.clientId = "cl-1";
    state.busy = true;
    dom.input.value = "hello";

    keydown("Enter");

    assert.equal(fetchCalls.length, 0);
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
    state.sessionId = "s1";
    state.sessionCwd = "/test";
    state.clientId = "cl-1";
    state.busy = true;
    setBusy(true);
    dom.input.value = "/pwd";

    clickSend();

    assert.ok(dom.messages.textContent.includes("/test"));
    assert.equal(dom.input.value, "");
  });

  it("warns instead of sending when the session is not ready", () => {
    state.clientId = "cl-1";
    dom.input.value = "hello";

    clickSend();

    assert.equal(fetchCalls.length, 0);
    assert.ok(dom.messages.textContent.includes("warn: Session not ready yet"));
  });

  it("uploads pending images before sending the prompt", async () => {
    state.sessionId = "s1";
    state.clientId = "cl-1";
    state.pendingImages.push({
      data: "abc123",
      mimeType: "image/png",
      previewUrl: "data:image/png;base64,abc123",
    });
    setFetch(async (url: string) => {
      if (url.includes("/api/v1/sessions/") && url.includes("/images")) {
        return { ok: true, json: async () => ({ url: "/api/v1/sessions/s1/images/image.png" }), text: async () => '{"url":"/api/v1/sessions/s1/images/image.png"}' };
      }
      // sendMessage call
      return { ok: true, json: async () => ({}), text: async () => '{}' };
    });

    clickSend();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const imageCall = fetchCalls.find(c => c.url.includes("/api/v1/sessions/") && c.url.includes("/images"));
    assert.ok(imageCall, "expected an image upload call");
    const msgCall = fetchCalls.find(c => c.url.includes("/prompt"));
    assert.ok(msgCall, "expected a prompt call");
    const body = JSON.parse(msgCall!.init?.body);
    assert.equal(body.text, "What is in this image?");
    assert.deepEqual(body.images, [{
      data: "abc123",
      mimeType: "image/png",
      path: "/api/v1/sessions/s1/images/image.png",
    }]);
  });

  it("sends cancel on global Ctrl+X while busy", () => {
    setFetch(() => ({ ok: true, json: async () => ({}) }));
    state.sessionId = "s1";
    state.busy = true;

    const event = docKeydown("x", { ctrlKey: true });

    assert.equal(event.defaultPrevented, true);
    // sendCancel now uses REST POST /api/v1/sessions/:id/cancel
    const cancelCall = fetchCalls.find(c => c.url.includes("/cancel"));
    assert.ok(cancelCall, "expected a cancel fetch call");
    assert.equal(cancelCall!.url, "/api/v1/sessions/s1/cancel");
    assert.equal(cancelCall!.init?.method, "POST");
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
    setFetch(() => ({ ok: true, json: async () => ({}), text: async () => '{}' }));
    state.sessionId = "s1";
    state.clientId = "cl-1";
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
    const call = fetchCalls.find(c => c.url.includes("/api/v1/sessions/s1/mode") && c.init?.method === "PUT");
    assert.ok(call, "expected a PUT config call");
    const body = JSON.parse(call!.init?.body);
    assert.equal(body.value, "chat#plan");
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

  it("does not send prompt when not connected and shows warning", () => {
    state.sessionId = "s1";
    // clientId is null → not connected
    dom.input.value = "hello";

    clickSend();

    assert.equal(fetchCalls.length, 0, "should not send when disconnected");
    assert.ok(dom.messages.textContent.includes("Not connected"), "should warn user");
    assert.equal(state.busy, false, "should not enter busy state");
  });

  it("does not send bash command when not connected", () => {
    state.sessionId = "s1";
    // clientId is null → not connected
    dom.input.value = "!echo hi";

    clickSend();

    assert.equal(fetchCalls.length, 0, "should not send bash when disconnected");
    assert.ok(dom.messages.textContent.includes("Not connected"), "should warn user");
    assert.equal(state.busy, false, "should not enter busy state");
  });

  it("does not send prompt with images when not connected", async () => {
    state.sessionId = "s1";
    // clientId is null → not connected
    state.pendingImages.push({
      data: "abc123",
      mimeType: "image/png",
      previewUrl: "data:image/png;base64,abc123",
    });
    setFetch(async () => ({ ok: true, json: async () => ({ url: "/api/v1/sessions/s1/images/image.png" }), text: async () => '{"url":"/api/v1/sessions/s1/images/image.png"}' }));

    clickSend();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Image upload may still fire, but the prompt should not
    const msgCall = fetchCalls.find(c => c.url.includes("/prompt"));
    assert.ok(!msgCall, "should not send message when disconnected");
    assert.equal(state.busy, false, "should not enter busy state");
  });
});
