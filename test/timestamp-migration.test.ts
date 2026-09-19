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

/** The eight columns that were TEXT in old releases and need data conversion. */
const TEXT_TIMESTAMP_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tasks: ["created_at", "last_active_at"],
  agent_sessions: ["created_at"],
  events: ["created_at"],
  push_subscriptions: ["created_at"],
  client_ops: ["created_at"],
  attachments: ["created_at"],
  recent_paths: ["last_used_at"],
};

/** The two columns that were already INTEGER with a seconds-aligned default. */
const DEFAULT_ONLY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  shares: ["created_at"],
  owner_prefs: ["updated_at"],
};

const TEXT_TABLES = Object.keys(TEXT_TIMESTAMP_COLUMNS);

/** Columns that identify a row in the abort report and in samples. */
const IDENTITY: Readonly<Record<string, readonly string[]>> = {
  tasks: ["id"],
  agent_sessions: ["agent_key", "agent_session_id"],
  events: ["task_id", "seq"],
  push_subscriptions: ["endpoint"],
  client_ops: ["task_id", "client_op_id"],
  attachments: ["id"],
  recent_paths: ["cwd"],
};

/** Indexes that live on rebuilt tables and must survive the rebuild. */
const REBUILT_INDEXES = [
  "idx_events_task",
  "idx_events_type",
  "idx_tasks_parent_title_live",
  "idx_agent_sessions_task",
  "idx_attachments_task",
  "idx_shares_task",
  "shares_one_active_preview",
] as const;

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

function schemaSqlByName(db: Database.Database): Map<string, string | null> {
  return new Map(readSchema(db).map((row) => [row.name, row.sql]));
}

function signedColumns(): Array<[string, string]> {
  return Object.entries(TIMESTAMP_COLUMNS).flatMap(([table, columns]) =>
    columns.map((column): [string, string] => [table, column]),
  );
}

function tableCounts(db: Database.Database): Record<string, number> {
  return Object.fromEntries(
    TEXT_TABLES.map((table) => [
      table,
      (
        db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as {
          n: number;
        }
      ).n,
    ]),
  );
}

interface TimestampSample {
  table: string;
  column: string;
  id: string;
  value: string | number | null;
}

/** Every stored timestamp cell of the converted tables, keyed by row identity. */
function sampleTimestamps(db: Database.Database): TimestampSample[] {
  const samples: TimestampSample[] = [];
  for (const [table, columns] of Object.entries(TEXT_TIMESTAMP_COLUMNS)) {
    const keys = IDENTITY[table];
    const keyList = keys.map((key) => `"${key}"`).join(", ");
    for (const column of columns) {
      const rows = db
        .prepare(
          `SELECT ${keyList}, "${column}" AS value FROM "${table}" ORDER BY ${keyList}`,
        )
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const id = keys
          .map((key) => `${key}=${JSON.stringify(row[key])}`)
          .join(",");
        samples.push({
          table,
          column,
          id,
          value: row.value as string | number | null,
        });
      }
    }
  }
  return samples;
}

function sampleKey(sample: TimestampSample): string {
  return `${sample.table}.${sample.column}#${sample.id}`;
}

/** Independent conversion: treat the bare string as UTC and let JS parse it. */
function expectedMillis(value: string): number {
  return Date.parse(`${value.replace(" ", "T")}Z`);
}

type LegacyVariant = "strftime" | "datetime";

function legacyTypeFor(variant: LegacyVariant): string {
  return variant === "strftime"
    ? "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))"
    : "TEXT NOT NULL DEFAULT (datetime('now'))";
}

