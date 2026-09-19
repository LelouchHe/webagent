import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Store } from "../src/store.ts";
import { TIMESTAMP_COLUMNS } from "../src/timestamp-migration.ts";

const AGENT = "test-agent";

/** 'YYYY-MM-DD HH:MM:SS' — the older of the two string formats in the wild. */
const NO_MS = "2026-09-19 15:51:07";
/** 'YYYY-MM-DD HH:MM:SS.SSS' — the current writer's format. */
const MS = "2026-09-19 15:51:07.123";

/** Expected values computed independently through JS `Date.parse`. */
const NO_MS_MILLIS = Date.parse("2026-09-19T15:51:07Z");
const MS_MILLIS = Date.parse("2026-09-19T15:51:07.123Z");

interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

function dbPath(dir: string): string {
  return join(dir, "webagent.db");
}

function readSchema(db: Database.Database): SchemaRow[] {
  return db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
    )
    .all() as SchemaRow[];
}

function signedColumns(): Array<[string, string]> {
  return Object.entries(TIMESTAMP_COLUMNS).flatMap(([table, columns]) =>
    columns.map((column): [string, string] => [table, column]),
  );
}

type LegacyVariant = "strftime" | "datetime";

/**
 * Create a database the way the *previous* release did: same DDL as
 * `initializeSchema`, except the eight timestamp columns are TEXT. Returns the
 * fresh canonical schema so it can be compared after migration.
 */
function createLegacyDatabase(
  dir: string,
  variant: LegacyVariant,
): SchemaRow[] {
  const seed = new Store(dir, AGENT);
  seed.close();
  const fresh = new Database(dbPath(dir));
  const freshSchema = readSchema(fresh);
  fresh.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath(dir)}${suffix}`, { force: true });
  }

  const legacy = new Database(dbPath(dir));
  // Tables must exist before the indexes that target them.
  const ordered = [...freshSchema].sort(
    (a, b) => (a.type === "table" ? 0 : 1) - (b.type === "table" ? 0 : 1),
  );
  for (const row of ordered) {
    if (row.sql === null || row.name === "sqlite_sequence") continue;
    const columns =
      row.type === "table" ? TIMESTAMP_COLUMNS[row.name] : undefined;
    legacy.exec(columns ? legacyTableSql(row.sql, columns, variant) : row.sql);
  }
  legacy.close();
  return freshSchema;
}

function legacyTableSql(
  sql: string,
  columns: readonly string[],
  variant: LegacyVariant,
): string {
  let out = sql;
  for (const column of columns) {
    const legacyType =
      variant === "strftime"
        ? "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))"
        : "TEXT NOT NULL DEFAULT (datetime('now'))";
    out = out.replace(
      new RegExp(`${column}(\\s+)INTEGER NOT NULL DEFAULT 0`),
      `${column}$1${legacyType}`,
    );
  }
  if (variant === "datetime") {
    // The oldest live DDL added this column without NOT NULL or a default.
    out = out.replace(
      "last_active_at TEXT NOT NULL DEFAULT (datetime('now'))",
      "last_active_at TEXT",
    );
  }
  return out;
}

/** Seed one row per migrated table, exercising both legacy string formats. */
function seedLegacyRows(db: Database.Database): void {
  db.prepare(
    "INSERT INTO tasks (id, cwd, created_at, last_active_at) VALUES (?, ?, ?, ?)",
  ).run("t1", "/x", NO_MS, MS);
  db.prepare(
    "INSERT INTO agent_sessions (agent_key, agent_session_id, task_id, created_at) VALUES (?, ?, ?, ?)",
  ).run(AGENT, "sess", "t1", NO_MS);
  db.prepare(
    "INSERT INTO events (task_id, seq, type, data, created_at, from_ref) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("t1", 1, "user_message", "{}", MS, "user");
  db.prepare(
    "INSERT INTO events (task_id, seq, type, data, created_at, from_ref) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("t1", 2, "assistant_message", '{"text":"hi"}', NO_MS, "agent");
  db.prepare(
    "INSERT INTO push_subscriptions (endpoint, auth, p256dh, created_at) VALUES (?, ?, ?, ?)",
  ).run("https://push.example/e", "auth", "p256dh", NO_MS);
  db.prepare(
    "INSERT INTO client_ops (task_id, client_op_id, result_json, created_at) VALUES (?, ?, ?, ?)",
  ).run("t1", "op", "{}", MS);
  db.prepare(
    `INSERT INTO attachments
       (id, task_id, kind, name, mime, size, realpath, upload_seq, width, height, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "att",
    "t1",
    "file",
    "f.txt",
    "text/plain",
    1,
    "/f.txt",
    2,
    null,
    null,
    NO_MS,
  );
  db.prepare("INSERT INTO recent_paths (cwd, last_used_at) VALUES (?, ?)").run(
    "/x",
    MS,
  );
}

function assertIntegerTimestamps(db: Database.Database): void {
  for (const [table, column] of signedColumns()) {
    const types = db
      .prepare(
        `SELECT DISTINCT typeof("${column}") AS t FROM "${table}" WHERE "${column}" IS NOT NULL`,
      )
      .all() as Array<{ t: string }>;
    assert.ok(
      types.every((row) => row.t === "integer"),
      `${table}.${column} must be stored as integer, saw ${JSON.stringify(types)}`,
    );
  }
}

