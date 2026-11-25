import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { ESLint } from "eslint";
import {
  sendSyncRequest,
  SyncFeedConsumer,
  SyncOutbox,
  type SyncFeedEntry,
  type SyncFeedTransport,
  type SyncFeedProtocolError,
} from "../src/shared/sync/index.ts";

class FakeTimer {
  private nextId = 1;
  private readonly callbacks = new Map<number, () => void>();
  readonly api = {
    setTimeout: (callback: () => void) => {
      const id = this.nextId++;
      this.callbacks.set(id, callback);
      return id;
    },
    clearTimeout: (id: unknown) => {
      this.callbacks.delete(id as number);
    },
  };

  fire(id?: number): void {
    const selected = id ?? this.callbacks.keys().next().value;
    if (selected === undefined) throw new Error("no scheduled timer");
    const callback = this.callbacks.get(selected);
    this.callbacks.delete(selected);
    callback?.();
  }
}

describe("shared/sync", () => {
  it("classifies requests and bounds a transport that ignores abort", async () => {
    const timer = new FakeTimer();
    const sends = [
      { status: 202, body: { accepted: true } },
      { status: 409, body: { error: "conflict" } },
      { status: 503, body: null },
    ];
    for (const response of sends) {
      const result = await sendSyncRequest({
        operationId: "op",
        request: {},
        timeoutMs: 10,
        timer: timer.api,
        transport: { send: async () => response },
      });
      assert.equal(
        result.kind,
        response.status === 202
          ? "success"
          : response.status === 409
            ? "rejected"
            : "unknown",
      );
    }

    const pending = sendSyncRequest({
      operationId: "late",
      request: {},
      timeoutMs: 10,
      timer: timer.api,
      transport: { send: () => new Promise(() => undefined) },
    });
    timer.fire();
    assert.equal((await pending).kind, "unknown");
  });

  it("fills feed gaps, ignores overlap, and serializes persistent apply", async () => {
    let applied = 5;
    let watch: Parameters<SyncFeedTransport["watch"]>[0] | undefined;
    const writes: number[] = [];
    const consumer = new SyncFeedConsumer({
      port: {
        applied: () => applied,
        apply: async (entry, expected) => {
          assert.equal(expected, applied);
          writes.push(entry.pos);
          await Promise.resolve();
          if (applied !== expected) return false;
          applied = entry.pos;
          return true;
        },
      },
      transport: {
        read: async (after) => {
          assert.equal(after, 7);
          return [{ pos: 8, prev: 7, data: "fill" }];
        },
        watch: async (input) => {
          watch = input;
          input.connected();
          await new Promise(() => undefined);
        },
      },
      retryDelay: () => 0,
    });
    consumer.start();
    await waitUntil(() => watch !== undefined);

    await watchEntry(watch, { pos: 7, prev: 5, data: "live" });
    await watchEntry(watch, { pos: 7, prev: 5, data: "overlap" });
    await watchEntry(watch, { pos: 9, prev: 8, data: "gap" });
    assert.deepEqual(writes, [7, 8, 9]);
    consumer.stop();
  });

  it("invalidates old feed frames and stops only the protocol-failed link", async () => {
    const timers = {
      now: () => 0,
      setTimeout: () => 1,
      clearTimeout: () => {},
      setInterval: () => 2,
      clearInterval: () => {},
    };
    const callbacks: Array<(entry: SyncFeedEntry) => Promise<void> | void> = [];
    let applied = 0;
    let attempts = 0;
    const protocolErrors: SyncFeedProtocolError[] = [];
    const consumer = new SyncFeedConsumer({
      port: {
        applied: () => applied,
        apply: (entry) => {
          applied = entry.pos;
          return true;
        },
      },
      transport: {
        read: async () => [],
        watch: async (input) => {
          callbacks.push((entry) => input.entry(entry));
          input.connected();
          attempts += 1;
          await new Promise(() => undefined);
        },
      },
      retryDelay: () => 1,
      onProtocolError: (error) => {
        protocolErrors.push(error);
      },
      clock: timers,
    });
    consumer.start();
    await waitUntil(() => callbacks.length === 1);
    consumer.start();
    await waitUntil(() => callbacks.length === 2);
    const stale = callbacks[0];
    const current = callbacks[1];
    assert.ok(stale);
    assert.ok(current);
    await stale({ pos: 1, prev: 0, data: "stale" });
    assert.equal(applied, 0);

    await current({ pos: 2, prev: 1, data: "gap" });
    assert.equal(protocolErrors.length, 1);
    assert.match(protocolErrors[0].message, /gap/);
    assert.equal(attempts, 2);
    consumer.stop();
  });

  it("outbox releases a next entry when a receipt overtakes a held request", async () => {
    const timer = new FakeTimer();
    const queue = [
      { id: "one", request: { body: "one" } },
      { id: "two", request: { body: "two" } },
    ];
    let resolveFirst: (() => void) | undefined;
    const finished: string[] = [];
    const sent: string[] = [];
    const outbox = new SyncOutbox({
      port: {
        next: () => queue[0],
        finish: (entry) => {
          finished.push(entry.id);
          queue.shift();
          return true;
        },
      },
      transport: {
        send: (operationId) => {
          sent.push(operationId);
          if (operationId === "one") {
            return new Promise((resolveTransport) => {
              resolveFirst = () => {
                resolveTransport({ status: 409, body: null });
              };
            });
          }
          return Promise.resolve({ status: 202, body: null });
        },
      },
      timer: timer.api,
      timeoutMs: 10,
      retryDelay: () => 0,
    });
    outbox.start();
    await waitUntil(() => sent.length === 1);
    queue.shift();
    outbox.handedOff("one");
    await waitUntil(() => sent.length === 2);
    assert.deepEqual(sent, ["one", "two"]);
    resolveFirst?.();
    await waitUntil(() => finished.includes("two"));
    assert.equal(finished.includes("one"), false);
    outbox.stop();
  });

  it("enforces the shared/sync dependency boundary in lint", async () => {
    const eslint = new ESLint({ cwd: resolve(".") });
    const [result] = await eslint.lintText(
      'import { Store } from "../../store.ts";\nexport const store = Store;\n',
      { filePath: resolve("src/shared/sync/request.ts") },
    );
    assert.ok(result);
    assert.ok(
      result.messages.some(
        (message) =>
          message.ruleId === "no-restricted-imports" &&
          /platform-neutral/.test(message.message),
      ),
    );
  });
});

async function watchEntry(
  watch: Parameters<SyncFeedTransport["watch"]>[0] | undefined,
  entry: SyncFeedEntry,
): Promise<void> {
  assert.ok(watch);
  await watch.entry(entry);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 0));
  }
}
