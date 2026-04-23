import type { Store } from "./store.ts";

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
export function sweepOnce(store: Store, ttlDays: number, now: number = Date.now()): number {
  if (ttlDays <= 0) return 0;
  const threshold = now - ttlDays * DAY_MS;
  const removed = store.deleteOlderThan(threshold);
  if (removed > 0) {
    console.info(`[msg] ttl sweep removed=${removed} ttl_days=${ttlDays}`);
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
export function startMessageCleanup(store: Store, ttlDays: number): CleanupHandle {
  sweepOnce(store, ttlDays);

  if (ttlDays <= 0) {
    return { armed: false, stop: () => {} };
  }

  const timer = setInterval(() => {
    try {
      sweepOnce(store, ttlDays);
    } catch (err) {
      console.error("[msg] ttl sweep failed:", err);
    }
  }, DAY_MS);
  // Don't keep the event loop alive for this interval alone (let server.ts own lifecycle).
  if (typeof timer.unref === "function") timer.unref();

  return {
    armed: true,
    stop: () => clearInterval(timer),
  };
}
