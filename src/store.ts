import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
  created_at: string;
}

export interface SubscriptionRow {
  id: number;
  endpoint: string;
  auth: string;
  p256dh: string;
  created_at: string;
}

export class Store {
  private db: Database.Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "webagent.db"));
    this.db.pragma("journal_mode = WAL");
    this.migrate();
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

  saveEvent(sessionId: string, type: string, data: Record<string, unknown> = {}): EventRow {
    const seq = (this.db.prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = ?"
    ).get(sessionId) as { next: number }).next;

    this.db.prepare(
      "INSERT INTO events (session_id, seq, type, data) VALUES (?, ?, ?, ?)"
    ).run(sessionId, seq, type, JSON.stringify(data));

    return this.db.prepare("SELECT * FROM events WHERE session_id = ? AND seq = ?")
      .get(sessionId, seq) as EventRow;
  }

  getEvents(sessionId: string, opts?: { excludeThinking?: boolean; afterSeq?: number }): EventRow[] {
    let query = "SELECT * FROM events WHERE session_id = ?";
    const params: unknown[] = [sessionId];
    if (opts?.afterSeq != null) {
      query += " AND seq > ?";
      params.push(opts.afterSeq);
    }
    if (opts?.excludeThinking) {
      query += " AND type != 'thinking'";
    }
    query += " ORDER BY seq";
    return this.db.prepare(query).all(...params) as EventRow[];
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

  close(): void {
    this.db.close();
  }
}
