import type Database from "better-sqlite3";

/** Fixed 24-hour retention window for HTTP ops records. */
export const OPS_TTL_MS = 24 * 60 * 60 * 1000;

export type StoredOpHeaders = Record<string, string | string[]>;

export interface StoredOpResponse {
  status: number;
  headers: StoredOpHeaders;
  body: Buffer;
}

export type OpClaimResult =
  | { kind: "new"; createdAt: number }
  | { kind: "pending" }
  | { kind: "conflict" }
  | { kind: "replay"; response: StoredOpResponse };

interface OpRow {
  fingerprint: string;
  status: number | null;
  headers: string | null;
  body: Buffer | Uint8Array | null;
  created_at: number;
}

function parseStoredHeaders(raw: string | null): StoredOpHeaders {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const headers: StoredOpHeaders = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (typeof value === "string") {
      headers[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((entry): entry is string => typeof entry === "string")
    ) {
      headers[key] = value;
    }
  }
  return headers;
}

function toBuffer(raw: Buffer | Uint8Array | null): Buffer {
  if (raw === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(raw)) return raw;
  return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
}

/**
 * Pure storage state machine for bounded-TTL operation deduplication.
 * Knows nothing about HTTP, routes, or tasks: only `claim`, `complete`, and `sweep`.
 */
export class OpsStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  claim(
    key: string,
    fingerprint: string,
    now: number = Date.now(),
  ): OpClaimResult {
    return this.db.transaction((): OpClaimResult => {
      const existing = this.db
        .prepare(
          "SELECT fingerprint, status, headers, body, created_at FROM ops WHERE key = ?",
        )
        .get(key) as OpRow | undefined;

      if (existing && now - existing.created_at < OPS_TTL_MS) {
        if (existing.fingerprint !== fingerprint) {
          return { kind: "conflict" };
        }
        if (existing.status === null) {
          return { kind: "pending" };
        }
        return {
          kind: "replay",
          response: {
            status: existing.status,
            headers: parseStoredHeaders(existing.headers),
            body: toBuffer(existing.body),
          },
        };
      }

      this.db
        .prepare(
          `INSERT OR REPLACE INTO ops (key, fingerprint, status, headers, body, created_at)
           VALUES (?, ?, NULL, NULL, NULL, ?)`,
        )
        .run(key, fingerprint, now);
      return { kind: "new", createdAt: now };
    })();
  }

  complete(
    key: string,
    response: StoredOpResponse,
    expectedCreatedAt?: number,
  ): boolean {
    const encodedHeaders = JSON.stringify(response.headers);
    const body = Buffer.isBuffer(response.body)
      ? response.body
      : Buffer.from(response.body);
    if (expectedCreatedAt !== undefined) {
      const result = this.db
        .prepare(
          `UPDATE ops
           SET status = ?, headers = ?, body = ?
           WHERE key = ? AND status IS NULL AND created_at = ?`,
        )
        .run(response.status, encodedHeaders, body, key, expectedCreatedAt);
      return result.changes === 1;
    }
    const result = this.db
      .prepare(
        `UPDATE ops
         SET status = ?, headers = ?, body = ?
         WHERE key = ? AND status IS NULL`,
      )
      .run(response.status, encodedHeaders, body, key);
    return result.changes === 1;
  }

  sweep(
    now: number = Date.now(),
    activeKeys?: Pick<ReadonlySet<string>, "size" | "has">,
  ): number {
    const cutoff = now - OPS_TTL_MS;
    if (!activeKeys || activeKeys.size === 0) {
      return this.db
        .prepare("DELETE FROM ops WHERE created_at <= ?")
        .run(cutoff).changes;
    }
    return this.db.transaction(() => {
      const expired = this.db
        .prepare("SELECT key FROM ops WHERE created_at <= ?")
        .all(cutoff) as Array<{ key: string }>;
      let removed = 0;
      const del = this.db.prepare("DELETE FROM ops WHERE key = ?");
      for (const row of expired) {
        if (activeKeys.has(row.key)) continue;
        removed += del.run(row.key).changes;
      }
      return removed;
    })();
  }
}
