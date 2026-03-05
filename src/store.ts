import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface SessionRow {
  id: string;
  cwd: string;
  title: string | null;
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

export class Store {
  private db: Database.Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "agent-web.db"));
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
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
  }

  createSession(id: string, cwd: string): SessionRow {
    this.db.prepare("INSERT INTO sessions (id, cwd) VALUES (?, ?)").run(id, cwd);
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow;
  }

  listSessions(): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions ORDER BY COALESCE(last_active_at, created_at) DESC").all() as SessionRow[];
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM events WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  updateSessionTitle(id: string, title: string): void {
    this.db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, id);
  }

  updateSessionLastActive(id: string): void {
    this.db.prepare("UPDATE sessions SET last_active_at = datetime('now') WHERE id = ?").run(id);
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

  getEvents(sessionId: string, opts?: { excludeThinking?: boolean }): EventRow[] {
    let query = "SELECT * FROM events WHERE session_id = ?";
    if (opts?.excludeThinking) {
      query += " AND type != 'thinking'";
    }
    query += " ORDER BY seq";
    return this.db.prepare(query).all(sessionId) as EventRow[];
  }

  close(): void {
    this.db.close();
  }
}
