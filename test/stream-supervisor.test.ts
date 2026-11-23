import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  StreamSupervisor,
  type StreamAttempt,
} from "../src/shared/stream-supervisor.ts";

type Scheduled = { callback: () => void; at: number; interval?: number };

class FakeTimers {
  private now = 0;
  private nextId = 1;
  private readonly timeouts = new Map<number, Scheduled>();
  private readonly intervals = new Map<number, Scheduled>();

  readonly api = {
    setTimeout: (callback: () => void, milliseconds: number) => {
      const id = this.nextId++;
      this.timeouts.set(id, { callback, at: this.now + milliseconds });
      return id;
    },
    clearTimeout: (handle: unknown) => {
      this.timeouts.delete(handle as number);
    },
    setInterval: (callback: () => void, milliseconds: number) => {
      const id = this.nextId++;
      this.intervals.set(id, {
        callback,
        at: this.now + milliseconds,
        interval: milliseconds,
      });
      return id;
    },
    clearInterval: (handle: unknown) => {
      this.intervals.delete(handle as number);
    },
    now: () => this.now,
  };

  advance(milliseconds: number): void {
    const target = this.now + milliseconds;
    for (;;) {
      const candidates = [
        ...this.timeouts.entries(),
        ...this.intervals.entries(),
      ].sort((left, right) => left[1].at - right[1].at);
      if (candidates.length === 0) break;
      const next = candidates[0];
      if (next[1].at > target) break;
      this.now = next[1].at;
      const [id, scheduled] = next;
      if (this.intervals.has(id)) {
        scheduled.at += scheduled.interval!;
        this.intervals.set(id, scheduled);
        scheduled.callback();
      } else {
        this.timeouts.delete(id);
        scheduled.callback();
      }
    }
    this.now = target;
  }

  size(): number {
    return this.timeouts.size + this.intervals.size;
  }
}

describe("StreamSupervisor", () => {
  it("invalidates old attempts and aborts actions from superseded epochs", () => {
    const timers = new FakeTimers();
    const attempts: StreamAttempt[] = [];
    const completed: number[] = [];
    const supervisor = new StreamSupervisor({
      run: (attempt) => {
        attempts.push(attempt);
      },
      retryDelay: () => 0,
      timers: timers.api,
    });
    const first = supervisor.start();
    const second = supervisor.start();
    supervisor.noteActivity(first);
    if (first.isCurrent()) completed.push(first.epoch);
    if (second.isCurrent()) completed.push(second.epoch);
    assert.equal(first.signal.aborted, true);
    assert.equal(second.signal.aborted, false);
    assert.deepEqual(completed, [second.epoch]);
    supervisor.stop();
  });

  it("schedules only one retry for repeated failures", () => {
    const timers = new FakeTimers();
    let attempts = 0;
    const supervisor = new StreamSupervisor({
      run: () => {
        attempts += 1;
      },
      retryDelay: () => 100,
      timers: timers.api,
    });
    const attempt = supervisor.start();
    supervisor.reconnect(attempt);
    supervisor.reconnect(attempt);
    timers.advance(100);
    assert.equal(attempts, 2);
    supervisor.stop();
  });

  it("uses the watchdog for a stalled pre-handshake attempt", () => {
    const timers = new FakeTimers();
    const failures: string[] = [];
    let attempts = 0;
    const supervisor = new StreamSupervisor({
      run: () => {
        attempts += 1;
      },
      retryDelay: () => 50,
      onFailure: (failure) => {
        failures.push(failure.kind);
      },
      stallTimeoutMs: 20,
      watchdogIntervalMs: 5,
      timers: timers.api,
    });
    const first = supervisor.start();
    timers.advance(20);
    assert.equal(first.signal.aborted, true);
    timers.advance(50);
    assert.equal(attempts, 2);
    assert.deepEqual(failures, ["stalled"]);
    supervisor.stop();
  });

  it("clears the watchdog and retry timer on stop", () => {
    const timers = new FakeTimers();
    let attempts = 0;
    const supervisor = new StreamSupervisor({
      run: () => {
        attempts += 1;
      },
      retryDelay: () => 100,
      timers: timers.api,
    });
    const first = supervisor.start();
    supervisor.reconnect(first);
    supervisor.stop();
    assert.equal(timers.size(), 0);
    timers.advance(1_000);
    assert.equal(attempts, 1);
  });
});
