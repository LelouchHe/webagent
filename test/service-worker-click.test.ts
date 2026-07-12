import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

describe("service worker notification click routing", () => {
  let notificationClick: (event: {
    notification: {
      data: Record<string, string>;
      tag: string;
      close(): void;
    };
    waitUntil(promise: Promise<unknown>): void;
  }) => void;
  let clients: Array<{
    url: string;
    focus(): Promise<void>;
    postMessage(message: unknown): void;
  }>;
  let openedUrls: string[];
  let postedMessages: unknown[];

  before(async () => {
    clients = [];
    openedUrls = [];
    postedMessages = [];
    const listeners = new Map<string, (event: never) => void>();
    Object.defineProperty(globalThis, "self", {
      configurable: true,
      value: {
        location: { origin: "https://agent.example" },
        registration: {
          getNotifications: async () => [],
          showNotification: async () => {},
        },
        clients: {
          claim: async () => {},
          matchAll: async () => clients,
          openWindow: async (url: string) => {
            openedUrls.push(url);
          },
        },
        skipWaiting: async () => {},
        addEventListener(type: string, listener: (event: never) => void) {
          listeners.set(type, listener);
        },
      },
    });
    await import(`../public/sw.js?test=${Date.now()}`);
    notificationClick = listeners.get("notificationclick")! as never;
  });

  after(() => {
    Reflect.deleteProperty(globalThis, "self");
  });

  async function click(data: Record<string, string>): Promise<void> {
    const pending: Promise<unknown>[] = [];
    notificationClick({
      notification: {
        data,
        tag: "tag",
        close() {},
      },
      waitUntil(promise) {
        pending.push(promise);
      },
    });
    assert.equal(pending.length, 1);
    await pending[0];
  }

  it("opens a session hash when a session notification has no window", async () => {
    clients.length = 0;
    openedUrls.length = 0;

    await click({ sessionId: "s1" });

    assert.deepEqual(openedUrls, ["/#s1"]);
  });

  it("opens a message intent when an Inbox notification has no window", async () => {
    clients.length = 0;
    openedUrls.length = 0;

    await click({ messageId: "msg-123" });

    assert.deepEqual(openedUrls, ["/?message=msg-123"]);
  });

  it("posts the unresolved message target to an existing window", async () => {
    openedUrls.length = 0;
    postedMessages.length = 0;
    clients.splice(0, clients.length, {
      url: "https://agent.example/#current",
      async focus() {},
      postMessage(message) {
        postedMessages.push(message);
      },
    });

    await click({ messageId: "msg-123" });

    assert.deepEqual(openedUrls, []);
    assert.deepEqual(postedMessages, [
      { type: "navigate", messageId: "msg-123" },
    ]);
  });
});
