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
}

export class LegacyDatabaseError extends Error {
  readonly report: LegacyDatabaseReport;

  constructor(report: LegacyDatabaseReport) {
    // The message says what to do, not which signal fired: the operator's
    // action is the same either way. The signals stay on `report`.
    super(
      "This database was created by an older WebAgent and cannot be used by " +
        "this version; nothing in it was changed. Back up the data " +
        "directory, then remove webagent.db (or the whole data directory) " +
        "and restart to create a new one.",
    );
    this.name = "LegacyDatabaseError";
    this.report = report;
  }
}

/** Inspect an already-open database. Returns null for a non-WebAgent DB. */
export function detectLegacyDatabase(
  db: Database.Database,
): LegacyDatabaseReport | null {
  const tables = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  if (!tables.has("tasks")) return null;

  const { taskCount } = db
    .prepare("SELECT COUNT(*) AS taskCount FROM tasks")
    .get() as { taskCount: number };
  const hasRoot =
    tables.has("workspace") &&
    db
      .prepare(
        "SELECT 1 AS present FROM workspace w JOIN tasks t ON t.id = w.root_task_id WHERE w.id = 1",
      )
      .get() !== undefined;
  const pathLikeAgentKeys = tables.has("agent_sessions")
    ? (
        db
          .prepare(
            "SELECT DISTINCT agent_key AS value FROM agent_sessions ORDER BY agent_key",
          )
          .all() as Array<{ value: string }>
      )
        .map((row) => row.value)
        .filter((key) => !AGENT_ID_PATTERN.test(key))
    : [];

  const report = {
    taskCount,
    hasRoot,
    pathLikeAgentKeys,
  };
  if (report.taskCount === 0 || report.hasRoot) {
    return report.pathLikeAgentKeys.length > 0 ? report : null;
  }
  return report;
}

/** Read-only pre-open check; a refused start leaves the file byte-identical. */
export function assertNotLegacyDatabase(dataDir: string): void {
  const dbPath = join(dataDir, "webagent.db");
  if (!existsSync(dbPath)) return;
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return; // not a readable SQLite DB: the normal writable open reports it
  }
  try {
    const report = detectLegacyDatabase(db);
    if (report) throw new LegacyDatabaseError(report);
  } catch (error) {
    if (error instanceof LegacyDatabaseError) throw error;
    // A DB without the expected tables falls through to ordinary schema checks.
  } finally {
    db.close();
  }
}
