import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { migrateS3Database } from "../scripts/migrate-s3-0.ts";
import { Store } from "../src/store.ts";

describe("migrate-s3-0", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backs up before renaming inbox messages and normalizing task data", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "webagent-s3-migration-"));
    dirs.push(dataDir);
    const dbPath = join(dataDir, "webagent.db");
    const backupPath = join(dataDir, "webagent.pre-s3-0.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        title TEXT,
        parent_id TEXT REFERENCES tasks(id),
        pending_compact_summary TEXT,
        model TEXT,
        mode TEXT,
        reasoning_effort TEXT,
        source TEXT NOT NULL DEFAULT 'auto',
        deleted_at INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        last_active_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
      );
      CREATE TABLE agent_sessions (
        agent_key TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        PRIMARY KEY (agent_key, agent_session_id)
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        from_ref TEXT NOT NULL,
        from_label TEXT,
        to_ref TEXT NOT NULL,
        deliver TEXT NOT NULL DEFAULT 'push',
        dedup_key TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        cwd TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_messages_created ON messages (created_at);
      CREATE INDEX idx_messages_dedup ON messages (to_ref, dedup_key);
    `);
    db.prepare(
      "INSERT INTO tasks (id, cwd, title, source, parent_id) VALUES (?, ?, ?, ?, ?)",
    ).run("root", "/tmp/root", null, "root", null);
    db.prepare(
      "INSERT INTO tasks (id, cwd, title, source, parent_id) VALUES (?, ?, ?, ?, ?)",
    ).run("child-a", "/tmp/a", "same/title", "auto", "root");
    db.prepare(
      "INSERT INTO tasks (id, cwd, title, source, parent_id) VALUES (?, ?, ?, ?, ?)",
    ).run("child-b", "/tmp/b", "same/title", "auto", "root");
    db.prepare(
      "INSERT INTO agent_sessions (agent_key, agent_session_id, task_id) VALUES (?, ?, ?)",
    ).run("test-agent", "current-agent-session", "child-a");
    db.prepare(
      "INSERT INTO agent_sessions (agent_key, agent_session_id, task_id) VALUES (?, ?, NULL)",
    ).run("test-agent", "old-title-session");
    db.prepare(
      `INSERT INTO messages
       (id, from_ref, to_ref, title, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("inbox-1", "external", "user", "notice", "preserve me", 100);
    db.close();

    const result = await migrateS3Database({ dataDir, backupPath });

    assert.equal(existsSync(backupPath), true);
    const backup = new Database(backupPath, { readonly: true });
    assert.equal(
      (
        backup
          .prepare("SELECT body FROM messages WHERE id = ?")
          .get("inbox-1") as { body: string }
      ).body,
      "preserve me",
    );
    backup.close();

    const migrated = new Database(dbPath, { readonly: true });
    assert.equal(
      (
        migrated
          .prepare("SELECT body FROM inbox_messages WHERE id = ?")
          .get("inbox-1") as { body: string }
      ).body,
      "preserve me",
    );
    assert.equal(
      (
        migrated.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
          count: number;
        }
      ).count,
      0,
    );
    const titles = migrated
      .prepare(
        "SELECT id, title, brief, workflow_status FROM tasks ORDER BY id",
      )
      .all() as Array<{
      id: string;
      title: string;
      brief: string;
      workflow_status: string;
    }>;
    assert.deepEqual(titles, [
      {
        id: "child-a",
        title: "same-title",
        brief: "",
        workflow_status: "idle",
      },
      {
        id: "child-b",
        title: "same-title-child-b",
        brief: "",
        workflow_status: "idle",
      },
      { id: "root", title: "root", brief: "", workflow_status: "idle" },
    ]);
    assert.equal(
      (
        migrated
          .prepare(
            "SELECT task_id FROM agent_sessions WHERE agent_session_id = 'old-title-session'",
          )
          .get() as { task_id: string | null }
      ).task_id,
      null,
    );
    migrated.close();
    assert.deepEqual(result.unboundAgentSessionIds, ["old-title-session"]);

    const store = new Store(dataDir, "test-agent");
    store.close();
  });
});
