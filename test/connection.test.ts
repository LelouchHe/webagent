import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

const RECONNECT_DELAY_MS = 3000;

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

  after(() => {
    teardownDOM();
  });

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

  type MockResponse = {
    ok: boolean;
    status?: number;
    json: () => Promise<unknown>;
    text?: () => Promise<string>;
  };

  function mockResponse(data: any): MockResponse {
    const body = JSON.stringify(data);
    return {
      ok: true,
      status: 200,
      json: async () => data,
      text: async () => body,
    };
  }

  function setFetch(
    handler: (url: string, init?: RequestInit) => Promise<MockResponse>,
    snapshot: Record<string, unknown> = {
      version: 1,
      seq: 0,
      session: {},
      runtime: { busy: null },
    },
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
        return mockResponse(snapshot);
      }
      return handler(url, init);
    }) as unknown as typeof fetch;
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
    pendingCount = 0,
  ) {
    return es.onmessage?.({
      data: JSON.stringify({ type: "connected", clientId, pendingCount }),
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

  it("initializes the inbox count from the SSE handshake", async () => {
    setFetch(async () => mockResponse([]));
    connection.connect();
    const es = await latestES();

    fireConnected(es, "client-1", 5);

    assert.equal(state.inboxCount, 5);
    assert.equal(dom.inboxCount.textContent, "(5)");
  });

  it("resumes the session from the URL hash on connect", async () => {
    history.replaceState(null, "", "/#hash-session");
    let releaseSession!: () => void;
    const sessionReady = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    let releaseHistory!: () => void;
    const historyReady = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    setFetch(
      async (url: string) => {
        if (url.includes("/visibility")) return mockResponse({});
        if (url === "/api/v1/sessions/hash-session") {
          await sessionReady;
          return mockResponse(sessionResponse("hash-session"));
        }
        if (url.startsWith("/api/v1/sessions/hash-session/events")) {
          await historyReady;
          return mockResponse([
            {
              seq: 1,
              type: "prompt_done",
              data: "{}",
            },
            {
              seq: 2,
              type: "assistant_message",
              data: JSON.stringify({ text: "restored" }),
            },
          ]);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
      {
        version: 1,
        seq: 2,
        session: {},
        runtime: {
          busy: {
            kind: "agent",
            since: "2026-07-10T00:00:00.000Z",
            promptId: "prompt-1",
          },
        },
      },
    );

    connection.connect();
    const es = await latestES();
    assert.equal(es.url, "/api/v1/events/stream?ticket=tkt-test");
    // Snapshot hydration must wait until metadata and history are complete.
    await flush();
    const snapshotStartedBeforeReplayFinished = fetchCalls.some(
      (c) => c.url === "/api/v1/sessions/hash-session/snapshot",
    );
    releaseSession();
    releaseHistory();
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
    assert.equal(snapshotStartedBeforeReplayFinished, false);
    assert.ok(dom.messages.textContent.includes("restored"));
    assert.equal(state.lastEventSeq, 2);
    assert.equal(state.busy, true);
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
      if (url === "/api/v1/sessions/bootstrap" && init?.method === "POST")
        return mockResponse({ id: "new-1", created: true });
      throw new Error(`Unexpected fetch: ${url} ${init?.method}`);
    });

    connection.connect();
    await flush(30);

    assert.equal(state.awaitingNewSession, false);
    assert.equal(state.sessionId, "new-1");
  });

  it("creates a new session when no previous session exists", async () => {
    setFetch(async (url: string, init?: RequestInit) => {
      if (url.includes("/visibility")) return mockResponse({});
      if (
        url === "/api/v1/sessions" &&
        (!init?.method || init.method === "GET")
      )
        return mockResponse([]);
      if (url === "/api/v1/sessions/bootstrap" && init?.method === "POST")
        return mockResponse({ id: "new-1", created: true });
      throw new Error(`Unexpected fetch: ${url} ${init?.method}`);
    });

    connection.connect();
    await flush();

    assert.equal(state.awaitingNewSession, false);
    assert.equal(state.sessionId, "new-1");
    assert.equal(
      fetchCalls.filter(
        (call) =>
          call.url === "/api/v1/sessions/bootstrap" &&
          call.init?.method === "POST",
      ).length,
      1,
    );
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
    state.lastStateSeq = 42;
    state.clientId = "cl-old";

    es.onerror?.();

    assert.equal(es.readyState, MockEventSource.CLOSED);
    assert.equal(dom.status.dataset.state, "disconnected");
    assert.equal(dom.status.getAttribute("aria-label"), "disconnected");
    assert.equal(state.busy, false);
    assert.equal(state.pendingToolCallIds.size, 0);
    assert.equal(state.pendingPermissionRequestIds.size, 0);
    assert.equal(state.pendingPromptDone, false);
    assert.equal(state.lastStateSeq, 0);
    assert.equal(state.clientId, null);
    assert.equal(state.eventSource, null);
    // Filter to the reconnect cadence: request deadlines also arm timers now,
    // and this test's subject is that exactly one reconnect was scheduled.
    assert.deepEqual(
      timeoutCalls.filter((ms) => ms === RECONNECT_DELAY_MS),
      [RECONNECT_DELAY_MS],
    );
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
    // Filter to the reconnect cadence: request deadlines also arm timers now,
    // and this test's subject is that exactly one reconnect was scheduled.
    assert.deepEqual(
      timeoutCalls.filter((ms) => ms === RECONNECT_DELAY_MS),
      [RECONNECT_DELAY_MS],
    );

    // Reconnect — initSession runs immediately (incremental path).
    // Pick the reconnect timer by its cadence: request deadlines share the
    // same mocked setTimeout, so index 0 is no longer necessarily ours.
    timeoutFns[timeoutCalls.indexOf(RECONNECT_DELAY_MS)]();
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

  it("syncs a /new session whose events were never loaded from history", async () => {
    // Regression: a session created via /new never calls loadHistory(), and
    // live SSE events do not advance state.lastEventSeq. The frontier
    // therefore stays 0 for the whole session, which used to gate this
    // catch-up off entirely (`state.lastEventSeq > 0`) — the exact path most
    // users are on. after=0 is a valid catch-up request: the server returns
    // the full persisted transcript and _loadNewEventsImpl replays it from
    // sequence zero.
    state.sessionId = "fresh-session";
    state.clientId = "cl-fresh";
    state.lastEventSeq = 0;

    setFetch(async (url: string) => {
      if (url.includes("/visibility")) return mockResponse({});
      if (url.includes("after=0")) {
        return {
          ok: true,
          json: async () => [
            {
              seq: 1,
              type: "assistant_message",
              data: JSON.stringify({ text: "persisted while backgrounded" }),
            },
          ],
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    Object.defineProperty(globalThis.document, "hidden", {
      value: false,
      configurable: true,
    });
    globalThis.document.dispatchEvent(
      new (globalThis.window as any).Event("visibilitychange"),
    );
    await new Promise((r) => originalSetTimeout(r, 50));

    assert.ok(
      fetchCalls.some((c) => c.url.includes("after=0")),
      "should catch up from sequence zero",
    );
    assert.ok(
      dom.messages.textContent.includes("persisted while backgrounded"),
      "missed content must render",
    );
    assert.equal(state.lastEventSeq, 1);
  });

  it("retries missed-event recovery after the reconnect shared a failed catch-up", async () => {
    history.replaceState(null, "", "/#recover-session");
    state.sessionId = "recover-session";
    state.lastEventSeq = 0;

    let rejectFirstCatchUp!: (error: Error) => void;
    const firstCatchUp = new Promise<MockResponse>((_resolve, reject) => {
      rejectFirstCatchUp = reject;
    });
    let eventsFetchCount = 0;
    setFetch(async (url: string) => {
      if (url.includes("/visibility")) return mockResponse({});
      if (url === "/api/v1/sessions/recover-session")
        return mockResponse(sessionResponse("recover-session"));
      if (url.startsWith("/api/v1/sessions/recover-session/events")) {
        eventsFetchCount++;
        if (eventsFetchCount === 1) return firstCatchUp;
        return mockResponse([
          {
            seq: 1,
            type: "assistant_message",
            data: JSON.stringify({ text: "recovered without refresh" }),
          },
          {
            seq: 2,
            type: "prompt_done",
            data: JSON.stringify({ stopReason: "end_turn" }),
          },
        ]);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    connection.connect();
    const es = await latestES();
    fireConnected(es, "client-recovered");
    rejectFirstCatchUp(new Error("network resumed with a stale request"));
    await flush(100);

    assert.equal(eventsFetchCount, 2, "handshake recovery must retry once");
    assert.ok(dom.messages.textContent.includes("recovered without refresh"));
    assert.equal(state.lastEventSeq, 2);
    assert.equal(dom.status.dataset.state, "connected");
  });

  it("runs a fresh catch-up after the reconnect shared a stale successful load", async () => {
    history.replaceState(null, "", "/#stale-success-session");
    state.sessionId = "stale-success-session";
    state.lastEventSeq = 0;

    let releaseFirstCatchUp!: (response: MockResponse) => void;
    const firstCatchUp = new Promise<MockResponse>((resolve) => {
      releaseFirstCatchUp = resolve;
    });
    let eventsFetchCount = 0;
    setFetch(async (url: string) => {
      if (url.includes("/visibility")) return mockResponse({});
      if (url === "/api/v1/sessions/stale-success-session")
        return mockResponse(sessionResponse("stale-success-session"));
      if (url.startsWith("/api/v1/sessions/stale-success-session/events")) {
        eventsFetchCount++;
        if (eventsFetchCount === 1) return firstCatchUp;
        return mockResponse([
          {
            seq: 1,
            type: "assistant_message",
            data: JSON.stringify({ text: "persisted after the stale query" }),
          },
        ]);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    connection.connect();
    const es = await latestES();
    fireConnected(es, "client-stale-success");
    releaseFirstCatchUp(mockResponse([]));
    await flush(100);

    assert.equal(
      eventsFetchCount,
      2,
      "handshake recovery must query again after an older successful load",
    );
    assert.ok(
      dom.messages.textContent.includes("persisted after the stale query"),
    );
    assert.equal(state.lastEventSeq, 1);
  });

  describe("stream liveness watchdog", () => {
    let realNow: () => number;
    let now: number;

    beforeEach(() => {
      realNow = Date.now;
      now = 1_000_000;
      Date.now = () => now;
    });

    afterEach(() => {
      Date.now = realNow;
    });

    it("reconnects when the stream goes silent past the stall threshold", async () => {
      // EventSource can sit in OPEN forever after a NAT rebind or an HTTP/3
      // stall: no bytes arrive and no `error` fires, so onerror-driven
      // reconnect never runs. Silence is the only available signal.
      setFetch(async () => mockResponse([]));
      connection.connect();
      const first = await latestES();
      assert.equal(MockEventSource.instances.length, 1);

      now += 60_000;
      connection.checkStreamLiveness();
      await flush();

      assert.equal(first.readyState, MockEventSource.CLOSED);
      assert.equal(
        MockEventSource.instances.length,
        2,
        "a fresh stream must be opened",
      );
    });

    it("stays connected while heartbeats keep arriving", async () => {
      setFetch(async () => mockResponse([]));
      connection.connect();
      const es = await latestES();

      // Three heartbeat intervals of traffic, checked in between.
      for (let i = 0; i < 3; i++) {
        now += 15_000;
        es.listeners.get("heartbeat")?.forEach((cb) => cb({ data: "{}" }));
        connection.checkStreamLiveness();
      }
      await flush();

      assert.equal(es.readyState, MockEventSource.OPEN);
      assert.equal(
        MockEventSource.instances.length,
        1,
        "a live stream must not be torn down",
      );
    });

    it("does not reconnect before any stream has been opened", async () => {
      now += 600_000;
      connection.checkStreamLiveness();
      await flush();

      assert.equal(MockEventSource.instances.length, 0);
    });

    it("arms only once per stream, so a stalled check cannot loop", async () => {
      setFetch(async () => mockResponse([]));
      connection.connect();
      await latestES();

      now += 60_000;
      connection.checkStreamLiveness();
      await flush();
      const afterFirst = MockEventSource.instances.length;
      // Same wall clock, no new traffic: the replacement stream is young and
      // must not be judged stale by the timestamp of the one it replaced.
      connection.checkStreamLiveness();
      await flush();

      assert.equal(MockEventSource.instances.length, afterFirst);
    });

    it("does not open a second stream when a stalled check races the error backoff", async () => {
      // On resume the browser often surfaces `error` for a connection that
      // already died minutes ago. That schedules a backoff reconnect, but the
      // silence is also long past the threshold, so the watchdog would fire
      // inside the backoff window and connect a second time. An orphaned
      // stream is not merely wasteful: its onmessage keeps marking activity,
      // so the watchdog can never fire again.
      setFetch(async () => mockResponse([]));
      connection.connect();
      const first = await latestES();

      now += 60_000;
      first.onerror?.();
      connection.checkStreamLiveness();
      await flush();

      const pending = timeoutCalls.indexOf(RECONNECT_DELAY_MS);
      assert.ok(pending >= 0, "error path must schedule a reconnect");
      timeoutFns[pending]();
      await flush();

      assert.equal(
        MockEventSource.instances.length,
        2,
        "exactly one replacement stream",
      );
      const live = MockEventSource.instances.filter(
        (es: any) => es.readyState !== MockEventSource.CLOSED,
      );
      assert.equal(live.length, 1, "no orphaned stream may stay open");
      assert.equal(state.eventSource, live[0]);
    });

    it("abandons a stream whose ticket resolved after a newer connect", async () => {
      // The mint is awaited, so a reconnect started during it would otherwise
      // let the stale continuation construct a second EventSource.
      let releaseTicket!: (v: unknown) => void;
      let mintCount = 0;
      // Bypass setFetch: its helper auto-answers the ticket mint, which is the
      // very await this test needs to hold open.
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init });
        if (url === "/api/v1/sse-ticket") {
          mintCount++;
          if (mintCount === 1) {
            return new Promise((resolve) => {
              releaseTicket = resolve;
            });
          }
          return mockResponse({ ticket: "tkt-2", expiresIn: 60 });
        }
        if (url.endsWith("/snapshot"))
          return mockResponse({
            version: 1,
            seq: 0,
            session: {},
            runtime: { busy: null },
          });
        return mockResponse([]);
      }) as unknown as typeof fetch;

      connection.connect();
      await flush();
      assert.equal(MockEventSource.instances.length, 0, "first mint pending");

      connection.connect();
      await flush();
      const opened = MockEventSource.instances.length;
      assert.equal(opened, 1, "the newer attempt opens exactly one stream");

      releaseTicket(mockResponse({ ticket: "stale", expiresIn: 60 }));
      await flush();

      assert.equal(
        MockEventSource.instances.length,
        opened,
        "the superseded mint must not open a stream",
      );
    });
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
