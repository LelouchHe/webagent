/**
 * Test-harness liveness guard.
 *
 * An E2E suite run touches <runDir>/heartbeat once a second. When that file
 * stops moving — the runner was killed, timed out, or crashed — the server
 * must not keep running with its agents, because the next run would find its
 * port taken and its data directory shared.
 *
 * This is enabled *only* when the process environment carries E2E_RUN_DIR.
 * Without it the function returns null before scheduling a timer or touching
 * the filesystem, so a production process has no watchdog at all.
 */
import { statSync } from "node:fs";
import { join } from "node:path";

export interface E2EHeartbeatWatchdogOptions {
  env: Record<string, string | undefined>;
  /** Called once, after the timer has been cancelled. */
  onStale: () => void;
  checkIntervalMs?: number;
  staleAfterMs?: number;
  now?: () => number;
  statMtimeMs?: (path: string) => number;
  schedule?: (fn: () => void, intervalMs: number) => WatchdogTimer;
}

export interface WatchdogTimer {
  cancel: () => void;
}

export interface E2EHeartbeatWatchdog {
  stop: () => void;
}

export function startE2EHeartbeatWatchdog(
  options: E2EHeartbeatWatchdogOptions,
): E2EHeartbeatWatchdog | null {
  const runDir = options.env.E2E_RUN_DIR;
  if (!runDir) return null;

  const heartbeatPath = join(runDir, "heartbeat");
  const checkIntervalMs = options.checkIntervalMs ?? 2_000;
  const staleAfterMs = options.staleAfterMs ?? 5_000;
  const now = options.now ?? Date.now;
  const statMtimeMs =
    options.statMtimeMs ?? ((path: string) => statSync(path).mtimeMs);
  const schedule =
    options.schedule ??
    ((fn: () => void, intervalMs: number): WatchdogTimer => {
      const timer = setInterval(fn, intervalMs);
      timer.unref();
      return {
        cancel: () => {
          clearInterval(timer);
        },
      };
    });

  let lastSeenAt = now();
  let stopped = false;
  // A holder because the timer only exists after `schedule` returns, while
  // the scheduled callback already refers back to it.
  const state: { timer: WatchdogTimer | null } = { timer: null };

  const check = (): void => {
    if (stopped) return;
    try {
      lastSeenAt = statMtimeMs(heartbeatPath);
    } catch {
      // A missing heartbeat is not an update: the clock above keeps running.
    }
    if (now() - lastSeenAt <= staleAfterMs) return;
    stopped = true;
    state.timer?.cancel();
    options.onStale();
  };

  state.timer = schedule(check, checkIntervalMs);
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      state.timer?.cancel();
    },
  };
}
