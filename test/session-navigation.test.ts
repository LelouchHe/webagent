import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resetState, setupDOM, teardownDOM } from "./frontend-setup.ts";

describe("shared session navigation", () => {
  let state: typeof import("../public/js/state.ts").state;
  let dom: typeof import("../public/js/state.ts").dom;
  let resetSessionUI: typeof import("../public/js/state.ts").resetSessionUI;
  let navigation: typeof import("../public/js/session-navigation.ts");
  let handleEvent: typeof import("../public/js/events.ts").handleEvent;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;
  let delayedHistory: Promise<Response> | null;

  before(async () => {
    setupDOM();
    ({ state, dom, resetSessionUI } = await import("../public/js/state.ts"));
    await import("../public/js/render.ts");
    ({ handleEvent } = await import("../public/js/events.ts"));
    navigation = await import("../public/js/session-navigation.ts");
  });

  after(() => {
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    fetchCalls = [];
    delayedHistory = null;
    history.replaceState(null, "", "/");
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      const response = (body: unknown, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
        json: async () => body,
      });
      if (url === "/api/v1/messages/m1/consume") {
        return response({
          sessionId: "message-session",
          alreadyConsumed: false,
        });
      }
      if (url === "/api/v1/messages/missing/consume") {
        return response({ error: "Not found" }, 404);
      }
      if (url === "/api/v1/messages/retry/consume") {
        return response({ error: "Unavailable" }, 500);
      }
      if (url === "/api/v1/sessions/message-session") {
        return response({
          id: "message-session",
          cwd: "/tmp",
          title: "Message",
          configOptions: [],
        });
      }
      if (url === "/api/v1/sessions/message-session/events?limit=500") {
        if (delayedHistory) return delayedHistory;
        return response({ events: [], streaming: {} });
      }
      if (url === "/api/v1/sessions/message-session/snapshot") {
        return response({
          version: 1,
          seq: 0,
          session: {},
          runtime: { busy: null },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
  });

  it("consumes a message using the current session and then shares session switching", async () => {
    state.sessionId = "current-session";

    const result = await navigation.consumeAndSwitch("m1");

    assert.equal(result, "switched");
    const consume = fetchCalls.find(
      (call) => call.url === "/api/v1/messages/m1/consume",
    );
    assert.ok(consume);
    assert.deepEqual(JSON.parse(consume.init!.body as string), {
      inheritFromSessionId: "current-session",
    });
    assert.equal(state.sessionId, "message-session");
    assert.equal(location.hash, "#message-session");
  });

  it("routes a session target directly without consuming a message", async () => {
    const result = await navigation.navigateFromNotification({
      sessionId: "message-session",
      messageId: "m1",
    });

    assert.equal(result, "switched");
    assert.equal(
      fetchCalls.some((call) => call.url.includes("/messages/")),
      false,
    );
    assert.equal(state.sessionId, "message-session");
  });

  it("does not let a competing session creation hijack a switch", async () => {
    state.sessionId = "current-session";
    let releaseHistory!: (response: Response) => void;
    delayedHistory = new Promise<Response>((resolve) => {
      releaseHistory = resolve;
    });

    const pending = navigation.switchToSession("message-session");
    resetSessionUI();
    assert.equal(state.pendingNavigationSessionId, "message-session");
    assert.equal(state.sessionId, null);
    handleEvent({
      type: "session_created",
      sessionId: "competing-session",
      cwd: "/other",
      configOptions: [],
    });
    assert.equal(state.sessionId, null);
    releaseHistory(
      new Response(JSON.stringify({ events: [], streaming: {} }), {
        status: 200,
      }),
    );
    const result = await pending;

    assert.equal(result, "switched");
    assert.equal(state.sessionId, "message-session");
    assert.equal(location.hash, "#message-session");
  });

  it("clears a terminal startup message intent", async () => {
    history.replaceState(null, "", "/?message=missing");

    const result = await navigation.processStartupMessageIntent();

    assert.equal(result, "terminal-error");
    assert.equal(location.search, "");
    assert.equal(
      fetchCalls.some((call) => call.url === "/api/v1/sessions"),
      true,
    );
  });

  it("retains a retryable startup message intent without retrying in-page", async () => {
    history.replaceState(null, "", "/?message=retry");

    const first = await navigation.processStartupMessageIntent();
    const second = await navigation.processStartupMessageIntent();

    assert.equal(first, "retryable-error");
    assert.equal(second, "ignored");
    assert.equal(location.search, "?message=retry");
    assert.equal(
      fetchCalls.filter((call) => call.url === "/api/v1/messages/retry/consume")
        .length,
      1,
    );
  });
});
