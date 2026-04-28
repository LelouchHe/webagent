/**
 * Share preview cleanup scheduler (panel-review V6).
 *
 * `pruneStalePreviews()` was defined on the store per share-plan §4.1 but
 * had no caller — preview rows that were never activated accumulated
 * forever. This module arms a daily sweep when `[share] enabled = true`.
 *
 * Mirrors the shape of `message-cleanup.ts` (immediate + interval + unref).
 */
import type { Store } from "../store.ts";

export interface SharePreviewCleanupHandle {
  armed: boolean;
  stop(): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sweep one batch of stale previews (older than 24h, never activated,
 * never revoked). Returns rows removed. `now` injectable for tests.
 */
export function sweepStaleSharePreviewsOnce(
  store: Store,
  now: number = Date.now(),
): number {
  const removed = store.pruneStalePreviews(now);
  if (removed > 0) {
    console.info(`[share] preview gc removed=${removed}`);
  }
  return removed;
}

/**
 * Start the share-preview GC: sweep once synchronously on boot, then
 * every 24h. Handle is unref'd so this interval alone doesn't keep the
 * event loop alive — server.ts owns lifecycle.
 *
 * Only call when `config.share.enabled === true`; otherwise skip entirely.
 */
export function startSharePreviewCleanup(
  store: Store,
): SharePreviewCleanupHandle {
  try {
    sweepStaleSharePreviewsOnce(store);
  } catch (err) {
    console.error("[share] preview gc initial sweep failed:", err);
  }

  const timer = setInterval(() => {
    try {
      sweepStaleSharePreviewsOnce(store);
    } catch (err) {
      console.error("[share] preview gc sweep failed:", err);
    }
  }, DAY_MS);
  if (typeof timer.unref === "function") timer.unref();

  return {
    armed: true,
    stop: () => {
      clearInterval(timer);
    },
  };
}
