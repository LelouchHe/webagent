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
    MockWebSocket.instances.length = 0;
    globalThis.fetch = undefined as any;
    history.replaceState(null, "", "/");
    originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: Function, ms?: number) => {
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
        json: async () => [{ type: "assistant_message", data: JSON.stringify({ text: "restored" }) }],
      };
    });

    connection.connect();
    const ws = latestSocket();
    await ws.onopen?.();

    assert.equal(ws.url, "ws://localhost:6801");
    assert.deepEqual(fetchCalls, ["/api/sessions/hash-session/events"]);
    assert.deepEqual(JSON.parse(ws.sent[0]), {
      type: "resume_session",
      sessionId: "hash-session",
    });
    assert.ok(dom.messages.textContent.includes("restored"));
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
    assert.deepEqual(JSON.parse(ws.sent[0]), {
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
    assert.deepEqual(JSON.parse(ws.sent[0]), { type: "new_session" });
  });

  it("marks the UI disconnected and schedules reconnect on close", () => {
    connection.connect();
    const ws = latestSocket();
    state.busy = true;
    state.currentBashEl = render.addBashBlock("echo hi", true);

    ws.onclose?.();

    assert.equal(dom.status.textContent, "disconnected");
    assert.equal(state.busy, false);
    assert.deepEqual(timeoutCalls, [3000]);
  });
});
