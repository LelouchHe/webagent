/**
 * ClientRegistry — in-memory tracking of connected clients.
 *
 * Tracks per-client metadata that survives SSE disconnect:
 *   - capabilities advertised by the client on /hello.
 *   - visible / active / visibleSince: identity-layer visibility state used
 *     by TTS dispatch (voice branch) and push suppression (main).
 *
 * Lifecycle: clients call /hello on SSE connect (register) and POST
 * /visibility on visibilitychange + 15s heartbeat. SSE disconnect does
 * not remove a client — it stays in the registry until an explicit
 * /goodbye or TTL eviction (caller's responsibility). This lets visibility
 * state outlive transient drops.
 */

export interface ClientEntry {
  id: string;
  capabilities: string[];
  /** Set of taskIds currently visible in foreground tabs for this client. */
  visibleTaskIds: Set<string>;
  /** Monotonic per-client visibility revision (from X-Visibility-Rev). */
  lastVisibilityRev: number;
  /**
   * ms timestamp (from injected `now()`) when `visibleTaskIds` was last
   * refreshed as non-empty; 0 when empty. Used by TTL-aware queries to ignore
   * ghost records from suspended clients.
   */
  visibleSince: number;
  lastSeen: number;
}

/** Edge-trigger result for setVisibility callers (e.g. /visibility handler
 *  firing sendClose only for newly added taskIds). */
export interface SetVisibilityResult {
  /** False when client is unknown or `rev <= lastVisibilityRev`. */
  applied: boolean;
  /**
   * Task IDs newly added to this client's fresh visible set by this update.
   * Heartbeat refreshes with the same set return an empty array.
   */
  newlyVisibleTaskIds: string[];
}

export interface ClientRegistryOptions {
  /** Visibility records older than this (ms since last refresh) are stale
   *  and do not count as visible. Default 60_000. */
  visibilityTtlMs?: number;
  /** Injection point for tests. Default Date.now. */
  now?: () => number;
}

export class ClientRegistry {
  private readonly clients = new Map<string, ClientEntry>();
  private readonly visibilityTtlMs: number;
  private readonly now: () => number;

  constructor(options: ClientRegistryOptions = {}) {
    this.visibilityTtlMs = options.visibilityTtlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  register(id: string, data: { capabilities: string[] }): ClientEntry {
    const existing = this.clients.get(id);
    if (existing) {
      existing.capabilities = data.capabilities;
      existing.lastSeen = this.now();
      return existing;
    }
    const entry: ClientEntry = {
      id,
      capabilities: data.capabilities,
      visibleTaskIds: new Set(),
      lastVisibilityRev: 0,
      visibleSince: 0,
      lastSeen: this.now(),
    };
    this.clients.set(id, entry);
    return entry;
  }

  remove(id: string): void {
    this.clients.delete(id);
  }

  /**
   * Declarative full-replacement visibility setter gated by monotonic revision.
   * Only accepts updates with `rev > lastVisibilityRev` (when `rev` is
   * provided). Returns `newlyVisibleTaskIds` for edge-triggered banner recall.
   */
  setVisibility(
    id: string,
    taskIds: readonly string[],
    rev?: number,
  ): SetVisibilityResult {
    const entry = this.clients.get(id);
    if (!entry) return { applied: false, newlyVisibleTaskIds: [] };
    if (rev !== undefined && rev <= entry.lastVisibilityRev) {
      return { applied: false, newlyVisibleTaskIds: [] };
    }
    if (rev !== undefined) {
      entry.lastVisibilityRev = rev;
    }

    const now = this.now();
    const wasFresh =
      entry.visibleTaskIds.size > 0 &&
      now - entry.visibleSince <= this.visibilityTtlMs;
    const nextSet = new Set(taskIds);
    const newlyVisibleTaskIds: string[] = [];
    for (const taskId of nextSet) {
      if (!wasFresh || !entry.visibleTaskIds.has(taskId)) {
        newlyVisibleTaskIds.push(taskId);
      }
    }

    entry.visibleTaskIds = nextSet;
    entry.visibleSince = nextSet.size > 0 ? now : 0;
    entry.lastSeen = now;
    return { applied: true, newlyVisibleTaskIds };
  }

  /** Is this specific client currently visible & viewing `taskId` & fresh? */
  isVisibleForTask(id: string, taskId: string): boolean {
    const entry = this.clients.get(id);
    if (!entry) return false;
    if (!entry.visibleTaskIds.has(taskId)) return false;
    if (this.now() - entry.visibleSince > this.visibilityTtlMs) return false;
    return true;
  }

  /** Is at least one fresh visible client viewing `taskId`? */
  isTaskVisibleToAnyClient(taskId: string): boolean {
    const now = this.now();
    for (const e of this.clients.values()) {
      if (!e.visibleTaskIds.has(taskId)) continue;
      if (now - e.visibleSince > this.visibilityTtlMs) continue;
      return true;
    }
    return false;
  }

  /** Is this specific client currently fresh-visible (any task)? */
  isClientVisible(id: string): boolean {
    const entry = this.clients.get(id);
    if (!entry) return false;
    if (entry.visibleTaskIds.size === 0) return false;
    if (this.now() - entry.visibleSince > this.visibilityTtlMs) return false;
    return true;
  }

  /** Is at least one fresh visible client connected (any task)? */
  hasAnyVisibleClient(): boolean {
    const now = this.now();
    for (const e of this.clients.values()) {
      if (e.visibleTaskIds.size === 0) continue;
      if (now - e.visibleSince > this.visibilityTtlMs) continue;
      return true;
    }
    return false;
  }

  updateCapabilities(id: string, caps: string[]): void {
    const entry = this.clients.get(id);
    if (!entry) return;
    entry.capabilities = caps;
    entry.lastSeen = this.now();
  }

  touch(id: string): void {
    const entry = this.clients.get(id);
    if (entry) entry.lastSeen = this.now();
  }

  get(id: string): ClientEntry | undefined {
    return this.clients.get(id);
  }

  list(): ClientEntry[] {
    return Array.from(this.clients.values());
  }
}
