import { generateSseTicket } from "./tokens.ts";

export interface TicketPrincipal {
  tokenName: string;
  scope: "admin" | "api";
}

interface TicketRecord extends TicketPrincipal {
  expiresAt: number;
}

interface TicketStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

/**
 * Short-lived single-use tickets that authenticate an SSE EventSource
 * connection (which can't carry a Bearer header). Lifecycle:
 *   1. Client POSTs /api/v1/sse-ticket with Bearer → mint() returns ticket.
 *   2. Client opens EventSource(?ticket=...) → consume() validates + deletes.
 *   3. After TTL (default 60s) any unused ticket is invalid; gc() purges.
 */
export class TicketStore {
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: TicketStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  mint(principal: TicketPrincipal): string {
    const ticket = generateSseTicket();
    this.tickets.set(ticket, {
      tokenName: principal.tokenName,
      scope: principal.scope,
      expiresAt: this.now() + this.ttlMs,
    });
    return ticket;
  }

  consume(ticket: string): TicketPrincipal | null {
    const rec = this.tickets.get(ticket);
    if (!rec) return null;
    this.tickets.delete(ticket);
    if (rec.expiresAt <= this.now()) return null;
    return { tokenName: rec.tokenName, scope: rec.scope };
  }

  gc(): void {
    const cutoff = this.now();
    for (const [k, v] of this.tickets) {
      if (v.expiresAt <= cutoff) this.tickets.delete(k);
    }
  }

  get size(): number {
    return this.tickets.size;
  }
}
