import { promises as fs, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { generateToken, hashToken, verifyToken } from "./auth.ts";
import { atomicWriteFile } from "./atomic-write.ts";

export type Scope = "admin" | "api";

export interface TokenRecord {
  name: string;
  scope: Scope;
  hash: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface AuthFileShape {
  tokens: TokenRecord[];
}

const VALID_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const VALID_SCOPE: ReadonlySet<string> = new Set(["admin", "api"]);
const FILE_MODE = 0o600;
const LOCK_OPTS = {
  retries: { retries: 10, factor: 2, minTimeout: 20, maxTimeout: 200 },
  stale: 5_000,
  realpath: false,
};

export class AuthStore {
  private tokens: Map<string, TokenRecord> = new Map(); // keyed by hash
  private readonly dirtyHashes: Set<string> = new Set(); // touched lastUsedAt waiting to flush
  private loaded = false;
  private flushTimer: NodeJS.Timeout | null = null;

  private readonly path: string;
  private readonly flushIntervalMs: number;

  constructor(path: string, flushIntervalMs = 60_000) {
    this.path = path;
    this.flushIntervalMs = flushIntervalMs;
  }

  /** Read auth.json into memory. Missing file = empty store. Throws on corrupt JSON. */
  async load(): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) {
      this.tokens = new Map();
      this.loaded = true;
      this.startFlushTimer();
      return;
    }
    const raw = readFileSync(this.path, "utf8");
    const data = parseAuthFile(raw);
    this.tokens = new Map(data.tokens.map((t) => [t.hash, t]));
    this.loaded = true;
    this.startFlushTimer();
  }

  /** Reload from disk, discarding any in-memory dirty state. */
  async reload(): Promise<void> {
    this.dirtyHashes.clear();
    this.loaded = false;
    await this.load();
  }

  list(): TokenRecord[] {
    return Array.from(this.tokens.values()).map((t) => ({ ...t }));
  }

  findByToken(token: string): TokenRecord | null {
    if (!token.startsWith("wat_")) return null;
    const h = hashToken(token);
    const rec = this.tokens.get(h);
    if (!rec) return null;
    // defense in depth: also verify timing-safe (cheap, same hash already)
    if (!verifyToken(token, rec.hash)) return null;
    return { ...rec };
  }

  /** True if a token with this name is still active. Used by SSE heartbeat
   *  to detect revocation mid-stream. */
  hasTokenName(name: string): boolean {
    for (const rec of this.tokens.values()) {
      if (rec.name === name) return true;
    }
    return false;
  }

  /** Update lastUsedAt in memory; persisted on next flush(). */
  touchLastUsed(token: string): void {
    if (!token) return;
    const h = hashToken(token);
    const rec = this.tokens.get(h);
    if (!rec) return;
    rec.lastUsedAt = Date.now();
    this.dirtyHashes.add(h);
  }

  async addToken(
    name: string,
    scope: Scope,
  ): Promise<{ token: string; record: TokenRecord }> {
    this.assertLoaded();
    if (!VALID_NAME.test(name)) {
      throw new Error(
        `Invalid token name: ${JSON.stringify(name)} (use [A-Za-z0-9_-], 1-64 chars)`,
      );
    }
    if (!VALID_SCOPE.has(scope)) {
      throw new Error(`Invalid scope: ${scope}`);
    }

    return this.withLock(async () => {
      // Reload to merge any external changes before mutating.
      const onDisk = await this.readFromDisk();
      const merged = this.mergeWithDisk(onDisk);

      if (merged.some((t) => t.name === name)) {
        throw new Error(`Token name already exists: ${name}`);
      }

      const token = generateToken();
      const record: TokenRecord = {
        name,
        scope,
        hash: hashToken(token),
        createdAt: Date.now(),
        lastUsedAt: null,
      };
      merged.push(record);
      await this.writeToDisk({ tokens: merged });
      this.replaceInMemory(merged);
      this.dirtyHashes.clear();
      return { token, record: { ...record } };
    });
  }

  async revokeToken(name: string): Promise<boolean> {
    this.assertLoaded();
    return this.withLock(async () => {
      const onDisk = await this.readFromDisk();
      const merged = this.mergeWithDisk(onDisk);
      const idx = merged.findIndex((t) => t.name === name);
      if (idx === -1) {
        // Sync memory with disk anyway.
        this.replaceInMemory(merged);
        this.dirtyHashes.clear();
        return false;
      }
      merged.splice(idx, 1);
      await this.writeToDisk({ tokens: merged });
      this.replaceInMemory(merged);
      this.dirtyHashes.clear();
      return true;
    });
  }

  /**
   * Persist dirty lastUsedAt fields to disk, preserving any external edits
   * (revokes, additions). Safe to call frequently; no-op if nothing dirty.
   */
  async flush(): Promise<void> {
    if (this.dirtyHashes.size === 0) return;
    await this.withLock(async () => {
      const onDisk = await this.readFromDisk();
      // Build merged list: start from disk (authoritative for membership)
      // then overlay our dirty lastUsedAt where the hash still exists.
      const merged = onDisk.map((diskRec) => {
        if (this.dirtyHashes.has(diskRec.hash)) {
          const memRec = this.tokens.get(diskRec.hash);
          if (
            memRec?.lastUsedAt &&
            (!diskRec.lastUsedAt || memRec.lastUsedAt > diskRec.lastUsedAt)
          ) {
            return { ...diskRec, lastUsedAt: memRec.lastUsedAt };
          }
        }
        return diskRec;
      });
      await this.writeToDisk({ tokens: merged });
      this.replaceInMemory(merged);
      this.dirtyHashes.clear();
    });
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.loaded && this.dirtyHashes.size > 0) {
      try {
        await this.flush();
      } catch {
        // best-effort on shutdown
      }
    }
  }

  // ---- internals -----------------------------------------------------------

  private assertLoaded(): void {
    if (!this.loaded)
      throw new Error("AuthStore not loaded; call load() first");
  }

  private startFlushTimer(): void {
    if (this.flushTimer || this.flushIntervalMs <= 0) return;
    this.flushTimer = setInterval(() => {
      void this.flush().catch(() => {});
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  private async readFromDisk(): Promise<TokenRecord[]> {
    if (!existsSync(this.path)) return [];
    const raw = await fs.readFile(this.path, "utf8");
    return parseAuthFile(raw).tokens;
  }

  /**
   * Merge in-memory tokens onto disk-authoritative list:
   *   - Membership comes from disk (deletions external = honored).
   *   - lastUsedAt: take the max of memory vs disk for matching hashes.
   *   - In-memory-only tokens (added by us, not yet on disk) — won't happen
   *     because addToken always writes synchronously. So disk is full truth.
   */
  private mergeWithDisk(onDisk: TokenRecord[]): TokenRecord[] {
    return onDisk.map((diskRec) => {
      const memRec = this.tokens.get(diskRec.hash);
      if (!memRec) return diskRec;
      const lastUsedAt =
        Math.max(diskRec.lastUsedAt ?? 0, memRec.lastUsedAt ?? 0) || null;
      return { ...diskRec, lastUsedAt };
    });
  }

  private replaceInMemory(records: TokenRecord[]): void {
    this.tokens = new Map(records.map((t) => [t.hash, { ...t }]));
  }

  private async writeToDisk(data: AuthFileShape): Promise<void> {
    await atomicWriteFile(this.path, JSON.stringify(data, null, 2), FILE_MODE);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    // Ensure file exists (proper-lockfile requires the target to exist).
    if (!existsSync(this.path)) {
      const fh = await fs.open(this.path, "w", FILE_MODE);
      await fh.writeFile(JSON.stringify({ tokens: [] }, null, 2));
      await fh.close();
    }
    const release = await lockfile.lock(this.path, LOCK_OPTS);
    try {
      return await fn();
    } finally {
      await release();
    }
  }
}

function parseAuthFile(raw: string): AuthFileShape {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`auth.json is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { tokens?: unknown }).tokens)
  ) {
    throw new Error("auth.json must have a 'tokens' array");
  }
  const tokens = (data as { tokens: unknown[] }).tokens.map((entry, i) => {
    if (!entry || typeof entry !== "object")
      throw new Error(`auth.json tokens[${i}] not an object`);
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string")
      throw new Error(`auth.json tokens[${i}].name missing`);
    if (e.scope !== "admin" && e.scope !== "api")
      throw new Error(`auth.json tokens[${i}].scope invalid`);
    if (typeof e.hash !== "string" || !/^[a-f0-9]{64}$/i.test(e.hash)) {
      throw new Error(`auth.json tokens[${i}].hash invalid`);
    }
    if (typeof e.createdAt !== "number")
      throw new Error(`auth.json tokens[${i}].createdAt missing`);
    const lastUsedAt = e.lastUsedAt;
    if (lastUsedAt !== null && typeof lastUsedAt !== "number") {
      throw new Error(`auth.json tokens[${i}].lastUsedAt invalid`);
    }
    return {
      name: e.name,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- narrowed by line 280 check but TSC needs cast from unknown
      scope: e.scope as Scope,
      hash: e.hash.toLowerCase(),
      createdAt: e.createdAt,
      lastUsedAt: lastUsedAt,
    };
  });
  return { tokens };
}
