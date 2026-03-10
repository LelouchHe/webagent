import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("connection", () => {
  let state: any;
  let dom: any;
  let render: any;
  let connection: any;
  let originalSetTimeout: typeof globalThis.setTimeout;
  let fetchCalls: string[];
  let timeoutCalls: number[];
  let timeoutFns: Function[];

  class MockWebSocket {
    static instances: MockWebSocket[] = [];
    static OPEN = 1;
    url: string;
    readyState = MockWebSocket.OPEN;
    sent: string[] = [];
    onopen?: () => unknown;
    onclose?: () => unknown;
    onerror?: () => unknown;
    onmessage?: (event: { data: string }) => unknown;

    constructor(url: string) {
      this.url = url;
      MockWebSocket.instances.push(this);
    }

    send(data: string) {
      this.sent.push(data);
    }

    close() {
      this.onclose?.();
    }
  }

  before(async () => {
    setupDOM();
    globalThis.WebSocket = MockWebSocket as any;
    const stateMod = await import("../public/js/state.js");
    state = stateMod.state;
    dom = stateMod.dom;
    render = await import("../public/js/render.js");
    connection = await import("../public/js/connection.js");
  });

  after(() => teardownDOM());

  beforeEach(() => {
    resetState(state, dom);
    fetchCalls = [];
    timeoutCalls = [];
    timeoutFns = [];
    MockWebSocket.instances.length = 0;
    globalThis.fetch = undefined as any;
    history.replaceState(null, "", "/");
    originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: Function, ms?: number) => {
      timeoutFns.push(fn);
      timeoutCalls.push(ms ?? 0);
      return 1 as any;
    }) as any;
  });

  function setFetch(handler: (url: string) => Promise<any> | any) {
    globalThis.fetch = (async (url: string) => {
      fetchCalls.push(url);
      return handler(url);
    }) as any;
  }

  function latestSocket() {
    const ws = MockWebSocket.instances.at(-1);
    assert.ok(ws);
    return ws;
  }

  it("resumes the session from the URL hash on connect", async () => {
    history.replaceState(null, "", "/#hash-session");
    setFetch(async (url: string) => {
      assert.equal(url, "/api/sessions/hash-session/events");
      return {
        ok: true,
        json: async () => [{ seq: 1, type: "assistant_message", data: JSON.stringify({ text: "restored" }) }],
      };
    });

    connection.connect();
    const ws = latestSocket();
    await ws.onopen?.();

    assert.equal(ws.url, "ws://localhost:6801");
    assert.deepEqual(fetchCalls, ["/api/sessions/hash-session/events"]);
    assert.deepEqual(JSON.parse(ws.sent[0]), { type: "visibility", visible: true });
    assert.deepEqual(JSON.parse(ws.sent[1]), {
      type: "resume_session",
      sessionId: "hash-session",
    });
    assert.ok(dom.messages.textContent.includes("restored"));
    assert.equal(state.lastEventSeq, 1);
  });

  it("resumes the most recent session when there is no hash", async () => {
    setFetch(async (url: string) => {
      if (url === "/api/sessions") {
        return { json: async () => [{ id: "recent-session" }] };
      }
      if (url === "/api/sessions/recent-session/events") {
        return { ok: true, json: async () => [] };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    connection.connect();
    const ws = latestSocket();
    await ws.onopen?.();

    assert.deepEqual(fetchCalls, ["/api/sessions", "/api/sessions/recent-session/events"]);
    assert.deepEqual(JSON.parse(ws.sent[0]), { type: "visibility", visible: true });
    assert.deepEqual(JSON.parse(ws.sent[1]), {
      type: "resume_session",
      sessionId: "recent-session",
    });
  });

  it("creates a new session when no previous session exists", async () => {
    setFetch(async (url: string) => {
      assert.equal(url, "/api/sessions");
      return { json: async () => [] };
    });

    connection.connect();
    const ws = latestSocket();
    await ws.onopen?.();

    assert.equal(state.awaitingNewSession, true);
    assert.deepEqual(JSON.parse(ws.sent[0]), { type: "visibility", visible: true });
    assert.deepEqual(JSON.parse(ws.sent[1]), { type: "new_session" });
  });

  it("marks the UI disconnected and schedules reconnect on close", () => {
    connection.connect();
    const ws = latestSocket();
    state.busy = true;
    state.currentBashEl = render.addBashBlock("echo hi", true);
    state.pendingToolCallIds.add("tc-orphan");
    state.pendingPermissionRequestIds.add("perm-orphan");
    state.pendingPromptDone = true;

    ws.onclose?.();

    assert.equal(dom.status.dataset.state, "disconnected");
    assert.equal(dom.status.getAttribute("aria-label"), "disconnected");
    assert.equal(state.busy, false);
    assert.equal(state.pendingToolCallIds.size, 0);
    assert.equal(state.pendingPermissionRequestIds.size, 0);
    assert.equal(state.pendingPromptDone, false);
    assert.deepEqual(timeoutCalls, [3000]);
  });

  it("reconnects and resumes the current hash session after close", async () => {
    history.replaceState(null, "", "/#restored-session");
    setFetch(async (url: string) => {
      assert.equal(url, "/api/sessions/restored-session/events");
      return {
        ok: true,
        json: async () => [{ seq: 1, type: "assistant_message", data: JSON.stringify({ text: "restored again" }) }],
      };
    });

    connection.connect();
    const firstWs = latestSocket();
    await firstWs.onopen?.();
    firstWs.onclose?.();

    assert.deepEqual(timeoutCalls, [3000]);
    assert.equal(timeoutFns.length, 1);

    await timeoutFns[0]();
    const secondWs = latestSocket();
    await secondWs.onopen?.();

    assert.equal(MockWebSocket.instances.length, 2);
    assert.deepEqual(fetchCalls, [
      "/api/sessions/restored-session/events",
      "/api/sessions/restored-session/events",
    ]);
    assert.deepEqual(JSON.parse(secondWs.sent[0]), { type: "visibility", visible: true });
    assert.deepEqual(JSON.parse(secondWs.sent[1]), {
      type: "resume_session",
      sessionId: "restored-session",
    });
    assert.equal(dom.messages.querySelectorAll(".msg.assistant").length, 1);
    assert.ok(dom.messages.textContent.includes("restored again"));
  });

  it("uses incremental sync on reconnect when sessionId matches hash", async () => {
    // Simulate an already-loaded session
    history.replaceState(null, "", "/#incr-session");
    state.sessionId = "incr-session";
    state.lastEventSeq = 2;

    // Existing DOM content from previous loadHistory
    const existingEl = globalThis.document.createElement("div");
    existingEl.className = "msg user";
    existingEl.textContent = "old message";
    existingEl.setAttribute("data-sync-boundary", "");
    dom.messages.appendChild(existingEl);

    // Simulate a live-added element (post-boundary)
    const liveEl = globalThis.document.createElement("div");
    liveEl.className = "msg assistant";
    liveEl.textContent = "partial stream";
    dom.messages.appendChild(liveEl);

    setFetch(async (url: string) => {
      assert.ok(url.includes("after_seq=2"), `Expected after_seq=2 in URL, got: ${url}`);
      return {
        ok: true,
        json: async () => [
          { seq: 3, type: "assistant_message", data: JSON.stringify({ text: "full reply" }) },
        ],
      };
    });

    connection.connect();
    const ws = latestSocket();
    await ws.onopen?.();

    // Should NOT have wiped the old message
    assert.ok(dom.messages.children[0].textContent.includes("old message"));
    // Live "partial stream" replaced by the DB version "full reply"
    assert.equal(dom.messages.children.length, 2);
    assert.ok(dom.messages.children[1].textContent.includes("full reply"));
    // Used incremental fetch, not full history
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].includes("after_seq=2"));
    assert.equal(state.lastEventSeq, 3);
    // Still sent resume_session (after initial visibility)
    assert.deepEqual(JSON.parse(ws.sent[0]), { type: "visibility", visible: true });
    assert.deepEqual(JSON.parse(ws.sent[1]), {
      type: "resume_session",
      sessionId: "incr-session",
    });
  });

  it("skips DOM changes when no new events on incremental reconnect", async () => {
    history.replaceState(null, "", "/#idle-session");
    state.sessionId = "idle-session";
    state.lastEventSeq = 5;

    const existingEl = globalThis.document.createElement("div");
    existingEl.className = "msg assistant";
    existingEl.textContent = "preserved content";
    existingEl.setAttribute("data-sync-boundary", "");
    dom.messages.appendChild(existingEl);

    setFetch(async () => ({
      ok: true,
      json: async () => [],
    }));

    connection.connect();
    const ws = latestSocket();
    await ws.onopen?.();

    // DOM unchanged
    assert.equal(dom.messages.children.length, 1);
    assert.ok(dom.messages.textContent.includes("preserved content"));
    assert.equal(state.lastEventSeq, 5);
  });
});
