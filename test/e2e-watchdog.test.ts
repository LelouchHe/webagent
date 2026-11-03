// The E2E liveness guard must be invisible to production. These tests pin the
// two halves of that: without E2E_RUN_DIR nothing is scheduled and nothing is
// read, and with it a stale heartbeat shuts the process down exactly once.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startE2EHeartbeatWatchdog } from "../src/e2e-watchdog.ts";

interface Harness {
  statCalls: string[];
  scheduled: Array<{ fn: () => void; intervalMs: number }>;
  cancels: number;
  stales: number;
  clock: { now: number };
  mtime: number | Error;
}

function watch(env: Record<string, string | undefined>): {
  harness: Harness;
  watchdog: ReturnType<typeof startE2EHeartbeatWatchdog>;
} {
  const harness: Harness = {
    statCalls: [],
    scheduled: [],
    cancels: 0,
    stales: 0,
    clock: { now: 1_000_000 },
    mtime: 1_000_000,
  };
  const watchdog = startE2EHeartbeatWatchdog({
    env,
    onStale: () => {
      harness.stales += 1;
    },
    checkIntervalMs: 2_000,
    staleAfterMs: 5_000,
    now: () => harness.clock.now,
    statMtimeMs: (path) => {
      harness.statCalls.push(path);
      if (harness.mtime instanceof Error) throw harness.mtime;
      return harness.mtime;
    },
    schedule: (fn, intervalMs) => {
      harness.scheduled.push({ fn, intervalMs });
      return {
        cancel: () => {
          harness.cancels += 1;
        },
      };
    },
  });
  return { harness, watchdog };
}

describe("e2e heartbeat watchdog", () => {
  it("does nothing at all when E2E_RUN_DIR is unset", () => {
    const { harness, watchdog } = watch({});
    assert.equal(watchdog, null);
    assert.deepEqual(harness.statCalls, []);
    assert.deepEqual(harness.scheduled, []);
  });

  it("does nothing when E2E_RUN_DIR is empty", () => {
    const { harness, watchdog } = watch({ E2E_RUN_DIR: "" });
    assert.equal(watchdog, null);
    assert.deepEqual(harness.statCalls, []);
    assert.deepEqual(harness.scheduled, []);
  });

  it("watches <runDir>/heartbeat when E2E_RUN_DIR is set", () => {
    const { harness, watchdog } = watch({ E2E_RUN_DIR: "/tmp/run-1" });
    assert.notEqual(watchdog, null);
    assert.equal(harness.scheduled.length, 1);
    assert.equal(harness.scheduled[0].intervalMs, 2_000);

    harness.scheduled[0].fn();
    assert.deepEqual(harness.statCalls, [join("/tmp/run-1", "heartbeat")]);
    assert.equal(harness.stales, 0);
  });

  it("stays alive while the heartbeat keeps moving", () => {
    const { harness, watchdog } = watch({ E2E_RUN_DIR: "/tmp/run-2" });
    assert.ok(watchdog);
    for (let pass = 0; pass < 10; pass += 1) {
      harness.clock.now += 2_000;
      harness.mtime = harness.clock.now;
      harness.scheduled[0].fn();
      assert.equal(harness.stales, 0, `fresh at pass ${pass}`);
    }
    assert.equal(harness.cancels, 0);
    watchdog.stop();
    assert.equal(harness.cancels, 1);
  });

  it("shuts down once when the heartbeat stops moving", () => {
    const { harness } = watch({ E2E_RUN_DIR: "/tmp/run-3" });
    for (let pass = 1; pass <= 3; pass += 1) {
      harness.clock.now = 1_000_000 + pass * 1_500;
      harness.scheduled[0].fn();
      assert.equal(harness.stales, 0, `still fresh at +${pass * 1.5}s`);
    }
    harness.clock.now = 1_000_000 + 6_000;
    harness.scheduled[0].fn();
    assert.equal(harness.stales, 1);
    assert.equal(harness.cancels, 1, "the timer is cancelled before the hook");

    // A tick that races the shutdown must not call the hook twice.
    harness.scheduled[0].fn();
    assert.equal(harness.stales, 1);
  });

  it("treats a heartbeat that never appears as stale", () => {
    const { harness } = watch({ E2E_RUN_DIR: "/tmp/run-4" });
    harness.mtime = Object.assign(new Error("missing"), { code: "ENOENT" });
    harness.clock.now = 1_000_000 + 2_000;
    harness.scheduled[0].fn();
    assert.equal(harness.stales, 0, "one missed read is not staleness");
    harness.clock.now = 1_000_000 + 6_000;
    harness.scheduled[0].fn();
    assert.equal(harness.stales, 1);
  });
});
