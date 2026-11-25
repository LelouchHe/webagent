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

class FakeClock {
  private time = 0;
  private nextId = 1;
  private readonly timeouts = new Map<
    number,
    { at: number; callback: () => void; interval?: number }
  >();

  readonly api = {
    now: () => this.time,
    setTimeout: (callback: () => void, milliseconds: number) => {
      const id = this.nextId++;
      this.timeouts.set(id, { at: this.time + milliseconds, callback });
      return id;
    },
    clearTimeout: (handle: unknown) => {
      this.timeouts.delete(handle as number);
    },
    setInterval: (callback: () => void, milliseconds: number) => {
      const id = this.nextId++;
      this.timeouts.set(id, {
        at: this.time + milliseconds,
        callback,
        interval: milliseconds,
      });
      return id;
    },
    clearInterval: (handle: unknown) => {
      this.timeouts.delete(handle as number);
    },
  };

  advance(milliseconds: number): void {
    const end = this.time + milliseconds;
    for (;;) {
      const next = [...this.timeouts]
        .sort(([, left], [, right]) => left.at - right.at)
        .at(0);
      if (!next || next[1].at > end) break;
      this.time = next[1].at;
      const [id, timer] = next;
      if (timer.interval === undefined) {
        this.timeouts.delete(id);
      } else {
        timer.at += timer.interval;
      }
      timer.callback();
    }
    this.time = end;
  }

  size(): number {
    return this.timeouts.size;
  }
}

