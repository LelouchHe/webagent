import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { ESLint } from "eslint";
import {
  sendSyncRequest,
  SyncFeedConsumer,
  SyncFeedProtocolError,
  SyncFeedTerminalError,
  SyncOutbox,
  type SyncFeedEntry,
  type SyncFeedTransport,
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
        opId: "op",
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

    // opId: null must never retry unknown even when retries > 0.
    let nullAttempts = 0;
    const nullResult = await sendSyncRequest({
      opId: null,
      request: {},
      timeoutMs: 10,
      retries: 3,
      timer: clock.api,
      transport: {
        send: async () => {
          nullAttempts += 1;
          return { status: 503, body: null };
        },
      },
    });
    assert.equal(nullResult.kind, "unknown");
    assert.equal(nullAttempts, 1);

    let signal: AbortSignal | undefined;
    const pending = sendSyncRequest({
      opId: "late",
      request: {},
      timeoutMs: 10,
      timer: clock.api,
      transport: {
        send: (_id, _request, requestSignal) => {
          signal = requestSignal;
          return new Promise<{ status: number; body: unknown }>(
            () => undefined,
          );
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

  it("does not apply an old live frame after an async applied lookup", async () => {
    const watches: Array<Parameters<SyncFeedTransport<number>["watch"]>[0]> =
      [];
    let releaseApplied: ((value: number) => void) | undefined;
    let appliedCalls = 0;
    const committed: number[] = [];
    const consumer = new SyncFeedConsumer<number>({
      port: {
        applied: () => {
          appliedCalls += 1;
          if (appliedCalls !== 2) return 0;
          return new Promise<number>((resolveApplied) => {
            releaseApplied = resolveApplied;
          });
        },
        apply: (entry) => {
          committed.push(entry.pos);
          return true;
        },
      },
      transport: {
        read: async () => [],
        watch: async (input) => {
          watches.push(input);
          input.connected();
          await new Promise(() => undefined);
        },
      },
      retryDelay: () => 0,
    });
    consumer.start();
    await waitUntil(() => watches.length === 1);
    const staleFrame = watches[0].entry({ pos: 9, prev: 0, data: 9 });
    await waitUntil(() => releaseApplied !== undefined);
    consumer.start();
    await waitUntil(() => watches.length === 2);
    releaseApplied?.(0);
    await staleFrame;
    assert.deepEqual(committed, []);
    await watches[1].entry({ pos: 1, prev: 0, data: 1 });
    assert.deepEqual(committed, [1]);
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
    const secondSignal = second.signal;
    one.stop();
    two.stop();
    assert.equal(secondSignal.aborted, true);
    clock.advance(100_000);
    assert.equal(attempts.two, 1);
  });

  it("invalidates old feed frames and reports a protocol error only on that link", async () => {
    const clock = new FakeClock();
    const callbacks: Array<
      (entry: SyncFeedEntry<number>) => Promise<void> | void
    > = [];
    const signals: AbortSignal[] = [];
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
          signals.push(input.signal);
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
    assert.equal(signals[1].aborted, true);
    const otherApplied: number[] = [];
    let otherWatch:
      Parameters<SyncFeedTransport<number>["watch"]>[0] | undefined;
    const other = new SyncFeedConsumer<number>({
      port: {
        applied: () => 0,
        apply: (entry) => {
          otherApplied.push(entry.pos);
          return true;
        },
      },
      transport: {
        read: async () => [],
        watch: async (input) => {
          otherWatch = input;
          input.connected();
          await new Promise(() => undefined);
        },
      },
      retryDelay: () => 0,
      clock: clock.api,
    });
    other.start();
    await waitUntil(() => otherWatch !== undefined);
    assert.ok(otherWatch);
    await otherWatch.entry({ pos: 1, prev: 0, data: 1 });
    assert.deepEqual(otherApplied, [1]);
    assert.equal(otherWatch.signal.aborted, false);
    other.stop();
    consumer.stop();
  });

  it("does not let a stale async apply stop the new generation", async () => {
    const clock = new FakeClock();
    const watches: Array<Parameters<SyncFeedTransport<number>["watch"]>[0]> =
      [];
    let rejectOld: ((error: Error) => void) | undefined;
    let newConnected = false;
    const consumer = new SyncFeedConsumer<number>({
      port: {
        applied: () => 0,
        apply: () => {
          if (!rejectOld) {
            return new Promise<boolean>((_resolve, reject) => {
              rejectOld = reject;
            });
          }
          return true;
        },
      },
      transport: {
        read: async () => [],
        watch: async (input) => {
          watches.push(input);
          input.connected();
          if (watches.length === 2) newConnected = true;
          await new Promise(() => undefined);
        },
      },
      retryDelay: () => 0,
      clock: clock.api,
    });
    consumer.start();
    await waitUntil(() => watches.length === 1);
    const oldApply = watches[0].entry({ pos: 1, prev: 0, data: 1 });
    await waitUntil(() => rejectOld !== undefined);
    consumer.start();
    await waitUntil(() => watches.length === 2);
    rejectOld?.(new SyncFeedProtocolError("stale"));
    await oldApply;
    assert.equal(newConnected, true);
    await watches[1].entry({ pos: 1, prev: 0, data: 1 });
    assert.equal(watches[1].signal.aborted, false);
    consumer.stop();
  });

  it("keeps an active retry on wake and clears it on hand-off or stop", async () => {
    for (const ordering of ["wake", "handedOff", "stop"] as const) {
      const clock = new FakeClock();
      const sent: string[] = [];
      let head:
        | { id: string; position: number; request: { body: string } }
        | undefined = {
        id: "one",
        position: 1,
        request: { body: "one" },
      };
      const outbox = new SyncOutbox<{ body: string }>({
        port: {
          next: () => head,
          finish: () => false,
        },
        transport: {
          send: async (operationId) => {
            sent.push(operationId!);
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
      if (ordering === "handedOff") {
        head = { id: "two", position: 2, request: { body: "two" } };
        outbox.handedOff("one");
        assert.equal(clock.size(), 0);
      }
      if (ordering === "stop") outbox.stop();
      clock.advance(100);
      await Promise.resolve();
      await waitUntil(() => ordering !== "handedOff" || sent.includes("two"));
      assert.deepEqual(
        sent,
        ordering === "wake"
          ? ["one", "one"]
          : ordering === "handedOff"
            ? ["one", "two"]
            : ["one"],
      );
      if (ordering === "handedOff") outbox.stop();
      if (ordering === "stop") assert.equal(clock.size(), 0);
    }
  });

  it("ignores both late 202 and late 4xx after a receipt hands off the head", async () => {
    for (const lateStatus of [202, 409]) {
      const clock = new FakeClock();
      const queue = [
        { id: "one", position: 1, request: { body: "one" } },
        { id: "two", position: 2, request: { body: "two" } },
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
            sent.push(operationId!);
            return new Promise((resolveTransport) => {
              resolvers.set(operationId!, resolveTransport);
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

  it("resumes after the persisted push cursor and safely replays a reset cursor", async () => {
    const clock = new FakeClock();
    let pushedPos = 5;
    const rows = [
      { id: "five", position: 5, request: { body: "five" } },
      { id: "six", position: 6, request: { body: "six" } },
    ];
    const sent: string[] = [];
    const accepted = new Set<string>(["five"]);
    const makeOutbox = () =>
      new SyncOutbox<{ body: string }>({
        port: {
          next: () => rows.find((row) => row.position > pushedPos),
          finish: (entry, result) => {
            if (result.kind === "success" && result.status === 202) {
              pushedPos = Math.max(pushedPos, entry.position);
              accepted.add(entry.id);
              return true;
            }
            return false;
          },
        },
        transport: {
          send: async (operationId) => {
            sent.push(operationId!);
            return {
              status: 202,
              body: { duplicate: accepted.has(operationId!) },
            };
          },
        },
        timer: clock.api,
        timeoutMs: 10_000,
        retryDelay: () => 0,
      });

    const first = makeOutbox();
    first.start();
    await waitUntil(() => pushedPos === 6);
    first.stop();
    const resumed = makeOutbox();
    resumed.start();
    await Promise.resolve();
    assert.deepEqual(sent, ["six"]);
    resumed.stop();

    pushedPos = 0;
    const replay = makeOutbox();
    replay.start();
    await waitUntil(() => sent.includes("five") && pushedPos === 6);
    assert.deepEqual(accepted, new Set(["five", "six"]));
    replay.stop();
  });

  it("does not advance the push cursor on a credential failure", async () => {
    const clock = new FakeClock();
    let pushedPos = 0;
    const entry = {
      id: "credential-check",
      position: 7,
      request: { body: "work" },
    };
    const outbox = new SyncOutbox<{ body: string }>({
      port: {
        next: () => (pushedPos < entry.position ? entry : undefined),
        finish: (_entry, result) => {
          if (result.kind === "rejected" && result.status === 401) return false;
          if (result.kind === "success") pushedPos = entry.position;
          return true;
        },
      },
      transport: {
        send: async () => ({ status: 401, body: { error: "credential" } }),
      },
      timer: clock.api,
      timeoutMs: 1_000,
      retryDelay: () => 100,
    });
    outbox.start();
    await waitUntil(() => clock.size() > 0);
    assert.equal(pushedPos, 0);
    outbox.stop();
    assert.equal(clock.size(), 0);
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

  it("handles 409 op_aborted, unknown->4xx, malformed 2xx, 5xx diagnostic retention, backoff+beforeSend, and external signal", async () => {
    const clock = new FakeClock();

    // 409 op_aborted terminates immediately as unknown without retrying.
    let abortedAttempts = 0;
    const aborted = await sendSyncRequest({
      opId: "op-aborted",
      request: {},
      timeoutMs: 100,
      retries: 2,
      timer: clock.api,
      transport: {
        send: async () => {
          abortedAttempts += 1;
          return {
            status: 409,
            body: { code: "op_aborted", error: "orphaned op" },
          };
        },
      },
    });
    assert.equal(aborted.kind, "unknown");
    assert.equal(abortedAttempts, 1);
    assert.equal(aborted.status, 409);

    // unknown -> 4xx stays unknown and stops retries.
    let u2rAttempts = 0;
    const u2r = await sendSyncRequest<
      object,
      { error: string; agentId?: string }
    >({
      opId: "op-u2r",
      request: {},
      timeoutMs: 100,
      retries: 2,
      timer: clock.api,
      transport: {
        send: async () => {
          u2rAttempts += 1;
          if (u2rAttempts === 1) {
            return {
              status: 503,
              body: { error: "agent down", agentId: "copilot" },
            };
          }
          return { status: 404, body: { error: "not found" } };
        },
      },
    });
    assert.equal(u2r.kind, "unknown");
    assert.equal(u2rAttempts, 2);

    // 5xx diagnostic body preserved when subsequent retry hits transport failure.
    let diagAttempts = 0;
    const diag = await sendSyncRequest({
      opId: "op-diag",
      request: {},
      timeoutMs: 100,
      retries: 1,
      timer: clock.api,
      transport: {
        send: async () => {
          diagAttempts += 1;
          if (diagAttempts === 1) {
            return {
              status: 503,
              body: { error: "spawn failed", agentId: "claude" },
            };
          }
          throw new Error("socket closed");
        },
      },
    });
    assert.equal(diag.kind, "unknown");
    assert.equal(diag.status, 503);
    assert.deepEqual(diag.body, { error: "spawn failed", agentId: "claude" });

    // Malformed non-204 2xx is unknown; 204 empty is success.
    const malformed = await sendSyncRequest({
      opId: null,
      request: {},
      timeoutMs: 100,
      timer: clock.api,
      transport: {
        send: async () => ({ status: 201, body: null, bodyMalformed: true }),
      },
    });
    assert.equal(malformed.kind, "unknown");
    const empty204 = await sendSyncRequest({
      opId: null,
      request: {},
      timeoutMs: 100,
      timer: clock.api,
      transport: {
        send: async () => ({ status: 204, body: null, bodyMalformed: true }),
      },
    });
    assert.equal(empty204.kind, "success");

    // beforeSend(0) false -> skipped; throw -> propagates.
    const skipped = await sendSyncRequest({
      opId: "op-skip",
      request: {},
      timeoutMs: 100,
      timer: clock.api,
      beforeSend: () => false,
      transport: {
        send: async () => {
          throw new Error("should not send");
        },
      },
    });
    assert.deepEqual(skipped, { kind: "skipped" });

    await assert.rejects(
      sendSyncRequest({
        opId: "op-throw0",
        request: {},
        timeoutMs: 100,
        timer: clock.api,
        beforeSend: () => {
          throw new Error("fence boom");
        },
        transport: {
          send: async () => ({ status: 200, body: {} }),
        },
      }),
      /fence boom/,
    );

    // Retry beforeSend runs AFTER backoff; false returns previous unknown.
    const events: string[] = [];
    const fencedPending = sendSyncRequest({
      opId: "op-fence-retry",
      request: {},
      timeoutMs: 10_000,
      retries: 2,
      backoffMs: [250],
      timer: clock.api,
      beforeSend: (attempt) => {
        events.push(`before:${attempt}`);
        return attempt === 0;
      },
      transport: {
        send: async () => {
          events.push("send");
          return { status: 503, body: { error: "busy" } };
        },
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(events, ["before:0", "send"]);
    clock.advance(250);
    const fencedResult = await fencedPending;
    assert.equal(fencedResult.kind, "unknown");
    assert.equal(fencedResult.status, 503);
    assert.deepEqual(events, ["before:0", "send", "before:1"]);

    // External AbortSignal cancels backoff wait immediately.
    const ac = new AbortController();
    const cancelPending = sendSyncRequest({
      opId: "op-cancel",
      request: {},
      timeoutMs: 10_000,
      retries: 2,
      backoffMs: [1_000],
      signal: ac.signal,
      timer: clock.api,
      transport: {
        send: async () => ({ status: 503, body: null }),
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(clock.size(), 1);
    ac.abort(new Error("navigated"));
    const cancelResult = await cancelPending;
    assert.equal(cancelResult.kind, "unknown");
    assert.equal(clock.size(), 0);
  });

  it("SyncFeedConsumer serializes ephemeral frames, supports catchUpOnConnect/catchUp, external liveness, and terminal 404", async () => {
    const clock = new FakeClock();
    let applied = 0;
    const order: string[] = [];
    let watch:
      Parameters<SyncFeedTransport<string, string>["watch"]>[0] | undefined;
    let releaseRead: ((entries: SyncFeedEntry<string>[]) => void) | undefined;
    const terminalErrors: SyncFeedTerminalError[] = [];

    const consumer = new SyncFeedConsumer<string, string>({
      liveness: "external",
      catchUpOnConnect: true,
      clock: clock.api,
      retryDelay: () => 100,
      onTerminalError: (err) => terminalErrors.push(err),
      port: {
        applied: () => applied,
        apply: (entry) => {
          applied = entry.pos;
          order.push(`entry:${entry.pos}`);
          return true;
        },
        applyEphemeral: (data) => {
          order.push(`eph:${data}`);
        },
        beforeCatchUp: async () => ({
          targetPos: 2,
          commit: () => {
            order.push("commit");
          },
        }),
      },
      transport: {
        read: (after) =>
          new Promise<SyncFeedEntry<string>[]>((resolveRead) => {
            if (after === 0) {
              releaseRead = resolveRead;
            } else {
              resolveRead([]);
            }
          }),
        watch: async (input) => {
          watch = input;
          input.connected();
          await new Promise<void>((_resolve, reject) => {
            input.signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          });
        },
      },
    });

    consumer.start();
    await waitUntil(() => releaseRead !== undefined && watch !== undefined);
    // Queue an ephemeral frame while catchUp read is in flight: must NOT run ahead of catchUp!
    const ephPromise = watch!.ephemeral?.("chunk-1");
    assert.deepEqual(order, []);

    // External liveness mode must NOT self-stall even after 120s of silence.
    clock.advance(120_000);
    assert.equal(watch!.signal.aborted, false);

    releaseRead!([
      { pos: 1, prev: 0, data: "a" },
      { pos: 2, prev: 1, data: "b" },
    ]);
    await ephPromise;
    assert.deepEqual(order, ["entry:1", "entry:2", "commit", "eph:chunk-1"]);

    // Terminal error (404) stops consumer without retry.
    const consumer404 = new SyncFeedConsumer<string, string>({
      liveness: "external",
      catchUpOnConnect: true,
      clock: clock.api,
      retryDelay: () => 100,
      onTerminalError: (err) => terminalErrors.push(err),
      port: {
        applied: () => 0,
        apply: () => true,
        beforeCatchUp: async () => {
          throw new SyncFeedTerminalError("gone", 404);
        },
      },
      transport: {
        read: async () => [],
        watch: async (input) => {
          input.connected();
          await new Promise<void>((_resolve, reject) => {
            input.signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          });
        },
      },
    });
    consumer404.start();
    await waitUntil(() => terminalErrors.length === 1);
    assert.equal(terminalErrors[0].status, 404);
    consumer.stop();
  });

  it("SyncFeedConsumer passes upTo only on bounded catchUp and leaves subsequent live gap reads uncapped (F1)", async () => {
    let applied = 0;
    const readCalls: Array<{ after: number; upTo?: number }> = [];
    const appliedPositions: number[] = [];
    let watch:
      Parameters<SyncFeedTransport<string, string>["watch"]>[0] | undefined;

    const consumer = new SyncFeedConsumer<string, string>({
      liveness: "external",
      catchUpOnConnect: true,
      retryDelay: () => 50,
      port: {
        applied: () => applied,
        apply: (entry) => {
          applied = entry.pos;
          appliedPositions.push(entry.pos);
          return true;
        },
        beforeCatchUp: async () => ({ targetPos: 2 }),
      },
      transport: {
        read: async (after, _signal, opts) => {
          readCalls.push({ after, upTo: opts?.upTo });
          if (after === 0) {
            return [
              { pos: 1, prev: 0, data: "one" },
              { pos: 2, prev: 1, data: "two" },
            ];
          }
          if (after === 2) {
            // If a stale upTo=2 were passed, this would return [] and break!
            if (opts?.upTo !== undefined && opts.upTo <= 2) return [];
            return [{ pos: 3, prev: 2, data: "three" }];
          }
          return [];
        },
        watch: async (input) => {
          watch = input;
          input.connected();
          await new Promise<void>((_r, reject) => {
            input.signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          });
        },
      },
    });

    consumer.start();
    await waitUntil(() => applied === 2 && watch !== undefined);
    assert.deepEqual(readCalls, [{ after: 0, upTo: 2 }]);

    // Drop live row 3 and deliver row 4 (prev: 3 !== applied: 2) -> uncapped gap read repairs 3 and applies 4.
    await watch!.entry({ pos: 4, prev: 3, data: "four" });
    assert.deepEqual(readCalls, [
      { after: 0, upTo: 2 },
      { after: 2, upTo: undefined },
    ]);
    assert.deepEqual(appliedPositions, [1, 2, 3, 4]);
    consumer.stop();
  });

  it("SyncFeedConsumer raises protocol error instead of looping if apply returns true without advancing applied (R1)", async () => {
    const errors: SyncFeedProtocolError[] = [];
    let readCount = 0;
    const consumer = new SyncFeedConsumer<string, string>({
      liveness: "external",
      catchUpOnConnect: true,
      retryDelay: () => 50,
      onProtocolError: (err) => errors.push(err),
      port: {
        applied: () => 0,
        apply: () => true, // Buggy port: claims success without advancing applied!
        beforeCatchUp: async () => ({ targetPos: 1 }),
      },
      transport: {
        read: async () => {
          readCount += 1;
          return [{ pos: 1, prev: 0, data: "stuck" }];
        },
        watch: async (input) => {
          input.connected();
          await new Promise<void>((_r, reject) => {
            input.signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          });
        },
      },
    });
    consumer.start();
    await waitUntil(() => errors.length === 1);
    assert.equal(readCount, 1);
    assert.match(errors[0].message, /without advancing applied/);
    consumer.stop();
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
