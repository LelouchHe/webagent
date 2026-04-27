import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

describe("connection", () => {
  let state: any;
  let dom: any;
  let render: any;
  let connection: any;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;
  let timeoutCalls: number[];
  let timeoutFns: (() => void)[];
  let originalSetTimeout: typeof globalThis.setTimeout;

  class MockEventSource {
    static instances: MockEventSource[] = [];
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    url: string;
    readyState = MockEventSource.OPEN;
    onopen: ((this: any) => any) | null = null;
    onmessage: ((this: any, event: { data: string }) => any) | null = null;
    onerror: ((this: any) => any) | null = null;
    listeners = new Map<string, ((e: { data: string }) => unknown)[]>();
    constructor(url: string) {
      this.url = url;
      MockEventSource.instances.push(this);
    }
    addEventListener(type: string, cb: (e: { data: string }) => unknown) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type)!.push(cb);
    }
    close() {
      this.readyState = MockEventSource.CLOSED;
    }
  }

  class MockWebSocket {
    static instances: MockWebSocket[] = [];
    url: string;
    sent: string[] = [];
    readyState = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => any) | null = null;
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
    originalSetTimeout = globalThis.setTimeout;
    setupDOM();
    globalThis.EventSource = MockEventSource as any;
    globalThis.WebSocket = MockWebSocket as any;
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    render = await import("../public/js/render.ts");
    connection = await import("../public/js/connection.ts");
  });

  after(() => teardownDOM());

  beforeEach(() => {
    resetState(state, dom);
    fetchCalls = [];
    timeoutCalls = [];
    timeoutFns = [];
    MockEventSource.instances.length = 0;
    MockWebSocket.instances.length = 0;
    globalThis.fetch = undefined as any;
    history.replaceState(null, "", "/");
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      timeoutFns.push(fn);
      timeoutCalls.push(ms ?? 0);
      return 1 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;
  });

  function mockResponse(data: any) {
    const body = JSON.stringify(data);
    return {
      ok: true,
      status: 200,
      json: async () => data,
      text: async () => body,
    };
  }

  function setFetch(
    handler: (url: string, init?: RequestInit) => Promise<Response>,
  ) {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      // Auto-respond to SSE ticket mints — every connect() call now does
      // this exchange before opening EventSource.
      if (url === "/api/v1/sse-ticket" && init?.method === "POST") {
        return mockResponse({ ticket: "tkt-test", expiresIn: 60 });
      }
      // Auto-stub snapshot endpoint so tests that don't care about it don't explode.
      if (url.endsWith("/snapshot")) {
        return mockResponse({
          version: 1,
          seq: 0,
          session: {},
          runtime: { busy: null },
        });
      }
      return handler(url, init);
    }) as any;
  }

  async function latestES() {
    // connect() is now async (awaits ticket mint + opens EventSource).
    // Flush microtasks so MockEventSource has been constructed before we
    // read it.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const es = MockEventSource.instances.at(-1);
    assert.ok(es, "Expected an EventSource instance");
    return es;
  }

  function fireConnected(
    es: InstanceType<typeof MockEventSource>,
    clientId: string,
  ) {
    return es.onmessage?.({
      data: JSON.stringify({ type: "connected", clientId }),
    });
  }

  function fireBridgeConnected(
    es: InstanceType<typeof MockEventSource>,
    agent: { name: string; version: string },
  ) {
    return es.onmessage?.({
      data: JSON.stringify({ type: "connected", agent, cancelTimeout: 10000 }),
    });
  }

  function sessionResponse(id: string, overrides?: Record<string, unknown>) {
    return {
      id,
      cwd: "/tmp",
      title: null,
      configOptions: [],
      busyKind: null,
      ...overrides,
    };
  }

  /** Flush microtask queue so fire-and-forget async (initSession) completes. */
  async function flush(n = 30) {
    for (let i = 0; i < n; i++) await Promise.resolve();
  }

  it("resumes the session from the URL hash on connect", async () => {
    history.replaceState(null, "", "/#hash-session");
    setFetch(async (url: string) => {
      if (url.includes("/visibility")) return mockResponse({});
      if (url === "/api/v1/sessions/hash-session")
        return mockResponse(sessionResponse("hash-session"));
      if (url.startsWith("/api/v1/sessions/hash-session/events"))
        return mockResponse([
          {
            seq: 1,
            type: "assistant_message",
            data: JSON.stringify({ text: "restored" }),
          },
        ]);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    connection.connect();
    const es = await latestES();
    assert.equal(es.url, "/api/v1/events/stream?ticket=tkt-test");
    // initSession runs immediately (parallel with SSE), flush to let it complete
    await flush();
    // SSE connected arrives — sets clientId only
    fireConnected(es, "cl-test");

    assert.equal(state.clientId, "cl-test");
    assert.equal(state.sessionId, "hash-session");
    const urls = fetchCalls.map((c) => c.url);
    assert.ok(urls.some((u) => u === "/api/v1/sessions/hash-session"));
    assert.ok(
      urls.some((u) => u.startsWith("/api/v1/sessions/hash-session/events")),
    );
    assert.ok(dom.messages.textContent.includes("restored"));
    assert.equal(state.lastEventSeq, 1);
  });

  it("resumes the most recent session when there is no hash", async () => {
    setFetch(async (url: string) => {
      if (url.includes("/visibility")) return mockResponse({});
      if (url === "/api/v1/sessions")
        return mockResponse([{ id: "recent-session" }]);
      if (url === "/api/v1/sessions/recent-session")
        return mockResponse(sessionResponse("recent-session"));
      if (url.startsWith("/api/v1/sessions/recent-session/events"))
        return mockResponse([]);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    connection.connect();
    await flush();

    const urls = fetchCalls.map((c) => c.url);
    assert.ok(urls.some((u) => u === "/api/v1/sessions"));
    assert.ok(urls.some((u) => u === "/api/v1/sessions/recent-session"));
    assert.equal(state.sessionId, "recent-session");
  });

  it("falls back to next existing session when hash session is expired", async () => {
    history.replaceState(null, "", "/#expired-session");
    setFetch(async (url: string, init?: RequestInit) => {
      if (url.includes("/visibility")) return mockResponse({});
      // The expired session returns 404
      if (url === "/api/v1/sessions/expired-session")
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "not found" }),
        };
      if (url.startsWith("/api/v1/sessions/expired-session/events"))
        return mockResponse([]);
      // listSessions returns another available session
      if (
        url === "/api/v1/sessions" &&
        (!init?.method || init.method === "GET")
      )
        return mockResponse([{ id: "fallback-session" }]);
      if (url === "/api/v1/sessions/fallback-session")
        return mockResponse(
          sessionResponse("fallback-session", { title: "Fallback" }),
        );
      if (url.startsWith("/api/v1/sessions/fallback-session/events"))
        return mockResponse([]);
      throw new Error(`Unexpected fetch: ${url} ${init?.method}`);
    });

    connection.connect();
    await flush(30);

    // Should have switched to the fallback session, not created a new one
    assert.equal(state.sessionId, "fallback-session");
    assert.equal(state.awaitingNewSession, false);
  });

  it("creates new session when hash session is expired and no other sessions exist", async () => {
    history.replaceState(null, "", "/#expired-session");
    setFetch(async (url: string, init?: RequestInit) => {
      if (url.includes("/visibility")) return mockResponse({});
      if (url === "/api/v1/sessions/expired-session")
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "not found" }),
        };
      if (url.startsWith("/api/v1/sessions/expired-session/events"))
        return mockResponse([]);
      // No other sessions available
      if (
        url === "/api/v1/sessions" &&
        (!init?.method || init.method === "GET")
      )
        return mockResponse([]);
      if (url === "/api/v1/sessions" && init?.method === "POST")
        return mockResponse({ id: "new-1" });
      throw new Error(`Unexpected fetch: ${url} ${init?.method}`);
    });

    connection.connect();
    await flush(30);

    assert.equal(state.awaitingNewSession, true);
  });

  it("creates a new session when no previous session exists", async () => {
    setFetch(async (url: string, init?: RequestInit) => {
      if (url.includes("/visibility")) return mockResponse({});
      if (
        url === "/api/v1/sessions" &&
        (!init?.method || init.method === "GET")
      )
        return mockResponse([]);
      if (url === "/api/v1/sessions" && init?.method === "POST")
        return mockResponse({ id: "new-1" });
      throw new Error(`Unexpected fetch: ${url} ${init?.method}`);
    });

    connection.connect();
    await flush();

    assert.equal(state.awaitingNewSession, true);
  });

  it("marks the UI disconnected and schedules reconnect on SSE error", async () => {
    setFetch(async () => mockResponse({}));
    connection.connect();
    const es = await latestES();
    state.busy = true;
    state.currentBashEl = render.addBashBlock("echo hi", true);
    state.pendingToolCallIds.add("tc-orphan");
    state.pendingPermissionRequestIds.add("perm-orphan");
    state.pendingPromptDone = true;
    state.clientId = "cl-old";

    es.onerror?.();

    assert.equal(es.readyState, MockEventSource.CLOSED);
    assert.equal(dom.status.dataset.state, "disconnected");
    assert.equal(dom.status.getAttribute("aria-label"), "disconnected");
    assert.equal(state.busy, false);
    assert.equal(state.pendingToolCallIds.size, 0);
    assert.equal(state.pendingPermissionRequestIds.size, 0);
    assert.equal(state.pendingPromptDone, false);
    assert.equal(state.clientId, null);
    assert.equal(state.eventSource, null);
    assert.deepEqual(timeoutCalls, [3000]);
  });

  it("reconnects and resumes the current hash session after error", async () => {
    history.replaceState(null, "", "/#restored-session");
    let eventsFetchCount = 0;
    setFetch(async (url: string) => {
      if (url.includes("/visibility")) return mockResponse({});
      if (url === "/api/v1/sessions/restored-session")
        return mockResponse(sessionResponse("restored-session"));
      if (url.includes("/api/v1/sessions/restored-session/events")) {
        eventsFetchCount++;
        if (eventsFetchCount === 1)
          return mockResponse([
            {
              seq: 1,
              type: "assistant_message",
              data: JSON.stringify({ text: "first load" }),
            },
          ]);
        return mockResponse([
          {
            seq: 2,
            type: "assistant_message",
            data: JSON.stringify({ text: "after reconnect" }),
          },
        ]);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    // First connect — initSession runs immediately
    connection.connect();
    await flush();
    assert.equal(state.sessionId, "restored-session");
    assert.equal(state.lastEventSeq, 1);

    // Disconnect
    const firstES = await latestES();
    firstES.onerror?.();
    assert.deepEqual(timeoutCalls, [3000]);

    // Reconnect — initSession runs immediately (incremental path)
    timeoutFns[0]();
    await flush();

    assert.equal(MockEventSource.instances.length, 2);
    assert.equal(state.sessionId, "restored-session");
    assert.equal(state.lastEventSeq, 2);
  });

  it("uses incremental sync on reconnect when sessionId matches hash", async () => {
    history.replaceState(null, "", "/#incr-session");
    state.sessionId = "incr-session";
    state.lastEventSeq = 2;

    const existingEl = globalThis.document.createElement("div");
    existingEl.className = "msg user";
    existingEl.textContent = "old message";
    existingEl.setAttribute("data-sync-boundary", "");
    dom.messages.appendChild(existingEl);

    const liveEl = globalThis.document.createElement("div");
    liveEl.className = "msg assistant";
    liveEl.textContent = "partial stream";
    dom.messages.appendChild(liveEl);

    setFetch(async (url: string) => {
      if (url.includes("/visibility")) return mockResponse({});
      if (url === "/api/v1/sessions/incr-session")
        return mockResponse(sessionResponse("incr-session"));
      if (url.includes("/api/v1/sessions/incr-session/events")) {
        assert.ok(
          url.includes("after=2"),
          `Expected after=2 in URL, got: ${url}`,
        );
        return mockResponse([
          {
            seq: 3,
            type: "assistant_message",
            data: JSON.stringify({ text: "full reply" }),
          },
        ]);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    connection.connect();
    await flush();

    assert.ok(dom.messages.children[0].textContent.includes("old message"));
    assert.equal(dom.messages.children.length, 2);
    assert.ok(dom.messages.children[1].textContent.includes("full reply"));
    assert.equal(state.lastEventSeq, 3);
  });

  it("syncs missed events on visibilitychange hidden→visible", async () => {
    state.sessionId = "vis-session";
    state.clientId = "cl-vis";
    state.lastEventSeq = 3;

    const existingEl = globalThis.document.createElement("div");
    existingEl.className = "msg assistant";
    existingEl.textContent = "before background";
    existingEl.setAttribute("data-sync-boundary", "");
    dom.messages.appendChild(existingEl);

    setFetch(async (url: string) => {
      if (url.includes("/visibility")) return mockResponse({});
      if (url.includes("after=3")) {
        return {
          ok: true,
          json: async () => [
            {
              seq: 4,
              type: "assistant_message",
              data: JSON.stringify({ text: "missed while backgrounded" }),
            },
          ],
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    // Simulate visibilitychange: hidden → visible
    Object.defineProperty(globalThis.document, "hidden", {
      value: false,
      configurable: true,
    });
    const event = new (globalThis.window as any).Event("visibilitychange");
    globalThis.document.dispatchEvent(event);

    // Wait for the async loadNewEvents to complete
    await new Promise((r) => originalSetTimeout(r, 50));

    // Should have sent visibility report via REST
    assert.ok(
      fetchCalls.some((c) => c.url.includes("/visibility")),
      "should POST visibility",
    );
    // Should have fetched missed events
    assert.ok(
      fetchCalls.some((c) => c.url.includes("after=3")),
      "should fetch new events",
    );
    // The missed message should now appear
    assert.ok(dom.messages.textContent.includes("missed while backgrounded"));
    assert.equal(state.lastEventSeq, 4);
  });

  it("aborts session resume when sessionSwitchGen changes mid-flight", async () => {
    history.replaceState(null, "", "/#session-a");

    let resolveSessionA!: () => void;
    const sessionADeferred = new Promise<void>((r) => {
      resolveSessionA = r;
    });

    setFetch(async (url: string) => {
      if (url.includes("/visibility")) return mockResponse({});
      if (url === "/api/v1/sessions/session-a") {
        await sessionADeferred;
        return mockResponse(sessionResponse("session-a"));
      }
      if (url.startsWith("/api/v1/sessions/session-a/events"))
        return mockResponse([]);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    connection.connect();
    await flush(5);

    // Simulate a user-initiated session switch (notification click, /switch)
    state.sessionSwitchGen++;

    // Let the stale session-a fetch resolve
    resolveSessionA();
    await flush();

    // The stale initSession should have aborted — session-a NOT activated
    assert.notEqual(state.sessionId, "session-a");
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

    setFetch(async (url: string) => {
      if (url.includes("/visibility")) return mockResponse({});
      if (url === "/api/v1/sessions/idle-session")
        return mockResponse(sessionResponse("idle-session"));
      if (url.includes("/api/v1/sessions/idle-session/events"))
        return mockResponse([]);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    connection.connect();
    await flush();

    assert.equal(dom.messages.children.length, 1);
    assert.ok(dom.messages.textContent.includes("preserved content"));
    assert.equal(state.lastEventSeq, 5);
  });

  it("passes bridge connected event (with agent) through to handleEvent", async () => {
    history.replaceState(null, "", "/#reload-session");
    setFetch(async (url: string) => {
      if (url.includes("/visibility")) return mockResponse({});
      if (url === "/api/v1/sessions/reload-session")
        return mockResponse(sessionResponse("reload-session"));
      if (url.startsWith("/api/v1/sessions/reload-session/events"))
        return mockResponse([]);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    connection.connect();
    const es = await latestES();
    await flush();

    // SSE handshake
    fireConnected(es, "cl-reload");
    assert.equal(state.clientId, "cl-reload");

    // Simulate reload in progress
    state.agentReloading = true;

    // Bridge connected event (has agent, no clientId) — must reach handleEvent
    fireBridgeConnected(es, { name: "copilot", version: "2.0" });

    assert.equal(
      state.agentReloading,
      false,
      "handleEvent should have cleared agentReloading",
    );
    assert.ok(
      dom.messages.textContent.includes("copilot 2.0 reloaded"),
      "should show reloaded message",
    );
  });
});
