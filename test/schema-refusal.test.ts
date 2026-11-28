import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { LegacyDatabaseError } from "../src/legacy-database.ts";
import { Store } from "../src/store.ts";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function freshDatabase(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "webagent-schema-refusal-"));
  const store = new Store(dir);
  store.close();
  return { dir, dbPath: join(dir, "webagent.db") };
}

function replaceTable(
  db: Database.Database,
  table: string,
  transform: (sql: string) => string,
): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string };
  const replacement = transform(row.sql);
  assert.notEqual(replacement, row.sql, `fixture must change ${table}`);
  db.pragma("foreign_keys = OFF");
  db.exec(`DROP TABLE "${table}"; ${replacement};`);
}

function assertRefusedWithoutChanges(
  dir: string,
  dbPath: string,
  reason: RegExp,
): void {
  const beforeHash = sha256(dbPath);
  const beforeFiles = readdirSync(dir).sort();
  assert.throws(
    () => new Store(dir),
    (error: unknown) => {
      assert.ok(error instanceof LegacyDatabaseError);
      assert.match(error.message, /Pre-1\.0 data directory detected/);
      assert.match(error.message, reason);
      assert.match(error.message, /Nothing in it was changed/);
      return true;
    },
  );
  assert.equal(sha256(dbPath), beforeHash);
  assert.deepEqual(readdirSync(dir).sort(), beforeFiles);
  assert.equal(existsSync(`${dbPath}-wal`), false);
  assert.equal(existsSync(`${dbPath}-shm`), false);
}

describe("pre-1.0 schema refusal", () => {
  it("refuses old TEXT timestamp declarations without modifying the file", () => {
    const { dir, dbPath } = freshDatabase();
    try {
      const db = new Database(dbPath);
      replaceTable(db, "tasks", (sql) =>
        sql.replace(
          "created_at INTEGER NOT NULL DEFAULT 0",
          "created_at TEXT NOT NULL DEFAULT (datetime('now'))",
        ),
      );
      db.close();
      assertRefusedWithoutChanges(dir, dbPath, /tasks\.created_at.*INTEGER/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses old timestamp defaults without modifying the file", () => {
    const { dir, dbPath } = freshDatabase();
    try {
      const db = new Database(dbPath);
      replaceTable(db, "shares", (sql) =>
        sql.replace(
          "created_at INTEGER NOT NULL DEFAULT 0",
          "created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)",
        ),
      );
      db.close();
      assertRefusedWithoutChanges(
        dir,
        dbPath,
        /shares\.created_at.*legacy.*default/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses the retired task-only agent session index", () => {
    const { dir, dbPath } = freshDatabase();
    try {
      const db = new Database(dbPath);
      db.exec(
        "CREATE UNIQUE INDEX idx_agent_sessions_task ON agent_sessions(task_id) WHERE task_id IS NOT NULL",
      );
      db.close();
      assertRefusedWithoutChanges(
        dir,
        dbPath,
        /legacy index idx_agent_sessions_task/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses tasks.brief instead of dropping it at startup", () => {
    const { dir, dbPath } = freshDatabase();
    try {
      const db = new Database(dbPath);
      db.exec("ALTER TABLE tasks ADD COLUMN brief TEXT");
      db.close();
      assertRefusedWithoutChanges(dir, dbPath, /legacy column tasks\.brief/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an old schema committed only to WAL without changing DB or WAL", () => {
    const { dir, dbPath } = freshDatabase();
    const db = new Database(dbPath);
    try {
      db.pragma("journal_mode = WAL");
      db.exec("ALTER TABLE tasks ADD COLUMN brief TEXT");
      assert.equal(existsSync(`${dbPath}-wal`), true);
      const walHash = sha256(`${dbPath}-wal`);
      const dbHash = sha256(dbPath);
      const beforeFiles = readdirSync(dir).sort();

      assert.throws(
        () => new Store(dir),
        (error: unknown) =>
          error instanceof LegacyDatabaseError &&
          /legacy column tasks\.brief/.test(error.message),
      );

      assert.equal(sha256(dbPath), dbHash);
      assert.equal(sha256(`${dbPath}-wal`), walHash);
      assert.deepEqual(readdirSync(dir).sort(), beforeFiles);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates non-schema SQLite preflight errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-schema-error-"));
    try {
      writeFileSync(join(dir, "webagent.db"), "not a sqlite database");
      assert.throws(() => new Store(dir), /file is not a database/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