describe("timestamp millis migration", () => {
  const dirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "webagent-ts-migration-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it("converts both legacy string formats to unix millis", () => {
    const dir = tempDir();
    createLegacyDatabase(dir, "strftime");
    const legacy = new Database(dbPath(dir));
    seedLegacyRows(legacy);
    legacy.close();

    assert.ok(Number.isFinite(NO_MS_MILLIS) && Number.isFinite(MS_MILLIS));

    const store = new Store(dir, AGENT);
    assert.equal(store.getTask("t1")!.created_at, NO_MS_MILLIS);
    assert.equal(store.getTask("t1")!.last_active_at, MS_MILLIS);
    assert.equal(store.getEvent("t1", 1)!.created_at, MS_MILLIS);
    assert.equal(store.getEvent("t1", 2)!.created_at, NO_MS_MILLIS);
    assert.equal(store.getAttachment("t1", "att")!.created_at, NO_MS_MILLIS);
    assert.equal(store.listRecentPaths()[0].last_used_at, MS_MILLIS);
    assert.equal(store.getAllSubscriptions()[0].created_at, NO_MS_MILLIS);
    store.close();

    const db = new Database(dbPath(dir));
    assertIntegerTimestamps(db);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.deepEqual(
      (db.pragma("integrity_check") as Array<{ integrity_check: string }>).map(
        (row) => row.integrity_check,
      ),
      ["ok"],
    );
    assert.deepEqual(db.prepare("SELECT created_at FROM client_ops").all(), [
      { created_at: MS_MILLIS },
    ]);
    db.close();
  });

  it("converges the migrated schema text on a freshly created database", () => {
    const dir = tempDir();
    const freshSchema = createLegacyDatabase(dir, "strftime");
    const legacy = new Database(dbPath(dir));
    seedLegacyRows(legacy);
    legacy.close();

    const store = new Store(dir, AGENT);
    store.close();

    const migrated = new Database(dbPath(dir));
    assert.deepEqual(readSchema(migrated), freshSchema);
    migrated.close();
  });

  it("accepts the oldest live DDL shape (datetime('now'), nullable column)", () => {
    const dir = tempDir();
    createLegacyDatabase(dir, "datetime");
    const legacy = new Database(dbPath(dir));
    // The oldest shape allowed NULL and had no default. A NULL must fall back
    // to the row's `created_at`, which is what listTasks' COALESCE already
    // meant, because the canonical declaration is NOT NULL.
    seedLegacyRows(legacy);
    legacy
      .prepare("UPDATE tasks SET last_active_at = NULL WHERE id = 't1'")
      .run();
    legacy.close();

    const store = new Store(dir, AGENT);
    assert.equal(store.getTask("t1")!.created_at, NO_MS_MILLIS);
    assert.equal(store.getTask("t1")!.last_active_at, NO_MS_MILLIS);
    assert.equal(store.getEvent("t1", 2)!.created_at, NO_MS_MILLIS);
    store.close();

    const db = new Database(dbPath(dir));
    assertIntegerTimestamps(db);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    db.close();
  });

  it("is idempotent — reopening a migrated database changes nothing", () => {
    const dir = tempDir();
    createLegacyDatabase(dir, "strftime");
    const legacy = new Database(dbPath(dir));
    seedLegacyRows(legacy);
    legacy.close();

    const first = new Store(dir, AGENT);
    first.close();
    const migrated = new Database(dbPath(dir));
    const schemaAfterFirstPass = readSchema(migrated);
    migrated.close();

    const second = new Store(dir, AGENT);
    assert.equal(second.getTask("t1")!.last_active_at, MS_MILLIS);
    second.close();

    const db = new Database(dbPath(dir));
    assert.deepEqual(readSchema(db), schemaAfterFirstPass);
    assertIntegerTimestamps(db);
    db.close();
  });

  it("never relies on the 0 default", () => {
    const dir = tempDir();
    const store = new Store(dir, AGENT);
    store.createTask("t1", "/x");
    store.saveEvent("t1", "user_message", {}, { from_ref: "user" });
    store.saveClientOp("t1", "op", {});
    store.touchRecentPath("/x");
    store.saveSubscription("https://push.example/e", "auth", "p256dh");
    store.close();

    const db = new Database(dbPath(dir));
    for (const [table, column] of signedColumns()) {
      const zeroed = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" = 0`)
          .get() as { n: number }
      ).n;
      assert.equal(zeroed, 0, `${table}.${column} relied on the DEFAULT 0`);
    }
    // The guard is only meaningful if the writers actually ran.
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
      1,
    );
    db.close();
  });

  it("leaves an already-integer database untouched", () => {
    const dir = tempDir();
    const store = new Store(dir, AGENT);
    store.createTask("t1", "/x");
    const created = store.getTask("t1")!.created_at;
    store.close();
    const before = new Database(dbPath(dir));
    const schema = readSchema(before);
    before.close();

    const reopened = new Store(dir, AGENT);
    assert.equal(reopened.getTask("t1")!.created_at, created);
    reopened.close();

    const db = new Database(dbPath(dir));
    assert.deepEqual(readSchema(db), schema);
    assertIntegerTimestamps(db);
    db.close();
  });
});
