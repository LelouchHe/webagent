import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Store } from "../src/store.ts";

describe("Store events.from_ref + orphan cleanup + FK", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-from-ref-"));
    dbPath = join(tmpDir, "webagent.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saveEvent persists explicit from_ref values per category", () => {
    const store = new Store(tmpDir);
    store.createSession("s1", "/tmp");

    const userMsg = store.saveEvent(
      "s1",
      "user_message",
      { text: "hi" },
      { from_ref: "user" },
    );
    const permResp = store.saveEvent(
      "s1",
      "permission_response",
      { ok: true },
      { from_ref: "system" },
    );
    const bashCmd = store.saveEvent(
      "s1",
      "bash_command",
      { cmd: "ls" },
      { from_ref: "user" },
    );
    const assistant = store.saveEvent(
      "s1",
      "assistant_message",
      { text: "ack" },
      { from_ref: "agent" },
    );
    const toolCall = store.saveEvent(
      "s1",
      "tool_call",
      { id: "t1" },
      { from_ref: "agent" },
    );

    assert.equal(userMsg.from_ref, "user");
    assert.equal(permResp.from_ref, "system");
    assert.equal(bashCmd.from_ref, "user");
    assert.equal(assistant.from_ref, "agent");
    assert.equal(toolCall.from_ref, "agent");

    store.close();
  });

  it("saveEvent accepts msg:<id> form for inbox-authored events", () => {
    const store = new Store(tmpDir);
    store.createSession("s1", "/tmp");

    const ev = store.saveEvent(
      "s1",
      "assistant_message",
      { text: "from inbox" },
      {
        from_ref: "msg:abc123",
      },
    );
    assert.equal(ev.from_ref, "msg:abc123");

    store.close();
  });

  it("saveEvent THROWS when from_ref is missing (guard active)", () => {
    const store = new Store(tmpDir);
    store.createSession("s1", "/tmp");
    assert.throws(
      () => store.saveEvent("s1", "user_message", { text: "x" }),
      /from_ref/,
    );
    store.close();
  });

  it("backfills from_ref on legacy rows (column added by ALTER, NULL backfilled by buckets)", () => {
    // Build a legacy DB without the from_ref column and seed mixed rows.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        last_active_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')));
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
      );
      INSERT INTO sessions (id, cwd) VALUES ('s1', '/tmp');
      INSERT INTO events (session_id, seq, type, data) VALUES
        ('s1', 1, 'user_message', '{}'),
        ('s1', 2, 'assistant_message', '{}'),
        ('s1', 3, 'bash_command', '{}'),
        ('s1', 4, 'permission_response', '{}'),
        ('s1', 5, 'plan', '{}');
    `);
    legacy.close();

    // Open via Store -- migrate() must add the column and backfill all rows.
    const store = new Store(tmpDir);
    const rows = store["db"]
      .prepare(
        "SELECT seq, type, from_ref FROM events WHERE session_id = 's1' ORDER BY seq",
      )
      .all() as Array<{ seq: number; type: string; from_ref: string }>;

    assert.equal(rows.length, 5);
    assert.equal(rows[0].from_ref, "user");
    assert.equal(rows[1].from_ref, "agent");
    assert.equal(rows[2].from_ref, "system");
    assert.equal(rows[3].from_ref, "system");
    assert.equal(rows[4].from_ref, "agent");

    store.close();
  });

  it("orphan cleanup removes events whose session_id is gone", () => {
    // Build a legacy DB with FK off so orphan rows can exist.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        last_active_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')));
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
      );
      INSERT INTO sessions (id, cwd) VALUES ('alive', '/tmp');
      INSERT INTO events (session_id, seq, type, data) VALUES
        ('alive', 1, 'user_message', '{}'),
        ('orphan', 1, 'user_message', '{}'),
        ('orphan', 2, 'assistant_message', '{}');
    `);
    legacy.close();

    const store = new Store(tmpDir);
    const orphans = store["db"]
      .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 'orphan'")
      .get() as { n: number };
    assert.equal(
      orphans.n,
      0,
      "orphan rows must be cleaned up at migrate time",
    );
    const alive = store["db"]
      .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 'alive'")
      .get() as { n: number };
    assert.equal(alive.n, 1, "non-orphan rows must survive cleanup");

    store.close();
  });

  it("foreign_keys pragma is on after construction (rejects orphan inserts)", () => {
    const store = new Store(tmpDir);
    const fk = store["db"].pragma("foreign_keys", { simple: true });
    assert.equal(fk, 1, "foreign_keys pragma must be on");

    store.createSession("s1", "/tmp");
    // Insert into a real session works
    assert.doesNotThrow(() =>
      store.saveEvent("s1", "user_message", {}, { from_ref: "user" }),
    );
    // Insert into a non-existent session is rejected by the FK
    assert.throws(
      () =>
        store.saveEvent("s2-missing", "user_message", {}, { from_ref: "user" }),
      /FOREIGN KEY constraint failed/i,
    );

    store.close();
  });

  it("idx_events_type exists after migrate", () => {
    const store = new Store(tmpDir);
    const idx = store["db"]
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_type'",
      )
      .get() as { name: string } | undefined;
    assert.equal(idx?.name, "idx_events_type");
    store.close();
  });
});
