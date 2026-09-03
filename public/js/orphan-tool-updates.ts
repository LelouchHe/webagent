import type { AgentEvent } from "../../src/types.ts";

type ToolCallUpdateEvent = Extract<AgentEvent, { type: "tool_call_update" }>;

interface CacheEntry {
  update: ToolCallUpdateEvent;
  sequence: number | null;
  expiresAt: number;
  bytes: number;
}

interface CacheOptions {
  ttlMs?: number;
  maxIds?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  now?: () => number;
  /** Fired when an entry expires without its host ever appearing (once per id). */
  onExpire?: (id: string, update: ToolCallUpdateEvent) => void;
}

export class OrphanToolUpdateCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxIds: number;
  private readonly maxEntryBytes: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;
  private readonly onExpire?: (id: string, update: ToolCallUpdateEvent) => void;
  private totalBytes = 0;

  constructor(options: CacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxIds = options.maxIds ?? 64;
    this.maxEntryBytes = options.maxEntryBytes ?? 256 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 2 * 1024 * 1024;
    this.now = options.now ?? (() => performance.now());
    this.onExpire = options.onExpire;
  }

  put(update: ToolCallUpdateEvent, sequence?: number): void {
    const now = this.now();
    this.prune(now);
    const previous = this.entries.get(update.id);
    const incomingIsNewer =
      !previous ||
      sequence === undefined ||
      previous.sequence === null ||
      sequence >= previous.sequence;
    // ACP tool content is a cumulative snapshot, not a delta: newer present
    // fields replace older ones, while omitted fields survive. Replay can load
    // pages newest-first, so an older sequence only fills missing fields.
    const merged = previous
      ? incomingIsNewer
        ? ({ ...previous.update, ...update } as ToolCallUpdateEvent)
        : ({ ...update, ...previous.update } as ToolCallUpdateEvent)
      : update;
    const mergedSequence = incomingIsNewer
      ? (sequence ?? previous?.sequence ?? null)
      : previous.sequence;
    this.drop(update.id);

    const bytes = this.serializedBytes(merged);
    if (bytes === null || bytes > this.maxEntryBytes) return;
    while (
      this.entries.size >= this.maxIds ||
      this.totalBytes + bytes > this.maxTotalBytes
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.drop(oldest.value);
    }
    this.entries.set(update.id, {
      update: merged,
      sequence: mergedSequence,
      expiresAt: now + this.ttlMs,
      bytes,
    });
    this.totalBytes += bytes;
  }

  take(id: string): ToolCallUpdateEvent | null {
    this.prune(this.now());
    const entry = this.entries.get(id);
    if (!entry) return null;
    this.drop(id);
    return entry.update;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private prune(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        // Expiry-without-recovery is the one genuinely abnormal outcome:
        // the buffered update never found a host before the TTL lapsed.
        this.onExpire?.(id, entry.update);
        this.drop(id);
      }
    }
  }

  private drop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.totalBytes -= entry.bytes;
    this.entries.delete(id);
  }

  private serializedBytes(update: ToolCallUpdateEvent): number | null {
    try {
      return new TextEncoder().encode(JSON.stringify(update)).byteLength;
    } catch {
      return null;
    }
  }
}
