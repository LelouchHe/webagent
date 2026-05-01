import type { Store } from "./store.ts";
import { log } from "./log.ts";

const mlog = log.scope("msg");

/** Cleanup handle returned by startMessageCleanup. */
export interface CleanupHandle {
  /** Whether the periodic interval is armed (false if ttlDays=0). */
  armed: boolean;
  stop(): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sweep unprocessed messages whose created_at is older than ttlDays.
 * Returns the number of rows removed. `now` is injectable for tests.
 * ttlDays=0 means "keep forever" — returns 0 without touching the DB.
 */
export function sweepOnce(
  store: Store,
  ttlDays: number,
  now: number = Date.now(),
): number {
  if (ttlDays <= 0) return 0;
  const threshold = now - ttlDays * DAY_MS;
  const removed = store.deleteOlderThan(threshold);
  if (removed > 0) {
    mlog.info("ttl sweep", { removed, ttl_days: ttlDays });
  }
  return removed;
}

/**
 * Start the unprocessed-message TTL cleanup job:
 *  - sweep once immediately (synchronous),
 *  - then every 24h via setInterval.
 *
 * ttlDays=0 disables the scheduler entirely (handle.armed=false).
 */
export function startMessageCleanup(
  store: Store,
  ttlDays: number,
): CleanupHandle {
  sweepOnce(store, ttlDays);

  if (ttlDays <= 0) {
    return { armed: false, stop: () => {} };
  }

  const timer = setInterval(() => {
    try {
      sweepOnce(store, ttlDays);
    } catch (err) {
      mlog.error("ttl sweep failed", { error: err });
    }
  }, DAY_MS);
  // Don't keep the event loop alive for this interval alone (let server.ts own lifecycle).
  if (typeof timer.unref === "function") timer.unref();

  return {
    armed: true,
    stop: () => {
      clearInterval(timer);
    },
  };
}
