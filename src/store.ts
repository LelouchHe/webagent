import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Default origin marker for an event row, mirroring the migration backfill. */
function defaultFromRef(type: string): string {
  if (type === "user_message") return "user";
  if (
    type === "permission_response" ||
    type === "bash_command" ||
    type === "bash_result" ||
    type === "system_message"
  ) {
    return "system";
  }
  return "agent";
}

export interface SessionRow {
  id: string;
  cwd: string;
  title: string | null;
  model: string | null;
  mode: string | null;
  reasoning_effort: string | null;
  source: string;
  created_at: string;
  last_active_at: string;
}

export interface EventRow {
  id: number;
  session_id: string;
  seq: number;
  type: string;
  data: string; // JSON
  /** Origin marker: 'user' | 'system' | 'agent' | 'msg:<id>'. NULL only on legacy rows that pre-date the column. */
  from_ref: string | null;
  created_at: string;
}

export interface SubscriptionRow {
  id: number;
  endpoint: string;
  auth: string;
  p256dh: string;
  created_at: string;
}

/** A pending unbound notification -- posted via /api/v1/messages with to="user". */
export interface MessageRow {
  id: string;
  from_ref: string;
  from_label: string | null;
  to_ref: string;
  deliver: string;
  dedup_key: string | null;
  title: string;
  body: string;
  cwd: string | null;
  created_at: number;
}

export interface MessageInput {
  id: string;
  from_ref: string;
  from_label: string | null;
  to_ref: string;
  deliver: string;
  dedup_key: string | null;
  title: string;
  body: string;
  cwd: string | null;
  created_at: number;
}

