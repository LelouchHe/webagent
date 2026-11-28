// Refuse the pre-multi-agent shape before any write.
//
// With the single-Root invariant, every database that has tasks has a Root,
// and the `workspace` row names it, so "tasks exist but no named Root does"
// is the primary signal. That also covers a database whose Root still has the
// pre-UUID literal id: it predates `workspace` and needs a reset too. A
// command-path `agent_key` (not a valid configured id) is the secondary signal
// for a hand-edited mixed database. A valid-but-removed agent id is allowed.

import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AGENT_ID_PATTERN } from "./config.ts";

export interface LegacyDatabaseReport {
  taskCount: number;
  hasRoot: boolean;
  pathLikeAgentKeys: string[];
  outdatedRemoteTasks: boolean;
  outdatedOutbox: boolean;
  schemaIncompatibility?: string;
}

function legacyDatabaseMessage(report: LegacyDatabaseReport): string {
  if (report.outdatedRemoteTasks) {
    return (
      "This database uses an older WebAgent remote_tasks link schema and " +
      "cannot be used by this version; nothing in it was changed. " +
      "Back up the data directory, then remove webagent.db (or the " +
      "whole data directory) and restart to create a new one."
    );
  }
  if (report.outdatedOutbox) {
    return (
      "This database uses an older WebAgent outbox schema and cannot " +
      "be used by this version; nothing in it was changed. Run the " +
      "offline outbox migration, or back up the data directory, " +
      "remove webagent.db (or the whole data directory), and restart " +
      "to create a new one."
    );
  }
  const classicLegacyShape =
    report.pathLikeAgentKeys.length > 0 ||
    (report.taskCount > 0 && !report.hasRoot);
  if (classicLegacyShape) {
    return (
      "This database was created by an older WebAgent and cannot be used " +
      "by this version; nothing in it was changed. Back up the data " +
      "directory, then remove webagent.db (or the whole data " +
      "directory) and restart to create a new one."
    );
  }
  if (report.schemaIncompatibility) {
    return (
      `Pre-1.0 data directory detected (${report.schemaIncompatibility}). ` +
      "Nothing in it was changed. Back up the data directory, then delete " +
      "webagent.db (or the whole data directory) and restart."
    );
  }
  return (
    "This database was created by an older WebAgent and cannot be used " +
    "by this version; nothing in it was changed. Back up the data directory, " +
    "then remove webagent.db (or the whole data directory) and restart to " +
    "create a new one."
  );
}

export class LegacyDatabaseError extends Error {
  readonly report: LegacyDatabaseReport;

  constructor(report: LegacyDatabaseReport) {
    super(legacyDatabaseMessage(report));
    this.name = "LegacyDatabaseError";
    this.report = report;
  }
}

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tasks: [
    "id",
    "cwd",
    "title",
    "workflow_status",
    "parent_id",
    "pending_compact_summary",
    "model",
    "mode",
    "reasoning_effort",
    "source",
    "deleted_at",
    "created_at",
    "last_active_at",
  ],
  agent_sessions: ["agent_key", "agent_session_id", "task_id", "created_at"],
  events: ["id", "task_id", "seq", "type", "data", "created_at", "from_ref"],
  shares: [
    "token",
    "task_id",
    "shared_at",
    "share_snapshot_seq",
    "ttl_hours",
    "display_name",
    "owner_label",
    "created_at",
    "last_accessed_at",
  ],
  attachments: [
    "id",
    "task_id",
    "kind",
    "name",
    "mime",
    "size",
    "realpath",
    "upload_seq",
    "width",
    "height",
    "created_at",
  ],
  inbox_messages: [
    "id",
    "from_ref",
    "from_label",
    "to_ref",
    "deliver",
    "dedup_key",
    "title",
    "body",
    "cwd",
    "created_at",
  ],
  messages: [
    "id",
    "source_task_id",
    "direct_target_task_id",
    "source_actor",
    "body",
    "created_at",
  ],
  message_projections: ["message_id", "task_id", "role", "created_at"],
  deliveries: [
    "id",
    "message_id",
    "recipient_task_id",
    "idempotency_key",
    "status",
    "queued_at",
    "delivered_at",
    "failed_at",
    "failure_reason",
    "source_remote_role",
    "source_remote_host",
    "source_entry_id",
    "source_label",
    "source_category",
  ],
};