/** Turn a fresh target column into its legacy TEXT declaration. */
function legacyTextSql(
  sql: string,
  columns: readonly string[],
  variant: LegacyVariant,
): string {
  let out = sql;
  for (const column of columns) {
    out = out.replace(
      new RegExp(`${column}(\\s+)INTEGER NOT NULL DEFAULT 0`),
      `${column}$1${legacyTypeFor(variant)}`,
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

/** Turn a fresh target column into its legacy seconds-aligned default. */
function legacyDefaultSql(sql: string, columns: readonly string[]): string {
  let out = sql;
  for (const column of columns) {
    out = out.replace(
      new RegExp(`${column}(\\s+)INTEGER NOT NULL DEFAULT 0`),
      `${column}$1INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)`,
    );
  }
  return out;
}

/** The previous release's DDL for one table (fresh DDL, legacy declarations). */
function previousReleaseSql(
  table: string,
  sql: string,
  variant: LegacyVariant,
): string {
  if (table in TEXT_TIMESTAMP_COLUMNS) {
    return legacyTextSql(sql, TEXT_TIMESTAMP_COLUMNS[table], variant);
  }
  if (table in DEFAULT_ONLY_COLUMNS) {
    return legacyDefaultSql(sql, DEFAULT_ONLY_COLUMNS[table]);
  }
  return sql;
}

/**
 * Create a database the way a previous release did. Returns the fresh canonical
 * schema so it can be compared after migration.
 */
function createLegacyDatabase(
  dir: string,
  variant: LegacyVariant,
  override?: (table: string, sql: string) => string,
): SchemaRow[] {
  return buildLegacyDatabase(dir, (table, sql) => {
    let out = previousReleaseSql(table, sql, variant);
    if (override) out = override(table, out);
    return out;
  });
}

function buildLegacyDatabase(
  dir: string,
  transform: (table: string, sql: string) => string,
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
    legacy.exec(row.type === "table" ? transform(row.name, row.sql) : row.sql);
  }
  legacy.close();
  return freshSchema;
}

/**
 * The exact `tasks` / `events` DDL shapes the long-lived dogfood database
 * carries: quoted table names, columns appended out of order, `datetime('now')`
 * defaults, and a nullable `last_active_at` / `from_ref`.
 */
const HISTORICAL_TABLE_SQL: Readonly<Record<string, string>> = {
  tasks: `CREATE TABLE "tasks" (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      , title TEXT, last_active_at TEXT, model TEXT, mode TEXT, reasoning_effort TEXT, source TEXT NOT NULL DEFAULT 'auto', deleted_at INTEGER, parent_id TEXT REFERENCES "tasks"(id), pending_compact_summary TEXT, workflow_status TEXT NOT NULL DEFAULT 'idle' CHECK (workflow_status IN ('running', 'idle', 'blocked', 'done')))`,
  events: `CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES "tasks"(id),
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      , from_ref TEXT)`,
};

function createHistoricalDatabase(dir: string): SchemaRow[] {
  return buildLegacyDatabase(
    dir,
    (table, sql) =>
      HISTORICAL_TABLE_SQL[table] ?? previousReleaseSql(table, sql, "strftime"),
  );
}

/** Seed one row per converted table, exercising both legacy string formats. */
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

/** Multiple rows per converted table, so a dropped row cannot pass. */
function seedManyLegacyRows(db: Database.Database): void {
  for (let i = 1; i <= 3; i += 1) {
    db.prepare(
      "INSERT INTO tasks (id, cwd, created_at, last_active_at) VALUES (?, ?, ?, ?)",
    ).run(`t${i}`, "/x", NO_MS, MS);
    db.prepare(
      "INSERT INTO agent_sessions (agent_key, agent_session_id, task_id, created_at) VALUES (?, ?, ?, ?)",
    ).run(AGENT, `sess${i}`, `t${i}`, i % 2 === 1 ? NO_MS : MS);
    db.prepare(
      "INSERT INTO push_subscriptions (endpoint, auth, p256dh, created_at) VALUES (?, ?, ?, ?)",
    ).run(`https://push.example/${i}`, "auth", "p256dh", NO_MS);
    db.prepare(
      "INSERT INTO client_ops (task_id, client_op_id, result_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(`t${i}`, `op${i}`, "{}", MS);
    db.prepare(
      "INSERT INTO recent_paths (cwd, last_used_at) VALUES (?, ?)",
    ).run(`/p${i}`, NO_MS);
    db.prepare(
      `INSERT INTO attachments
         (id, task_id, kind, name, mime, size, realpath, upload_seq, width, height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `att${i}`,
      `t${i}`,
      "file",
      `f${i}.txt`,
      "text/plain",
      1,
      `/f${i}.txt`,
      2,
      null,
      null,
      MS,
    );
    for (let seq = 1; seq <= 2; seq += 1) {
      db.prepare(
        "INSERT INTO events (task_id, seq, type, data, created_at, from_ref) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        `t${i}`,
        seq,
        seq === 1 ? "user_message" : "assistant_message",
        "{}",
        seq === 1 ? NO_MS : MS,
        seq === 1 ? "user" : "agent",
      );
    }
  }
}

function dbPrepareTask(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO tasks (id, cwd, created_at, last_active_at) VALUES (?, ?, ?, ?)",
  ).run(id, "/x", NO_MS, MS);
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

function assertIntegrity(db: Database.Database): void {
  assert.deepEqual(
    (db.pragma("integrity_check") as Array<{ integrity_check: string }>).map(
      (row) => row.integrity_check,
    ),
    ["ok"],
  );
  assert.deepEqual(db.pragma("foreign_key_check"), []);
}

interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
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

  it("converges exactly the columns the contract lists", () => {
    assert.deepEqual(TIMESTAMP_COLUMNS, {
      ...TEXT_TIMESTAMP_COLUMNS,
      ...DEFAULT_ONLY_COLUMNS,
    });
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
    assertIntegrity(db);
    assert.deepEqual(db.prepare("SELECT created_at FROM client_ops").all(), [
      { created_at: MS_MILLIS },
    ]);
    db.close();
  });

  it("preserves every row and converts every value", () => {
    const dir = tempDir();
    createLegacyDatabase(dir, "strftime");
    const legacy = new Database(dbPath(dir));
    seedManyLegacyRows(legacy);
    const preCounts = tableCounts(legacy);
    const preSamples = sampleTimestamps(legacy);
    legacy.close();

    // Non-vacuous counts: every converted table actually holds rows.
    for (const [table, count] of Object.entries(preCounts)) {
      assert.ok(count > 0, `${table} must be seeded (got ${count})`);
    }
    assert.equal(preCounts.events, 6);
    assert.equal(preCounts.tasks, 3);
    assert.equal(preSamples.length, 27);
    assert.ok(preSamples.every((sample) => typeof sample.value === "string"));

    const store = new Store(dir, AGENT);
    store.close();

    const db = new Database(dbPath(dir));
    assert.deepEqual(
      tableCounts(db),
      preCounts,
      "row counts must be preserved",
    );
    const post = sampleTimestamps(db);
    assert.equal(post.length, preSamples.length, "no sample may disappear");
    const expected = new Map(
      preSamples.map((sample) => [sampleKey(sample), sample.value as string]),
    );
    for (const sample of post) {
      const old = expected.get(sampleKey(sample));
      assert.ok(old !== undefined, `missing sample ${sampleKey(sample)}`);
      assert.equal(
        sample.value,
        expectedMillis(old),
        `value for ${sampleKey(sample)}`,
      );
    }
    assertIntegerTimestamps(db);
    assertIntegrity(db);
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

  it("recreates every index that lives on a rebuilt table", () => {
    const dir = tempDir();
    const freshSchema = createLegacyDatabase(dir, "strftime");
    const legacy = new Database(dbPath(dir));
    seedLegacyRows(legacy);
    legacy.close();

    const store = new Store(dir, AGENT);
    store.close();

    const db = new Database(dbPath(dir));
    const freshIndexes = new Map(
      freshSchema
        .filter((row) => row.type === "index")
        .map((row) => [row.name, row.sql]),
    );
    const liveIndexes = schemaSqlByName(db);
    for (const name of REBUILT_INDEXES) {
      assert.ok(liveIndexes.has(name), `missing index ${name}`);
      assert.equal(
        liveIndexes.get(name),
        freshIndexes.get(name),
        `index text for ${name}`,
      );
    }
    assertIntegrity(db);
    db.close();
  });

  it("converges INTEGER columns that still carry the legacy seconds default", () => {
    const dir = tempDir();
    const freshSchema = createLegacyDatabase(dir, "strftime");
    const legacy = new Database(dbPath(dir));
    dbPrepareTask(legacy, "t1");
    // Written through the old default, so both values are seconds aligned.
    legacy
      .prepare(
        "INSERT INTO shares (token, task_id, share_snapshot_seq) VALUES (?, ?, ?)",
      )
      .run("tok", "t1", 1);
    legacy
      .prepare("INSERT INTO owner_prefs (key, value) VALUES (?, ?)")
      .run("k", "v");
    const before = legacy
      .prepare(
        "SELECT (SELECT created_at FROM shares WHERE token = 'tok') AS share_at, (SELECT updated_at FROM owner_prefs WHERE key = 'k') AS pref_at",
      )
      .get() as { share_at: number; pref_at: number };
    assert.equal(before.share_at % 1000, 0, "expected the legacy default");
    assert.equal(before.pref_at % 1000, 0, "expected the legacy default");
    const sharesBefore = schemaSqlByName(legacy).get("shares")!;
    assert.match(
      sharesBefore,
      /CAST\(strftime\('%s','now'\) AS INTEGER\) \* 1000/,
    );
    legacy.close();

    const store = new Store(dir, AGENT);
    store.close();

    const db = new Database(dbPath(dir));
    const live = schemaSqlByName(db);
    assert.equal(
      live.get("shares"),
      freshSchema.find((r) => r.name === "shares")!.sql,
    );
    assert.equal(
      live.get("owner_prefs"),
      freshSchema.find((r) => r.name === "owner_prefs")!.sql,
    );
    assert.ok(!live.get("shares")!.includes("strftime"));
    assert.ok(!live.get("owner_prefs")!.includes("strftime"));
    // Values are copied through untouched, not run through julianday().
    assert.deepEqual(
      db.prepare("SELECT created_at FROM shares WHERE token = 'tok'").get(),
      { created_at: before.share_at },
    );
    assert.deepEqual(
      db.prepare("SELECT updated_at FROM owner_prefs WHERE key = 'k'").get(),
      { updated_at: before.pref_at },
    );
    assertIntegerTimestamps(db);
    assertIntegrity(db);
    db.close();
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
    assertIntegrity(db);
    db.close();
  });

  it("migrates the real historical tasks/events layout without rewriting it", () => {
    const dir = tempDir();
    const freshSchema = createHistoricalDatabase(dir);
    const legacy = new Database(dbPath(dir));
    legacy
      .prepare(
        "INSERT INTO tasks (id, cwd, created_at, last_active_at) VALUES (?, ?, ?, ?)",
      )
      .run("t1", "/x", NO_MS, null);
    legacy
      .prepare(
        "INSERT INTO tasks (id, cwd, created_at, last_active_at) VALUES (?, ?, ?, ?)",
      )
      .run("t2", "/y", MS, MS);
    legacy
      .prepare(
        "INSERT INTO agent_sessions (agent_key, agent_session_id, task_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(AGENT, "sess1", "t1", NO_MS);
    legacy
      .prepare(
        "INSERT INTO agent_sessions (agent_key, agent_session_id, task_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(AGENT, "sess2", "t2", MS);
    legacy
      .prepare(
        "INSERT INTO events (task_id, seq, type, data, created_at, from_ref) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("t1", 1, "user_message", "{}", MS, "user");
    legacy
      .prepare(
        "INSERT INTO events (task_id, seq, type, data, created_at, from_ref) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("t1", 2, "assistant_message", '{"text":"hi"}', NO_MS, "agent");
    legacy.close();

    const store = new Store(dir, AGENT);
    assert.equal(store.getTask("t1")!.created_at, NO_MS_MILLIS);
    assert.equal(store.getTask("t1")!.last_active_at, NO_MS_MILLIS);
    assert.equal(store.getTask("t2")!.last_active_at, MS_MILLIS);
    assert.equal(store.getEvent("t1", 1)!.created_at, MS_MILLIS);
    assert.equal(store.getEvent("t1", 2)!.created_at, NO_MS_MILLIS);
    store.close();

    const db = new Database(dbPath(dir));
    const live = schemaSqlByName(db);
    const tasksSql = live.get("tasks")!;
    const eventsSql = live.get("events")!;
    // The historical layout (quoted name, out-of-order columns) is preserved;
    // only the timestamp declarations converge.
    assert.ok(tasksSql.startsWith('CREATE TABLE "tasks" ('), tasksSql);
    assert.ok(eventsSql.startsWith("CREATE TABLE events ("), eventsSql);
    assert.match(tasksSql, /created_at INTEGER NOT NULL DEFAULT 0/);
    assert.match(tasksSql, /last_active_at INTEGER NOT NULL DEFAULT 0/);
    assert.match(eventsSql, /created_at INTEGER NOT NULL DEFAULT 0/);
    assert.ok(!tasksSql.includes("datetime('now')"), tasksSql);
    assert.ok(!eventsSql.includes("datetime('now')"), eventsSql);
    // Nullable legacy columns that are not timestamp columns are untouched.
    assert.match(eventsSql, /from_ref TEXT\)/);

    const freshIndexes = new Map(
      freshSchema
        .filter((row) => row.type === "index")
        .map((row) => [row.name, row.sql]),
    );
    for (const name of [
      "idx_events_task",
      "idx_events_type",
      "idx_tasks_parent_title_live",
    ]) {
      assert.equal(
        live.get(name),
        freshIndexes.get(name),
        `index text ${name}`,
      );
    }
    assertIntegerTimestamps(db);
    assertIntegrity(db);
    db.close();
  });

  it("rebuilds an INTEGER column whose default is still the legacy expression", () => {
    const dir = tempDir();
    createLegacyDatabase(dir, "strftime", (table, sql) =>
      table === "client_ops"
        ? sql.replace(
            "created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))",
            "created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)",
          )
        : sql,
    );
    const legacy = new Database(dbPath(dir));
    seedLegacyRows(legacy);
    // An already-millisecond value must be copied through, never run through
    // julianday() (which would corrupt it).
    legacy.prepare("UPDATE client_ops SET created_at = ?").run(1789833067123);
    const beforeDdl = schemaSqlByName(legacy).get("client_ops")!;
    assert.match(
      beforeDdl,
      /CAST\(strftime\('%s','now'\) AS INTEGER\) \* 1000/,
    );
    legacy.close();

    const store = new Store(dir, AGENT);
    store.close();

    const db = new Database(dbPath(dir));
    assert.match(
      schemaSqlByName(db).get("client_ops")!,
      /created_at {3}INTEGER NOT NULL DEFAULT 0/,
    );
    assert.deepEqual(db.prepare("SELECT created_at FROM client_ops").all(), [
      { created_at: 1789833067123 },
    ]);
    assertIntegerTimestamps(db);
    assertIntegrity(db);
    db.close();
  });

  it("converts boundary values without aborting", () => {
    const dir = tempDir();
    createLegacyDatabase(dir, "strftime");
    const legacy = new Database(dbPath(dir));
    dbPrepareTask(legacy, "t1");
    const insert = legacy.prepare(
      "INSERT INTO events (task_id, seq, type, data, created_at, from_ref) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("t1", 1, "user_message", "{}", "1970-01-01 00:00:00", "user");
    insert.run(
      "t1",
      2,
      "assistant_message",
      "{}",
      "9999-12-31 23:59:59",
      "agent",
    );
    // A real leap day must still be accepted.
    insert.run("t1", 3, "user_message", "{}", "2024-02-29 00:00:00", "user");
    legacy.close();

    const store = new Store(dir, AGENT);
    assert.equal(store.getEvent("t1", 1)!.created_at, 0);
    assert.equal(
      store.getEvent("t1", 2)!.created_at,
      Date.parse("9999-12-31T23:59:59Z"),
    );
    assert.equal(
      store.getEvent("t1", 3)!.created_at,
      Date.parse("2024-02-29T00:00:00Z"),
    );
    store.close();
  });

  for (const bad of [
    "0",
    "",
    "not-a-date",
    "2026-13-45 99:99:99",
    "now",
    "2026-09-19T15:51:07",
    "2026-09-19",
    " 2026-09-19 15:51:07",
    // Calendar-invalid values SQLite would otherwise normalize silently.
    "2026-02-29 00:00:00",
    "2026-04-31 00:00:00",
    "2026-06-31 00:00:00",
    "2026-02-30 00:00:00",
    "2026-09-19 24:00:00",
    "2026-09-19 23:59:60",
    "2026-02-29 00:00:00.000",
  ]) {
    it(`aborts and rolls back on malformed legacy value ${JSON.stringify(bad)}`, () => {
      const dir = tempDir();
      createLegacyDatabase(dir, "strftime");
      const legacy = new Database(dbPath(dir));
      dbPrepareTask(legacy, "t1");
      legacy
        .prepare(
          "INSERT INTO events (task_id, seq, type, data, created_at, from_ref) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("t1", 1, "user_message", "{}", bad, "user");
      const schemaBefore = readSchema(legacy);
      const countsBefore = tableCounts(legacy);
      legacy.close();

      assert.throws(
        () => new Store(dir, AGENT),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Timestamp migration aborted/);
          assert.match(error.message, /events\.created_at/);
          assert.ok(
            error.message.includes('task_id="t1"'),
            `expected the offending task id, got: ${error.message}`,
          );
          assert.ok(
            error.message.includes("seq=1"),
            `expected the offending seq, got: ${error.message}`,
          );
          assert.ok(
            error.message.includes(JSON.stringify(bad)),
            `expected the original value ${JSON.stringify(bad)}, got: ${error.message}`,
          );
          return true;
        },
      );

      // Fail closed: nothing was rebuilt, converted, or left behind.
      const db = new Database(dbPath(dir));
      assert.deepEqual(readSchema(db), schemaBefore);
      assert.deepEqual(tableCounts(db), countsBefore);
      assert.deepEqual(
        db
          .prepare(
            "SELECT typeof(created_at) AS t, created_at AS v FROM events",
          )
          .all(),
        [{ t: "text", v: bad }],
      );
      assert.deepEqual(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name LIKE '%timestamp_migration%'",
          )
          .all(),
        [],
      );
      db.close();
    });
  }

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
    store.insertSharePreview({ token: "tok", taskId: "t1", snapshotSeq: 1 });
    store.setOwnerPref("k", "v");
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
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM shares").get() as { n: number }).n,
      1,
    );
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS n FROM owner_prefs").get() as {
          n: number;
        }
      ).n,
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
