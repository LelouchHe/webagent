import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { Store } from "../src/store.ts";
import {
  detectLegacyDatabase,
  LegacyDatabaseError,
} from "../src/legacy-database.ts";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function makeLegacyDb(
  dir: string,
  agentKey: string,
  rootId: string | null,
  options: { namedRoot?: boolean } = {},
): string {
  const dbPath = join(dir, "webagent.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      title TEXT,
      parent_id TEXT,
      deleted_at INTEGER
    );
    CREATE TABLE agent_sessions (
      agent_key TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      task_id TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_key, agent_session_id)
    );
  `);
  if (rootId !== null) {
    db.prepare(
      "INSERT INTO tasks (id, cwd, title, parent_id, deleted_at) VALUES (?, ?, ?, NULL, NULL)",
    ).run(rootId, "/tmp/legacy", "root");
  }
  db.prepare(
    "INSERT INTO tasks (id, cwd, title, parent_id, deleted_at) VALUES (?, ?, ?, ?, NULL)",
  ).run("legacy-child", "/tmp/legacy", "child", rootId);
  db.prepare(
    "INSERT INTO agent_sessions (agent_key, agent_session_id, task_id, created_at) VALUES (?, ?, ?, ?)",
  ).run(agentKey, "legacy-session", rootId ?? "legacy-child", Date.now());
  if (options.namedRoot && rootId !== null) {
    db.exec(
      "CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK (id = 1), root_task_id TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO workspace (id, root_task_id) VALUES (1, ?)").run(
      rootId,
    );
  }
  db.close();
  return dbPath;
}

describe("legacy database refusal", () => {
  it("detects tasks without a Root and command-path agent keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-legacy-detect-"));
    try {
      const dbPath = makeLegacyDb(dir, "/opt/homebrew/bin/pi", null);
      const db = new Database(dbPath, { readonly: true });
      try {
        const report = detectLegacyDatabase(db);
        assert.ok(report);
        assert.equal(report.taskCount, 1);
        assert.equal(report.hasRoot, false);
        assert.deepEqual(report.pathLikeAgentKeys, ["/opt/homebrew/bin/pi"]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses before any write and leaves the DB bytes unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-legacy-refuse-"));
    try {
      const dbPath = makeLegacyDb(dir, "/opt/homebrew/bin/pi", null);
      const beforeHash = sha256(dbPath);
      const beforeFiles = readdirSync(dir).sort();

      assert.throws(
        () => new Store(dir),
        (error: unknown) => {
          assert.ok(error instanceof LegacyDatabaseError);
          assert.match(error.message, /pre-multi-agent/);
          assert.match(error.message, /but no Root/);
          assert.match(error.message, /back up/i);
          assert.match(error.message, /re-initialize/);
          assert.doesNotMatch(error.message, /migrate/);
          return true;
        },
      );

      assert.equal(sha256(dbPath), beforeHash);
      assert.deepEqual(readdirSync(dir).sort(), beforeFiles);
      assert.equal(existsSync(`${dbPath}-wal`), false);
      assert.equal(existsSync(`${dbPath}-shm`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a pre-UUID database whose Root has the literal id", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-legacy-literal-"));
    try {
      // Nothing names this Root: the database predates `workspace`, so it is
      // a breaking change that needs a reset, not a migration.
      const dbPath = makeLegacyDb(dir, "pi", "root");
      const db = new Database(dbPath, { readonly: true });
      try {
        const report = detectLegacyDatabase(db);
        assert.ok(report);
        assert.equal(report.taskCount, 2);
        assert.equal(report.hasRoot, false);
        assert.deepEqual(report.pathLikeAgentKeys, []);
      } finally {
        db.close();
      }
      const beforeHash = sha256(dbPath);
      assert.throws(() => new Store(dir), /but no Root/);
      assert.equal(sha256(dbPath), beforeHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses command-path keys even when a Root exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-legacy-key-"));
    try {
      const dbPath = makeLegacyDb(
        dir,
        "claude-agent-acp --profile work",
        "named-root",
        { namedRoot: true },
      );
      const db = new Database(dbPath, { readonly: true });
      try {
        const report = detectLegacyDatabase(db);
        assert.ok(report);
        assert.equal(report.taskCount, 2);
        assert.equal(report.hasRoot, true);
        assert.deepEqual(report.pathLikeAgentKeys, [
          "claude-agent-acp --profile work",
        ]);
      } finally {
        db.close();
      }
      const beforeHash = sha256(dbPath);
      assert.throws(() => new Store(dir), /pre-multi-agent/);
      assert.equal(sha256(dbPath), beforeHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a migrated DB, including tasks owned by a removed agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-legacy-accept-"));
    try {
      const store = new Store(dir);
      const rootTaskId = store.ensureRootTask("/tmp/root").id;
      store.createTask("live-task", "/tmp/live", "auto", "pi", "session-live");
      store.close();

      // A task legitimately owned by an agent no longer in config must not
      // look like the pre-multi-agent shape.
      const retired = new Store(dir);
      retired.createTask(
        "retired-task",
        "/tmp/retired",
        "auto",
        "retired-agent",
        "session-old",
      );
      retired.close();

      const reopened = new Store(dir);
      // Reads are global: a task whose agent left the configuration stays
      // visible, and so does the unbound Root.
      assert.deepEqual(
        reopened
          .listTasks()
          .map((task) => task.id)
          .sort(),
        ["live-task", "retired-task", reopened.rootTaskId].sort(),
      );
      assert.equal(reopened.rootTaskId, rootTaskId);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts ordinary root-prefixed task ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-legacy-prefix-"));
    try {
      const store = new Store(dir);
      const rootTaskId = store.ensureRootTask("/tmp/root").id;
      store.attachAgentSession(rootTaskId, "test-agent", "root-session");
      store.createTask("root-forged", "/tmp/forged", "auto", "pi");
      store.createTask("root-2f3a9c", "/tmp/short", "auto", "pi");
      store.close();

      const reopened = new Store(dir);
      assert.equal(reopened.getTask("root-forged")?.id, "root-forged");
      assert.equal(reopened.getTask("root-2f3a9c")?.id, "root-2f3a9c");
      assert.equal(reopened.getTask(rootTaskId)?.id, rootTaskId);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a fresh database directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-legacy-fresh-"));
    try {
      const store = new Store(dir);
      assert.equal(store.ensureRootTask("/tmp/root").id, store.rootTaskId);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
