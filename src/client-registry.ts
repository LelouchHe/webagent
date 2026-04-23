/**
 * ClientRegistry — in-memory tracking of connected clients.
 *
 * Tracks per-client metadata that survives SSE disconnect:
 *   - capabilities advertised by the client on /hello.
 *   - focus: clientId's current sessionId (set via /focus). Used by push
 *     visibility suppression to know which session each client is viewing.
 *
 * Lifecycle: clients call /hello on SSE connect (register) and /focus when
 * they switch sessions. SSE disconnect does not remove a client — it stays
 * in the registry until an explicit /goodbye or TTL eviction (caller's
 * responsibility). This lets visibility state outlive transient drops.
 */

export interface ClientEntry {
  id: string;
  capabilities: string[];
  focus: string | null;
  lastSeen: number;
}

export class ClientRegistry {
  private readonly clients = new Map<string, ClientEntry>();

  register(id: string, data: { capabilities: string[] }): ClientEntry {
    const existing = this.clients.get(id);
    if (existing) {
      existing.capabilities = data.capabilities;
      existing.lastSeen = Date.now();
      return existing;
    }
    const entry: ClientEntry = {
      id,
      capabilities: data.capabilities,
      focus: null,
      lastSeen: Date.now(),
    };
    this.clients.set(id, entry);
    return entry;
  }

  remove(id: string): void {
    this.clients.delete(id);
  }

  setFocus(id: string, sessionId: string | null): void {
    const entry = this.clients.get(id);
    if (!entry) return;
    entry.focus = sessionId;
    entry.lastSeen = Date.now();
  }

  updateCapabilities(id: string, caps: string[]): void {
    const entry = this.clients.get(id);
    if (!entry) return;
    entry.capabilities = caps;
    entry.lastSeen = Date.now();
  }

  touch(id: string): void {
    const entry = this.clients.get(id);
    if (entry) entry.lastSeen = Date.now();
  }

  get(id: string): ClientEntry | undefined {
    return this.clients.get(id);
  }

  list(): ClientEntry[] {
    return Array.from(this.clients.values());
  }
}
