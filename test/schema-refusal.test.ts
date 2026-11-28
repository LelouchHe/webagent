import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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
  const walPath = `${dbPath}-wal`;
  const beforeWalHash = existsSync(walPath) ? sha256(walPath) : null;
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
  if (beforeWalHash !== null) {
    assert.equal(sha256(walPath), beforeWalHash);
  }
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
    const dir = mkdtempSync(join(tmpdir(), "webagent-wal-refusal-"));
    const dbPath = join(dir, "webagent.db");
    const script = `
      import Database from "better-sqlite3";
      const db = new Database(${JSON.stringify(dbPath)});
      db.pragma("journal_mode = WAL");
      db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, brief TEXT, created_at INTEGER NOT NULL DEFAULT 0)");
      db.exec("INSERT INTO tasks (id, brief) VALUES ('old-task', 'legacy')");
      process.kill(process.pid, "SIGKILL");
    `;
    try {
      const child = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", script],
        { cwd: process.cwd() },
      );
      assert.equal(child.signal, "SIGKILL");
      assert.equal(existsSync(`${dbPath}-wal`), true);
      if (existsSync(`${dbPath}-shm`)) {
        rmSync(`${dbPath}-shm`);
      }
      const walHash = sha256(`${dbPath}-wal`);
      const dbHash = sha256(dbPath);

      assert.throws(
        () => new Store(dir),
        (error: unknown) =>
          error instanceof LegacyDatabaseError &&
          /created by an older WebAgent/i.test(error.message),
      );

      assert.equal(sha256(dbPath), dbHash);
      assert.equal(sha256(`${dbPath}-wal`), walHash);
    } finally {
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
