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
  /** True iff the client most-recently reported the page as visible. */
  visible: boolean;
  /** Session the client is currently viewing (null = no session pane open). */
  active: string | null;
  /**
   * ms timestamp (from injected `now()`) when `visible` last became true OR
   * when `active` last changed while visible; 0 when not visible. Used by
   * TTL-aware queries to ignore ghost records from iOS PWA suspension.
   */
  visibleSince: number;
  lastSeen: number;
}

/** Patch input for setVisibility. `active` distinguishes preserve (omit) from
 *  clear (explicit null) from replace (string). */
export interface VisibilityPatch {
  visible?: boolean;
  active?: string | null;
}

/** Edge-trigger flag for setVisibility callers (e.g. /visibility handler
 *  firing sendClose on first visible+session transition only, not on
 *  every 15s heartbeat). Mirrors PushService.UpdateClientResult. */
export interface SetVisibilityResult {
  /**
   * Non-null iff this update transitioned the client into
   * "visible + active=X" — either invisible→visible, or session-switch
   * X→Y while visible. Repeated heartbeats with the same (visible, active)
   * return null.
   */
  becameVisibleFor: string | null;
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
      visible: false,
      active: null,
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
   * Atomic visibility setter. Mirrors PushService.updateClient semantics:
   *   - `visible` omitted = preserve; bool = set (and stamp/clear visibleSince).
   *   - `active`  omitted = preserve; null = clear; string = replace.
   *   - Returns `becameVisibleFor=X` only on first transition into
   *     (visible:true, active:X) — heartbeat refreshes return null so
   *     callers can fire edge-triggered side effects exactly once.
   *   - Session-switch while visible (active X→Y) restarts the TTL clock
   *     even when the patch doesn't carry an explicit visible:true.
   *
   * No-op on unknown client.
   */
  setVisibility(id: string, patch: VisibilityPatch): SetVisibilityResult {
    const entry = this.clients.get(id);
    if (!entry) return { becameVisibleFor: null };

    const wasVisibleForSession =
      entry.visible && entry.active != null ? entry.active : null;

    if (patch.visible !== undefined) {
      entry.visible = patch.visible;
      entry.visibleSince = patch.visible ? this.now() : 0;
    }
    if (patch.active !== undefined) {
      entry.active = patch.active;
    }

    const becameVisibleFor =
      entry.visible &&
      entry.active != null &&
      entry.active !== wasVisibleForSession
        ? entry.active
        : null;
    if (becameVisibleFor) {
      // Any transition into "visible + active=X" restarts TTL — including
      // session-switches that arrive without an explicit visible:true.
      entry.visibleSince = this.now();
    }

    entry.lastSeen = this.now();
    return { becameVisibleFor };
  }

  /** Is this specific client currently visible & viewing `sessionId` & fresh? */
  isVisibleForSession(id: string, sessionId: string): boolean {
    const entry = this.clients.get(id);
    if (!entry) return false;
    if (!entry.visible) return false;
    if (entry.active !== sessionId) return false;
    if (this.now() - entry.visibleSince > this.visibilityTtlMs) return false;
    return true;
  }

  /** Is at least one fresh visible client viewing `sessionId`? */
  isSessionVisibleToAnyClient(sessionId: string): boolean {
    const now = this.now();
    for (const e of this.clients.values()) {
      if (!e.visible) continue;
      if (e.active !== sessionId) continue;
      if (now - e.visibleSince > this.visibilityTtlMs) continue;
      return true;
    }
    return false;
  }

  /** Is this specific client currently fresh-visible (any session)? */
  isClientVisible(id: string): boolean {
    const entry = this.clients.get(id);
    if (!entry) return false;
    if (!entry.visible) return false;
    if (this.now() - entry.visibleSince > this.visibilityTtlMs) return false;
    return true;
  }

  /** Is at least one fresh visible client connected (any session)? */
  hasAnyVisibleClient(): boolean {
    const now = this.now();
    for (const e of this.clients.values()) {
      if (!e.visible) continue;
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
