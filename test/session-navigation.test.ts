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
  let delayedSnapshot: Promise<Response> | null;
  let onDelayedSnapshotFetch: (() => void) | null;

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
    delayedSnapshot = null;
    onDelayedSnapshotFetch = null;
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
        if (delayedSnapshot) {
          onDelayedSnapshotFetch?.();
          return delayedSnapshot;
        }
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
    resetSessionUI({ preserveNavigationTarget: true });
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

  it("does not complete a switch when snapshot hydration fails", async () => {
    state.sessionId = "current-session";
    delayedSnapshot = Promise.resolve(
      new Response(JSON.stringify({ error: "snapshot failed" }), {
        status: 500,
      }),
    );

    await assert.rejects(
      navigation.switchToSession("message-session"),
      /snapshot/i,
    );
    assert.equal(state.sessionId, null);
    assert.equal(state.busy, false);
    assert.equal(state.pendingNavigationSessionId, null);
  });

  it("explicit switch supersedes stale new-session ownership", async () => {
    state.sessionId = "current-session";
    state.awaitingNewSession = true;
    let releaseHistory!: (response: Response) => void;
    delayedHistory = new Promise<Response>((resolve) => {
      releaseHistory = resolve;
    });

    const pending = navigation.switchToSession("message-session");
    assert.equal(state.awaitingNewSession, false);
    releaseHistory(
      new Response(JSON.stringify({ events: [], streaming: {} }), {
        status: 200,
      }),
    );

    assert.equal(await pending, "switched");
    assert.equal(state.sessionId, "message-session");
    assert.equal(state.awaitingNewSession, false);
  });

  it("does not let a slower notification consume override a newer one", async () => {
    state.sessionId = "current-session";
    let releaseSlow!: (response: Response) => void;
    const slowConsume = new Promise<Response>((resolve) => {
      releaseSlow = resolve;
    });
    const response = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/v1/messages/slow/consume") return slowConsume;
      if (url === "/api/v1/messages/fast/consume") {
        return response({ sessionId: "fast-session", alreadyConsumed: false });
      }
      if (url === "/api/v1/sessions/fast-session") {
        return response({
          id: "fast-session",
          cwd: "/fast",
          title: "Fast",
          configOptions: [],
        });
      }
      if (url === "/api/v1/sessions/fast-session/events?limit=500") {
        return response({ events: [], streaming: {} });
      }
      if (url === "/api/v1/sessions/fast-session/snapshot") {
        return response({
          version: 1,
          seq: 0,
          session: {},
          runtime: { busy: null },
        });
      }
      if (url.startsWith("/api/beta/clients/")) return response({});
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const older = navigation.consumeAndSwitch("slow");
    const newer = navigation.consumeAndSwitch("fast");
    assert.equal(await newer, "switched");
    releaseSlow(
      response({ sessionId: "slow-session", alreadyConsumed: false }),
    );

    assert.equal(await older, "ignored");
    assert.equal(state.sessionId, "fast-session");
    assert.equal(location.hash, "#fast-session");
  });

  it("same-session selection supersedes a pending notification consume", async () => {
    state.sessionId = "current-session";
    let releaseSlow!: (response: Response) => void;
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/v1/messages/slow/consume") {
        return new Promise<Response>((resolve) => {
          releaseSlow = resolve;
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const pending = navigation.consumeAndSwitch("slow");
    assert.equal(
      await navigation.switchToSession("current-session"),
      "unchanged",
    );
    releaseSlow(
      new Response(
        JSON.stringify({
          sessionId: "slow-session",
          alreadyConsumed: false,
        }),
        { status: 200 },
      ),
    );

    assert.equal(await pending, "ignored");
    assert.equal(state.sessionId, "current-session");
  });

  it("failed notification consume does not invalidate an existing switch", async () => {
    state.sessionId = "current-session";
    let releaseHistory!: (response: Response) => void;
    delayedHistory = new Promise<Response>((resolve) => {
      releaseHistory = resolve;
    });

    const pendingSwitch = navigation.switchToSession("message-session");
    await assert.rejects(navigation.consumeAndSwitch("missing"), /Not found/);
    releaseHistory(
      new Response(JSON.stringify({ events: [], streaming: {} }), {
        status: 200,
      }),
    );

    assert.equal(await pendingSwitch, "switched");
    assert.equal(state.sessionId, "message-session");
  });

  it("applies target state patches that arrive during snapshot hydration", async () => {
    state.sessionId = "current-session";
    let releaseSnapshot!: (response: Response) => void;
    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    onDelayedSnapshotFetch = markSnapshotStarted;
    delayedSnapshot = new Promise<Response>((resolve) => {
      releaseSnapshot = resolve;
    });

    const pending = navigation.switchToSession("message-session");
    await snapshotStarted;
    handleEvent({
      type: "state_patch",
      sessionId: "message-session",
      seq: 5,
      patch: {
        runtime: {
          busy: { kind: "agent", since: "t1", promptId: "p2" },
        },
      },
    });
    releaseSnapshot(
      new Response(
        JSON.stringify({
          version: 1,
          seq: 4,
          session: {},
          runtime: { busy: null },
        }),
        { status: 200 },
      ),
    );

    assert.equal(await pending, "switched");
    assert.equal(state.busy, true);
    assert.equal(state.busyKind, "agent");
    assert.equal(state.lastStateSeq, 5);
  });

  it("abandons a switch superseded by ordinary session creation", async () => {
    state.sessionId = "current-session";
    let releaseHistory!: (response: Response) => void;
    delayedHistory = new Promise<Response>((resolve) => {
      releaseHistory = resolve;
    });

    const pending = navigation.switchToSession("message-session");
    resetSessionUI();
    state.awaitingNewSession = true;
    handleEvent({
      type: "session_created",
      sessionId: "new-session",
      cwd: "/new",
      configOptions: [],
    });
    releaseHistory(
      new Response(JSON.stringify({ events: [], streaming: {} }), {
        status: 200,
      }),
    );
    const result = await pending;

    assert.equal(result, "ignored");
    assert.equal(state.sessionId, "new-session");
    assert.equal(
      fetchCalls.some(
        (call) => call.url === "/api/v1/sessions/message-session/snapshot",
      ),
      false,
    );
  });

  it("does not apply a snapshot after navigation ownership is revoked", async () => {
    state.sessionId = "current-session";
    let releaseSnapshot!: (response: Response) => void;
    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    onDelayedSnapshotFetch = markSnapshotStarted;
    delayedSnapshot = new Promise<Response>((resolve) => {
      releaseSnapshot = resolve;
    });

    const pending = navigation.switchToSession("message-session");
    await snapshotStarted;
    resetSessionUI();
    state.awaitingNewSession = true;
    handleEvent({
      type: "session_created",
      sessionId: "new-session",
      cwd: "/new",
      configOptions: [],
    });
    releaseSnapshot(
      new Response(
        JSON.stringify({
          version: 1,
          seq: 77,
          session: {},
          runtime: { busy: { kind: "prompt" } },
        }),
        { status: 200 },
      ),
    );
    const result = await pending;

    assert.equal(result, "ignored");
    assert.equal(state.sessionId, "new-session");
    assert.equal(state.busy, false);
    assert.equal(state.lastStateSeq, 0);
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
