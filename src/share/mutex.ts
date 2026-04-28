/**
 * Per-session async mutex (share-plan §4.3 R2-c2).
 *
 * POST /api/v1/sessions/:id/share is transactional: flush buffered
 * chunks → compute snapshot_seq → gate sanitizer → INSERT preview. If
 * two owner-side requests race, we want exactly one INSERT (the other
 * waits, then sees existing preview and returns it). DB-level partial
 * unique index is the ultimate backstop (and is asserted in C1 store
 * tests), but the mutex avoids the noisy SQLITE_CONSTRAINT path.
 *
 * In-memory only — fine because preview creation is always owner-side
 * (single host, single node process) and cross-restart concurrency is
 * impossible (server is single-instance per §7 deploy model).
 */

const locks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` inside the per-key mutex. Serializes callers with the same
 * key; different keys run in parallel. Returns `fn`'s result / throws.
 */
export async function withSessionLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  const chain = prev.then(() => next);
  locks.set(key, chain);

  try {
    await prev;
    return await fn();
  } finally {
    resolve();
    // Only clear if nothing else queued after us. Must compare against the
    // same Promise object we stored — `prev.then(...)` returns a fresh
    // Promise each call, so recomputing would always miss.
    if (locks.get(key) === chain) {
      locks.delete(key);
    }
  }
}

/** Test helper — force-clear all locks. */
export function __clearAllLocks(): void {
  locks.clear();
}

/** Test helper — inspect current Map size (for leak assertions). */
export function __locksSize(): number {
  return locks.size;
}
