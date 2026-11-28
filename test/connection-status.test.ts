import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { setupDOM, teardownDOM, resetState } from "./frontend-setup.ts";

const RECONNECT_DELAY_MS = 3000;
const ROOT_ID = "00000000-0000-4000-8000-000000000001";

describe("connection status indicator transitions", () => {
  let state: typeof import("../public/js/state.ts").state;
  let dom: typeof import("../public/js/state.ts").dom;
  let connection: typeof import("../public/js/connection.ts");
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
    onmessage: ((this: unknown, event: { data: string }) => unknown) | null =
      null;
    onerror: ((this: unknown) => unknown) | null = null;
    constructor(url: string) {
      this.url = url;
      MockEventSource.instances.push(this);
    }
    addEventListener() {}
    close() {
      this.readyState = MockEventSource.CLOSED;
    }
  }

  before(async () => {
    originalSetTimeout = globalThis.setTimeout;
    setupDOM();
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const stateMod = await import("../public/js/state.ts");
    state = stateMod.state;
    dom = stateMod.dom;
    connection = await import("../public/js/connection.ts");
  });

  after(() => {
    globalThis.setTimeout = originalSetTimeout;
    teardownDOM();
  });

  beforeEach(() => {
    resetState(state, dom);
    timeoutCalls = [];
    timeoutFns = [];
    MockEventSource.instances.length = 0;
    history.replaceState(null, "", "/");
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      timeoutFns.push(fn);
      timeoutCalls.push(ms ?? 0);
      return 1 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;
  });

  async function flush(ticks = 20): Promise<void> {
    for (let i = 0; i < ticks; i++) {
      await Promise.resolve();
    }
  }

  it("transitions disconnected -> connecting (yellow) -> connected across SyncHub reconnect", async () => {
    const jsonResp = (data: unknown) => ({
      ok: true,
      status: 200,
      json: async () => data,
      text: async () => JSON.stringify(data),
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === "/api/v1/sse-ticket") return jsonResp({ ticket: "tk" });
      if (url === "/api/v1/config") {
        return jsonResp({
          rootTaskId: ROOT_ID,
          defaultAgentId: "mock",
          agents: [{ id: "mock", name: "Mock" }],
        });
      }
      if (url.includes("/visibility")) return jsonResp({});
      if (url.split("?")[0] === "/api/v1/tasks") {
        return jsonResp({
          tasks: [{ id: ROOT_ID, title: "Root", cwd: "/tmp", isRoot: true }],
        });
      }
      if (url.split("?")[0] === `/api/v1/tasks/${ROOT_ID}`) {
        return jsonResp({
          id: ROOT_ID,
          title: "Root",
          cwd: "/tmp",
          agentId: "mock",
          isRoot: true,
          configOptions: [],
          agentCommands: { epoch: "e1", revision: 0, commands: [] },
        });
      }
      if (url.startsWith(`/api/v1/tasks/${ROOT_ID}/events`)) {
        return jsonResp([]);
      }
      if (url.split("?")[0] === `/api/v1/tasks/${ROOT_ID}/snapshot`) {
        return jsonResp({
          version: 1,
          seq: 0,
          task: { id: ROOT_ID, lastEventSeq: 0 },
          runtime: { busy: null },
        });
      }
      return jsonResp({});
    }) as typeof fetch;

    connection.connect();
    await flush(50);

    // 1. Initial connection establishes green (connected).
    const firstEs = MockEventSource.instances[0];
    assert.ok(firstEs, "initial EventSource must be opened");
    firstEs.onmessage?.({
      data: JSON.stringify({
        type: "connected",
        clientId: "c-1",
        pendingCount: 0,
      }),
    });
    await flush(20);
    assert.equal(dom.status.classList.contains("is-connected"), true);
    assert.equal(dom.status.classList.contains("is-connecting"), false);
    assert.equal(dom.status.classList.contains("is-disconnected"), false);

    // 2. Physical disconnect transitions indicator to red (disconnected).
    timeoutFns.length = 0;
    timeoutCalls.length = 0;
    firstEs.onerror?.();
    await flush(10);
    assert.equal(dom.status.classList.contains("is-disconnected"), true);
    assert.equal(dom.status.classList.contains("is-connecting"), false);

    // 3. Reconnect timer fires -> SyncHub redials -> indicator turns yellow (connecting).
    const retryIdx = timeoutCalls.indexOf(RECONNECT_DELAY_MS);
    assert.ok(retryIdx >= 0, "reconnect backoff timer must be scheduled");
    timeoutFns[retryIdx]();
    await flush(20);
    assert.equal(
      dom.status.classList.contains("is-connecting"),
      true,
      "indicator must enter connecting (yellow) state while redialing",
    );
    assert.equal(dom.status.classList.contains("is-disconnected"), false);
    assert.equal(dom.status.classList.contains("is-connected"), false);

    // 4. Second EventSource completes handshake -> indicator turns green (connected).
    const secondEs = MockEventSource.instances[1];
    assert.ok(secondEs, "second EventSource must be opened on retry");
    secondEs.onmessage?.({
      data: JSON.stringify({
        type: "connected",
        clientId: "c-2",
        pendingCount: 0,
      }),
    });
    await flush(20);
    assert.equal(dom.status.classList.contains("is-connected"), true);
    assert.equal(dom.status.classList.contains("is-connecting"), false);
  });
});