const TIMESTAMP_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tasks: ["created_at", "last_active_at"],
  agent_sessions: ["created_at"],
  events: ["created_at"],
  push_subscriptions: ["created_at"],
  shares: ["created_at"],
  attachments: ["created_at"],
  recent_paths: ["last_used_at"],
  owner_prefs: ["updated_at"],
};

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) !== undefined
  );
}

function tableColumns(
  db: Database.Database,
  table: string,
): Map<
  string,
  { type: string; notnull: number; dflt_value: unknown; name: string }
> {
  return new Map(
    (
      db.pragma(`table_info("${table}")`) as Array<{
        type: string;
        notnull: number;
        dflt_value: unknown;
        name: string;
      }>
    ).map((column) => [column.name, column]),
  );
}

function detectColumnIncompatibility(db: Database.Database): string | null {
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    if (!tableExists(db, table)) continue;
    const actual = tableColumns(db, table);
    if (table === "tasks" && actual.has("brief")) {
      return "legacy column tasks.brief";
    }
    const missing = required.find((column) => !actual.has(column));
    if (missing) return `${table}.${missing} column is missing`;
    const unexpected = [...actual.keys()].find(
      (column) => !required.includes(column),
    );
    if (unexpected) return `${table}.${unexpected} unexpected column`;
  }
  return null;
}

function detectTimestampIncompatibility(db: Database.Database): string | null {
  for (const [table, columns] of Object.entries(TIMESTAMP_COLUMNS)) {
    if (!tableExists(db, table)) continue;
    const actual = tableColumns(db, table);
    for (const name of columns) {
      const column = actual.get(name);
      if (!column) continue;
      if (column.type.toUpperCase() !== "INTEGER") {
        return `${table}.${name} must be an INTEGER timestamp`;
      }
      if (column.notnull !== 1 || String(column.dflt_value) !== "0") {
        return `${table}.${name} has a legacy NOT NULL/default declaration`;
      }
    }
  }
  return null;
}

function detectConstraintIncompatibility(db: Database.Database): string | null {
  if (
    tableExists(db, "events") &&
    db
      .prepare("SELECT 1 AS present FROM events WHERE from_ref IS NULL LIMIT 1")
      .get()
  ) {
    return "events.from_ref contains NULL";
  }
  const tasksSql = tableExists(db, "tasks")
    ? (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
          )
          .get() as { sql?: string } | undefined
      )?.sql
    : undefined;
  if (tasksSql && !tasksSql.includes("'waiting'")) {
    return "tasks.workflow_status CHECK does not include waiting";
  }
  const deliveriesSql = tableExists(db, "deliveries")
    ? (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'",
          )
          .get() as { sql?: string } | undefined
      )?.sql
    : undefined;
  if (deliveriesSql?.includes("'draining'")) {
    return "deliveries.status CHECK still includes draining";
  }
  return null;
}

/** Find any existing table/index shape that this version must not mutate. */
export function detectSchemaIncompatibility(
  db: Database.Database,
): string | null {
  if (tableExists(db, "sessions")) return "legacy sessions table";
  if (tableExists(db, "client_ops")) return "legacy client_ops table";
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_sessions_task'",
      )
      .get()
  ) {
    return "legacy index idx_agent_sessions_task";
  }
  return (
    detectColumnIncompatibility(db) ??
    detectTimestampIncompatibility(db) ??
    detectConstraintIncompatibility(db)
  );
}