export class Store {
  private db: Database.Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "webagent.db"));
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    // Enforce foreign keys *after* migrate() so the one-time orphan cleanup
    // can run without pragma interfering with legacy cleanup queries.
    this.db.pragma("foreign_keys = ON");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        last_active_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint TEXT NOT NULL UNIQUE,
        auth TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
      );
    `);

    // Migrate existing tables: add columns if missing
    const cols = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map(c => c.name));
    if (!colNames.has("title")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN title TEXT");
    }
    if (!colNames.has("last_active_at")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN last_active_at TEXT");
      // Backfill from created_at
      this.db.exec("UPDATE sessions SET last_active_at = created_at WHERE last_active_at IS NULL");
    }
    if (!colNames.has("model")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
    }
    if (!colNames.has("mode")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN mode TEXT");
    }
    if (!colNames.has("reasoning_effort")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT");
    }
    if (!colNames.has("source")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'auto'");
    }

    // messages — pending unbound notifications. POST /api/v1/messages with
    // `to = "user"` lands here; consumeMessageTx transactionally moves the
    // content into a new session's events and deletes the row. Bound
    // messages (to = session id) skip this table entirely and go straight
    // to `events`.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        from_ref        TEXT NOT NULL,
        from_label      TEXT,
        to_ref          TEXT NOT NULL,
        deliver         TEXT NOT NULL DEFAULT 'push',
        dedup_key       TEXT,
        title           TEXT NOT NULL,
        body            TEXT NOT NULL,
        cwd             TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_dedup   ON messages (to_ref, dedup_key);
    `);

    // recent_paths: LRU path list for /new menu
    const rpExists = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='recent_paths'"
    ).get();
    if (!rpExists) {
      this.db.exec(`
        CREATE TABLE recent_paths (
          cwd TEXT PRIMARY KEY,
          last_used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
        );
      `);
      // Backfill from existing sessions
      this.db.exec(`
        INSERT OR IGNORE INTO recent_paths (cwd, last_used_at)
        SELECT cwd, MAX(COALESCE(last_active_at, created_at))
        FROM sessions GROUP BY cwd;
      `);
    }

    // events.from_ref — origin marker for every event row.
    // Values: 'user' | 'system' | 'agent' | 'msg:<id>'. The 'msg:<id>'
    // form is reserved for events authored by consuming an inbox message
    // (see C7+). Bucketed backfill runs once for legacy rows.
    const eventCols = this.db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    const eventColNames = new Set(eventCols.map((c) => c.name));
    if (!eventColNames.has("from_ref")) {
      this.db.exec("ALTER TABLE events ADD COLUMN from_ref TEXT");
      // Buckets:
      //   user   — user-authored input
      //   system — client-originated side-channel actions + host responses
      //            (permission responses, local bash, system messages)
      //   agent  — everything else (assistant_message, thinking, tool_call,
      //            tool_call_update, plan, prompt_done, permission_request,
      //            etc.)
      this.db.exec(`
        UPDATE events SET from_ref = CASE
          WHEN type = 'user_message' THEN 'user'
          WHEN type IN ('permission_response', 'bash_command', 'bash_result',
                        'system_message') THEN 'system'
          ELSE 'agent'
        END
        WHERE from_ref IS NULL
      `);
    }

    // One-time orphan cleanup: rows whose session_id no longer exists in
    // `sessions`. Pre-FK writes could leave these behind (a session DELETE
    // that didn't cascade because the FK pragma was off). Must run before
    // enabling FK pragma.
    this.db.exec("DELETE FROM events WHERE session_id NOT IN (SELECT id FROM sessions)");

    // Secondary index for events queried by (session_id, type, created_at)
    // -- used by upcoming inbox/message consume queries.
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_events_type ON events(session_id, type, created_at)",
    );
  }

  createSession(id: string, cwd: string, source: string = "auto"): SessionRow {
    this.db.prepare("INSERT INTO sessions (id, cwd, source) VALUES (?, ?, ?)").run(id, cwd, source);
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow;
  }

  listSessions(opts?: { source?: string }): SessionRow[] {
    if (opts?.source) {
      return this.db.prepare("SELECT * FROM sessions WHERE source = ? ORDER BY COALESCE(last_active_at, created_at) DESC").all(opts.source) as SessionRow[];
    }
    return this.db.prepare("SELECT * FROM sessions ORDER BY COALESCE(last_active_at, created_at) DESC").all() as SessionRow[];
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM events WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  /** Delete sessions that have zero events and are older than minAgeS seconds. Returns IDs deleted. */
  deleteEmptySessions(minAgeS: number): string[] {
    const empties = this.db.prepare(`
      SELECT s.id FROM sessions s
      LEFT JOIN events e ON e.session_id = s.id
      WHERE e.id IS NULL
        AND strftime('%s', 'now') - strftime('%s', s.created_at) >= ?
    `).all(minAgeS) as Array<{ id: string }>;
    if (empties.length === 0) return [];
    const del = this.db.prepare("DELETE FROM sessions WHERE id = ?");
    for (const r of empties) del.run(r.id);
    return empties.map(r => r.id);
  }

  updateSessionTitle(id: string, title: string): void {
    this.db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, id);
  }

  updateSessionLastActive(id: string): void {
    this.db.prepare("UPDATE sessions SET last_active_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").run(id);
  }

  /** Update a config option value (model, mode, reasoning_effort) for a session. */
  updateSessionConfig(id: string, configId: string, value: string): void {
    const column = ({ model: "model", mode: "mode", reasoning_effort: "reasoning_effort" } as Record<string, string>)[configId];
    if (!column) return;
    this.db.prepare(`UPDATE sessions SET ${column} = ? WHERE id = ?`).run(value, id);
  }

  saveEvent(
    sessionId: string,
    type: string,
    data: Record<string, unknown> = {},
    opts?: { from_ref?: string },
  ): EventRow {
    const seq = (this.db.prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = ?"
    ).get(sessionId) as { next: number }).next;

    // from_ref defaults via the same buckets as the migration backfill so
    // existing call sites keep working without churn. Explicit values
    // (e.g. 'msg:<id>' for inbox-authored events) win when passed.
    const fromRef = opts?.from_ref ?? defaultFromRef(type);

    this.db.prepare(
      "INSERT INTO events (session_id, seq, type, data, from_ref) VALUES (?, ?, ?, ?, ?)"
    ).run(sessionId, seq, type, JSON.stringify(data), fromRef);

    return this.db.prepare("SELECT * FROM events WHERE session_id = ? AND seq = ?")
      .get(sessionId, seq) as EventRow;
  }

  getEvents(sessionId: string, opts?: { excludeThinking?: boolean; afterSeq?: number; beforeSeq?: number; limit?: number }): EventRow[] {
    const hasLimit = opts?.limit != null && opts.limit > 0;
    const conditions = ["session_id = ?"];
    const params: unknown[] = [sessionId];
    if (opts?.afterSeq != null) {
      conditions.push("seq > ?");
      params.push(opts.afterSeq);
    }
    if (opts?.beforeSeq != null) {
      conditions.push("seq < ?");
      params.push(opts.beforeSeq);
    }
    if (opts?.excludeThinking) {
      conditions.push("type != 'thinking'");
    }
    const where = conditions.join(" AND ");

    if (hasLimit) {
      // Fetch the last N matching rows: subquery orders DESC with LIMIT,
      // outer query re-orders ASC so the page is in chronological order.
      const sql = `SELECT * FROM (SELECT * FROM events WHERE ${where} ORDER BY seq DESC LIMIT ?) ORDER BY seq`;
      params.push(opts!.limit);
      return this.db.prepare(sql).all(...params) as EventRow[];
    }
    return this.db.prepare(`SELECT * FROM events WHERE ${where} ORDER BY seq`).all(...params) as EventRow[];
  }

  getEventCount(sessionId: string, opts?: { excludeThinking?: boolean }): number {
    let query = "SELECT COUNT(*) as count FROM events WHERE session_id = ?";
    const params: unknown[] = [sessionId];
    if (opts?.excludeThinking) {
      query += " AND type != 'thinking'";
    }
    return (this.db.prepare(query).get(...params) as { count: number }).count;
  }

  /** Check if the most recent agent turn was interrupted (user_message without a following prompt_done). */
  hasInterruptedTurn(sessionId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM events
      WHERE session_id = ? AND type = 'user_message'
        AND seq > COALESCE(
          (SELECT MAX(seq) FROM events WHERE session_id = ? AND type = 'prompt_done'),
          0
        )
      LIMIT 1
    `).get(sessionId, sessionId);
    return !!row;
  }

  // --- Push subscriptions ---

  saveSubscription(endpoint: string, auth: string, p256dh: string): void {
    this.db.prepare(
      `INSERT INTO push_subscriptions (endpoint, auth, p256dh)
       VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET auth = excluded.auth, p256dh = excluded.p256dh`,
    ).run(endpoint, auth, p256dh);
  }

  removeSubscription(endpoint: string): void {
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  getAllSubscriptions(): SubscriptionRow[] {
    return this.db.prepare("SELECT * FROM push_subscriptions").all() as SubscriptionRow[];
  }

  // --- Recent paths ---

  touchRecentPath(cwd: string): void {
    this.db.prepare(
      `INSERT INTO recent_paths (cwd, last_used_at)
       VALUES (?, strftime('%Y-%m-%d %H:%M:%f', 'now'))
       ON CONFLICT(cwd) DO UPDATE SET last_used_at = strftime('%Y-%m-%d %H:%M:%f', 'now')`,
    ).run(cwd);
  }

  listRecentPaths(opts?: { limit?: number; ttlDays?: number }): Array<{ cwd: string; last_used_at: string }> {
    const ttl = opts?.ttlDays ?? 0;
    if (ttl > 0) {
      this.db.prepare(
        "DELETE FROM recent_paths WHERE last_used_at < strftime('%Y-%m-%d %H:%M:%f', 'now', ?)"
      ).run(`-${ttl} days`);
    }
    const limit = opts?.limit;
    if (limit && limit > 0) {
      return this.db.prepare(
        "SELECT cwd, last_used_at FROM recent_paths ORDER BY last_used_at DESC LIMIT ?"
      ).all(limit) as Array<{ cwd: string; last_used_at: string }>;
    }
    return this.db.prepare(
      "SELECT cwd, last_used_at FROM recent_paths ORDER BY last_used_at DESC"
    ).all() as Array<{ cwd: string; last_used_at: string }>;
  }

  deleteRecentPath(cwd: string): void {
    this.db.prepare("DELETE FROM recent_paths WHERE cwd = ?").run(cwd);
  }

  // ===== messages (pending unbound notifications) =====

  createMessage(input: MessageInput): void {
    this.db
      .prepare(
        `INSERT INTO messages
         (id, from_ref, from_label, to_ref, deliver, dedup_key, title, body, cwd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.from_ref,
        input.from_label,
        input.to_ref,
        input.deliver,
        input.dedup_key,
        input.title,
        input.body,
        input.cwd,
        input.created_at,
      );
  }

  getMessage(id: string): MessageRow | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
  }

  listUnprocessed(): MessageRow[] {
    return this.db
      .prepare("SELECT * FROM messages ORDER BY created_at DESC")
      .all() as MessageRow[];
  }

  deleteMessage(id: string): number {
    const info = this.db.prepare("DELETE FROM messages WHERE id = ?").run(id);
    return info.changes;
  }

  /**
   * Delete unprocessed messages whose created_at is older than the given
   * epoch-ms threshold. Returns the number of rows removed.
   */
  deleteOlderThan(thresholdMs: number): number {
    const info = this.db.prepare("DELETE FROM messages WHERE created_at < ?").run(thresholdMs);
    return info.changes;
  }

  /** Find an existing unprocessed message matching (to_ref, dedup_key) for server-side supersede. */
  findBySupersede(to_ref: string, dedup_key: string | null): MessageRow | undefined {
    if (!dedup_key) return undefined;
    return this.db
      .prepare("SELECT * FROM messages WHERE to_ref = ? AND dedup_key = ? LIMIT 1")
      .get(to_ref, dedup_key) as MessageRow | undefined;
  }

  /**
   * Atomic consume: create a session, append a `message` event whose data
   * includes `message_id`, and delete the messages row -- all in a single
   * transaction. If the row is already gone, returns the prior session id
   * by looking up the historic `message` event; callers can treat this as
   * idempotent.
   */
  consumeMessageTx(
    messageId: string,
    opts: { sessionId: string; cwd?: string },
  ): { sessionId: string; alreadyConsumed: boolean } {
    // Fast idempotency pre-check outside the tx to avoid the cost of
    // opening one for an already-resolved message.
    const existing = this.findMessageEventSession(messageId);
    if (existing) {
      return { sessionId: existing, alreadyConsumed: true };
    }

    const row = this.getMessage(messageId);
    if (!row) {
      throw new Error(`consumeMessageTx: message not found (id=${messageId})`);
    }

    const tx = this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO sessions (id, cwd, source) VALUES (?, ?, ?)")
        .run(opts.sessionId, opts.cwd ?? row.cwd ?? "", "message");
      // Append message event via saveEvent so seq logic applies.
      this.saveEvent(
        opts.sessionId,
        "message",
        {
          message_id: row.id,
          from_ref: row.from_ref,
          from_label: row.from_label,
          title: row.title,
          body: row.body,
          cwd: row.cwd,
        },
        { from_ref: row.from_ref },
      );
      const del = this.db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
      if (del.changes === 0) {
        // Should never happen -- we just fetched the row above. If it does,
        // roll back via throw.
        throw new Error(`consumeMessageTx: row vanished mid-tx (id=${messageId})`);
      }
    });
    tx();

    return { sessionId: opts.sessionId, alreadyConsumed: false };
  }

  private findMessageEventSession(messageId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT session_id FROM events
         WHERE type = 'message'
           AND json_extract(data, '$.message_id') = ?
         LIMIT 1`,
      )
      .get(messageId) as { session_id: string } | undefined;
    return row?.session_id;
  }

  close(): void {
    this.db.close();
  }
}
