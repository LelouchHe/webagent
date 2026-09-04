#!/usr/bin/env node

/**
 * One-time pre-1.0 S3.0 database migration.
 *
 * This script is deliberately separate from server startup. Run it only while
 * WebAgent is stopped; it creates a consistent SQLite backup before changing
 * the schema and never deletes ACP bindings.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface S3MigrationOptions {
  dataDir: string;
  backupPath: string;
}

export interface S3MigrationResult {
  backupPath: string;
  normalizedTitleCount: number;
  unboundAgentSessionIds: string[];
}

type LegacyTaskTitle = {
  id: string;
  parent_id: string | null;
  title: string | null;
  deleted_at: number | null;
};

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== undefined
  );
}

function columnExists(
  db: Database.Database,
  table: string,
  column: string,
): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((entry) => (entry as { name: string }).name === column);
}

function normalizeTitle(value: string | null, taskId: string): string {
  const normalized = (value ?? "").replaceAll("/", "-").trim();
  if (!normalized || normalized === "." || normalized === "..") {
    return taskId === "root" ? "root" : `task-${taskId.slice(0, 8)}`;
  }
  return normalized;
}

function uniqueTitle(title: string, taskId: string, used: Set<string>): string {
  if (!used.has(title)) return title;
  const suffix = `-${taskId.slice(0, 8)}`;
  let candidate = `${title}${suffix}`;
  let sequence = 2;
  while (used.has(candidate)) {
    candidate = `${title}${suffix}-${sequence}`;
    sequence++;
  }
  return candidate;
}

function createCollaborationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      source_task_id TEXT NOT NULL,
      direct_target_task_id TEXT NOT NULL,
      source_actor TEXT NOT NULL CHECK (source_actor IN ('user', 'agent', 'system')),
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_messages_source_created
      ON messages (source_task_id, created_at);
    CREATE INDEX idx_messages_target_created
      ON messages (direct_target_task_id, created_at);

    CREATE TABLE message_projections (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('source', 'target', 'supervisor')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, task_id)
    );
    CREATE INDEX idx_message_projections_task_created
      ON message_projections (task_id, created_at);

    CREATE TABLE deliveries (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      recipient_task_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('queued', 'draining', 'delivered', 'failed')),
      queued_at INTEGER NOT NULL,
      claimed_at INTEGER,
      delivered_at INTEGER,
      failed_at INTEGER,
      failure_reason TEXT
    );
    CREATE INDEX idx_deliveries_recipient_status_queued
      ON deliveries (recipient_task_id, status, queued_at);
  `);
}

/**
 * Run the known S2-to-S3.0 transformation after making a SQLite online backup.
 * Callers are responsible for stopping WebAgent first; the CLI requires an
 * explicit acknowledgement for that operational precondition.
 */
export async function migrateS3Database(
  options: S3MigrationOptions,
): Promise<S3MigrationResult> {
  const dataDir = resolve(options.dataDir);
  const dbPath = join(dataDir, "webagent.db");
  const backupPath = resolve(options.backupPath);
  if (!existsSync(dbPath))
    throw new Error(`Database does not exist: ${dbPath}`);
  if (existsSync(backupPath)) {
    throw new Error(`Refusing to overwrite existing backup: ${backupPath}`);
  }

  mkdirSync(dirname(backupPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.pragma("foreign_keys = ON");
    if (!tableExists(db, "tasks") || !tableExists(db, "messages")) {
      throw new Error(
        "Expected an S2 tasks/messages database before S3.0 migration",
      );
    }
    if (tableExists(db, "inbox_messages")) {
      throw new Error(
        "Database already has inbox_messages; refusing repeated migration",
      );
    }
    if (columnExists(db, "messages", "source_task_id")) {
      throw new Error(
        "Database already has S3 collaboration messages; refusing repeated migration",
      );
    }

    await db.backup(backupPath);

    let normalizedTitleCount = 0;
    const unboundAgentSessionIds = tableExists(db, "agent_sessions")
      ? (
          db
            .prepare(
              "SELECT agent_session_id FROM agent_sessions WHERE task_id IS NULL ORDER BY agent_session_id",
            )
            .all() as Array<{ agent_session_id: string }>
        ).map((row) => row.agent_session_id)
      : [];

    db.transaction(() => {
      db.exec("ALTER TABLE messages RENAME TO inbox_messages");
      db.exec("DROP INDEX IF EXISTS idx_messages_created");
      db.exec("DROP INDEX IF EXISTS idx_messages_dedup");
      db.exec(
        "CREATE INDEX idx_inbox_messages_created ON inbox_messages (created_at)",
      );
      db.exec(
        "CREATE INDEX idx_inbox_messages_dedup ON inbox_messages (to_ref, dedup_key)",
      );

      db.exec("ALTER TABLE tasks ADD COLUMN brief TEXT NOT NULL DEFAULT ''");
      db.exec(
        "ALTER TABLE tasks ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'idle' CHECK (workflow_status IN ('running', 'idle', 'blocked', 'done'))",
      );

      const titles = db
        .prepare(
          `SELECT id, parent_id, title, deleted_at FROM tasks
           ORDER BY CASE WHEN parent_id IS NULL THEN '' ELSE parent_id END, id`,
        )
        .all() as LegacyTaskTitle[];
      const usedByLiveParent = new Map<string, Set<string>>();
      const updateTitle = db.prepare("UPDATE tasks SET title = ? WHERE id = ?");
      for (const task of titles) {
        const normalized = normalizeTitle(task.title, task.id);
        const parentKey = task.parent_id ?? "\u0000";
        const used = usedByLiveParent.get(parentKey) ?? new Set<string>();
        if (task.deleted_at === null) usedByLiveParent.set(parentKey, used);
        const title =
          task.deleted_at === null
            ? uniqueTitle(normalized, task.id, used)
            : normalized;
        if (task.deleted_at === null) used.add(title);
        if (title !== task.title) {
          updateTitle.run(title, task.id);
          normalizedTitleCount++;
        }
      }
      db.exec(`
        CREATE UNIQUE INDEX idx_tasks_parent_title_live
          ON tasks (parent_id, title)
          WHERE deleted_at IS NULL AND title IS NOT NULL
      `);
      createCollaborationSchema(db);
    })();

    return { backupPath, normalizedTitleCount, unboundAgentSessionIds };
  } finally {
    db.close();
  }
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes("--execute") || !args.includes("--server-stopped")) {
    throw new Error(
      "Refusing to migrate. Required: --execute --server-stopped --data-dir <dir> [--backup <file>]",
    );
  }
  const dataDir = readOption(args, "--data-dir");
  if (!dataDir) throw new Error("Missing --data-dir");
  const backupPath =
    readOption(args, "--backup") ?? join(dataDir, "webagent.pre-s3-0.db");
  const result = await migrateS3Database({ dataDir, backupPath });
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
