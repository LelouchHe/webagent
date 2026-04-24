import { createHash } from "node:crypto";
import { sanitizeEventsForShare, SANITIZER_VERSION, type ParsedEvent, type SanitizeInputEvent } from "./sanitize.ts";

/**
 * In-memory LRU cache of sanitized event projections
 * (share-plan §4.3 R2-c2, storage strategy).
 *
 * Key = `${session_id}:${contentHash}:${SANITIZER_VERSION}`. The content
 * hash is an SHA-1 of the event list's raw-data JSON (stable across
 * calls as long as nothing underneath changed). When the sanitizer
 * version bumps on a deploy, all old keys naturally miss.
 *
 * Capacity fixed at 100 (plan default). Rationale: memory cheap, misses
 * cheap (re-sanitize is pure O(N_events) with simple regex). The LRU is
 * a latency optimization for hot-spot tokens, not a correctness layer.
 */

const DEFAULT_CAPACITY = 100;

export interface ProjectionInput {
  sessionId: string;
  events: SanitizeInputEvent[];
  cwd: string;
  homeDir: string;
  internalHosts: string[];
  /** Optional override for test / small deployments. */
  capacity?: number;
}

export interface ProjectionResult {
  events: ParsedEvent[];
  cacheHit: boolean;
}

/**
 * Stringify each event's raw data for hashing. We include seq+type so
 * re-ordering or type change busts the hash even if data strings are
 * identical.
 */
function hashEvents(events: SanitizeInputEvent[]): string {
  const h = createHash("sha1");
  for (const ev of events) {
    h.update(String(ev.seq));
    h.update("\0");
    h.update(ev.type);
    h.update("\0");
    h.update(typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data));
    h.update("\n");
  }
  return h.digest("base64url");
}

const cache = new Map<string, ParsedEvent[]>();
let capacity = DEFAULT_CAPACITY;

export function configureProjectionCache(opts: { capacity?: number }): void {
  if (opts.capacity != null) capacity = opts.capacity;
}

export function clearProjectionCache(): void {
  cache.clear();
}

export function projectionCacheSize(): number {
  return cache.size;
}

/**
 * Get (or compute) the sanitized projection for `events` belonging to
 * `sessionId`. Caller is responsible for passing the FULL event list
 * up to the snapshot_seq — partial lists will hash to different keys.
 */
export function getOrComputeProjection(input: ProjectionInput): ProjectionResult {
  const hash = hashEvents(input.events);
  const key = `${input.sessionId}:${hash}:${SANITIZER_VERSION}`;

  // LRU: Map iteration order = insertion order. Delete + re-set to move to end.
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return { events: cached, cacheHit: true };
  }

  const { events: sanitized } = sanitizeEventsForShare({
    events: input.events,
    cwd: input.cwd,
    homeDir: input.homeDir,
    internalHosts: input.internalHosts,
  });

  const cap = input.capacity ?? capacity;
  while (cache.size >= cap) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  cache.set(key, sanitized);
  return { events: sanitized, cacheHit: false };
}