function hasNamedRoot(
  db: Database.Database,
  tableSql: ReadonlyMap<string, string>,
): boolean {
  if (
    !tableColumns(db, "tasks").has("id") ||
    !tableSql.has("workspace") ||
    !tableColumns(db, "workspace").has("root_task_id")
  ) {
    return false;
  }
  return (
    db
      .prepare(
        "SELECT 1 AS present FROM workspace w JOIN tasks t ON t.id = w.root_task_id WHERE w.id = 1",
      )
      .get() !== undefined
  );
}

function detectPathLikeAgentKeys(
  db: Database.Database,
  tableSql: ReadonlyMap<string, string>,
): string[] {
  if (
    !tableSql.has("agent_sessions") ||
    !tableColumns(db, "agent_sessions").has("agent_key")
  ) {
    return [];
  }
  return (
    db
      .prepare(
        "SELECT DISTINCT agent_key AS value FROM agent_sessions ORDER BY agent_key",
      )
      .all() as Array<{ value: string }>
  )
    .map((row) => row.value)
    .filter((key) => !AGENT_ID_PATTERN.test(key));
}

function hasOutdatedRemoteTasks(
  db: Database.Database,
  tableSql: ReadonlyMap<string, string>,
): boolean {
  if (!tableSql.has("remote_tasks")) return false;
  const remoteHostColumn = (
    db.prepare("PRAGMA table_info(remote_tasks)").all() as Array<{
      name: string;
      notnull: number;
    }>
  ).find((column) => column.name === "remote_host");
  return remoteHostColumn?.notnull !== 1;
}

function hasOutdatedOutbox(tableSql: ReadonlyMap<string, string>): boolean {
  const outboxSql = tableSql.get("outbox");
  if (outboxSql === undefined) return false;
  return (
    /category\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*category\s+IN\s*\(/i.test(
      outboxSql,
    ) ||
    !/category\s+NOT\s+IN\s*\(\s*'message'\s*,\s*'report'\s*\)\s+AND\s+delivery_id\s+IS\s+NULL/i.test(
      outboxSql,
    )
  );
}

/** Inspect an already-open database. Returns null for a non-WebAgent DB. */
export function detectLegacyDatabase(
  db: Database.Database,
): LegacyDatabaseReport | null {
  const tableSql = new Map(
    (
      db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string; sql: string | null }>
    ).map((row) => [row.name, row.sql ?? ""]),
  );
  const schemaIncompatibility = detectSchemaIncompatibility(db) ?? undefined;
  if (!tableSql.has("tasks")) {
    return schemaIncompatibility
      ? {
          taskCount: 0,
          hasRoot: false,
          pathLikeAgentKeys: [],
          outdatedRemoteTasks: false,
          outdatedOutbox: false,
          schemaIncompatibility,
        }
      : null;
  }

  const { taskCount } = db
    .prepare("SELECT COUNT(*) AS taskCount FROM tasks")
    .get() as { taskCount: number };
  const hasRoot = hasNamedRoot(db, tableSql);
  const pathLikeAgentKeys = detectPathLikeAgentKeys(db, tableSql);
  const outdatedRemoteTasks = hasOutdatedRemoteTasks(db, tableSql);
  const outdatedOutbox = hasOutdatedOutbox(tableSql);
  const report = {
    taskCount,
    hasRoot,
    pathLikeAgentKeys,
    outdatedRemoteTasks,
    outdatedOutbox,
    schemaIncompatibility,
  };
  if (outdatedRemoteTasks || outdatedOutbox || schemaIncompatibility) {
    return report;
  }
  if (report.taskCount === 0 || report.hasRoot) {
    return report.pathLikeAgentKeys.length > 0 ? report : null;
  }
  return report;
}

/**
 * Read-only pre-open check. Database and WAL bytes are left unchanged; SQLite
 * may create or refresh the temporary shared-memory index alongside a WAL.
 */
export function assertNotLegacyDatabase(dataDir: string): void {
  const dbPath = join(dataDir, "webagent.db");
  if (!existsSync(dbPath)) return;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const report = detectLegacyDatabase(db);
    if (report) throw new LegacyDatabaseError(report);
  } finally {
    db.close();
  }
}