describe("shared/sync", () => {
  it("classifies requests and times out a transport that ignores abort", async () => {
    const clock = new FakeClock();
    const responses = [
      { status: 202, body: { accepted: true } },
      { status: 409, body: { error: "conflict" } },
      { status: 503, body: null },
    ] as const;
    for (const response of responses) {
      const result = await sendSyncRequest<object, unknown>({
        operationId: "op",
        request: {},
        timeoutMs: 10,
        timer: clock.api,
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

    let signal: AbortSignal | undefined;
    const pending = sendSyncRequest({
      operationId: "late",
      request: {},
      timeoutMs: 10,
      timer: clock.api,
      transport: {
        send: (_id, _request, requestSignal) => {
          signal = requestSignal;
          return new Promise(() => undefined);
        },
      },
    });
    clock.advance(10);
    assert.equal(signal?.aborted, true);
    assert.equal((await pending).kind, "unknown");
  });

  it("fills multiple feed pages, ignores overlap, and serializes arrivals", async () => {
    let applied = 5;
    let activeApplies = 0;
    let watch: Parameters<SyncFeedTransport<number>["watch"]>[0] | undefined;
    const writes: number[] = [];
    const reads: number[] = [];
    const consumer = new SyncFeedConsumer<number>({
      port: {
        applied: () => applied,
        apply: async (entry, expected) => {
          assert.equal(expected, applied);
          activeApplies += 1;
          assert.equal(activeApplies, 1);
          writes.push(entry.pos);
          await Promise.resolve();
          applied = entry.pos;
          activeApplies -= 1;
          return true;
        },
      },
      transport: {
        read: async (after) => {
          reads.push(after);
          if (after === 5) {
            return [
              { pos: 7, prev: 5, data: 7 },
              { pos: 8, prev: 7, data: 8 },
            ];
          }
          if (after === 8) {
            return [
              { pos: 9, prev: 8, data: 9 },
              { pos: 10, prev: 9, data: 10 },
            ];
          }
          if (after === 10) {
            return [{ pos: 11, prev: 10, data: 11 }];
          }
          return [];
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

    const first = watchEntry(watch, { pos: 12, prev: 11, data: 12 });
    const overlap = watchEntry(watch, { pos: 7, prev: 5, data: 7 });
    await Promise.all([first, overlap]);
    assert.deepEqual(reads, [5, 8, 10]);
    assert.deepEqual(writes, [7, 8, 9, 10, 11, 12]);
    consumer.stop();
  });

  it("treats heartbeats as activity without reconnecting another link", async () => {
    const clock = new FakeClock();
    const attempts = { one: 0, two: 0 };
    let first: Parameters<SyncFeedTransport<number>["watch"]>[0] | undefined;
    let second: Parameters<SyncFeedTransport<number>["watch"]>[0] | undefined;
    const consumer = (
      name: "one" | "two",
      capture: (input: NonNullable<typeof first>) => void,
    ) =>
      new SyncFeedConsumer<number>({
        port: {
          applied: () => 0,
          apply: () => true,
        },
        transport: {
          read: async () => [],
          watch: async (input) => {
            attempts[name] += 1;
            capture(input);
            input.connected();
            await new Promise<void>((_resolve, reject) => {
              input.signal.addEventListener(
                "abort",
                () => {
                  reject(new Error("aborted"));
                },
                {
                  once: true,
                },
              );
            });
          },
        },
        retryDelay: () => 100,
        clock: clock.api,
      });
    const one = consumer("one", (input) => {
      first = input;
    });
    const two = consumer("two", (input) => {
      second = input;
    });
    one.start();
    two.start();
    await waitUntil(() => first !== undefined && second !== undefined);
    assert.ok(second);
    clock.advance(40_000);
    second.activity();
    clock.advance(5_100);
    await waitUntil(() => attempts.one === 2);
    assert.equal(attempts.one, 2);
    assert.equal(attempts.two, 1);
    one.stop();
    two.stop();
  });

  it("invalidates old feed frames and reports a protocol error only on that link", async () => {
    const clock = new FakeClock();
    const callbacks: Array<
      (entry: SyncFeedEntry<number>) => Promise<void> | void
    > = [];
    let applied = 0;
    let attempts = 0;
    const protocolErrors: SyncFeedProtocolError[] = [];
    const consumer = new SyncFeedConsumer<number>({
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
      onProtocolError: (error) => protocolErrors.push(error),
      clock: clock.api,
    });
    consumer.start();
    await waitUntil(() => callbacks.length === 1);
    consumer.start();
    await waitUntil(() => callbacks.length === 2);
    const stale = callbacks[0];
    const current = callbacks[1];
    assert.ok(stale);
    assert.ok(current);
    await stale({ pos: 1, prev: 0, data: 1 });
    assert.equal(applied, 0);
    await current({ pos: 2, prev: 1, data: 2 });
    assert.equal(protocolErrors.length, 1);
    assert.match(protocolErrors[0].message, /gap/);
    assert.equal(attempts, 2);
    consumer.stop();
  });

  it("keeps an active retry on wake and clears it on hand-off or stop", async () => {
    for (const ordering of ["wake", "handedOff", "stop"] as const) {
      const clock = new FakeClock();
      const sent: string[] = [];
      const outbox = new SyncOutbox<{ body: string }>({
        port: {
          next: () => ({ id: "one", request: { body: "one" } }),
          finish: () => false,
        },
        transport: {
          send: async (operationId) => {
            sent.push(operationId);
            return { status: 503, body: null };
          },
        },
        timer: clock.api,
        timeoutMs: 10_000,
        retryDelay: () => 100,
      });
      outbox.start();
      await waitUntil(() => sent.length === 1 && clock.size() > 0);
      if (ordering === "wake") outbox.wake();
      if (ordering === "handedOff") outbox.handedOff("one");
      if (ordering === "stop") outbox.stop();
      clock.advance(100);
      assert.equal(sent.length, ordering === "wake" ? 2 : 1);
    }
  });

  it("ignores both late 202 and late 4xx after a receipt hands off the head", async () => {
    for (const lateStatus of [202, 409]) {
      const clock = new FakeClock();
      const queue = [
        { id: "one", request: { body: "one" } },
        { id: "two", request: { body: "two" } },
      ];
      const resolvers = new Map<
        string,
        (response: { status: number; body: unknown }) => void
      >();
      const finished: string[] = [];
      const sent: string[] = [];
      const outbox = new SyncOutbox<{ body: string }>({
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
            return new Promise((resolveTransport) => {
              resolvers.set(operationId, resolveTransport);
            });
          },
        },
        timer: clock.api,
        timeoutMs: 10_000,
        retryDelay: () => 0,
      });
      outbox.start();
      await waitUntil(() => sent.length === 1);
      queue.shift();
      outbox.handedOff("one");
      await waitUntil(() => sent.length === 2);
      resolvers.get("one")?.({ status: lateStatus, body: null });
      await Promise.resolve();
      assert.equal(finished.length, 0);
      resolvers.get("two")?.({ status: 202, body: { accepted: true } });
      await waitUntil(() => finished.includes("two"));
      assert.equal(finished.includes("one"), false);
      outbox.stop();
    }
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

async function watchEntry<T>(
  watch: Parameters<SyncFeedTransport<T>["watch"]>[0] | undefined,
  entry: SyncFeedEntry<T>,
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
